#include "pattern_renderer_base.h"
#include <Arduino.h>
#include <new> // std::nothrow
#include <cstring> // strcmp (operator-type compare for state-preserving pattern updates)
#include "esp_heap_caps.h" // largest contiguous block — the number that decides a crossfade

// What a string parameter value means depends on the parameter it lands on. Mirrors the WASM
// bindings so the preview and the device agree:
//
//  - SELECT: the value is the integer option index, read with getInt(). New patterns send an
//    int directly; tolerate a string here too — a numeric index ("2") or a label ("Multiply").
//  - COLOR: the value is "#rrggbb", the same spelling the operator metadata reports for the
//    default. Without this it stayed a STRING, getColor() saw the wrong type and handed back
//    the default, and a colour param picked in the app rendered white on the device forever.
//  - anything else: the raw string.
static ParameterValue valueForString(const ParameterInfo& info, const char* value) {
    if (info.type == ParameterInfo::COLOR) {
        const char* h = (value[0] == '#') ? value + 1 : value;
        uint32_t rgb = 0;
        int n = 0;
        for (; n < 6 && h[n]; n++) {
            char c = h[n];
            int d = (c >= '0' && c <= '9') ? c - '0'
                  : (c >= 'a' && c <= 'f') ? c - 'a' + 10
                  : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
            if (d < 0) break;
            rgb = (rgb << 4) | (uint32_t)d;
        }
        if (n != 6) return info.defaultValue;  // not a colour we can read — keep the default
        return ParameterValue(CRGB((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF));
    }
    if (info.type == ParameterInfo::SELECT) {
        bool numeric = value[0] != '\0';
        for (const char* p = value; *p; ++p) if (*p < '0' || *p > '9') { numeric = false; break; }
        if (numeric) return ParameterValue((int)atoi(value));
        for (size_t i = 0; i < info.options.size(); i++) {
            if (info.options[i] == value) return ParameterValue((int)i);
        }
        return ParameterValue((int)0);
    }
    return ParameterValue(std::string(value));
}

// Read a msgpack string node in FULL. The param-value reads below used a fixed
// char[32], which silently truncated long STRING params — an SVG-fill encoded path
// (~300-465 chars) became 31 chars of garbage, the operator's decode failed, and it
// fell back to its default shape (a heart). SELECT labels are short, so the length
// only matters for free STRING params like the SVG path.
static std::string mpackFullStr(mpack_node_t node) {
    size_t len = mpack_node_strlen(node);
    const char* p = mpack_node_str(node);
    return (p && len) ? std::string(p, len) : std::string();
}

// PatternRendererBase implementation using native operators
PatternRendererBase::PatternRendererBase(LedConfig::LedManager* ledMgr) 
    : ledManager(ledMgr), buffers(nullptr), lastFrameTime(0), frameStartTime(0), globalTime(0), hasPattern(false) {
    
    initializeFromLedConfig();
}

PatternRendererBase::~PatternRendererBase() {
    deallocateBuffers();
}

void PatternRendererBase::allocateBuffers() {
    if (buffersAllocated) {
        deallocateBuffers();
    }
    
    uint32_t totalPixels = getTotalPixels();
    if (totalPixels == 0) {
        Serial.println("PatternRenderer: refusing to allocate 0-pixel buffers");
        return; // buffersAllocated stays false; update()/render() bail via their guards
    }

    buffers = new CRGB*[NUM_BUFFERS];
    for (int i = 0; i < NUM_BUFFERS; i++) {
        buffers[i] = new (std::nothrow) CRGB[totalPixels];
        if (!buffers[i]) {
            // Out of memory — the configured matrix is too large for available
            // RAM. Roll back instead of writing into a null/short buffer (which
            // would corrupt the heap once operators render width*height pixels).
            Serial.printf("PatternRenderer: failed to allocate %u-pixel buffer (out of memory)\n",
                          (unsigned)totalPixels);
            for (int k = 0; k < i; k++) delete[] buffers[k];
            delete[] buffers;
            buffers = nullptr;
            return; // buffersAllocated stays false
        }
        for (uint32_t j = 0; j < totalPixels; j++) {
            buffers[i][j] = CRGB::Black;
        }
    }
    buffersAllocated = true;
}

uint32_t PatternRendererBase::bufferBytes() const {
    if (!buffersAllocated) return 0;
    uint32_t bytes = (uint32_t)NUM_BUFFERS * getTotalPixels() * (uint32_t)sizeof(CRGB);
    bytes += fadeBufferPixels * (uint32_t)sizeof(CRGB); // released alongside them
    return bytes;
}

void PatternRendererBase::releaseBuffers() {
    if (!buffersAllocated) return;
    deallocateBuffers();
}

// The crossfade hold buffer, sized like any other lane. Kept once allocated: a device that
// crossfades does it on every cycle boundary, and allocating/freeing a full-grid contiguous
// block every interval is exactly the churn that fragments the heap. deallocateBuffers()
// gives it back with the rest, so an OTA still gets all of it.
//
// Asking for it is gated on the LARGEST CONTIGUOUS BLOCK, not on free heap, and not on
// whether the allocation happens to succeed. Succeeding is the dangerous case: on a big
// grid this buffer is tens of KB of contiguous DRAM, and there is no PSRAM here — so a
// crossfade that quietly takes the last large block leaves a pattern upload, a ledmap or a
// WebSocket frame reserve to fail instead, and those are the control path. A dissolve is a
// luxury; it yields to them rather than competing with them.
//
// A fixed slice of headroom rather than a fraction of the block, for the reason the
// WebSocket reader already documents: mid-pressure the largest block is small enough that
// "half" refuses allocations that would have fit comfortably.
static const uint32_t FADE_ALLOC_HEADROOM = 16384; // room left for a pattern/ledmap upload

bool PatternRendererBase::ensureFadeBuffer() {
    // The lanes have to exist for there to be anything to fade. This also means a released
    // set of buffers (an update in flight) can never be re-grown into by a crossfade —
    // enforced here rather than trusting the caller's OTA gate to stay where it is.
    if (!buffersAllocated) return false;

    uint32_t totalPixels = getTotalPixels();
    if (totalPixels == 0) return false;
    if (fadeBuffer && fadeBufferPixels == totalPixels) return true;
    releaseFadeBuffer();

    const uint32_t need = totalPixels * (uint32_t)sizeof(CRGB);
    const uint32_t largest =
        heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (need + FADE_ALLOC_HEADROOM > largest) {
        // Warn once, not on every cycle boundary: while memory stays tight this is asked
        // and refused every interval, and a line a minute forever buries everything else.
        if (!fadeLowMemoryWarned) {
            fadeLowMemoryWarned = true;
            Serial.printf("PatternRenderer: crossfade wants %u bytes, largest free block is %u "
                          "— cutting instead until there is room\n",
                          (unsigned)need, (unsigned)largest);
        }
        return false;
    }

    fadeBuffer = new (std::nothrow) CRGB[totalPixels];
    if (!fadeBuffer) {
        // Passed the headroom check and still failed — the heap moved under us. Same
        // outcome: cut. Better a hard switch than a failed render.
        if (!fadeLowMemoryWarned) {
            fadeLowMemoryWarned = true;
            Serial.printf("PatternRenderer: no memory for a %u-pixel crossfade buffer; cutting instead\n",
                          (unsigned)totalPixels);
        }
        return false;
    }
    fadeLowMemoryWarned = false; // room came back; say so if it goes away again
    fadeBufferPixels = totalPixels;
    return true;
}

void PatternRendererBase::releaseFadeBuffer() {
    delete[] fadeBuffer;
    fadeBuffer = nullptr;
    fadeBufferPixels = 0;
}

void PatternRendererBase::reacquireBuffers() {
    if (buffersAllocated) return;
    allocateBuffers();
}

void PatternRendererBase::deallocateBuffers() {
    endCrossfade();          // the outgoing graph renders into these lanes; it can't outlive them
    releaseFadeBuffer();
    if (buffersAllocated && buffers) {
        for (int i = 0; i < NUM_BUFFERS; i++) {
            delete[] buffers[i];
        }
        delete[] buffers;
        buffers = nullptr;
        buffersAllocated = false;
    }
}

uint16_t PatternRendererBase::getMatrixWidth() const {
    if (!ledManager || ledManager->getNumStrips() == 0) return 8; // Default fallback

    // Multiple strips MIRROR the same pattern (see render()): the canvas is sized to
    // the widest strip, and each strip samples the full canvas independently. Using
    // the max (not strip 0) keeps the canvas stable when a smaller strip is added or
    // removed, so strips don't share a coordinate space.
    if (ledManager->getNumStrips() > 1) {
        uint16_t maxW = 0;
        for (size_t i = 0; i < ledManager->getNumStrips(); i++) {
            const LedConfig::LedBus* s = ledManager->getStrip(i);
            if (!s) continue;
            uint16_t w = s->effectiveWidth(); // layout's virtual matrix, else configured/linear
            if (w > maxW) maxW = w;
        }
        return maxW > 0 ? maxW : 8;
    }

    const LedConfig::LedBus* strip = ledManager->getStrip(0);
    if (!strip) return 8; // Default fallback
    if (strip->hasLayout()) return strip->layoutWidth();

    const auto& config = strip->getConfig();
    if (config.width > 0) {
        return config.width;
    } else {
        // Linear strip (no matrix dimensions): treat it as a 1 x numLeds row so
        // every LED is driven. The previous sqrt(numLeds) "square" left the tail
        // LEDs of any non-perfect-square strip permanently dark (e.g. 300 LEDs
        // rendered as 17x17 = 289, leaving 11 dark) and folded a 2D image onto a
        // 1D strip, which isn't meaningful anyway.
        return config.numLeds;
    }
}

uint16_t PatternRendererBase::getMatrixHeight() const {
    if (!ledManager || ledManager->getNumStrips() == 0) return 8; // Default fallback

    // Mirror multi-strip mode: canvas height is the tallest strip (see getMatrixWidth).
    if (ledManager->getNumStrips() > 1) {
        uint16_t maxH = 0;
        for (size_t i = 0; i < ledManager->getNumStrips(); i++) {
            const LedConfig::LedBus* s = ledManager->getStrip(i);
            if (!s) continue;
            uint16_t h = s->effectiveHeight();
            if (h > maxH) maxH = h;
        }
        return maxH > 0 ? maxH : 1;
    }

    const LedConfig::LedBus* strip = ledManager->getStrip(0);
    if (!strip) return 8; // Default fallback
    if (strip->hasLayout()) return strip->layoutHeight();

    const auto& config = strip->getConfig();
    if (config.height > 0) {
        return config.height;
    } else {
        // Linear strip: a single row (see getMatrixWidth). totalPixels then
        // equals numLeds and the strip is driven 1:1.
        return 1;
    }
}

uint32_t PatternRendererBase::getTotalPixels() const {
    // uint32 so width*height can't overflow a uint16 for larger matrices
    // (e.g. 300x300 = 90000) — truncation there sized buffers far too small and
    // let operators write past them (heap corruption).
    return (uint32_t)getMatrixWidth() * (uint32_t)getMatrixHeight();
}

void PatternRendererBase::initializeFromLedConfig() {
    if (!ledManager || ledManager->getNumStrips() == 0) {
        Serial.println("PatternRenderer: No LED strips available");
        return;
    }
    
    const LedConfig::LedBus* strip = ledManager->getStrip(0);
    if (!strip) {
        Serial.println("PatternRenderer: Strip 0 not available");
        return;
    }
    
    const auto& config = strip->getConfig();
    uint16_t width = getMatrixWidth();
    uint16_t height = getMatrixHeight();
    uint32_t pixels = getTotalPixels();
    
    if (config.width > 0 && config.height > 0) {
        Serial.printf("PatternRenderer: Matrix mode %dx%d (%d pixels)\n", width, height, pixels);
    } else {
        Serial.printf("PatternRenderer: Linear mode, using %dx%d matrix (%d of %d pixels)\n", 
                     width, height, pixels, config.numLeds);
    }
    
    allocateBuffers();
}

void PatternRendererBase::updateMatrixConfig() {
    initializeFromLedConfig();
    // Clear all buffers after reallocation
    for (int i = 0; i < NUM_BUFFERS; i++) {
        clearBuffer(i);
    }
}

void PatternRendererBase::clearBuffer(int bufferIndex) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS || !buffersAllocated) return;
    
    uint32_t totalPixels = getTotalPixels();
    for (uint32_t i = 0; i < totalPixels; i++) {
        buffers[bufferIndex][i] = CRGB::Black;
    }
}

