#pragma once

#include <FastLED.h>
#include <vector>
#include "led_manager.h"
#include "mpack.h"

#define NUM_BUFFERS 4 // Three lanes for patterns (0/1/2) + one scratch (3)
#define SCRATCH_BUFFER 3 // Internal: render here when output aliases an input, then copy back
// The crossfade hold buffer is deliberately NOT one of these. It is allocated on demand
// (see armCrossfade) so a device that never crossfades pays nothing, and so patterns —
// which are validated against NUM_BUFFERS — can never address it.

// Define ESP32 build to disable emscripten includes
#define ESP32_BUILD

// Include native operator system (now ESP32-compatible!)
#include "../../native/BaseOperator.h"
#include "../../native/Modulation.h"
#include "../../native/OperatorList.h"

// Per-parameter automation config (parallel to PatternNode.parameters; inactive = static value).
struct ParamModulator {
    bool active = false;
    bool isInt = false;   // round the modulated value for integer params (cached from param info)
    int shape = 0;
    float mn = 0.0f, mx = 1.0f, period = 1.0f;
    uint32_t seed = 0;    // per-instance decorrelation seed (from app: node id + param name)
    // Phase state (mutable: updated during const render) so a live period change stays continuous.
    // Carried across pattern reloads by the PRESERVED path in setPattern().
    mutable Modulation::ModState st;
};

// Node structure for pattern execution
struct PatternNode {
    std::unique_ptr<BaseOperator> op;  // Unique pointer to operator
    std::vector<ParameterValue> parameters;
    std::vector<ParamModulator> modulators; // empty, or same size as parameters
    int inputBuffer = -1;     // Buffer index to read from (-1 if none)
    int outputBuffer = 0;     // Buffer index to write to
    int secondInputBuffer = -1; // Second input for blend operations

    PatternNode() : op(nullptr) {}
};

// Pattern structure
struct Pattern {
    std::vector<PatternNode> nodes;
    int outputBuffer = 0; // Which buffer to display
    String name;
};

// Pattern renderer class using native operators
class PatternRendererBase {
protected:
    LedConfig::LedManager* ledManager;
    CRGB** buffers; // Dynamically allocated buffers
    Pattern currentPattern;
    bool hasPattern = false;
    unsigned long lastFrameTime;
    unsigned long frameStartTime;
    unsigned long globalTime;
    // Frame time captured once per update(), reused by each per-strip graph render
    // so all strips render the same instant.
    uint32_t frameFloatTime = 0;
    uint32_t frameFloatDelta = 0;
    std::vector<ParameterValue> _effParams; // reused scratch for modulated parameter values

    // Timestamp synchronization
    unsigned long syncedBaseTime = 0;       // Synchronized base timestamp
    unsigned long syncedLocalTime = 0;      // Local millis() when sync was received
    bool useSyncedTime = false;             // Whether to use synchronized time
    
    bool buffersAllocated = false;

    // ── Crossfade ───────────────────────────────────────────────────────────────────────
    // Cycle mode can dissolve one pattern into the next instead of cutting: the two
    // patterns' graphs joined under a single Blend node, which is what it renders.
    //
    // Two graphs under one Blend node do NOT need two graphs' worth of lanes. Run them
    // sequentially and only ONE value has to survive across the join — the first graph's
    // result. The second graph then needs nothing but lanes the first isn't holding. So the
    // question is not "do six lanes fit in three", it is "does the second graph leave one
    // lane free", and lanes here are editor columns: a pattern only occupies three of them
    // if someone actually placed nodes in all three.
    //
    // Hence: whichever graph uses fewer lanes goes SECOND, the other's frame is held in a
    // lane it doesn't touch, and the blend composites the two — three lanes, no extra
    // memory, which is the common case. No remapping is needed either; the held frame is
    // simply parked in a lane the second graph was never wired to.
    //
    // The exception is real and is the reason the hold buffer still exists: when BOTH
    // patterns occupy all three lanes there is no free lane, and no ordering fixes it. That
    // is the classic register-allocation result — two subtrees each needing three registers,
    // combined under a binary operator, need four. Then, and only then, a crossfade costs
    // one extra full-grid buffer.
    Pattern outgoingPattern;                 // the graph being faded OUT (owns its own operators,
                                             // so its stateful ones keep running while it fades)
    bool hasOutgoing = false;
    CRGB* fadeBuffer = nullptr;              // holds the outgoing frame, then the blended result
    uint32_t fadeBufferPixels = 0;           // what fadeBuffer was sized for (realloc if the grid changes)
    bool fadeLowMemoryWarned = false;        // so a tight heap doesn't log once per cycle boundary, forever
    // Which lane holds the first-rendered frame while the other graph runs, or -1 when the
    // two graphs between them leave no lane free and the hold buffer is needed instead.
    int fadeHoldLane = -1;
    // Whether the INCOMING graph is the one rendered first (and so the one being held). The
    // graph rendered second is whichever can spare a lane; that is not always the incoming one.
    bool fadeHoldIsIncoming = false;
    std::unique_ptr<BaseOperator> fadeOp;    // a real "blend" operator — same code path as a Blend node
    std::vector<ParameterValue> fadeParams;  // [opacity, mode=Normal], refreshed per frame
    bool fadeArmed = false;                  // a crossfade was requested; the next setPattern() starts it
    bool fadeActive = false;
    unsigned long fadeStartTime = 0;         // on the SYNCED clock, so all devices dissolve together
    uint32_t fadeDurationMs = 0;
    float fadeProgress = 0.0f;               // 0 = all outgoing, 1 = all incoming (recomputed in update())

