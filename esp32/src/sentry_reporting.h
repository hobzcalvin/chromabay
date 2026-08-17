#pragma once
//
// Crash + reset-reason reporting through sentry-micro (https://github.com/getsentry/sentry-micro).
//
// The device builds a real Sentry envelope itself and hands the bytes to a transport; the SDK
// owns every Sentry-specific detail (DSN, envelope format, auth header, backoff). Two
// transports are wired up here and chosen automatically per attempt:
//
//   wifi   HTTPS straight to ingest, when the device is in WiFi mode and associated.
//   relay  the phone does it. The device chunks (url, headers, body) over a BLE
//          characteristic and the app performs the request — which is the only route a
//          BLE-mode ChromaBay has, and therefore the one that matters most here.
//
// Neither is usually available at the moment a crash is discovered — that happens in setup(),
// before the radio is up and long before the app connects — so the event is written to the
// LittleFS-backed offline buffer and delivered later by tick().
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

#include <sentry_micro.h>
#include <transport/sentry_transport_relay.hpp>
#include <device/sentry_storage_fs.hpp>
#if CHROMABAY_WIFI
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
static NimBLECharacteristic *gRelayTx = nullptr;
static bool gBleConnected = false;
static bool gRelayWasReady = false;
static uint32_t gLastFlushMs = 0;

// NVS namespace of its own rather than a field on DeviceSettings: the DSN is optional
// diagnostics config, and mixing it into the settings struct would mean touching the
// settings wire format (and its app-side mirror) for something the app already knows.
static const char *NVS_NAMESPACE = "cbaysentry";
static const char *NVS_KEY_DSN = "dsn";

// How often we're willing to spend a blocking send from loop(). Only ever paid when
// something is actually queued — i.e. after a crash — never on a healthy device.
static const uint32_t FLUSH_INTERVAL_MS = 30000;

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
    if (!gRelayTx || !gBleConnected) return false;
    gRelayTx->setValue(const_cast<uint8_t *>(frame), len);
    gRelayTx->notify();
    delay(8);
    return true;
}

static sentry::RelayTransport gRelayTransport(relayWriteFrame);

#if CHROMABAY_WIFI
static sentry::WiFiTransport gWifiTransport;
#endif

/**
 * Picks a route per attempt: WiFi if the device is actually associated, else the phone.
 *
 * The SDK has no auto-select chain of its own yet, so it lives here for now. It belongs in
 * sentry-micro — "WiFi if connected → else a registered relay → else buffer" is in the
 * design, and every adopter with two transports needs exactly this object.
 */
class AutoTransport : public sentry::Transport {
public:
    sentry::Response send(const char *url, const sentry::Headers &headers, const uint8_t *body,
                          size_t len) override {
#if CHROMABAY_WIFI
        if (gWifiTransport.is_available()) return gWifiTransport.send(url, headers, body, len);
#endif
        if (gRelayTransport.is_available()) return gRelayTransport.send(url, headers, body, len);
        return sentry::SEND_UNAVAILABLE;
    }

    bool is_available() override {
#if CHROMABAY_WIFI
        if (gWifiTransport.is_available()) return true;
#endif
        return gRelayTransport.is_available();
    }

    const char *name() const override { return "auto"; }
};

static AutoTransport gTransport;

// ── BLE plumbing ────────────────────────────────────────────────────────────────────────
class RelayRxCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *pCharacteristic) {
        // Runs on the NimBLE host task, possibly while the loop task is blocked inside
        // send() waiting for exactly this frame. on_host_frame() is written for that.
        std::string value = pCharacteristic->getValue();
        gRelayTransport.on_host_frame((const uint8_t *)value.data(), value.length());
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

class SentryConfigCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() > SENTRY_MICRO_MAX_DSN_LEN) return;
        if (!value.empty() && !dsnHostAllowed(value.c_str())) {
            Serial.println("[Sentry] refusing a DSN outside the allowed ingest host");
            return;
        }
        // Stage it and let the loop task do the work, the way every other characteristic in
        // this firmware does: writing NVS and reopening the filesystem buffer from the NimBLE
        // host task would both stall the BLE stack and race the loop task's own file I/O.
        strncpy(gPendingDsn, value.c_str(), sizeof(gPendingDsn) - 1);
        gPendingDsn[sizeof(gPendingDsn) - 1] = '\0';
        gDsnPending = true;
    }
};

static RelayRxCallbacks gRelayRxCallbacks;
static SentryConfigCallbacks gConfigCallbacks;

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
    options.release = "chromabay@" FIRMWARE_VERSION;  // must match the uploaded debug files
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

/** Track the BLE link. An app that disconnects mid-relay must not be waited on. */
inline void setBleConnected(bool connected) {
    gBleConnected = connected;
    gRelayTransport.set_host_attached(connected);
}

/**
 * Report the crash the device just came back from, if it was one. Call after begin().
 *
 * Almost always ends up in the offline buffer rather than on the wire: at this point in
 * setup() the app has not connected and WiFi has not associated. That is the design working,
 * not failing — the event survives to the next time either happens.
 */
inline void reportLastBoot() {
    if (!sentry_is_enabled()) return;

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

    char message[96];
    snprintf(message, sizeof(message), "Device rebooted: %s",
             sentry_reset_reason_name(dev.reset_reason));
    event.level = SENTRY_LEVEL_FATAL;
    event.message = message;

#if CHROMABAY_SENTRY_COREDUMP
    // Turns the event from "it panicked" into a symbolicated backtrace. Sets its own message
    // and level when a dump is present, so the fallback above only ever describes a crash we
    // have nothing better to say about.
    sentry_coredump_t coredump;
    const bool attached = sentry_event_attach_coredump(&event, &coredump);
#endif

    // 2 KB of the setup() stack (the Arduino loop task has 8 KB), released on return.
    uint8_t envelope[SENTRY_MICRO_ENVELOPE_BUFFER_BYTES];
    size_t len = sentry_envelope_write((char *)envelope, sizeof(envelope), &event);
    if (len >= sizeof(envelope)) return;  // nothing usable was written

    Serial.printf("[Sentry] reporting last boot: %s\n", message);
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
        Preferences p;
        if (p.begin(NVS_NAMESPACE, false)) {
            p.putString(NVS_KEY_DSN, String(gPendingDsn));
            p.end();
            Serial.printf("[Sentry] DSN %s by app\n", gPendingDsn[0] ? "provisioned" : "cleared");
            initSdk();
        }
    }

    if (!sentry_is_enabled()) return;

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
        if (ready) gLastFlushMs = nowMs - FLUSH_INTERVAL_MS;  // deliver now, not in 30s
    }
    gRelayWasReady = ready;

    if (sentry_buffered_count() == 0) return;
    if (nowMs - gLastFlushMs < FLUSH_INTERVAL_MS) return;
    gLastFlushMs = nowMs;
    uint32_t delivered = sentry_flush(1);
    Serial.printf("[Sentry] flush: delivered %u, %u still queued (route: %s)\n",
                  (unsigned)delivered, (unsigned)sentry_buffered_count(),
                  gTransport.is_available() ? "up" : "none");
}

}  // namespace SentryReporting

#else  // !CHROMABAY_SENTRY — the SDK isn't on the include path.

#include <stdint.h>
class NimBLEService;

namespace SentryReporting {
inline void begin() {}
inline void attachBleService(NimBLEService *) {}
inline void setBleConnected(bool) {}
inline void reportLastBoot() {}
inline void tick(uint32_t) {}
}  // namespace SentryReporting

#endif  // CHROMABAY_SENTRY