CRGB* PatternRendererBase::getBufferPtr(int bufferIndex) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS || !buffersAllocated) return nullptr;
    return buffers[bufferIndex];
}

const CRGB* PatternRendererBase::getBuffer(int bufferIndex) const {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS || !buffersAllocated) return nullptr;
    return buffers[bufferIndex];
}

void PatternRendererBase::setPattern(Pattern&& pattern) {
    // An armed crossfade turns this from a replacement into a dissolve: the pattern that is
    // showing becomes the OUTGOING graph — moved, not copied, so it keeps the very operator
    // instances it has been running, and a Fire or Moving-Blobs fades out still burning
    // rather than restarting for its own funeral.
    //
    // The state-preserving path below is deliberately skipped: the outgoing graph owns those
    // operators now, and the incoming pattern needs its own. A crossfade is always between
    // two different library entries anyway, so there was nothing to preserve.
    if (fadeArmed) {
        fadeArmed = false;
        if (hasPattern && !currentPattern.nodes.empty() && !pattern.nodes.empty()) {
            // Both graphs have to be in place before the plan can look at them, so move
            // first and decide after.
            outgoingPattern = std::move(currentPattern);
            hasOutgoing = true;
            currentPattern = std::move(pattern);
            hasPattern = true;
            if (!fadeOp) fadeOp = OperatorRegistry::getInstance().createOperator("blend");
            if (fadeOp && planCrossfade()) {
                fadeActive = true;
                fadeProgress = 0.0f;
                Serial.printf("Pattern set: %u node(s), crossfading (%s)\n",
                              (unsigned)currentPattern.nodes.size(),
                              fadeHoldLane >= 0 ? "held in a spare lane" : "held in the extra buffer");
            } else {
                // No blend operator, or all six lane slots spoken for and no memory for the
                // fourth buffer. Cut, which is what cycling did before this existed.
                endCrossfade();
                Serial.printf("Pattern set: %u node(s), cut in (crossfade unavailable)\n",
                              (unsigned)currentPattern.nodes.size());
            }
            return;
        }
        endCrossfade(); // nothing to fade from — fall through and just set the pattern
    }

    // Not a cycle step — a live push from the app, or a boot restore. "Here's your pattern
    // now" means now: abandon any dissolve still in flight rather than blending the new
    // pattern in from a frame the user has already moved on from.
    endCrossfade();

    // If the incoming pattern has the SAME structure as the current one (same operator
    // types + same buffer wiring — only parameters differ), reuse the existing operator
    // instances so STATEFUL operators don't reset. The app resends the whole pattern on
    // every parameter change, so without this a Fire/Moving-Blobs slider nudge restarts
    // the simulation from scratch.
    bool preserved = false;
    if (hasPattern && currentPattern.nodes.size() == pattern.nodes.size() && !pattern.nodes.empty()) {
        bool same = true;
        for (size_t i = 0; i < pattern.nodes.size(); i++) {
            const PatternNode& a = currentPattern.nodes[i];
            const PatternNode& b = pattern.nodes[i];
            if (!a.op || !b.op ||
                a.inputBuffer != b.inputBuffer ||
                a.outputBuffer != b.outputBuffer ||
                a.secondInputBuffer != b.secondInputBuffer ||
                strcmp(a.op->getName(), b.op->getName()) != 0) {
                same = false;
                break;
            }
        }
        if (same) {
            // Move the existing (stateful) operators into the new pattern, keeping its
            // freshly-parsed parameters/wiring. The just-created operators in `pattern`
            // are discarded.
            for (size_t i = 0; i < pattern.nodes.size(); i++) {
                pattern.nodes[i].op = std::move(currentPattern.nodes[i].op);
                // Carry modulator phase state so a live period/speed change stays continuous
                // on-device (the app resends the whole pattern on every tweak).
                auto& oldMods = currentPattern.nodes[i].modulators;
                auto& newMods = pattern.nodes[i].modulators;
                for (size_t j = 0; j < newMods.size() && j < oldMods.size(); j++) {
                    newMods[j].st = oldMods[j].st;
                }
            }
            preserved = true;
        }
    }

    currentPattern = std::move(pattern);
    hasPattern = true;
    Serial.printf("Pattern set: %u node(s), operator state %s\n",
                  (unsigned)currentPattern.nodes.size(), preserved ? "PRESERVED" : "fresh");
}

