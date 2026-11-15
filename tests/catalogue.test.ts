/**
 * A catalogue of real sequencing rules written with the sequence API. Each `it` is meant to be
 * read as documentation: the code inside is what a task author would write.
 */
import seedrandom from "seedrandom";

import {
  SequenceConstraint,
  SequenceError,
  allocate,
  autoSolver,
  balancedTransitions,
  blocksOf,
  checkSequence,
  column,
  countBetween,
  exactCount,
  expand,
  forbidPattern,
  maxGap,
  maxRun,
  minGap,
  noRepeat,
  runLength,
  sampler,
  sequence,
  sequenceBlocks,
  startWith,
  uniqueWithin,
  windowCount,
} from "../src";

const setSeed = (seed: string) => {
  Math.random = seedrandom(seed);
};

beforeEach(() => setSeed("sequence-catalogue"));

const sorted = <T>(a: T[]) => a.map((x) => JSON.stringify(x)).sort();
/** Every constraint holds and the same items came out. */
function valid<T>(out: T[], cs: SequenceConstraint<T>[], items?: T[], after?: T[]) {
  expect(checkSequence(out, cs, { after })).toEqual({ ok: true, failures: [] });
  if (items) expect(sorted(out)).toEqual(sorted(items));
}
const rep = <T>(x: T, n: number) => new Array<T>(n).fill(x);

// =============================================================================================
// Part 1. Hard cases beyond the survey
// =============================================================================================

