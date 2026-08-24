#pragma once
// One definition of the control protocol, carried by whichever link is up.
//
// The protocol is a set of characteristics: things the app reads, writes, and gets notified
// about. Bluetooth expresses that natively. Wi-Fi expresses it as [u8 channel][u8 op][payload]
// over a WebSocket. Those are two carriages for ONE protocol, so there is exactly one handler
// per endpoint and it does not know which link called it.
//
// Why this exists: the two used to be written separately — 22 BLE characteristics against a
// hand-maintained enum of 11 Wi-Fi channels and a parallel switch. Every characteristic added
// after that enum was written silently did not exist over Wi-Fi (OTA, layouts, calibration,
// the button, the crash relay). A second source of truth for "what the protocol is" will
// always drift; this file removes it.
//
// Adding an endpoint is one row in the table in main.cpp. Wi-Fi picks it up for free.
#include <Arduino.h>
#include <NimBLEDevice.h>

namespace Endpoints {

// ---- Wi-Fi framing -------------------------------------------------------------------
// The three things BLE can do to a characteristic, so a Wi-Fi message routes into exactly
// the handler its BLE characteristic would have called.
enum Op : uint8_t {
    OP_WRITE = 0x00, // app → device: the bytes a BLE write would have carried
    OP_READ  = 0x01, // app → device: "send me your value"
    OP_VALUE = 0x02, // device → app: a read reply OR an unsolicited notify
};

/**
 * A characteristic's Wi-Fi channel is DERIVED from its UUID: the low byte of the first group.
 * Every ChromaBay characteristic is a0be83XX-8dc9-47f0-ab40-b19721d20ed1, so XX identifies it
 * and both ends compute the same number from the same string. Nothing to assign, nothing to
 * keep in step — this is what makes Wi-Fi inherit new characteristics automatically.
 * Returns 0 if the UUID is not in that family (rejected at startup, see attachBle).
 */
inline uint8_t channelForUuid(const char *uuid) {
    if (!uuid || strlen(uuid) < 8) return 0;
    if (strncmp(uuid, "a0be83", 6) != 0) return 0;
    auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    int hi = hex(uuid[6]), lo = hex(uuid[7]);
    if (hi < 0 || lo < 0) return 0;
    return (uint8_t)((hi << 4) | lo);
}

// ---- Links ---------------------------------------------------------------------------
// What a handler answers through. It never learns which one it has.
struct Link {
    virtual ~Link() {}
    virtual void send(const uint8_t *data, size_t len) = 0;
    void send(const String &s) { send((const uint8_t *)s.c_str(), s.length()); }
    void sendEmpty() { send((const uint8_t *)nullptr, 0); }
};

// Handlers. onWrite gets the payload; onRead is asked to produce the value.
using WriteFn = void (*)(const uint8_t *data, size_t len, Link &link);
using ReadFn  = void (*)(Link &link);

struct Endpoint {
    const char *uuid;
    uint32_t    props;    // NIMBLE_PROPERTY::* — also tells Wi-Fi whether a read is meaningful
    WriteFn     onWrite;  // nullptr if the endpoint is not writable
    ReadFn      onRead;   // nullptr if the endpoint has no readable value
};

// ---- Wiring --------------------------------------------------------------------------

// The Wi-Fi transport registers how to put a frame on the wire. Returns false when no client
// is connected, which is how notify() knows to skip it.
using WifiSendFn = bool (*)(uint8_t channel, uint8_t op, const uint8_t *data, size_t len);

namespace detail {
inline const Endpoint *gTable = nullptr;
inline size_t gCount = 0;
inline WifiSendFn gWifiSend = nullptr;
// UUID → characteristic, for notify(). Small and fixed; a linear scan is cheaper than a map.
inline NimBLECharacteristic *gChars[40] = {nullptr};

inline const Endpoint *find(const char *uuid) {
    for (size_t i = 0; i < gCount; i++)
        if (strcasecmp(gTable[i].uuid, uuid) == 0) return &gTable[i];
    return nullptr;
}
inline const Endpoint *findByChannel(uint8_t ch) {
    for (size_t i = 0; i < gCount; i++)
        if (channelForUuid(gTable[i].uuid) == ch) return &gTable[i];
    return nullptr;
}
inline int indexOf(const char *uuid) {
    for (size_t i = 0; i < gCount; i++)
        if (strcasecmp(gTable[i].uuid, uuid) == 0) return (int)i;
    return -1;
}
} // namespace detail

inline void install(const Endpoint *table, size_t count) {
    detail::gTable = table;
    detail::gCount = count;
}
inline void setWifiSender(WifiSendFn fn) { detail::gWifiSend = fn; }

// Answers over BLE. During a read the value must simply be set (NimBLE returns it); at any
// other time the same "here is the value" means a notification.
struct BleLink : Link {
    NimBLECharacteristic *ch;
    bool inRead;
    BleLink(NimBLECharacteristic *c, bool r) : ch(c), inRead(r) {}
    void send(const uint8_t *data, size_t len) override {
        if (!ch) return;
        ch->setValue((uint8_t *)data, len);
        if (!inRead) ch->notify();
    }
};

// Answers over Wi-Fi. Always a VALUE frame on the endpoint's channel — the app resolves it
// against a pending read if it has one, exactly as BLE cannot distinguish the two either.
struct WsLink : Link {
    uint8_t channel;
    explicit WsLink(uint8_t c) : channel(c) {}
    void send(const uint8_t *data, size_t len) override {
        if (detail::gWifiSend) detail::gWifiSend(channel, OP_VALUE, data, len);
    }
};

/**
 * Push a value to whoever is listening, without being asked: OTA progress, a button gesture,
 * a brightness change made by the device itself.
 *
 * This is the other half of the old duplication — every such push had to remember to poke the
 * BLE characteristic AND the Wi-Fi client, and the Wi-Fi half was usually missing. One call
 * now reaches whichever link is up.
 */
inline void notify(const char *uuid, const uint8_t *data, size_t len) {
    int i = detail::indexOf(uuid);
    if (i >= 0 && detail::gChars[i]) {
        detail::gChars[i]->setValue((uint8_t *)data, len);
        detail::gChars[i]->notify();
    }
    if (detail::gWifiSend) detail::gWifiSend(channelForUuid(uuid), OP_VALUE, data, len);
}
inline void notify(const char *uuid, const String &s) {
    notify(uuid, (const uint8_t *)s.c_str(), s.length());
}
inline void notify(const char *uuid, const char *s) {
    notify(uuid, (const uint8_t *)s, strlen(s));
}

/** The BLE characteristic for an endpoint, or nullptr on a Wi-Fi boot (there is no BLE). */
inline NimBLECharacteristic *characteristicFor(const char *uuid) {
    int i = detail::indexOf(uuid);
    return i >= 0 ? detail::gChars[i] : nullptr;
}

/** Send only over Wi-Fi. For pushes whose BLE half is handled elsewhere (the crash relay,
 *  which paces its own notifications). Returns false when no Wi-Fi client is attached. */
inline bool sendWifi(const char *uuid, const uint8_t *data, size_t len) {
    if (!detail::gWifiSend) return false;
    return detail::gWifiSend(channelForUuid(uuid), OP_VALUE, data, len);
}

/** Set a characteristic's stored value without notifying (BLE reads answer from it). */
inline void setValue(const char *uuid, const uint8_t *data, size_t len) {
    int i = detail::indexOf(uuid);
    if (i >= 0 && detail::gChars[i]) detail::gChars[i]->setValue((uint8_t *)data, len);
}
inline void setValue(const char *uuid, const String &s) {
    setValue(uuid, (const uint8_t *)s.c_str(), s.length());
}

// ---- BLE side ------------------------------------------------------------------------
// One callbacks object for every characteristic: it finds the endpoint by UUID and calls the
// shared handler. There are no per-characteristic callback classes any more.
class TableCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *c) override {
        const Endpoint *e = detail::find(c->getUUID().toString().c_str());
        if (!e || !e->onWrite) return;
        std::string v = c->getValue();
        BleLink link(c, /*inRead=*/false);
        e->onWrite((const uint8_t *)v.data(), v.length(), link);
    }
    void onRead(NimBLECharacteristic *c) override {
        const Endpoint *e = detail::find(c->getUUID().toString().c_str());
        if (!e || !e->onRead) return;
        BleLink link(c, /*inRead=*/true);
        e->onRead(link);
    }
};