void PatternRendererBase::clearPattern() {
    endCrossfade();
    hasPattern = false;
    currentPattern.nodes.clear();
}

void PatternRendererBase::armCrossfade(unsigned long startTime, uint32_t durationMs) {
    if (durationMs == 0) { cancelCrossfade(); return; }
    fadeArmed = true;
    fadeStartTime = startTime;
    fadeDurationMs = durationMs;
}

void PatternRendererBase::cancelCrossfade() {
    fadeArmed = false;
    endCrossfade();
}

// Drop the outgoing graph. The hold buffer is kept (see ensureFadeBuffer) — the next cycle
// boundary wants it again, and re-allocating a full-grid block every interval is the churn
// this avoids. deallocateBuffers() is what actually gives it back.
void PatternRendererBase::endCrossfade() {
    fadeActive = false;
    fadeProgress = 0.0f;
    fadeHoldLane = -1;
    fadeHoldIsIncoming = false;
    if (hasOutgoing) {
        outgoingPattern.nodes.clear();
        hasOutgoing = false;
    }
}

unsigned long PatternRendererBase::getCurrentTime() {
    if (useSyncedTime) {
        // Calculate elapsed time since sync point using local millis()
        unsigned long currentLocalTime = millis();
        unsigned long elapsedTime = currentLocalTime - syncedLocalTime;
        return syncedBaseTime + elapsedTime;
    } else {
        // Fall back to local time if no sync received
        return millis();
    }
}

