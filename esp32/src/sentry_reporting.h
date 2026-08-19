#pragma once
//
// Crash + reset-reason reporting through sentry-micro (https://github.com/getsentry/sentry-micro).
//
// The device builds a real Sentry envelope itself and hands the bytes to a transport; the SDK
// owns every Sentry-specific detail (DSN, envelope format, auth header, backoff). The route
// is the relay: the device chunks (url, headers, body) over a BLE characteristic and the app
// performs the request. A phone that is already holding an HTTPS stack is a better place to
// put one than a chip with 300 KB of usable flash left — see CHROMABAY_SENTRY_WIFI below for
// the direct-to-ingest alternative and what it costs.
//
// The route is not usually available at the moment a crash is discovered — that happens in
// setup(), long before the app connects — so the event is written to the LittleFS-backed
// offline buffer and delivered later by tick().
//
// Entirely optional, and inert unless two things line up:
//   1. the SDK is on the include path  (lib_deps: ${sysenv.CHROMABAY_SENTRY_MICRO})
//   2. a DSN is configured             (provisioned by the app over BLE, or baked in with
//                                       CHROMABAY_SENTRY_DSN for a local build)
// Miss either and every function below compiles to nothing or no-ops at runtime. Crash
// reporting must never be load-bearing for the firmware it reports on.
//
// What gets sent: one event on the boot that FOLLOWS a crash (panic, watchdog, brownout),
// carrying the reset reason, chip/board/flash facts, heap and uptime — plus the coredump
// backtrace when the SDK build supports it. Clean boots send nothing; a fleet of LED
// controllers rebooting on a power switch is not news, and it would burn the project's quota.

#ifndef CHROMABAY_WIFI
#define CHROMABAY_WIFI 1
#endif

// Auto-detect the SDK the same way firmware_version.h detects the stamped build header, so a
// checkout without sentry-micro (and CI, which has no access to it yet) builds unchanged.
#ifndef CHROMABAY_SENTRY
#  if defined(__has_include)
#    if __has_include(<sentry_micro.h>)
#      define CHROMABAY_SENTRY 1
#    else
#      define CHROMABAY_SENTRY 0
#    endif
#  else
#    define CHROMABAY_SENTRY 0
#  endif
#endif

#if CHROMABAY_SENTRY

// Whether the device may deliver its own reports over HTTPS, instead of always handing them
// to the phone. Off, and deliberately so, even in WiFi builds.
//
// It is not the DSN or the certificate that costs anything — we pin no root anyway, so the
// connection has always been encrypted but unauthenticated. It is mbedTLS: WiFiClientSecure
// drags in the SSL and x509 layers, which is ~120 KB of flash on top of the mbedcrypto this
// firmware already links for OTA signature checks. That is more than the entire rest of
// crash reporting costs (~18 KB), spent so a device can do for itself something the phone
// in the user's hand can already do for it.
//
// The cost of leaving it off: a device in WiFi comm mode has no BLE, so it can only deliver
// when the app is connected over the WiFi link. Set to 1 for a fleet that must report with
// no app anywhere near it, and accept the flash.
#ifndef CHROMABAY_SENTRY_WIFI
#define CHROMABAY_SENTRY_WIFI 0
#endif

#include <sentry_micro.h>
#include <transport/sentry_transport_auto.hpp>
#include <transport/sentry_transport_relay.hpp>
#include <device/sentry_storage_fs.hpp>
#if CHROMABAY_WIFI && CHROMABAY_SENTRY_WIFI
#include <transport/sentry_transport_wifi.hpp>
#endif
// The coredump half of the SDK is still landing; use it when the checkout has it, and fall
// back to a reset-reason-only event when it doesn't.
#if defined(__has_include)
#  if __has_include(<core/sentry_coredump.h>)
#    define CHROMABAY_SENTRY_COREDUMP 1
#  endif
#endif
#ifndef CHROMABAY_SENTRY_COREDUMP
#define CHROMABAY_SENTRY_COREDUMP 0
#endif
#if defined(__has_include)
#  if __has_include(<core/sentry_trace.h>)
#    define CHROMABAY_SENTRY_TRACE 1
#  endif
#  if __has_include(<core/sentry_span.h>)
#    define CHROMABAY_SENTRY_SPANS 1
#  endif
#endif
#ifndef CHROMABAY_SENTRY_TRACE
#define CHROMABAY_SENTRY_TRACE 0
#endif
#ifndef CHROMABAY_SENTRY_SPANS
#define CHROMABAY_SENTRY_SPANS 0
#endif

#include <LittleFS.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include "firmware_version.h"

// Optional build-time DSN, injected from the environment by platformio.ini. Empty in a
// released build — see provisionDsn() for how a shipped device gets one.
#ifndef CHROMABAY_SENTRY_DSN
#define CHROMABAY_SENTRY_DSN ""
#endif
#ifndef CHROMABAY_SENTRY_ENV
#define CHROMABAY_SENTRY_ENV "production"
#endif
#ifndef ARDUINO_BOARD
#define ARDUINO_BOARD "unknown"
#endif

