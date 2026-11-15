/** Timing and uniformity measurements. These print a table; the assertions are loose sanity bounds. */
import seedrandom from "seedrandom";

import {
  SequenceConstraint,
  balancedTransitions,
  blocksOf,
  checkSequence,
  column,
  maxGap,
  maxRun,
  minGap,
  noRepeat,
  sequence,
  sequenceBlocks,
  startWith,
  uniqueWithin,
} from "../src";

const setSeed = (seed: string) => {
  Math.random = seedrandom(seed);
};

const rep = <T>(x: T, n: number) => new Array<T>(n).fill(x);
const ms = (f: () => void) => {
  const t = performance.now();
  f();
  return +(performance.now() - t).toFixed(1);
};
/** Median ms over several seeds; failures counted. */
function bench(label: string, make: (seed: number) => void, runs = 7) {
  const times: number[] = [];
  let failures = 0;
  for (let s = 0; s < runs; s++) {
    setSeed("bench" + s);
    const t = performance.now();
    try {
      make(s);
    } catch {
      failures++;
    }
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const row = `${label.padEnd(58)} median ${times[Math.floor(runs / 2)]
    .toFixed(1)
    .padStart(8)} ms  max ${times[runs - 1]
    .toFixed(1)
    .padStart(8)} ms  failures ${failures}/${runs}`;
  rows.push(row);
  return failures;
}
const rows: string[] = [];
afterAll(() => console.log("\nTIMINGS\n" + rows.join("\n")));

const N = 2;
const kind = (s: string[], i: number) => {
  if (i >= N && s[i] === s[i - N]) return "target";
  if ((i >= N - 1 && s[i] === s[i - (N - 1)]) || (i >= N + 1 && s[i] === s[i - N - 1]))
    return "lure";
  return "";
};
const nBack = (T: number): SequenceConstraint<string> => ({
  name: "nBack",
  allows(prefix, next) {
    const s = [...prefix, next];
    const k = kind(s, s.length - 1);
    if (k === "lure") return false;
    if (k === "target") {
      let t = 0;
      for (let i = 0; i < prefix.length; i++) if (kind(prefix, i) === "target") t++;
      return t + 1 <= T;
    }
    return true;
  },
  violations(seq, start) {
    let t = 0,
      l = 0;
    for (let i = start; i < seq.length; i++) {
      const k = kind(seq, i);
      if (k === "target") t++;
      else if (k === "lure") l++;
    }
    return Math.abs(t - T) + l;
  },
});

describe("speed", () => {
  it("1000 items x 3 neighbour rules", () => {
    const items = [] as { color: string; shape: string; size: string }[];
    for (const color of ["r", "g", "b", "y"])
      for (const shape of ["s", "c", "t", "d", "x"])
        for (const size of ["S", "L"])
          for (let i = 0; i < 25; i++) items.push({ color, shape, size });
    expect(items).toHaveLength(1000);
    const cs = [
      maxRun<(typeof items)[0]>({ key: "color", max: 3 }),
      noRepeat<(typeof items)[0]>({ key: "shape" }),
      maxRun<(typeof items)[0]>({ key: "size", max: 2 }),
    ];
    expect(
      bench("1000 items x 3 neighbour rules, backtrack", () =>
        expect(checkSequence(sequence(items, cs, { solver: "backtrack" }), cs).ok).toBe(true)
      )
    ).toBe(0);
    bench(
      "1000 items x 3 neighbour rules, repair",
      () => sequence(items, cs, { solver: "repair" }),
      3
    );
  });

  it("200-item n-back (8 letters, 2-back, 40 targets, no lures)", () => {
    const items = "BCDFGHJK".split("").flatMap((l) => rep(l, 25));
    const c = [nBack(40)];
    bench("n-back 200, backtrack only", () =>
      sequence(items, c, { solver: "backtrack", max_attempts: 30 })
    );
    bench("n-back 200, repair only", () => sequence(items, c, { solver: "repair" }));
    bench("n-back 200, auto (backtrack, then repair)", () => sequence(items, c));
  });

  it("transition balance", () => {
    const t2 = [...rep({ cong: "c" }, 200), ...rep({ cong: "i" }, 200)];
    const c2 = [balancedTransitions<{ cong: string }>({ key: "cong" })];
    bench("transition balance, 400 trials, 2 types (4 cells), repair", () =>
      expect(checkSequence(sequence(t2, c2), c2).ok).toBe(true)
    );
    const t4 = ["a", "b", "c", "d"].flatMap((x) => rep({ x }, 50));
    const c4 = [balancedTransitions<{ x: string }>({ key: "x", tolerance: 1 })];
    bench("transition balance, 200 trials, 4 types (16 cells, tol 1), repair", () =>
      expect(checkSequence(sequence(t4, c4), c4).ok).toBe(true)
    );
    const c4b = [...c4, maxRun<{ x: string }>({ key: "x", max: 2 })];
    bench("  ... plus maxRun 2", () => sequence(t4, c4b));
  });

  it("other catalogue cases", () => {
    const odd = [...rep("T", 40), ...rep("S", 160)];
    const isT = (x: string) => x === "T";
    const co = [
      startWith<string>({ key: isT, values: [false], count: 15 }),
      minGap<string>({ key: isT, values: [true], gap: 2 }),
      maxGap<string>({ key: isT, values: [true], gap: 7 }),
    ];
    bench("oddball 200 (15 leading, gap 2-7), auto", () => sequence(odd, co));
    const lat = ["A", "B", "C", "D"].flatMap((c) => rep(c, 4));
    bench("Latin 4x4, auto", () =>
      sequence(lat, [
        uniqueWithin<string>({ group: blocksOf(4) }),
        uniqueWithin<string>({ group: column(4) }),
      ])
    );
    const lat6 = ["A", "B", "C", "D", "E", "F"].flatMap((c) => rep(c, 6));
    bench("Latin 6x6, auto", () =>
      sequence(lat6, [
        uniqueWithin<string>({ group: blocksOf(6) }),
        uniqueWithin<string>({ group: column(6) }),
      ])
    );
    const unit = [...rep("AX", 7), "AY", "BX", "BY"];
    bench("AX-CPT 120 trials in 12 chunks, maxRun AX 5", () =>
      sequenceBlocks(rep(unit, 12), [maxRun<string>({ values: ["AX"], max: 5 })])
    );
  });
});

describe("uniformity: backtrack vs rejection", () => {
  function perms<T>(a: T[]): T[][] {
    if (a.length <= 1) return [a];
    const seen = new Set<string>();
    const out: T[][] = [];
    a.forEach((x, i) => {
      const k = JSON.stringify(x);
      if (seen.has(k)) return;
      seen.add(k);
      for (const p of perms([...a.slice(0, i), ...a.slice(i + 1)])) out.push([x, ...p]);
    });
    return out;
  }
  function compare(
    label: string,
    items: string[],
    cs: SequenceConstraint<string>[],
    draws = 60000
  ) {
    const valid = perms(items).filter((p) => checkSequence(p, cs).ok);
    const result: Record<string, { chi2: number; ratio: number; maxdev: number }> = {};
    for (const solver of ["backtrack", "rejection"] as const) {
      setSeed("uniformity-" + solver);
      const counts = new Map(valid.map((p) => [p.join(""), 0]));
      for (let i = 0; i < draws; i++) {
        const k = sequence(items, cs, { solver }).join("");
        counts.set(k, counts.get(k)! + 1);
      }
      const e = draws / valid.length;
      const vals = [...counts.values()];
      const chi2 = vals.reduce((s, o) => s + (o - e) ** 2 / e, 0);
      result[solver] = {
        chi2: +chi2.toFixed(1),
        ratio: +(Math.max(...vals) / Math.min(...vals)).toFixed(2),
        maxdev: +((Math.max(...vals) / e - 1) * 100).toFixed(1),
      };
    }
    const line =
      `${label}: ${valid.length} valid orders, ${draws} draws each (chi2 df=${
        valid.length - 1
      }; ~df expected if uniform) -> ` + JSON.stringify(result);
    rows.push(line);
    return result;
  }
  it("small cases", () => {
    const a = compare(
      "aabbc, no immediate repeat",
      ["a", "a", "b", "b", "c"],
      [noRepeat<string>()]
    );
    expect(a.rejection.ratio).toBeLessThan(1.3);
    compare("aaabbc, max run 1 (no repeat)", ["a", "a", "a", "b", "b", "c"], [noRepeat<string>()]);
    compare(
      "aabbcc, at least 2 items between the two c",
      ["a", "a", "b", "b", "c", "c"],
      [minGap<string>({ values: ["c"], gap: 2 })]
    );
  });
});

describe("time to fail on infeasible inputs of realistic size", () => {
  const time = (label: string, f: () => void) => {
    setSeed("inf");
    const t = performance.now();
    let msg = "(NO ERROR)";
    try {
      f();
    } catch (e: any) {
      msg = e.message.slice(0, 170);
    }
    rows.push(`[infeasible] ${label}: ${(performance.now() - t).toFixed(0)} ms -> ${msg}`);
  };
  it("fails fast", () => {
    const isT = (x: string) => x === "T";
    for (const n of [200, 1000]) {
      const items = [...rep("T", n * 0.4), ...rep("S", n * 0.6)];
      time(`minGap 2 on ${n * 0.4} targets of ${n}`, () =>
        sequence(items, [minGap<string>({ key: isT, values: [true], gap: 2 })])
      );
    }
    time("maxRun 1 on 120 a / 80 b", () =>
      sequence([...rep("a", 120), ...rep("b", 80)], [maxRun<string>({ max: 1 })])
    );
    time("noRepeat within 5 on 4 symbols x 50", () =>
      sequence(
        ["a", "b", "c", "d"].flatMap((x) => rep(x, 50)),
        [noRepeat<string>({ within: 5 })]
      )
    );
    time("contradictory rules: balanced transitions + no repeat (100 a, 100 b)", () =>
      sequence(
        [...rep("a", 100), ...rep("b", 100)],
        [balancedTransitions<string>(), noRepeat<string>()]
      )
    );
    time("same, 1000 items", () =>
      sequence(
        [...rep("a", 500), ...rep("b", 500)],
        [balancedTransitions<string>(), noRepeat<string>()]
      )
    );
    time("transitions impossible (200 a, 1 b)", () =>
      sequence([...rep("a", 200), "b"], [balancedTransitions<string>()])
    );
  });
});