describe("hard cases", () => {
  it("n-back with an exact number of targets and no lures at n-1 / n+1 (custom constraint)", () => {
    const N = 2;
    const TARGETS = 40;
    // Classify position i: 'target' (same as n back), 'lure' (same as n-1 or n+1 back), or ''.
    const kind = (s: string[], i: number) => {
      if (i >= N && s[i] === s[i - N]) return "target";
      if ((i >= N - 1 && N > 1 && s[i] === s[i - (N - 1)]) || (i >= N + 1 && s[i] === s[i - N - 1]))
        return "lure";
      return "";
    };
    const nBack: SequenceConstraint<string> = {
      name: `nBack(${N}, targets=${TARGETS}, no lures)`,
      allows(prefix, next) {
        const s = [...prefix, next];
        const k = kind(s, s.length - 1);
        if (k === "lure") return false;
        if (k === "target") {
          let t = 0;
          for (let i = 0; i < prefix.length; i++) if (kind(prefix, i) === "target") t++;
          return t + 1 <= TARGETS;
        }
        return true;
      },
      violations(seq, start) {
        let t = 0,
          lures = 0;
        for (let i = start; i < seq.length; i++) {
          const k = kind(seq, i);
          if (k === "target") t++;
          else if (k === "lure") lures++;
        }
        return Math.abs(t - TARGETS) + lures;
      },
    };
    const letters = "BCDFGHJK".split("");
    const items = letters.flatMap((l) => rep(l, 25)); // 200 trials
    const out = sequence(items, [nBack]);
    valid(out, [nBack], items);
    expect(out.filter((_, i) => i >= N && out[i] === out[i - N]).length).toBe(TARGETS);
  });

  it("first-order transition balance: cC, iC, cI, iI equally often", () => {
    const trials = [...rep({ congruency: "c" }, 100), ...rep({ congruency: "i" }, 100)];
    const cs = [
      balancedTransitions<{ congruency: string }>({ key: "congruency" }),
      maxRun({ key: "congruency", max: 4 }),
    ];
    expect(autoSolver(cs)).toBe("repair"); // whole-sequence rule: no allows()
    const out = sequence(trials, cs);
    valid(out, cs, trials);
    const t: Record<string, number> = {};
    for (let i = 1; i < out.length; i++) {
      const k = out[i - 1].congruency + out[i].congruency;
      t[k] = (t[k] ?? 0) + 1;
    }
    expect(Object.values(t).every((c) => c === 49 || c === 50)).toBe(true);
  });

  it("Latin-square-like order within a block: rows and columns are permutations", () => {
    const items = ["A", "B", "C", "D"].flatMap((c) => rep(c, 4)); // 4 x 4
    const cs = [
      uniqueWithin<string>({ group: blocksOf(4) }),
      uniqueWithin<string>({ group: column(4) }),
    ];
    const out = sequence(items, cs);
    valid(out, cs, items);
    for (let r = 0; r < 4; r++) expect(new Set(out.slice(r * 4, r * 4 + 4)).size).toBe(4);
    for (let c = 0; c < 4; c++)
      expect(new Set([0, 1, 2, 3].map((r) => out[r * 4 + c])).size).toBe(4);
  });

  it("a run limit that carries across block boundaries", () => {
    const block = [...rep("red", 6), ...rep("blue", 6)];
    const cs = [maxRun<string>({ max: 2 })];
    const blocks = sequenceBlocks([block, block, block, block], cs);
    valid(blocks.flat(), cs, blocks.flat()); // checked on the whole session, not per block
    // Each block was generated knowing what came before it, so boundaries are safe.
    blocks.forEach((b, i) => i && valid(b, cs, block, blocks.slice(0, i).flat()));
    // Without `after`, boundaries can break the rule (this is what the feature prevents):
    let broken = 0;
    for (let s = 0; s < 200; s++) {
      setSeed("naive" + s);
      const naive = [0, 1, 2].map(() => sequence(block, cs)).flat();
      if (!checkSequence(naive, cs).ok) broken++;
    }
    expect(broken).toBeGreaterThan(0);
  });

  it("AX-CPT: each run of 10 has 7 AX + 1 AY + 1 BX + 1 BY; at most 5 AX in a row over the whole session", () => {
    const unit = [...rep("AX", 7), "AY", "BX", "BY"];
    const cs = [maxRun<string>({ values: ["AX"], max: 5 })];
    const chunks = sequenceBlocks(rep(unit, 12), cs); // 120 trials
    const session = chunks.flat();
    valid(session, cs);
    valid(session, [
      windowCount<string>({
        key: (t) => t === "AX",
        values: [true],
        size: 10,
        step: 10,
        exactly: 7,
      }),
    ]);
    chunks.forEach((c) => expect(sorted(c)).toEqual(sorted(unit)));
  });

  it("oddball: 15 leading standards, 2 to 7 standards between targets", () => {
    const items = [...rep("T", 40), ...rep("S", 160)];
    const isTarget = (x: string) => x === "T";
    const cs = [
      startWith<string>({ key: isTarget, values: [false], count: 15 }),
      minGap<string>({ key: isTarget, values: [true], gap: 2 }),
      maxGap<string>({ key: isTarget, values: [true], gap: 7 }),
    ];
    const out = sequence(items, cs);
    valid(out, cs, items);
    expect(out.slice(0, 15).join("")).toBe("S".repeat(15));
  });

  it("film clips: at most 1 clip of the same emotion and 3 of the same valence in a row (two attributes)", () => {
    const emotions: Record<string, string> = {
      sad: "neg",
      fear: "neg",
      anger: "neg",
      joy: "pos",
      calm: "pos",
      awe: "pos",
    };
    const clips = Object.keys(emotions).flatMap((emotion) =>
      [1, 2, 3].map((n) => ({ id: emotion + n, emotion, valence: emotions[emotion] }))
    );
    const cs = [
      maxRun<(typeof clips)[0]>({ key: "emotion", max: 1 }),
      maxRun<(typeof clips)[0]>({ key: "valence", max: 3 }),
    ];
    const out = sequence(clips, cs);
    valid(out, cs, clips);
  });

  it("2-step task: realized common transitions between 0.6 and 0.8 (sampler + whole-sequence rule)", () => {
    const draw = sampler(["common", "rare"], 200, [0.7, 0.3]);
    const cs = [
      countBetween<string>({ key: (t) => t === "common", values: [true], min: 120, max: 160 }),
    ];
    const out = sequence(draw, cs, { solver: "rejection" }); // exactly the old 'resample until in range'
    valid(out, cs);
    const p = out.filter((t) => t === "common").length / out.length;
    expect(p).toBeGreaterThanOrEqual(0.6);
    expect(p).toBeLessThanOrEqual(0.8);
    // The default solver also handles it (backtracking with the upper bound, final check for the lower).
    valid(sequence(draw, cs), cs);
  });

  it("go/no-go: runs of 1, 3 or 5 go before each no-go (rule version)", () => {
    const items = [...rep("nogo", 20), ...rep("go", 60)];
    const isGo = (x: string) => x === "go";
    const cs = [
      runLength<string>({ key: isGo, values: [true], allowed: [1, 3, 5] }),
      // runLength only sees runs of go, so "no-go first" and "two no-go in a row" (a run of 0 go)
      // need their own rules:
      maxRun<string>({ max: 1, values: ["nogo"] }),
      startWith<string>({ values: ["go"] }),
    ];
    for (let seed = 0; seed < 10; seed++) {
      setSeed("gonogo" + seed);
      const out = sequence(items, cs);
      valid(out, cs, items);
      // direct check, independent of the constraints: the go-run before every no-go is 1, 3 or 5
      let run = 0;
      for (const x of out) {
        if (x === "go") run++;
        else {
          expect([1, 3, 5]).toContain(run);
          run = 0;
        }
      }
    }
  });

  it("go/no-go: runs of 1, 3 or 5 go before each no-go (composition version: shuffle compound units)", () => {
    const counts = allocate([1, 1, 1], 20); // 7,7,6 units of each length
    const units = expand([1, 3, 5], counts).map((len) => [...rep("go", len), "nogo"]);
    const order = sequence(units, [noRepeat({ key: (u: string[]) => u.length })]); // e.g. no unit length twice in a row
    const out = order.flat();
    expect(out.filter((x) => x === "nogo").length).toBe(20);
    const gos = out
      .join(",")
      .split("nogo")
      .slice(0, -1)
      .map((s) => s.split(",").filter(Boolean).length);
    expect(gos.every((g) => [1, 3, 5].includes(g))).toBe(true);
  });
});