void PatternRendererBase::setSynchronizedTime(unsigned long syncTimestamp, unsigned long localTime) {
    syncedBaseTime = syncTimestamp;
    syncedLocalTime = localTime;
    useSyncedTime = true;
    Serial.printf("PatternRenderer: Sync time set - base: %lu, local: %lu\n", syncTimestamp, localTime);
}

void PatternRendererBase::clearSynchronizedTime() {
    useSyncedTime = false;
    syncedBaseTime = 0;
    syncedLocalTime = 0;
    Serial.println("PatternRenderer: Synchronized time cleared");
}

void PatternRendererBase::update() {
    if (!hasPattern || !buffersAllocated) return;
    
    unsigned long currentTime = getCurrentTime(); // Use synchronized time if available
    frameStartTime = currentTime;
    
    if (lastFrameTime == 0) {
        lastFrameTime = currentTime;
    }
    
    unsigned long deltaTime = currentTime - lastFrameTime;
    globalTime = currentTime;
    
    // Capture the frame's time ONCE here. render() runs the operator graph per strip,
    // and every strip must render the same instant. Keep it float-friendly (large ms
    // lose float precision): 1M ms ≈ 16.67 min cycle.
    frameFloatTime = globalTime % 1000000;
    frameFloatDelta = deltaTime;

    lastFrameTime = currentTime;

    // Advance the dissolve on the same clock the cycle boundary was measured against, so
    // devices that share a time sync are at the same point in the fade on the same frame.
    if (fadeActive) {
        long elapsed = (long)(currentTime - fadeStartTime); // signed: a sync can move the clock back
        if (fadeDurationMs == 0 || elapsed >= (long)fadeDurationMs) {
            // Fully arrived. Ending the fade here means this frame renders the incoming
            // graph alone, which is what progress 1.0 composites to anyway — and stops the
            // device paying for two graphs a frame longer than it has to.
            endCrossfade();
        } else {
            fadeProgress = (elapsed <= 0) ? 0.0f : ((float)elapsed / (float)fadeDurationMs);
        }
    }
}

void PatternRendererBase::renderGraphAt(const Pattern& pattern, uint16_t width, uint16_t height,
                                       const LaneAssignment* lanes) {
    // Run every operator node into the shared buffers at the given canvas size.
    const size_t totalPixels = (size_t)width * (size_t)height;
    // An assignment is indexed by node, so one built for a different graph would read off the
    // end of it. Cheap to rule out, and the alternative is corrupting memory.
    if (lanes && lanes->out.size() != pattern.nodes.size()) lanes = nullptr;
    for (size_t idx = 0; idx < pattern.nodes.size(); idx++) {
        const PatternNode& node = pattern.nodes[idx];
        if (!node.op) continue;
        // A re-packed graph runs on lanes other than the ones it was drawn on. The
        // connections are identical, and the connections are the whole of what it means.
        const int inLane   = lanes ? (int)lanes->in1[idx] : node.inputBuffer;
        const int in2Lane  = lanes ? (int)lanes->in2[idx] : node.secondInputBuffer;
        const int outLane  = lanes ? (int)lanes->out[idx] : node.outputBuffer;
        CRGB* inputBuffer1 = (inLane  >= 0) ? getBufferPtr(inLane)  : nullptr;
        CRGB* inputBuffer2 = (in2Lane >= 0) ? getBufferPtr(in2Lane) : nullptr;
        CRGB* outputBuffer = getBufferPtr(outLane);
        if (!outputBuffer) continue;

        // A same-lane chain makes the output buffer alias an input. Spatial operators
        // (scroll/mirror/tile/glitch) must not render in-place — they'd read pixels they
        // already overwrote. Render into the scratch buffer, then copy back to the lane.
        bool aliases = (outLane == inLane) || (outLane == in2Lane);
        CRGB* renderOut = aliases ? getBufferPtr(SCRATCH_BUFFER) : outputBuffer;
        if (!renderOut) renderOut = outputBuffer; // scratch unavailable -> in-place fallback

        // Apply parameter automation (LFO/noise/random) over a reused copy of the base values.
        // Each modulator carries a per-instance seed (from the app: node id + param name) so
        // simultaneous Random/Perlin automations decorrelate. Same math + clock + seed as the
        // WASM preview (native/Modulation.h), so device and app agree.
        const std::vector<ParameterValue>* params = &node.parameters;
        if (!node.modulators.empty()) {
            _effParams = node.parameters;
            for (size_t i = 0; i < node.modulators.size() && i < _effParams.size(); i++) {
                const ParamModulator& md = node.modulators[i];
                if (!md.active) continue;
                float v = Modulation::modulate(md.st, md.shape, md.mn, md.mx, md.period, frameFloatTime, md.seed);
                _effParams[i] = md.isInt ? ParameterValue((int)lroundf(v)) : ParameterValue(v);
            }
            params = &_effParams;
        }

        node.op->render(inputBuffer1, inputBuffer2, renderOut,
                        width, height, frameFloatTime, frameFloatDelta, *params);

        if (renderOut != outputBuffer) {
            memcpy(outputBuffer, renderOut, totalPixels * sizeof(CRGB));
        }
    }
}