// Relay characteristics, continuing the service's UUID sequence (…fa was COMM_CONFIG).
// TX notifies request frames to the app; RX takes the app's HELLO and STATUS frames; CONFIG
// carries the DSN the app provisions.
#define CHARACTERISTIC_UUID_SENTRY_TX     "a0be83fb-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_SENTRY_RX     "a0be83fc-8dc9-47f0-ab40-b19721d20ed1"
#define CHARACTERISTIC_UUID_SENTRY_CONFIG "a0be83fd-8dc9-47f0-ab40-b19721d20ed1"

namespace SentryReporting {

// ── State ───────────────────────────────────────────────────────────────────────────────
// The DSN is stored by POINTER by the SDK (it never copies option strings — see
// sentry_options_t), so the buffer it points at has to outlive init. Hence a static.
static char gDsn[SENTRY_MICRO_MAX_DSN_LEN + 1] = { 0 };
// A DSN the app wrote, waiting to be persisted + applied on the loop task.
static char gPendingDsn[SENTRY_MICRO_MAX_DSN_LEN + 1] = { 0 };
static volatile bool gDsnPending = false;
#if CHROMABAY_SENTRY_TRACE
static char gPendingTrace[192] = { 0 };
static volatile bool gTracePending = false;
static volatile bool gTraceReleasePending = false;
#endif
static NimBLECharacteristic *gRelayTx = nullptr;
static bool gBleConnected = false;

/**
 * The Wi-Fi half of the relay.
 *
 * BLE and Wi-Fi are mutually exclusive per boot (NVS commMode), so at most one of these links
 * is ever live — but the relay has to work on whichever one it is, or a device switched to
 * Wi-Fi silently stops reporting. Registered as a function pointer by WifiLink rather than
 * called directly, because this header is included long before that namespace is defined.
 */
typedef bool (*FrameSink)(const uint8_t *frame, size_t len);
/** Services the Wi-Fi link's socket. See relayWait() for why the relay cannot work without it. */
typedef void (*PumpFn)();
static FrameSink gWifiSink = nullptr;
static PumpFn gWifiPump = nullptr;
static bool gWifiConnected = false;
static bool gRelayWasReady = false;
static uint32_t gLastFlushMs = 0;
static bool gLastFlushDelivered = false;
static bool gLastBootReported = false;
// Slow on purpose: see the comment at the flush in tick().
static const uint32_t METRICS_INTERVAL_MS = 300000;   // 5 minutes
static uint32_t gLastMetricsMs = 0;
static uint32_t gLastFpsTimes10 = 0;

// NVS namespace of its own rather than a field on DeviceSettings: the DSN is optional
// diagnostics config, and mixing it into the settings struct would mean touching the
// settings wire format (and its app-side mirror) for something the app already knows.
static const char *NVS_NAMESPACE = "cbaysentry";
static const char *NVS_KEY_DSN = "dsn";

// How often we're willing to spend a blocking send from loop(). Only ever paid when
// something is actually queued — i.e. after a crash — never on a healthy device.
//
// Two rates, because the two cases are not alike. An attempt that delivered proves the route
// works, and the only thing left to decide is how fast a backlog drains: one envelope every
// 5 s clears a handful of crashes while someone is still holding the phone, and still bounds
// the stall to one blocking send per interval. An attempt that failed says the far end is
// gone, and retrying that every 5 s is a hitch in the LED render loop paid for nothing.
static const uint32_t FLUSH_INTERVAL_MS = 30000;
static const uint32_t FLUSH_BACKLOG_INTERVAL_MS = 5000;

// Payload budget per BLE notification. 180 is what the rest of this firmware uses for
// device→app chunk streams (see processLibraryDumpRequest), so it's the size already known
// to survive the MTU every supported phone negotiates.
static const size_t RELAY_CHUNK_BYTES = 180;

// ── Relay transport over the ChromaBay BLE service ──────────────────────────────────────
// The SDK's RelayTransport owns the protocol; this is the ~20 lines that put its frames on
// this particular radio. Pacing lives here, not in the SDK: NimBLE will happily accept
// notifications faster than the link can drain them and silently drop the excess, and 8 ms
// is the interval the library dump already uses successfully.
inline bool relayWriteFrame(void *, const uint8_t *frame, size_t len) {
    if (gRelayTx && gBleConnected) {
        gRelayTx->setValue(const_cast<uint8_t *>(frame), len);
        gRelayTx->notify();
        delay(8);
        return true;
    }
    // No pacing on the Wi-Fi path: TCP has its own flow control, and the 8 ms above exists
    // only because NimBLE accepts notifications faster than the link drains them and drops
    // the excess in silence.
    if (gWifiSink && gWifiConnected) return gWifiSink(frame, len);
    return false;
}

static sentry::RelayTransport gRelayTransport(relayWriteFrame);

/**
 * What the relay does while waiting for the app to answer — and on Wi-Fi it must be more than
 * sleep, or nothing ever answers.
 *
 * send() blocks the loop task until a STATUS frame arrives. Over BLE that works because
 * inbound writes land on the NimBLE host task, which is still running. Over Wi-Fi the socket
 * is read by WifiLink::tick() — from the loop task, the one now blocked here. Sleeping
 * through the wait would mean nothing ever reads the reply: every relayed report would sit
 * for the full 10 s timeout and then fail, hanging the LED render loop each time. So the wait
 * pumps the link it is waiting on.
 *
 * Guarded against re-entry rather than assumed safe: a dispatch from inside the pump could in
 * principle reach code that sends again, and WifiLink's receive buffers are not reentrant.
 */
static bool gPumping = false;

inline void relayWait(void *, uint32_t ms) {
    if (gWifiPump && gWifiConnected && !gPumping) {
        gPumping = true;
        gWifiPump();
        gPumping = false;
    }
    delay(ms);
}

#if CHROMABAY_WIFI && CHROMABAY_SENTRY_WIFI
static sentry::WiFiTransport gWifiTransport;
#endif

// Picks a route per delivery attempt: WiFi when the device is actually associated, else
// the phone. Ordering is the whole contract — AutoTransport takes the first transport whose
// is_available() says yes, so the one that can tell the truth about its own link goes first.
//
// This used to be a hand-written class here. It is the SDK's now (sentry-micro SDK-1389):
// every adopter with two routes needs exactly this object, and the re-selection it does on
// every attempt — rather than once at boot — is the part that is easy to get wrong.
#if CHROMABAY_WIFI && CHROMABAY_SENTRY_WIFI
static sentry::AutoTransport gTransport({ &gWifiTransport, &gRelayTransport });
#else
static sentry::AutoTransport gTransport({ &gRelayTransport });
#endif

// ── Inbound, from whichever transport the app is on ─────────────────────────────────────
// Written once and called from both the BLE callbacks below and the Wi-Fi channel dispatch
// in main.cpp. onConfigWrite (further down, next to the host check it depends on) matters
// most: that check is the thing standing between an unpaired stranger and pointing this
// device at a host they control, and it must not exist in two places.

/** A HELLO or STATUS frame from the app. */
inline void onHostFrame(const uint8_t *data, size_t len) {
    // May run on the NimBLE host task while the loop task is blocked inside send() waiting
    // for exactly this frame. on_host_frame() is written for that.
    gRelayTransport.on_host_frame(data, len);
}

// ── BLE plumbing ────────────────────────────────────────────────────────────────────────
class RelayRxCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        onHostFrame((const uint8_t *)value.data(), value.length());
    }
};

