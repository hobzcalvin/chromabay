// Host checks for the lane re-packer. No hardware, no FastLED, no PlatformIO:
//
//   g++ -std=c++17 -O1 -Wall esp32/test/lane_repack_test.cpp -o /tmp/lane_repack_test && /tmp/lane_repack_test
//
// Not wired into CI — the firmware build has no host-test step to hang it off yet.
//
// The important property is not "did it find an assignment" but "does the assignment compute
// the same thing". So the core check is an interpreter: evaluate the graph symbolically with
// its own lane numbers, evaluate it again with the re-packed ones, and compare the expression
// that lands on the display lane. Run over hand-built shapes and then a few thousand random
// graphs.
#include "../src/lane_repack.h"
#include <cstdio>
#include <string>
#include <vector>
#include <random>

static int failures = 0;
static void check(bool ok, const char* what) {
    printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) failures++;
}

struct Graph {
    std::vector<int> in1, in2, out;
    int display = 0;
    size_t size() const { return out.size(); }
};

// Evaluate symbolically. `assign` null = use the graph's own lanes.
static std::string evaluate(const Graph& g, const LaneAssignment* assign) {
    std::string lane[3];
    for (size_t i = 0; i < g.size(); i++) {
        const int a  = assign ? assign->in1[i] : g.in1[i];
        const int b  = assign ? assign->in2[i] : g.in2[i];
        const int o  = assign ? assign->out[i] : g.out[i];
        // Read BOTH inputs before writing: the renderer routes an output that aliases an
        // input through the scratch buffer, so a node never reads what it just wrote.
        const std::string x = (a >= 0) ? lane[a] : std::string("_");
        const std::string y = (b >= 0) ? lane[b] : std::string("_");
        lane[o] = "n" + std::to_string(i) + "(" + x + "," + y + ")";
    }
    const int d = assign ? assign->display : g.display;
    return (d >= 0) ? lane[d] : std::string("?");
}

static bool repack(const Graph& g, uint8_t allowed, LaneAssignment& plan) {
    return repackLanes(g.in1.data(), g.in2.data(), g.out.data(), g.size(), g.display, allowed, plan);
}

// Same expression under both assignments?
static bool preservesMeaning(const Graph& g, const LaneAssignment& plan) {
    return evaluate(g, nullptr) == evaluate(g, &plan);
}

int main() {
    LaneAssignment plan;

    // 1. The shape that motivated all this: two generators laid out left and right, blended
    //    into the centre column. It touches all three lanes, so "lanes touched" calls it a
    //    three-lane pattern — but it only ever has two values alive, so it fits in two.
    Graph twoGens;
    twoGens.in1 = { -1, -1,  0 };
    twoGens.in2 = { -1, -1,  2 };
    twoGens.out = {  0,  2,  1 };
    twoGens.display = 1;
    check(repack(twoGens, 0b011, plan), "two generators blended across 3 columns fit in 2 lanes");
    check(preservesMeaning(twoGens, plan), "  ...and compute the same expression");

    // 2. A plain chain, however it was laid out, needs exactly one lane.
    Graph chain;
    chain.in1 = { -1,  0,  1 };
    chain.in2 = { -1, -1, -1 };
    chain.out = {  0,  1,  2 };
    chain.display = 2;
    check(repack(chain, 0b001, plan), "a three-node chain fits in a single lane");
    check(preservesMeaning(chain, plan), "  ...and computes the same expression");

    // 3. Three values genuinely alive at once cannot fit in two, and must not pretend to.
    //    Three generators, then two blends that consume them.
    Graph threeLive;
    threeLive.in1 = { -1, -1, -1,  0,  1 };
    threeLive.in2 = { -1, -1, -1,  1,  2 };
    threeLive.out = {  0,  1,  2,  0,  1 };
    threeLive.display = 1;
    check(!repack(threeLive, 0b011, plan), "three simultaneously-live values are refused by 2 lanes");
    check(repack(threeLive, 0b111, plan), "  ...and accepted by 3");
    check(preservesMeaning(threeLive, plan), "  ...still computing the same expression");

    // 4. Reading a lane nothing wrote is refused rather than silently re-pointed.
    Graph undefinedRead;
    undefinedRead.in1 = { 1 };
    undefinedRead.in2 = { -1 };
    undefinedRead.out = { 0 };
    undefinedRead.display = 0;
    check(!repack(undefinedRead, 0b111, plan), "a read of a never-written lane is refused");

    // 5. Fuzz. Random well-formed graphs: every read is of a lane already written, which is
    //    what the serializer produces. Whenever a packing is found it must preserve meaning,
    //    and anything that fits in 2 must also fit in 3.
    std::mt19937 rng(12345);
    int packedInto2 = 0, total = 0;
    bool meaningAlwaysHeld = true, monotone = true;
    for (int trial = 0; trial < 5000; trial++) {
        Graph g;
        const int n = 1 + (int)(rng() % 8);
        bool written[3] = { false, false, false };
        for (int i = 0; i < n; i++) {
            auto pickWritten = [&]() -> int {
                int opts[3], c = 0;
                for (int L = 0; L < 3; L++) if (written[L]) opts[c++] = L;
                return c ? opts[rng() % c] : -1;
            };
            const int kind = (int)(rng() % 3);
            int a = -1, b = -1;
            if (kind >= 1) a = pickWritten();
            if (kind >= 2) b = pickWritten();
            const int o = (int)(rng() % 3);
            g.in1.push_back(a); g.in2.push_back(b); g.out.push_back(o);
            written[o] = true;
        }
        g.display = g.out[g.size() - 1];
        total++;

        LaneAssignment p2, p3;
        const bool fits2 = repack(g, 0b011, p2);
        const bool fits3 = repack(g, 0b111, p3);
        if (fits2) {
            packedInto2++;
            if (!preservesMeaning(g, p2)) meaningAlwaysHeld = false;
            if (!fits3) monotone = false;   // two lanes worked, three must too
        }
        if (fits3 && !preservesMeaning(g, p3)) meaningAlwaysHeld = false;
    }
    check(meaningAlwaysHeld, "5000 random graphs: every packing preserves the expression");
    check(monotone, "5000 random graphs: anything that fits in 2 lanes also fits in 3");
    printf("      (%d of %d random graphs fit in two lanes)\n", packedInto2, total);

    printf(failures ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
    return failures ? 1 : 0;
}