    bool ensureFadeBuffer();                 // allocate/resize the hold buffer; false = no crossfade
    void releaseFadeBuffer();
    void endCrossfade();                     // drop the outgoing graph and its buffer
    // Render the crossfade composite for one canvas size. Returns the buffer holding it —
    // a lane when the two graphs fit the lanes between them, the hold buffer when they
    // don't — or nullptr if it could not be built this frame.
    const CRGB* renderCrossfadeAt(uint16_t width, uint16_t height);
    // Decide how this crossfade will be rendered, once, when it starts. Sets fadeHoldLane /
    // fadeHoldIsIncoming and allocates the hold buffer only if the lanes can't do it.
    // False = no way to fade these two (cut instead).
    bool planCrossfade();

    // Helper functions
    void clearBuffer(int bufferIndex);
    CRGB* getBufferPtr(int bufferIndex);
    void allocateBuffers();
    void deallocateBuffers();
    void initializeFromLedConfig();
    unsigned long getCurrentTime(); // Get current time (synced or local)
    // Run a whole operator graph into the shared buffers at the given canvas size.
    // Called once per strip from render() so each strip gets its own native render.
    void renderGraphAt(const Pattern& pattern, uint16_t width, uint16_t height);
    
    // Get current dimensions from LED config (single source of truth)
    uint16_t getMatrixWidth() const;
    uint16_t getMatrixHeight() const;
    uint32_t getTotalPixels() const;
    
public:
    PatternRendererBase(LedConfig::LedManager* ledMgr);
    virtual ~PatternRendererBase();
    
    // Configuration
    void updateMatrixConfig(); // Call when LED config changes

    // Render buffers, around a firmware update.
    //
    // These are the biggest display-proportional allocation in the firmware — NUM_BUFFERS
    // full-grid CRGB buffers, so 4 * width * height * 3 bytes — and they are large CONTIGUOUS
    // blocks, which is the currency an update actually needs. Rendering is already suspended
    // for the duration of an update, so holding them through one buys nothing and costs
    // exactly the memory the update is short of. The bigger the installation, the more this
    // frees, which is the right way round: big displays are the ones that struggle to update.
    void releaseBuffers();          // give the grid buffers back (rendering must be suspended)
    void reacquireBuffers();        // take them again afterwards
    bool buffersReady() const { return buffersAllocated; }
    uint32_t bufferBytes() const;   // what releaseBuffers() would return
    
    // Timestamp synchronization
    void setSynchronizedTime(unsigned long syncTimestamp, unsigned long localTime);
    void clearSynchronizedTime();
    
    // Pattern management
    void setPattern(Pattern&& pattern);
    void clearPattern();
    bool loadPatternFromMessagePack(const uint8_t* data, unsigned int size);

    // Crossfade the pattern that is loaded NEXT over the one showing now.
    //
    // Arms only — the fade starts when the next setPattern() lands, because that is the
    // moment there are two graphs to blend. So the caller arms, then loads; if the load
    // fails it must cancelCrossfade(), or the arm would attach to whatever pattern arrives
    // after it. Anything that sets a pattern WITHOUT arming first (a live push from the
    // app) cancels a pending or running fade and cuts, which is what "here's your pattern
    // now" should do.
    //
    // startTime is on the synchronized clock and is the cycle BOUNDARY, not "now": every
    // device crosses that boundary together but reaches this call a different number of
    // milliseconds later (flash read, msgpack parse), and anchoring to the boundary keeps
    // them dissolving in step. A boundary already further back than durationMs simply
    // yields progress >= 1 on the first frame — a cut, which is the honest outcome for a
    // device that joined late.
    void armCrossfade(unsigned long startTime, uint32_t durationMs);
    void cancelCrossfade();
    bool isCrossfading() const { return fadeActive; }
    
    // Rendering
    void update();
    void render();
    
    // Buffer access
    const CRGB* getBuffer(int bufferIndex) const;

    // Name of the currently-loaded pattern (meta.name from the last
    // loadPatternFromMessagePack). Used to key the on-device pattern library.
    const char* getCurrentPatternName() const { return currentPattern.name.c_str(); }
};