inline void initSdk();  // fwd: provisioning re-runs init with the new DSN

// Which ingest hosts a provisioned DSN may name. Anyone within BLE range can write this
// characteristic — there's no pairing — and on a WiFi-mode device the DSN also decides where
// the firmware itself will POST. Without this, a stranger could point a device at a host they
// control and have it deliver its own diagnostics there. Override at build time for a
// self-hosted Sentry.
#ifndef CHROMABAY_SENTRY_ALLOWED_HOST_SUFFIX
#define CHROMABAY_SENTRY_ALLOWED_HOST_SUFFIX ".sentry.io"
#endif
#ifndef CHROMABAY_SENTRY_REQUIRED_HOST_PART
#define CHROMABAY_SENTRY_REQUIRED_HOST_PART ".ingest."
#endif

/**
 * True if `dsn` is https and names a Sentry ingest host.
 *
 * Two conditions, not one: the host must END with `.sentry.io` and CONTAIN `.ingest.`. A
 * plain suffix of ".ingest.sentry.io" looks like it covers everything but does not — ingest
 * is regional, and the real hosts are `o<org>.ingest.us.sentry.io` / `.ingest.de.sentry.io`,
 * which that suffix rejects. (Found the hard way: the device refused the app's own DSN.)
 */
inline bool dsnHostAllowed(const char *dsn) {
    if (!dsn || strncmp(dsn, "https://", 8) != 0) return false;
    const char *at = strrchr(dsn, '@');            // skip the key: https://<key>@<host>/<id>
    const char *host = at ? at + 1 : dsn + 8;
    const char *slash = strchr(host, '/');
    const size_t hostLen = slash ? (size_t)(slash - host) : strlen(host);

    const char *suffix = CHROMABAY_SENTRY_ALLOWED_HOST_SUFFIX;
    const size_t suffixLen = strlen(suffix);
    if (hostLen < suffixLen) return false;
    if (strncmp(host + hostLen - suffixLen, suffix, suffixLen) != 0) return false;

    // Bounded search: strstr would happily match inside the path that follows the host.
    const char *needle = CHROMABAY_SENTRY_REQUIRED_HOST_PART;
    const size_t needleLen = strlen(needle);
    if (hostLen < needleLen) return false;
    for (size_t i = 0; i + needleLen <= hostLen; i++) {
        if (strncmp(host + i, needle, needleLen) == 0) return true;
    }
    return false;
}