// Feed a Pattern to the lane re-packer (lane_repack.h), which is deliberately ignorant of
// Pattern, FastLED and Arduino so it can be tested on a host.
static bool repackPattern(const Pattern& pattern, uint8_t allowedMask, LaneAssignment& plan) {
    const size_t n = pattern.nodes.size();
    if (n == 0) return false;
    std::vector<int> in1(n), in2(n), out(n);
    for (size_t i = 0; i < n; i++) {
        // renderGraphAt skips a node with no operator, which would make the value flow the
        // re-packer derives a fiction. Patterns never load such a node; refuse if one exists.
        if (!pattern.nodes[i].op) return false;
        in1[i] = pattern.nodes[i].inputBuffer;
        in2[i] = pattern.nodes[i].secondInputBuffer;
        out[i] = pattern.nodes[i].outputBuffer;
    }
    return repackLanes(in1.data(), in2.data(), out.data(), n, pattern.outputBuffer, allowedMask, plan);
}

// Settle, once per crossfade, how the two graphs will share the lanes.
//
// One graph's frame is parked in a lane; the other is re-packed onto the two that remain.
// Which lane is parked in is arbitrary — the other graph is being re-packed around it either
// way — so park in the first graph's OWN output lane, and the copy to get it there disappears
// as well. Try the natural order first (outgoing parked, incoming second), then the other,
// because it is whichever graph runs second that has to fit in two lanes.
bool PatternRendererBase::planCrossfade() {
    for (int attempt = 0; attempt < 2; attempt++) {
        const bool holdIncoming = (attempt == 1);
        const Pattern& first  = holdIncoming ? currentPattern  : outgoingPattern;
        const Pattern& second = holdIncoming ? outgoingPattern : currentPattern;
        int lane = first.outputBuffer;
        if (lane < 0 || lane > 2) lane = 0;
        const uint8_t allowed = (uint8_t)(0x07u & ~(1u << lane));
        if (repackPattern(second, allowed, fadeSecondLanes)) {
            fadeHoldLane = lane;
            fadeHoldIsIncoming = holdIncoming;
            fadeSecondRepacked = true;
            return true;
        }
    }

    // Neither graph fits in two lanes: both keep three values alive at once, which no
    // ordering or re-packing can reduce. This is the case that needs a fourth frame's worth
    // of memory, and the only one that does.
    fadeHoldLane = -1;
    fadeHoldIsIncoming = false;
    fadeSecondRepacked = false;
    return ensureFadeBuffer();
}

// Render both graphs for one canvas size and composite the dissolve between them.
//
// This is the joined graph the crossfade is described as — the two patterns feeding a Blend
// node — evaluated in the order that lets them share the lanes they were already wired to.
// One graph runs, its frame is parked in a lane the other never touches, the other runs
// exactly as it would alone, and the blend composites them. Nothing is remapped and nothing
// needs restoring afterwards.
const CRGB* PatternRendererBase::renderCrossfadeAt(uint16_t width, uint16_t height) {
    const uint32_t totalPixels = (uint32_t)width * (uint32_t)height;

    // Which graph is held and which runs second was settled at planCrossfade(). Holding the
    // incoming one is not a special case in the rendering, only in the blend's direction.
    const Pattern& first  = fadeHoldIsIncoming ? currentPattern  : outgoingPattern;
    const Pattern& second = fadeHoldIsIncoming ? outgoingPattern : currentPattern;

    // Where the first graph's frame waits: a lane the re-packed second graph was kept out
    // of, or the hold buffer when neither graph could be packed into two lanes. The second
    // graph cannot read it by accident either — the re-packer refuses any graph that reads a
    // lane it has not written itself, so it can never sample the frame parked beside it.
    CRGB* held = (fadeHoldLane >= 0) ? getBufferPtr(fadeHoldLane) : fadeBuffer;
    if (!held) return nullptr;

    // 1. The graph whose frame is held. Park it — already in place if it rendered there.
    renderGraphAt(first, width, height);
    const CRGB* firstOut = getBuffer(first.outputBuffer);
    if (firstOut != held) {
        if (firstOut) memcpy(held, firstOut, totalPixels * sizeof(CRGB));
        else for (uint32_t i = 0; i < totalPixels; i++) held[i] = CRGB::Black;
    }

    // 2. The other graph, re-packed onto the lanes the held frame leaves — same connections,
    //    different columns, so it computes exactly what it would alone.
    const LaneAssignment* secondLanes = fadeSecondRepacked ? &fadeSecondLanes : nullptr;
    renderGraphAt(second, width, height, secondLanes);
    CRGB* secondOut = getBufferPtr(secondLanes ? (int)secondLanes->display : second.outputBuffer);
    if (!secondOut) {
        // Nothing wired to Output on that pattern: it shows black, so fade to/from black.
        // Scratch is idle between graph renders, which is exactly what it's for.
        secondOut = getBufferPtr(SCRATCH_BUFFER);
        if (!secondOut) return nullptr;        // leave the held frame standing this frame
        for (uint32_t i = 0; i < totalPixels; i++) secondOut[i] = CRGB::Black;
    }

    // 3. Blend. Normal mode is in1*(1-op) + in2*op, so holding the INCOMING graph means
    //    running the dissolve backwards — op = 1-progress — which lands on exactly the same
    //    frame as holding the outgoing one. Strictly per-pixel at one index, which is why
    //    writing the result back over input1 is safe and costs no further buffer.
    fadeParams.resize(2);
    fadeParams[0] = ParameterValue(fadeHoldIsIncoming ? (1.0f - fadeProgress) : fadeProgress);
    fadeParams[1] = ParameterValue((int)0); // Normal
    fadeOp->render(held, secondOut, held, width, height, frameFloatTime, frameFloatDelta, fadeParams);
    return held;
}