// =============================================================================================
// Part 2. Rules observed in the literature survey (grouped by what they ask for)
// =============================================================================================

describe("observed rules", () => {
  // --- maximum runs ---------------------------------------------------------------------
  it("max_consecutive_same_cs / max_N_consecutive_same / max 3 identical trials in a row / max 4 pairs of same relatedness / enforced_max_2_same_position", () => {
    const items = ["CS+", "CS-", "CS2"].flatMap((c) => rep(c, 20));
    const cs = [maxRun<string>({ max: 2 })];
    valid(sequence(items, cs), cs, items);
    // other keys: relatedness of a word pair, a response position
    const pairs = [
      ...rep({ rel: "related" }, 24),
      ...rep({ rel: "unrelated" }, 24),
      ...rep({ rel: "neutral" }, 24),
    ];
    valid(
      sequence(pairs, [maxRun({ key: "rel", max: 4 })]),
      [maxRun({ key: "rel", max: 4 })],
      pairs
    );
  });

  it("max_same_emotion_in_row + max_same_valence_in_row (fixed_first: a low-contentment film first)", () => {
    const clips = [
      { id: "lc", emotion: "contentment", valence: "pos", low: true },
      ...["sad", "fear", "anger", "joy", "calm"].flatMap((e) =>
        [1, 2].map((n) => ({
          id: e + n,
          emotion: e,
          valence: ["joy", "calm"].includes(e) ? "pos" : "neg",
          low: false,
        }))
      ),
    ];
    type Clip = (typeof clips)[0];
    const cs = [
      startWith<Clip>({ key: "low", values: [true] }),
      maxRun<Clip>({ key: "emotion", max: 1 }),
      maxRun<Clip>({ key: "valence", max: 3 }),
    ];
    const out = sequence(clips, cs);
    valid(out, cs, clips);
    expect(out[0].id).toBe("lc");
  });

  it("same cue never in 3 consecutive trials / cue always changes (task switching)", () => {
    const trials = ["A", "B", "C"].flatMap((c) => rep({ cue: c }, 12));
    valid(
      sequence(trials, [maxRun({ key: "cue", max: 2 })]),
      [maxRun({ key: "cue", max: 2 })],
      trials
    );
    valid(sequence(trials, [noRepeat({ key: "cue" })]), [noRepeat({ key: "cue" })], trials);
  });

  it("cue repeat vs cue switch balanced on task repetitions (task switching)", () => {
    // Among task repetitions, cue repeats and cue switches should be equally frequent.
    // (Each trial is (task, cue), 2 cues per task, so a cue repeat is always a task repeat.)
    type T = { task: string; cue: string };
    const trials: T[] = [];
    for (const [task, cue] of [
      ["parity", "P1"],
      ["parity", "P2"],
      ["magnitude", "M1"],
      ["magnitude", "M2"],
    ]) {
      for (let i = 0; i < 24; i++) trials.push({ task, cue });
    }
    const cells = ["tR.cR", "tR.cS"]; // task switches are not counted
    const classify = (a: T, b: T) =>
      `t${a.task === b.task ? "R" : "S"}.c${a.cue === b.cue ? "R" : "S"}`;
    const cs = [balancedTransitions<T>({ classify, cells, tolerance: 1 })];
    const out = sequence(trials, cs);
    valid(out, cs, trials);
  });

  it("no immediate repeat / repetition_free / no_repeat (stroop, spans, running memory)", () => {
    const items = ["red", "green", "blue", "yellow"].flatMap((c) => rep(c, 10));
    valid(sequence(items, [noRepeat()]), [noRepeat()], items);
  });

  it("windowed_constraints: no repeat within the last 3 items (running memory)", () => {
    const items = "ABCDEFGH".split("").flatMap((c) => rep(c, 5));
    const cs = [noRepeat<string>({ within: 3 })];
    valid(sequence(items, cs), cs, items);
  });

  it("no same initial letter / no consecutive same voicing / no immediate pair repeat (key = derived attribute)", () => {
    const words = [
      "bat",
      "bed",
      "cat",
      "cup",
      "dog",
      "doll",
      "fig",
      "fan",
      "gap",
      "gum",
      "hat",
      "hen",
    ].map((w) => ({ w }));
    const cs = [noRepeat<{ w: string }>({ key: (x) => x.w[0] })];
    valid(sequence(words, cs), cs, words);
  });

  it("no related neighbours / no chaining (premise pairs sharing an element must not be adjacent)", () => {
    const pairs = [
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
      ["D", "E"],
      ["E", "F"],
      ["A", "C"],
      ["B", "D"],
      ["C", "E"],
      ["D", "F"],
    ];
    const cs = [
      forbidPattern<string[]>({
        bad: ([a, b]) => a.some((x) => b.includes(x)),
        name: "noChaining",
      }),
    ];
    const out = sequence(pairs, cs);
    valid(out, cs, pairs);
  });

  it("no adjacent items within 2 / no ascending-descending neighbours / no runs of 3+ ascending or descending (spans)", () => {
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const cs = [
      forbidPattern<number>({ bad: ([a, b]) => Math.abs(a - b) <= 2, name: "noWithin2" }),
      forbidPattern<number>({
        size: 3,
        bad: ([a, b, c]) => (b - a === 1 && c - b === 1) || (a - b === 1 && b - c === 1),
        name: "noRuns",
      }),
      forbidPattern<number>({ bad: ([a, b]) => a % 2 === 0 && b % 2 === 0, name: "noEvenPairs" }),
    ];
    const out = sequence(digits.slice(0, 7), cs); // a 7-digit span list
    valid(out, cs, digits.slice(0, 7));
  });

  it("randomized, no consecutive incentive trials (MID)", () => {
    const trials = [...rep({ incentive: true }, 20), ...rep({ incentive: false }, 20)];
    const cs = [maxRun<{ incentive: boolean }>({ key: "incentive", values: [true], max: 1 })];
    valid(sequence(trials, cs), cs, trials);
  });

  it("max 5 AX in a row, max 2 of the other trial types (fixed pseudorandom AX)", () => {
    const items = [...rep("AX", 70), ...rep("AY", 10), ...rep("BX", 10), ...rep("BY", 10)];
    const cs = [
      maxRun<string>({ values: ["AX"], max: 5 }),
      maxRun<string>({ values: (v) => v !== "AX", max: 2 }),
    ];
    valid(sequence(items, cs), cs, items);
  });

  it("max 2 consecutive no-go, at least 3 go between no-go runs (go/no-go)", () => {
    const items = [...rep("nogo", 20), ...rep("go", 80)];
    const isGo = (x: string) => x === "go";
    const cs = [
      maxRun<string>({ values: ["nogo"], max: 2 }),
      runLength<string>({ key: isGo, values: [true], min: 3 }),
    ];
    valid(sequence(items, cs), cs, items);
  });

  it("different limits in different phases: max 3 in training, max 2 in test (acquired equivalence)", () => {
    const train = ["a", "b", "c", "d"].flatMap((x) => rep(x, 10));
    const test = ["a", "b", "c", "d"].flatMap((x) => rep(x, 6));
    const [t1, t2] = sequenceBlocks([train, test], (b) => [
      maxRun<string>({ max: b === 0 ? 3 : 2 }),
    ]);
    valid(t1, [maxRun({ max: 3 })], train);
    valid(t2, [maxRun({ max: 2 })], test, t1);
  });

  it("reversal every 4th to 6th trial (cued reversal task): run lengths of the active rule", () => {
    const items = [...rep("ruleA", 24), ...rep("ruleB", 24)];
    const cs = [runLength<string>({ min: 4, max: 6 })];
    valid(sequence(items, cs), cs, items);
  });

  // --- positions --------------------------------------------------------------------------
  it("leading_standards 5 / 15 and first_n non-target / first 3 primer trials compatible / first CS+ reinforced", () => {
    const items = [...rep("deviant", 30), ...rep("standard", 120)];
    const cs = [startWith<string>({ values: ["standard"], count: 15 })];
    const out = sequence(items, cs);
    valid(out, cs, items);
    expect(out.slice(0, 15).every((x) => x === "standard")).toBe(true);
    // 'first 3 trials feasible' / 'first CS+ trial is reinforced': same rule, other key
    const trials = [
      ...rep({ cs: "+", us: true }, 8),
      ...rep({ cs: "+", us: false }, 8),
      ...rep({ cs: "-", us: false }, 16),
    ];
    const c2 = [
      startWith<(typeof trials)[0]>({ key: (t) => t.cs === "+" && t.us, values: [true] }),
    ];
    valid(sequence(trials, c2), c2, trials);
  });

  it("booster: 5 of the first 7 trials reinforced (count within a range)", () => {
    const trials = [...rep({ us: true }, 20), ...rep({ us: false }, 20)];
    const cs = [
      exactCount<{ us: boolean }>({ key: "us", values: [true], count: 5, range: [0, 7] }),
    ];
    const out = sequence(trials, cs);
    valid(out, cs, trials);
    expect(out.slice(0, 7).filter((t) => t.us).length).toBe(5);
  });

  // --- gaps -------------------------------------------------------------------------------
  it("min_standards_between_targets 1/2, max_trials_between_targets 7 (oddball)", () => {
    const items = [...rep("T", 30), ...rep("S", 120)];
    const cs = [
      minGap<string>({ values: ["T"], gap: 2 }),
      maxGap<string>({ values: ["T"], gap: 7 }),
    ];
    valid(sequence(items, cs), cs, items);
  });

  // --- composition: structure from repeated calls -----------------------------------------
  it("each stimulus presented once per block / one of each type per block / randomized within repeated design cycles", () => {
    const stimuli = ["a", "b", "c", "d", "e", "f"];
    const blocks = sequenceBlocks(rep(stimuli, 5), [noRepeat<string>()]); // no repeat even across blocks
    blocks.forEach((b) => expect(sorted(b)).toEqual(sorted(stimuli)));
    valid(blocks.flat(), [noRepeat<string>()]);
    // the same rule as a single call, with group constraints:
    const flat = sequence(rep(stimuli, 5).flat(), [uniqueWithin<string>({ group: blocksOf(6) })]);
    valid(flat, [uniqueWithin<string>({ group: blocksOf(6) })]);
  });

  it("shuffled list with exact stop proportion per block (countermanding) / shuffled repeats of a fixed proportion unit", () => {
    const [stop, go] = Object.values(allocate({ stop: 1, go: 3 }, 32)); // 8 stop + 24 go per block
    const block = [...rep("stop", stop), ...rep("go", go)];
    const blocks = sequenceBlocks(rep(block, 4), [maxRun<string>({ values: ["stop"], max: 2 })]);
    blocks.forEach((b) => expect(b.filter((x) => x === "stop").length).toBe(8));
  });

  it("balanced full factorial, shuffled (flanker, antisaccade cue side x CTI x trial type)", () => {
    const cells = [] as { side: string; cti: number; type: string }[];
    for (const side of ["L", "R"])
      for (const cti of [100, 500])
        for (const type of ["pro", "anti"])
          for (let i = 0; i < 5; i++) cells.push({ side, cti, type });
    const out = sequence(cells, []); // no constraints: a plain shuffle
    expect(sorted(out)).toEqual(sorted(cells));
  });

  it("random_within_blocks_random_block_order / amount conditions and probability blocks in random order", () => {
    const blocks = [
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
      ["c1", "c2", "c3"],
    ];
    const within = sequenceBlocks(blocks, []);
    const order = sequence(within, []); // shuffle the blocks themselves: a sequence of blocks
    expect(sorted(order.flat())).toEqual(sorted(blocks.flat()));
  });

  it("study order randomized each cycle, but a cycle may not start with the previous cycle's last item", () => {
    const study = ["p1", "p2", "p3", "p4", "p5"];
    const cycles = sequenceBlocks(rep(study, 4), [noRepeat<string>()]);
    valid(cycles.flat(), [noRepeat<string>()]);
  });

  it("congruency sequences (cC, iC, cI, iI) balanced; trial_order_constraint (Simon / SRC)", () => {
    const trials = [...rep({ cong: "c" }, 64), ...rep({ cong: "i" }, 64)];
    const cs = [balancedTransitions<{ cong: string }>({ key: "cong" })];
    valid(sequence(trials, cs), cs, trials);
  });

  // --- samplers (with replacement) ---------------------------------------------------------
  it("random draw with replacement per trial (independent_random, flanker) - and with a run limit", () => {
    const draw = sampler(["left", "right"], 100);
    expect(sequence(draw, [])).toHaveLength(100);
    const cs = [maxRun<string>({ max: 3 })];
    valid(sequence(draw, cs), cs);
  });

  it("random with replacement but exact proportion of a type (e.g. 25% stop, whole session)", () => {
    const draw = sampler(["stop", "go"], 100, [1, 3]);
    const cs = [exactCount<string>({ key: (x) => x === "stop", values: [true], count: 25 })];
    const out = sequence(draw, cs, { solver: "repair" });
    valid(out, cs);
    expect(out.filter((x) => x === "stop").length).toBe(25);
  });

  // --- allocation ----------------------------------------------------------------------------
  it("allocate: largest remainder, ties to the earlier entry", () => {
    expect(allocate([1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(allocate([0.5, 0.25, 0.25], 10)).toEqual([5, 3, 2]);
    expect(allocate({ high: 0.7, low: 0.3 }, 9)).toEqual({ high: 6, low: 3 });
    expect(allocate([1, 2, 3], 7)).toEqual([1, 2, 4]);
  });
});

// =============================================================================================
// Part 3. Infeasible inputs fail with a message naming the constraint
// =============================================================================================

describe("infeasible inputs", () => {
  const msg = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(SequenceError);
      return e as SequenceError;
    }
    throw new Error("expected SequenceError");
  };

  it("too many of one value for a run limit", () => {
    const e = msg(() => sequence(["a", "a", "a", "a", "b"], [maxRun<string>({ max: 1 })]));
    console.log("[error 1]", e.message);
    expect(e.message).toContain("maxRun(item<=1)");
    expect(e.proven_infeasible).toBe(true);
  });

  it("not enough standards for the requested leading standards", () => {
    const e = msg(() =>
      sequence(["T", "T", "S", "S"], [startWith<string>({ values: ["S"], count: 3 })])
    );
    console.log("[error 2]", e.message);
    expect(e.constraints[0]).toContain("startWith");
  });

  it("an exact count the items cannot give", () => {
    const e = msg(() =>
      sequence(
        ["x", "y", "y", "y"],
        [exactCount<string>({ key: (v) => v === "x", values: [true], count: 2 })]
      )
    );
    console.log("[error 3]", e.message);
    expect(e.constraints[0]).toContain("exactCount");
  });

  it("a whole-sequence rule that repair cannot meet (no allows)", () => {
    const e = msg(() =>
      sequence(["a", "a", "a", "a", "b"], [balancedTransitions<string>()], { max_attempts: 5 })
    );
    console.log("[error 4]", e.message);
    expect(e.constraints[0]).toContain("balancedTransitions");
  });
});