/**
 * The trace the app is currently working in: `trace <sentry-trace> <baggage>`.
 *
 * One trace per connection, adopted when the app attaches and released when it goes away.
 * That is coarser than sentry-micro asks for — it wants a trace per *request*, and a
 * connection is a session — and the trade is deliberate. A per-command trace would mean
 * putting ids on the wire beside every pattern sync, slider drag and settings write, for a
 * link the demo gets from the connection alone. The failure the SDK warns about is a device
 * holding one id for days and welding unrelated interactions to it; this one dies with the
 * link, which is what keeps that from happening.
 *
 * The crash path is why it works at all: the active trace lives in RTC memory, which
 * survives a panic reset. A device that dies mid-session reboots, finds the trace still
 * there, and the report it sends on the next boot carries the trace and replay id of the
 * session it died in — so the issue links to the video of whatever caused it.
 */
#if CHROMABAY_SENTRY_TRACE
inline void onTraceWrite(const char *payload) {
    // `trace <sentry-trace> <baggage>` — split on the two spaces, in place.
    char buf[192];
    strncpy(buf, payload, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    char *traceHeader = strchr(buf, ' ');
    if (!traceHeader) return;
    *traceHeader++ = '\0';
    char *baggage = strchr(traceHeader, ' ');
    if (baggage) *baggage++ = '\0';
    // A malformed header is rejected whole by the SDK, so a garbled write leaves the device
    // in no trace rather than in a fictional one.
    if (sentry::trace_adopt(traceHeader, baggage)) {
        Serial.printf("[Sentry] joined trace %s%s\n", sentry::trace().trace_id,
                      sentry::trace().replay_id[0] ? " (with replay)" : "");
    }
}
#endif

/** The DSN the app is provisioning. Empty clears it. */
inline void onConfigWrite(const uint8_t *data, size_t len) {
    if (len > SENTRY_MICRO_MAX_DSN_LEN) return;
    char dsn[SENTRY_MICRO_MAX_DSN_LEN + 1];
    memcpy(dsn, data, len);
    dsn[len] = '\0';

    // Same characteristic, two messages. A DSN is a URL and always starts `https://`, so
    // the prefix is an unambiguous discriminator and no new BLE surface is needed for what
    // is, after all, more Sentry configuration.
#if CHROMABAY_SENTRY_TRACE
    if (strncmp(dsn, "trace ", 6) == 0) {
        // Staged, not adopted here — see tick(), which owns both the ordering and the
        // reason this cannot run on the NimBLE host task.
        strncpy(gPendingTrace, dsn, sizeof(gPendingTrace) - 1);
        gPendingTrace[sizeof(gPendingTrace) - 1] = '\0';
        gTracePending = true;
        return;
    }
#endif
    if (len > 0 && !dsnHostAllowed(dsn)) {
        Serial.println("[Sentry] refusing a DSN outside the allowed ingest host");
        return;
    }
    // Stage it and let the loop task do the work, the way every other characteristic in
    // this firmware does: writing NVS and reopening the filesystem buffer from the NimBLE
    // host task would both stall the BLE stack and race the loop task's own file I/O.
    memcpy(gPendingDsn, dsn, len + 1);
    gDsnPending = true;
}

class SentryConfigCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        onConfigWrite((const uint8_t *)value.data(), value.length());
    }
};

static RelayRxCallbacks gRelayRxCallbacks;
static SentryConfigCallbacks gConfigCallbacks;

// ── Tracing this device's own work ──────────────────────────────────────────────────────
#if CHROMABAY_SENTRY_SPANS
/**
 * Whether a transaction can be sent at all.
 *
 * The SDK discards an undated one, because a duration with no anchor places real work at an
 * arbitrary time. ChromaBay learns the date from TIMESTAMP_SYNC just after the app connects
 * (or from NTP in WiFi mode), so the only gap this skips is between a power cut and the
 * first sync — and every operation traced below is app-initiated, so the app is by
 * definition already there.
 */
inline bool clockIsSet() { return time(nullptr) >= 1704067200; }  // 2024-01-01

/**
 * One traced operation, as a child of whatever the app was doing.
 *
 * Declare it where the work happens; it sends when it goes out of scope.
 *
 * NOT SAMPLED, and that is a constraint on where it may be used rather than a free choice:
 * transaction_finish() SENDS, and on a BLE-only device that send leaves from the loop task —
 * the one rendering the LEDs — and blocks until the phone answers. Everything traced with
 * this must be rare and user-initiated. Applying a pattern is neither: a slider drag applies
 * several a second, which is why it is deliberately not traced.
 */
class Operation {
public:
    Operation(const char *name, const char *op) {
        if (!sentry_is_enabled() || !clockIsSet()) return;
        active_ = sentry::transaction_start(txn_, name, op);
    }
    ~Operation() {
        if (active_) sentry::transaction_finish(txn_);
    }

    /** nullptr when inactive or full; everything below tolerates that, so never check. */
    sentry_span_t *child(const char *op, const char *description = nullptr) {
        return active_ ? sentry::start_child(txn_, op, description) : nullptr;
    }
    void set(sentry_span_t *span, const char *key, int64_t value) {
        sentry::span_set_attribute(span, key, value);
    }
    void finish(sentry_span_t *span) { sentry::span_finish(span); }

private:
    sentry::Transaction txn_;   // 688 B of this task's stack, live only for the operation
    bool active_ = false;
};