void PatternRendererBase::render() {
    if (!hasPattern || !ledManager || !buffersAllocated) return;
    if (ledManager->getNumStrips() == 0) return;

    // A dissolve needs both graphs, a blend operator, and somewhere to hold the first
    // frame — a spare lane, or the extra buffer when the graphs leave none. Anything
    // missing (buffers released for an OTA, a blend operator that failed to construct)
    // falls back to showing the incoming pattern alone, which is where the fade was headed.
    const bool fading = fadeActive && hasOutgoing && fadeOp &&
                        (fadeHoldLane >= 0 ||
                         (fadeBuffer && fadeBufferPixels == getTotalPixels()));

    // Nothing wired to the Output node: meta.output is the sentinel -1 (or otherwise
    // out of range). Show black rather than whatever a node happens to leave in a lane
    // buffer, so disconnected nodes can't "bleed" onto the LEDs. While fading, the
    // composite handles this instead — an unwired incoming pattern fades to black rather
    // than cutting to it.
    if (!fading && (currentPattern.outputBuffer < 0 || currentPattern.outputBuffer >= NUM_BUFFERS)) {
        for (size_t s = 0; s < ledManager->getNumStrips(); s++) {
            LedConfig::LedBus* strip = ledManager->getStrip(s);
            if (!strip) continue;
            const auto& config = strip->getConfig();
            for (uint16_t i = 0; i < config.numLeds; i++) strip->setPixelColor(i, CRGB::Black);
        }
        ledManager->show();
        return;
    }

    // Each strip is its OWN canvas: run the full operator graph at the strip's own
    // dimensions into its own LED space. A 1xN linear strip renders the effects at
    // 1xN; a WxH matrix renders at WxH — independent coordinate spaces. The shared
    // buffers are sized to the largest strip and reused per strip: we output to the
    // strip immediately after rendering, before the next strip overwrites them.
    const uint32_t bufferCap = getTotalPixels(); // capacity = largest strip's pixels

    // Strips that share the same canvas dimensions render an IDENTICAL graph (same w,h, same
    // frame time) — so render once and reuse the buffers for each consecutive same-size strip.
    // Two 40×40 curtains then cost one graph render per frame instead of two. The buffers aren't
    // touched between a strip's output mapping and the next strip, so reuse is safe.
    uint16_t lastRenderW = 0, lastRenderH = 0; bool haveRender = false;
    const CRGB* composite = nullptr; // while fading: where this canvas size's dissolve landed

    for (size_t s = 0; s < ledManager->getNumStrips(); s++) {
        LedConfig::LedBus* strip = ledManager->getStrip(s);
        if (!strip) continue;
        const auto& config = strip->getConfig();

        uint16_t w = strip->effectiveWidth();   // layout virtual matrix, else configured/linear
        uint16_t h = strip->effectiveHeight();
        if (w == 0 || h == 0) continue;
        // Safety net: never render past the allocated buffers (shouldn't trigger —
        // buffers are sized to the widest x tallest strip).
        if ((uint32_t)w * (uint32_t)h > bufferCap) {
            w = (uint16_t)(bufferCap / h);
            if (w == 0) continue;
        }

        if (!haveRender || w != lastRenderW || h != lastRenderH) {
            if (fading) composite = renderCrossfadeAt(w, h); else renderGraphAt(currentPattern, w, h);
            lastRenderW = w; lastRenderH = h; haveRender = true;
        }

        // While fading, the composite IS the frame, wherever it was assembled.
        const CRGB* patternBuffer = fading ? composite : getBuffer(currentPattern.outputBuffer);
        if (!patternBuffer) continue;

        if (strip->hasLayout()) {
            // Arbitrary layout (WLED ledmap): walk the W×H grid; each cell lights the LED it
            // maps to (gaps are -1). w*h == layoutWidth*layoutHeight.
            uint32_t cells = (uint32_t)w * (uint32_t)h;
            for (uint32_t c = 0; c < cells; c++) {
                int32_t led = strip->layoutLedAt(c);
                if (led >= 0) strip->setPixelColor((uint16_t)led, patternBuffer[c]);
            }
        } else if (config.isMatrix()) {
            // 2D matrix: xyToIndex owns rotation/flip/serpentine mapping.
            for (uint16_t y = 0; y < h; y++) {
                for (uint16_t x = 0; x < w; x++) {
                    int ledIndex = config.xyToIndex(x, y);
                    if (ledIndex >= 0 && ledIndex < config.numLeds) {
                        strip->setPixelColor(ledIndex, patternBuffer[(uint32_t)y * w + x]);
                    }
                }
            }
        } else {
            // Linear strip: direct 1:1 (w == numLeds, h == 1).
            uint32_t pixelCount = (uint32_t)w * (uint32_t)h;
            if (pixelCount > (uint32_t)config.numLeds) pixelCount = config.numLeds;
            for (uint32_t i = 0; i < pixelCount; i++) {
                strip->setPixelColor((uint16_t)i, patternBuffer[i]);
            }
        }
    }

    ledManager->show();
}

