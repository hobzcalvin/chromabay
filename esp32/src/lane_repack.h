#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>

// Re-pack a pattern graph onto a restricted set of lanes.
//
// Which lane a node occupies is not part of what a pattern MEANS. Lanes are editor columns —
// assigned from a node's x position — and the graph computes the same thing however they are
// numbered, as long as the connections are preserved. So a pattern laid out across all three
// columns very often runs in two, and that difference is what decides whether a crossfade
// costs nothing or needs a fourth full-grid buffer.
//
// Why a greedy scan is enough: the node list is already in execution order and each node
// writes exactly one value, so this is straight-line code. A value is live from the node that
// writes it to the last node that reads it, and for straight-line code with a fixed order the
// number of lanes required is just the maximum number of simultaneously live values. A scan
// that reuses any lane whose value is dead therefore succeeds whenever ANY assignment would —
// it is exact for this order, not a heuristic. (Reordering the nodes could do better still;
// this deliberately does not, because the order is the pattern's own.)
//
// Deliberately free of Arduino, FastLED and Pattern so it can be tested on a host.
struct LaneAssignment {
    std::vector<int8_t> in1, in2, out; // physical lane per node; -1 = no input wired
    int8_t display = -1;               // physical lane holding the frame to show
};

// in1Lane/in2Lane/outLane: the graph's own lane numbers per node (-1 = no input).
// displayLane: the lane the pattern displays from.
// allowedMask: bit i set = lane i may be used.
// Returns false if the graph cannot be placed in those lanes, or if it does something this
// cannot faithfully reproduce (see the undefined-read bail-out below).
inline bool repackLanes(const int* in1Lane, const int* in2Lane, const int* outLane, size_t n,
                        int displayLane, uint8_t allowedMask, LaneAssignment& plan) {
    if (n == 0) return false;

    // 1. Resolve lane references to the node that produced the value. "Lane k" only ever meant
    //    "whatever was last written to k", so this recovers the data flow the numbers stood in
    //    for — and the data flow is the part that must survive re-packing.
    std::vector<int32_t> src1(n, -1), src2(n, -1);
    int32_t last[3] = { -1, -1, -1 }; // node that last wrote each lane
    for (size_t i = 0; i < n; i++) {
        const int reads[2] = { in1Lane[i], in2Lane[i] };
        int32_t* dst[2] = { &src1[i], &src2[i] };
        for (int k = 0; k < 2; k++) {
            if (reads[k] < 0) continue;            // nothing wired to that input
            if (reads[k] > 2) return false;        // not a lane this reasons about
            // Reading a lane nothing has written yet samples whatever the previous frame — or
            // the OTHER pattern — happened to leave there. Re-packing cannot reproduce that,
            // and during a crossfade getting it wrong would leak one pattern into the other,
            // so refuse rather than guess.
            if (last[reads[k]] < 0) return false;
            *dst[k] = last[reads[k]];
        }
        if (outLane[i] < 0 || outLane[i] > 2) return false;
        last[outLane[i]] = (int32_t)i;
    }
    if (displayLane < 0 || displayLane > 2 || last[displayLane] < 0) return false;
    const int32_t displayValue = last[displayLane];

    // 2. Last reader of each value. The displayed one outlives the graph.
    std::vector<int32_t> lastUse(n, -1);
    for (size_t i = 0; i < n; i++) {
        if (src1[i] >= 0) lastUse[src1[i]] = (int32_t)i;
        if (src2[i] >= 0) lastUse[src2[i]] = (int32_t)i;
    }
    lastUse[displayValue] = (int32_t)n;

    // 3. Greedy scan.
    plan.in1.assign(n, -1);
    plan.in2.assign(n, -1);
    plan.out.assign(n, -1);
    int32_t held[3] = { -1, -1, -1 }; // value currently occupying each physical lane
    auto laneOf = [&](int32_t value) -> int8_t {
        for (int L = 0; L < 3; L++) if (held[L] == value) return (int8_t)L;
        return -1;
    };

    for (size_t i = 0; i < n; i++) {
        // Inputs sit wherever they were placed when produced. They are still resident: a value
        // read here has lastUse >= i, and nothing with lastUse >= i is retired below.
        if (src1[i] >= 0) { plan.in1[i] = laneOf(src1[i]); if (plan.in1[i] < 0) return false; }
        if (src2[i] >= 0) { plan.in2[i] = laneOf(src2[i]); if (plan.in2[i] < 0) return false; }

        // Retire values whose last reader is already behind us.
        for (int L = 0; L < 3; L++) {
            if (held[L] >= 0 && lastUse[held[L]] < (int32_t)i) held[L] = -1;
        }

        // Somewhere to write: a free lane if there is one, otherwise a lane holding a value
        // THIS node is the last to read — writing over one of its own inputs, which the
        // renderer already handles by going through the scratch buffer.
        int8_t dest = -1;
        for (int L = 0; L < 3 && dest < 0; L++) {
            if ((allowedMask & (1u << L)) && held[L] < 0) dest = (int8_t)L;
        }
        for (int L = 0; L < 3 && dest < 0; L++) {
            if ((allowedMask & (1u << L)) && held[L] >= 0 && lastUse[held[L]] == (int32_t)i) {
                dest = (int8_t)L;
            }
        }
        if (dest < 0) return false; // genuinely more live values than lanes allowed

        plan.out[i] = dest;
        held[dest] = (int32_t)i;
    }

    plan.display = laneOf(displayValue);
    return plan.display >= 0;
}