/**
 * Numbers this device wants to report that belong to no operation.
 *
 * Free heap, uptime, frame rate, disconnect counts: continuous, and attached to nothing a
 * trace could hang them off. Span attributes cannot carry them — a span needs an operation,
 * and the only operations here are an OTA, a config write, and a boot.
 *
 * The property that matters on this hardware is that RECORDING DOES NOT SEND. A gauge is a
 * write into a fixed table; nothing touches the transport until the next flush that was
 * happening anyway. That is what makes it safe to call these from the render loop, which is
 * exactly where transactions are not safe — finishing one blocks the task drawing the LEDs.
 *
 * They do need a clock, like everything else. Unlike a transaction, one without a date is
 * held rather than dropped: a counter covering a longer interval is still true, while a
 * duration anchored to nothing is not. So boot numbers recorded before the app ever connects
 * survive until it does — which is the honest version of the boot-transaction carrier this
 * replaces, and it needs no carrier at all.
 */
inline void recordBoot(uint32_t setupMs) {
    sentry::metric_count("device.boot");
    sentry::metric_gauge("device.setup_ms", (int64_t)setupMs, "millisecond");
}

/** The render loop hands us its latest rate; recorded on the flush cadence, not here. */
inline void noteFps(uint32_t fpsTimes10) { gLastFpsTimes10 = fpsTimes10; }

/** Called on every BLE drop. A fleet's disconnect rate is a number, not an anecdote. */
inline void recordDisconnect() { sentry::metric_count("device.ble_disconnect"); }

/**
 * The periodic readings, sampled on the flush cadence rather than continuously — a gauge
 * keeps only the newest value, so recording it more often than it is flushed just burns
 * cycles writing over itself.
 */
inline void recordVitals(uint32_t fpsTimes10) {
    sentry::metric_gauge("device.free_heap", (int64_t)ESP.getFreeHeap(), "byte");
    sentry::metric_gauge("device.min_free_heap", (int64_t)ESP.getMinFreeHeap(), "byte");
    sentry::metric_gauge("device.uptime", (int64_t)(millis() / 1000), "second");
    sentry::metric_gauge("device.fps_x10", (int64_t)fpsTimes10);
}

// ── OTA, which outlives any scope ───────────────────────────────────────────────────────
// An OTA runs for minutes across many loop iterations, so its transaction cannot be a local.
// 688 bytes of permanent RAM, which is the price of measuring the one operation on this
// device that actually takes long enough to be worth measuring.
//
// Task ownership matters here. esp_ota_begin and the chunk writes run on the NimBLE host
// task; only the finalize runs on the loop task. The handoff is the existing `ota_finalizing`
// flag: the BLE side opens the verify span and sets the flag, and the loop side does not
// touch the transaction until it sees it. Same staged-flag pattern as the rest of this
// firmware, and it is why there is no lock here.
static sentry::Transaction gOtaTxn;
static sentry_span_t *gOtaSpan = nullptr;
static bool gOtaTracing = false;

/** Begin tracing an OTA. Safe to call when reporting is off. */
inline void otaBegin() {
    if (gOtaTracing || !sentry_is_enabled() || !clockIsSet()) return;
    gOtaTracing = sentry::transaction_start(gOtaTxn, "firmware update", "device.ota");
    gOtaSpan = nullptr;
}

/** Close the current phase and open the next. */
inline void otaPhase(const char *op) {
    if (!gOtaTracing) return;
    if (gOtaSpan) sentry::span_finish(gOtaSpan);
    gOtaSpan = sentry::start_child(gOtaTxn, op);
}

/** Attach a number to the current phase. */
inline void otaSet(const char *key, int64_t value) {
    if (gOtaTracing) sentry::span_set_attribute(gOtaSpan, key, value);
}

/**
 * Finish and send. MUST be called before esp_restart() on the success path — a reboot is
 * not a flush, and the whole point is measuring the update that just happened.
 */
inline void otaFinish(bool ok) {
    if (!gOtaTracing) return;
    if (gOtaSpan) { sentry::span_finish(gOtaSpan); gOtaSpan = nullptr; }
    gOtaTracing = false;
    sentry::transaction_finish(gOtaTxn);
    (void)ok;
}
#else
// Same shape, no spans in this SDK. `auto *` at the call sites makes the span type moot.
class Operation {
public:
    Operation(const char *, const char *) {}
    void *child(const char *, const char * = nullptr) { return nullptr; }
    void set(void *, const char *, int64_t) {}
    void finish(void *) {}
};
inline void recordBoot(uint32_t) {}
inline void noteFps(uint32_t) {}
inline void recordDisconnect() {}
inline void recordVitals(uint32_t) {}
inline void otaBegin() {}
inline void otaPhase(const char *) {}
inline void otaSet(const char *, int64_t) {}
inline void otaFinish(bool) {}
#endif

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────