bool PatternRendererBase::loadPatternFromMessagePack(const uint8_t* data, unsigned int size) {
    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char*)data, size);
    mpack_tree_parse(&tree);
    mpack_node_t root = mpack_tree_root(&tree);

    if (mpack_tree_error(&tree) != mpack_ok) {
        mpack_tree_destroy(&tree);
        return false;
    }

    Pattern pattern;
    
    // Parse meta information
    if (mpack_node_map_contains_cstr(root, "meta")) {
        mpack_node_t metaNode = mpack_node_map_cstr(root, "meta");
        
        if (mpack_node_map_contains_cstr(metaNode, "name")) {
            mpack_node_t nameNode = mpack_node_map_cstr(metaNode, "name");
            mpack_type_t nameType = mpack_node_type(nameNode);
            if (nameType == mpack_type_str) {
                // Read in full: copying into a fixed buffer flags mpack_error_too_big on the
                // WHOLE tree for a name of 64+ bytes (~21 Cyrillic/CJK characters), after which
                // every later read returns nothing and the pattern loads with no nodes.
                pattern.name = String(mpackFullStr(nameNode).c_str());
            } else if (nameType == mpack_type_nil) {
                pattern.name = ""; // Default to empty string for null values
            } else {
                pattern.name = ""; // Default to empty string for other types
            }
        }
        
        if (mpack_node_map_contains_cstr(metaNode, "output")) {
            mpack_node_t outputNode = mpack_node_map_cstr(metaNode, "output");
            mpack_type_t outputType = mpack_node_type(outputNode);
            if (outputType == mpack_type_int) {
                pattern.outputBuffer = mpack_node_int(outputNode);
            } else if (outputType == mpack_type_uint) {
                pattern.outputBuffer = (int)mpack_node_uint(outputNode);
            } else if (outputType == mpack_type_float) {
                pattern.outputBuffer = (int)mpack_node_float(outputNode);
            } else if (outputType == mpack_type_double) {
                pattern.outputBuffer = (int)mpack_node_double(outputNode);
            } else if (outputType == mpack_type_nil) {
                pattern.outputBuffer = 0; // Default to buffer 0 for null values
            } else {
                pattern.outputBuffer = 0; // Default to buffer 0 for other types
            }
        }
    }
    
    // Parse nodes using operator registry
    if (mpack_node_map_contains_cstr(root, "nodes")) {
        mpack_node_t nodesArray = mpack_node_map_cstr(root, "nodes");
        if (mpack_node_type(nodesArray) == mpack_type_array) {
            size_t nodeCount = mpack_node_array_length(nodesArray);
            
            for (size_t i = 0; i < nodeCount; i++) {
                mpack_node_t nodeObj = mpack_node_array_at(nodesArray, i);
                PatternNode node;
                
                // Parse operator type and create operator using registry
                if (mpack_node_map_contains_cstr(nodeObj, "t")) {
                    mpack_node_t typeNode = mpack_node_map_cstr(nodeObj, "t");
                    mpack_type_t typeNodeType = mpack_node_type(typeNode);
                    if (typeNodeType == mpack_type_str) {
                        char typeBuffer[32];
                        mpack_node_copy_cstr(typeNode, typeBuffer, sizeof(typeBuffer));
                        std::string operatorName(typeBuffer);
                        
                        // Use operator registry to create operator by name
                        node.op = OperatorRegistry::getInstance().createOperator(operatorName);
                        if (!node.op) {
                            continue; // Skip this node if operator creation failed
                        }
                    } else {
                        continue; // Skip nodes with invalid or null operator types
                    }
                } else {
                    continue; // Skip nodes without operator type
                }
                
                // Parse input/output buffers with robust type checking
                if (mpack_node_map_contains_cstr(nodeObj, "i")) {
                    mpack_node_t inputNode = mpack_node_map_cstr(nodeObj, "i");
                    mpack_type_t inputType = mpack_node_type(inputNode);
                    if (inputType == mpack_type_int) {
                        node.inputBuffer = mpack_node_int(inputNode);
                    } else if (inputType == mpack_type_uint) {
                        node.inputBuffer = (int)mpack_node_uint(inputNode);
                    } else if (inputType == mpack_type_float) {
                        node.inputBuffer = (int)mpack_node_float(inputNode);
                    } else if (inputType == mpack_type_double) {
                        node.inputBuffer = (int)mpack_node_double(inputNode);
                    } else {
                        node.inputBuffer = -1; // Default for other types
                    }
                }
                
                if (mpack_node_map_contains_cstr(nodeObj, "o")) {
                    mpack_node_t outputNode = mpack_node_map_cstr(nodeObj, "o");
                    mpack_type_t outputType = mpack_node_type(outputNode);
                    if (outputType == mpack_type_int) {
                        node.outputBuffer = mpack_node_int(outputNode);
                    } else if (outputType == mpack_type_uint) {
                        node.outputBuffer = (int)mpack_node_uint(outputNode);
                    } else if (outputType == mpack_type_float) {
                        node.outputBuffer = (int)mpack_node_float(outputNode);
                    } else if (outputType == mpack_type_double) {
                        node.outputBuffer = (int)mpack_node_double(outputNode);
                    } else {
                        node.outputBuffer = 0; // Default for other types
                    }
                } else {
                    node.outputBuffer = 0; // Default when missing
                }
                
                if (mpack_node_map_contains_cstr(nodeObj, "i2")) {
                    mpack_node_t input2Node = mpack_node_map_cstr(nodeObj, "i2");
                    mpack_type_t input2Type = mpack_node_type(input2Node);
                    if (input2Type == mpack_type_int) {
                        node.secondInputBuffer = mpack_node_int(input2Node);
                    } else if (input2Type == mpack_type_uint) {
                        node.secondInputBuffer = (int)mpack_node_uint(input2Node);
                    } else if (input2Type == mpack_type_float) {
                        node.secondInputBuffer = (int)mpack_node_float(input2Node);
                    } else if (input2Type == mpack_type_double) {
                        node.secondInputBuffer = (int)mpack_node_double(input2Node);
                    } else {
                        node.secondInputBuffer = -1; // Default for other types
                    }
                }
                
                // Parse parameters using native ParameterValue system
                if (mpack_node_map_contains_cstr(nodeObj, "p") && node.op) {
                    mpack_node_t paramsNode = mpack_node_map_cstr(nodeObj, "p");
                    
                    // Get parameter info from the operator to know expected parameters
                    auto paramInfo = node.op->getParameterInfo();
                    node.parameters.resize(paramInfo.size());
                    
                    // Initialize with default values
                    for (size_t j = 0; j < paramInfo.size(); j++) {
                        node.parameters[j] = paramInfo[j].defaultValue;
                    }
                    
                    // Handle both array and map parameter formats
                    if (mpack_node_type(paramsNode) == mpack_type_array) {
                        // Array format: parameters in order
                        size_t paramCount = mpack_node_array_length(paramsNode);
                        size_t maxParams = (paramCount < paramInfo.size()) ? paramCount : paramInfo.size();
                        
                        for (size_t j = 0; j < maxParams; j++) {
                            mpack_node_t paramNode = mpack_node_array_at(paramsNode, j);
                            mpack_type_t paramType = mpack_node_type(paramNode);
                            
                            if (paramType == mpack_type_float) {
                                float value = mpack_node_float(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_int) {
                                float value = (float)mpack_node_int(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_uint) {
                                float value = (float)mpack_node_uint(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_double) {
                                float value = (float)mpack_node_double(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_bool) {
                                bool value = mpack_node_bool(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_str) {
                                // A string means what the parameter says it means: a SELECT
                                // option, a "#rrggbb" colour, or free text.
                                std::string vb = mpackFullStr(paramNode);
                                node.parameters[j] = valueForString(paramInfo[j], vb.c_str());
                            }
                            // For nil or unknown types, keep the default value
                        }
                    } else if (mpack_node_type(paramsNode) == mpack_type_map) {
                        // Map format: parameters by name
                        size_t paramCount = mpack_node_map_count(paramsNode);
                        
                        for (size_t j = 0; j < paramCount; j++) {
                            mpack_node_t keyNode = mpack_node_map_key_at(paramsNode, j);
                            mpack_node_t valueNode = mpack_node_map_value_at(paramsNode, j);
                            
                            if (mpack_node_type(keyNode) == mpack_type_str) {
                                char keyBuffer[32];
                                mpack_node_copy_cstr(keyNode, keyBuffer, sizeof(keyBuffer));
                                std::string paramName(keyBuffer);
                                
                                // Find parameter index by name
                                for (size_t k = 0; k < paramInfo.size(); k++) {
                                    if (paramInfo[k].name == paramName) {
                                        mpack_type_t valueType = mpack_node_type(valueNode);
                                        if (valueType == mpack_type_float) {
                                            float value = mpack_node_float(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_int) {
                                            float value = (float)mpack_node_int(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_uint) {
                                            float value = (float)mpack_node_uint(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_double) {
                                            float value = (float)mpack_node_double(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_bool) {
                                            bool value = mpack_node_bool(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_str) {
                                            std::string vb = mpackFullStr(valueNode);
                                            node.parameters[k] = valueForString(paramInfo[k], vb.c_str());
                                        }
                                        // For nil or unknown types, keep default value
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                // Parse parameter automation ("m": paramName -> {s:shape, lo:min, hi:max, pr:period}).
                if (mpack_node_map_contains_cstr(nodeObj, "m") && node.op) {
                    mpack_node_t mNode = mpack_node_map_cstr(nodeObj, "m");
                    if (mpack_node_type(mNode) == mpack_type_map) {
                        auto mInfo = node.op->getParameterInfo();
                        // Ensure base params are sized+defaulted so modulation applies even when no
                        // "p" was sent (all-default node with automation on).
                        if (node.parameters.size() < mInfo.size()) {
                            size_t old = node.parameters.size();
                            node.parameters.resize(mInfo.size());
                            for (size_t p = old; p < mInfo.size(); p++) node.parameters[p] = mInfo[p].defaultValue;
                        }
                        node.modulators.resize(mInfo.size());
                        auto numOf = [](mpack_node_t n) -> float {
                            switch (mpack_node_type(n)) {
                                case mpack_type_float:  return mpack_node_float(n);
                                case mpack_type_double: return (float)mpack_node_double(n);
                                case mpack_type_int:    return (float)mpack_node_int(n);
                                case mpack_type_uint:   return (float)mpack_node_uint(n);
                                default: return 0.0f;
                            }
                        };
                        size_t mc = mpack_node_map_count(mNode);
                        for (size_t j = 0; j < mc; j++) {
                            mpack_node_t k = mpack_node_map_key_at(mNode, j);
                            mpack_node_t v = mpack_node_map_value_at(mNode, j);
                            if (mpack_node_type(k) != mpack_type_str || mpack_node_type(v) != mpack_type_map) continue;
                            char kb[32]; mpack_node_copy_cstr(k, kb, sizeof(kb));
                            std::string pn(kb);
                            int pi = -1;
                            for (size_t p = 0; p < mInfo.size(); p++) if (mInfo[p].name == pn) { pi = (int)p; break; }
                            if (pi < 0) continue;
                            ParamModulator mod;
                            mod.active = true;
                            mod.isInt  = (mInfo[pi].type == ParameterInfo::INT);
                            mod.shape  = mpack_node_map_contains_cstr(v, "s")  ? (int)numOf(mpack_node_map_cstr(v, "s"))  : 0;
                            mod.mn     = mpack_node_map_contains_cstr(v, "lo") ? numOf(mpack_node_map_cstr(v, "lo")) : 0.0f;
                            mod.mx     = mpack_node_map_contains_cstr(v, "hi") ? numOf(mpack_node_map_cstr(v, "hi")) : 1.0f;
                            mod.period = mpack_node_map_contains_cstr(v, "pr") ? numOf(mpack_node_map_cstr(v, "pr")) : 1.0f;
                            mod.seed   = mpack_node_map_contains_cstr(v, "sd") ? (uint32_t)numOf(mpack_node_map_cstr(v, "sd")) : 0u;
                            node.modulators[pi] = mod;
                        }
                    }
                }

                // Only add node if operator was created successfully
                if (node.op) {
                    pattern.nodes.push_back(std::move(node));
                }
            }
        }
    }
    
    mpack_tree_destroy(&tree);
    
    setPattern(std::move(pattern));
    return true;
}