/** Create every characteristic in the table on `service`. */
inline void attachBle(NimBLEService *service) {
    static TableCallbacks callbacks;
    for (size_t i = 0; i < detail::gCount && i < 40; i++) {
        const Endpoint &e = detail::gTable[i];
        // A UUID outside the family has no Wi-Fi channel, so it would be BLE-only — the exact
        // asymmetry this file exists to prevent. Fail loudly at boot rather than silently.
        if (channelForUuid(e.uuid) == 0) {
            Serial.printf("[Endpoints] FATAL: %s is not a0be83XX-… and cannot be carried over Wi-Fi\n", e.uuid);
            continue;
        }
        NimBLECharacteristic *c = service->createCharacteristic(e.uuid, e.props);
        detail::gChars[i] = c;
        if (c && (e.onWrite || e.onRead)) c->setCallbacks(&callbacks);
    }
    Serial.printf("[Endpoints] %u endpoints on BLE\n", (unsigned)detail::gCount);
}

// ---- Wi-Fi side ----------------------------------------------------------------------
/** Route one Wi-Fi message into the same handler its BLE characteristic would have called. */
inline void dispatchWifi(uint8_t channel, uint8_t op, const uint8_t *data, uint32_t len) {
    const Endpoint *e = detail::findByChannel(channel);
    if (!e) { Serial.printf("[Endpoints] unknown channel %u\n", channel); return; }
    WsLink link(channel);
    if (op == OP_READ) {
        if (e->onRead) e->onRead(link);
        else Serial.printf("[Endpoints] channel %u is not readable\n", channel);
    } else if (op == OP_WRITE) {
        if (e->onWrite) e->onWrite(data, len, link);
        else Serial.printf("[Endpoints] channel %u is not writable\n", channel);
    }
}

} // namespace Endpoints