/** Load the DSN: whatever the app provisioned, else the build-time one (empty in releases). */
inline void loadDsn() {
    gDsn[0] = '\0';
    Preferences p;
    // Read-write, not read-only: opening a namespace that doesn't exist yet fails, and the
    // Preferences library logs that at ERROR level on every boot of a device that has never
    // been provisioned. Opening it writable creates it once and keeps the console honest.
    if (p.begin(NVS_NAMESPACE, false)) {
        String stored = p.getString(NVS_KEY_DSN, "");
        p.end();
        if (stored.length() > 0 && stored.length() <= SENTRY_MICRO_MAX_DSN_LEN) {
            strncpy(gDsn, stored.c_str(), sizeof(gDsn) - 1);
            gDsn[sizeof(gDsn) - 1] = '\0';
            return;
        }
    }
    strncpy(gDsn, CHROMABAY_SENTRY_DSN, sizeof(gDsn) - 1);
    gDsn[sizeof(gDsn) - 1] = '\0';
}

/**
 * (Re)start the SDK from the currently loaded DSN.
 *
 * Idempotent, because provisioning a DSN over BLE has to be able to bring reporting up on a
 * device that booted without one — the whole point of not baking a key into a public binary.
 */
inline void initSdk() {
    sentry_close();
    loadDsn();
    if (gDsn[0] == '\0') {
        // Say so once. Silence here is indistinguishable from a build with no SDK at all,
        // which makes bringing the relay up on a new device needlessly hard to debug.
        Serial.println("[Sentry] no DSN provisioned yet — connect the app to enable reporting");
        return;
    }

    sentry::Options options;
    options.dsn = gDsn;
    // Plain `fwv0.1.x`, matching the app's `app1.1.x` — one glance tells you which half of
    // the product an issue came from. Must match the string CI registers the release under,
    // or the release has no commits attached to the events reporting it. (It does NOT have
    // to match the debug files: symbolication keys off debug_id, from the GNU build-id.)
    options.release = FIRMWARE_VERSION;
    options.environment = CHROMABAY_SENTRY_ENV;
    options.board = ARDUINO_BOARD;
#ifdef CHROMABAY_SENTRY_DEBUG
    options.debug = true;
#endif

    if (!sentry::init(options)) {
        Serial.println("[Sentry] DSN did not parse; reporting disabled");
        return;
    }
    sentry::set_transport(gTransport);
    gRelayTransport.set_chunk_bytes(RELAY_CHUNK_BYTES);
    // Shorter than the SDK's default: send() blocks the loop task, which is also the task
    // that renders LEDs, so a phone that stops answering must cost a visible hitch rather
    // than a visible freeze.
    gRelayTransport.set_timeout_ms(10000);
    gRelayTransport.set_wait_fn(relayWait);
    gRelayTransport.set_host_attached(gBleConnected);

    // LittleFS rather than NVS deliberately: the nvs partition is 20 KB and already holds
    // the device settings, while the filesystem has room to spare. Never mounts or formats —
    // the caller owns that, so this must run after the mount in setup().
    sentry_enable_buffering(sentry::storage_fs(LittleFS, 8));

    const sentry_device_info_t &dev = sentry::device_info();
    Serial.printf("[Sentry] %s enabled, device %s, last reset: %s, %u queued\n",
                  sentry::sdk_version(), dev.device_id,
                  sentry_reset_reason_name(dev.reset_reason),
                  (unsigned)sentry_buffered_count());
}

/**
 * Start reporting. Call after the filesystem is mounted (the offline buffer lives there) and
 * before anything that might crash — it reads the PREVIOUS boot's reset reason, so whatever
 * reboots ahead of this point is invisible.
 */
inline void begin() { initSdk(); }

/** Create the relay characteristics. Call from the BLE service setup, before start(). */
inline void attachBleService(NimBLEService *service) {
    if (!service) return;
    gRelayTx = service->createCharacteristic(CHARACTERISTIC_UUID_SENTRY_TX,
                                             NIMBLE_PROPERTY::NOTIFY);
    NimBLECharacteristic *rx = service->createCharacteristic(
        CHARACTERISTIC_UUID_SENTRY_RX, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
    rx->setCallbacks(&gRelayRxCallbacks);
    NimBLECharacteristic *config = service->createCharacteristic(
        CHARACTERISTIC_UUID_SENTRY_CONFIG, NIMBLE_PROPERTY::WRITE);
    config->setCallbacks(&gConfigCallbacks);
}

/**
 * Track whichever link the app is on. One that disconnects mid-relay must not be waited on.
 *
 * `host_attached` is the OR of the two, not the last one set: the transport uses it to decide
 * whether waiting for a STATUS frame can possibly be answered, and answering that with the
 * state of a radio the app is not on would strand every queued report.
 */
inline void updateHostAttached() {
    gRelayTransport.set_host_attached(gBleConnected || gWifiConnected);
}
inline void setBleConnected(bool connected) {
    gBleConnected = connected;
    updateHostAttached();
#if CHROMABAY_SENTRY_TRACE
    // The session ended, so the trace it carried has ended too. Anything the device does
    // from here belongs to nobody until the next app connects — which is the whole reason
    // to release rather than keep the last id around.
    if (!connected) gTraceReleasePending = true;
#endif
}
inline void setWifiConnected(bool connected) {
    gWifiConnected = connected;
    updateHostAttached();
}

/**
 * Register the Wi-Fi link: how to write a frame, and how to service its socket.
 *
 * Both, not just the writer — see relayWait(). Call once, from the Wi-Fi transport's setup.
 */
inline void setWifiLink(FrameSink sink, PumpFn pump) { gWifiSink = sink; gWifiPump = pump; }

/**
 * Report the crash the device just came back from, if it was one. Call after begin().
 *
 * Almost always ends up in the offline buffer rather than on the wire: at this point in
 * setup() the app has not connected. That is the design working, not failing — the event
 * survives to the next time it does.
 *
 * Runs at most once per boot, but not necessarily *at* boot. A device that has never met the
 * app has no DSN, so it cannot build an envelope at all, and the crash it just came back from
 * would be dropped on the floor — which is precisely the first crash of a new device, the one
 * most worth having. So this stays armed until reporting is actually enabled, and tick()
 * calls it again the moment the app provisions a DSN.
 */
inline void reportLastBoot() {
    if (gLastBootReported) return;
    if (!sentry_is_enabled()) return;   // still armed; try again once a DSN arrives
    // From here we either report or establish there is nothing to report, and either way
    // this boot is done with the question.
    gLastBootReported = true;

    const sentry_device_info_t &dev = sentry::device_info();
#if CHROMABAY_SENTRY_COREDUMP
    const bool haveCoredump = sentry_coredump_available();
#else
    const bool haveCoredump = false;
#endif
    if (!sentry_reset_reason_is_crash(dev.reset_reason) && !haveCoredump) return;

    char eventId[SENTRY_MICRO_EVENT_ID_LEN];
    sentry_event_t event;
    if (!sentry_event_prepare(&event, eventId)) return;

    event.level = SENTRY_LEVEL_FATAL;

    // The coredump first, because whether we got one decides what there is to say. It turns
    // the event from "it panicked" into an `exception` with a symbolicated backtrace — which
    // is also what Sentry titles the issue from, so an event that has one needs no message
    // of ours competing with it.
#if CHROMABAY_SENTRY_COREDUMP
    sentry_coredump_t coredump;
    const bool attached = sentry_event_attach_coredump(&event, &coredump);
#else
    const bool attached = false;
#endif

    // Only when the dump gave us nothing: a brownout or a watchdog with an empty coredump
    // partition still deserves to be reported, and "Device rebooted: brownout" is the whole
    // of what we know. Attaching it to an event that already carries a stack trace would
    // just add a generic line beside a specific one.
    char message[96];
    snprintf(message, sizeof(message), "Device rebooted: %s",
             sentry_reset_reason_name(dev.reset_reason));
    if (!attached) event.message = message;

    // 2 KB of the setup() stack (the Arduino loop task has 8 KB), released on return.
    uint8_t envelope[SENTRY_MICRO_ENVELOPE_BUFFER_BYTES];
    size_t len = sentry_envelope_write((char *)envelope, sizeof(envelope), &event);
    if (len >= sizeof(envelope)) return;  // nothing usable was written

    Serial.printf("[Sentry] reporting last boot: %s%s\n", message,
                  attached ? " (with backtrace)" : "");
    sentry_response_t response = sentry_send_envelope(envelope, len);

#if CHROMABAY_SENTRY_COREDUMP
    // Only erase once the dump is somewhere durable — delivered, or in the offline buffer.
    // Erasing on a failed send would lose the crash; never erasing would re-report it on
    // every boot forever.
    if (attached && (response.result == SENTRY_SEND_OK || sentry_buffered_count() > 0)) {
        sentry_coredump_erase();
    }
#else
    (void)response;
    (void)attached;
#endif
}

/**
 * Retry anything the buffer is holding. Returns immediately unless something is queued and a
 * route exists, so a healthy device never pays for this.
 *
 * One envelope per attempt: a backlog must not turn into a multi-second stall of the task
 * that also renders the LEDs.
 */
inline void tick(uint32_t nowMs) {
    // Apply a DSN the app wrote since the last loop. Before the enabled check, because this
    // is exactly how a device with no DSN gets one — and it's the only path that can turn
    // reporting on for the first time.
    if (gDsnPending) {
        gDsnPending = false;
        // Only when it actually changed. The app re-sends the DSN on every connect and it is
        // the same string every time; without this each connect cost an NVS write plus a full
        // sentry_close()/init() cycle that reopens the filesystem buffer — during a reconnect
        // storm, dozens of flash writes to store something that never changed.
        if (strcmp(gPendingDsn, gDsn) != 0) {
            Preferences p;
            if (p.begin(NVS_NAMESPACE, false)) {
                p.putString(NVS_KEY_DSN, String(gPendingDsn));
                p.end();
                Serial.printf("[Sentry] DSN %s by app\n",
                              gPendingDsn[0] ? "provisioned" : "cleared");
                initSdk();
                // A first-ever provisioning can be the thing that makes this boot's crash
                // reportable. No-op afterwards — it only runs once per boot.
                reportLastBoot();
            }
        }
    }

    if (!sentry_is_enabled()) return;

#if CHROMABAY_SENTRY_TRACE
    // Staged for this task rather than done in the BLE callback, for the same reason as the
    // DSN: NVS and filesystem work must not run on the NimBLE host task.
    //
    // It used to matter for a second reason, and the history is worth keeping. reportLastBoot()
    // above had to run FIRST, because the SDK recovered the crash's trace from RTC memory into
    // the same slot an adopt would write — so the app connecting to collect a crash report
    // would offer a new trace, that adopt would clobber the one the device actually died in,
    // and the panic would be attached to the connection that came to fetch it. A wrong link
    // that renders exactly like a right one. sentry-micro 0fab55e gives the recovered trace its
    // own slot, so the order no longer changes the answer — but only because that was reported
    // and fixed, not because it was ever safe to assume.
    if (gTraceReleasePending) {
        gTraceReleasePending = false;
        sentry::trace_release();
    }
    if (gTracePending) {
        gTracePending = false;
        onTraceWrite(gPendingTrace);
    }
#endif

    // The app connecting is the event we're waiting for on a BLE-only device — flush then
    // rather than up to 30 s later, so a crash report lands while someone is still looking.
    const bool ready = gRelayTransport.host_ready();
    if (ready != gRelayWasReady) {
        // Log both edges. Whether the phone has announced itself is the single fact that
        // decides if a queued crash can go anywhere, and inferring it from silence cost an
        // afternoon: the device sat on three panics because the app never re-sent HELLO
        // after reconnecting.
        Serial.printf("[Sentry] relay host %s (%u queued)\n", ready ? "ready" : "gone",
                      (unsigned)sentry_buffered_count());
        if (ready) {
            gLastFlushMs = nowMs - FLUSH_INTERVAL_MS;  // deliver now, not in 30s
            gLastFlushDelivered = false;
        }
    }
    gRelayWasReady = ready;

    // Metrics ride sentry_flush(), which this used to reach only when something was
    // buffered — i.e. only after a crash. A healthy device would have accumulated gauges
    // forever and sent none of them. They get their own slow cadence instead: the flush
    // blocks the render loop for as long as the phone takes to answer, so once every few
    // minutes is the right price for numbers that change slowly.
    const bool metricsDue = (nowMs - gLastMetricsMs) >= METRICS_INTERVAL_MS;
    if (metricsDue) {
        gLastMetricsMs = nowMs;
        recordVitals(gLastFpsTimes10);
    }

    if (sentry_buffered_count() == 0 && !metricsDue) return;
    const uint32_t interval = gLastFlushDelivered ? FLUSH_BACKLOG_INTERVAL_MS : FLUSH_INTERVAL_MS;
    if (sentry_buffered_count() > 0 && nowMs - gLastFlushMs < interval) return;
    gLastFlushMs = nowMs;
    uint32_t delivered = sentry_flush(1);
    gLastFlushDelivered = delivered > 0;
    // name() reports whichever route AutoTransport actually selected, so this says `wifi` or
    // `relay` rather than a generic "up" — which is the first thing you want to know when a
    // device that should be relaying through the phone quietly went out over WiFi instead.
    Serial.printf("[Sentry] flush: delivered %u, %u still queued (route: %s)\n",
                  (unsigned)delivered, (unsigned)sentry_buffered_count(),
                  gTransport.is_available() ? gTransport.name() : "none");
}

}  // namespace SentryReporting

#else  // !CHROMABAY_SENTRY — the SDK isn't on the include path.

#include <stdint.h>
class NimBLEService;

namespace SentryReporting {
typedef bool (*FrameSink)(const uint8_t *frame, size_t len);
class Operation {
public:
    Operation(const char *, const char *) {}
    void *child(const char *, const char * = nullptr) { return nullptr; }
    void set(void *, const char *, int64_t) {}
    void finish(void *) {}
};
inline void recordBoot(uint32_t) {}
inline void noteFps(uint32_t) {}
inline void recordDisconnect() {}
inline void recordVitals(uint32_t) {}
inline void otaBegin() {}
inline void otaPhase(const char *) {}
inline void otaSet(const char *, int64_t) {}
inline void otaFinish(bool) {}
inline void begin() {}
inline void attachBleService(NimBLEService *) {}
inline void setBleConnected(bool) {}
inline void setWifiConnected(bool) {}
inline void setWifiLink(FrameSink, void (*)()) {}
inline void onHostFrame(const uint8_t *, size_t) {}
inline void onConfigWrite(const uint8_t *, size_t) {}
inline void reportLastBoot() {}
inline void tick(uint32_t) {}
}  // namespace SentryReporting

#endif  // CHROMABAY_SENTRY
