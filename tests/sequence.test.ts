import seedrandom from "seedrandom";

import {
  SequenceError,
  checkSequence,
  createSequencer,
  maxGap,
  maxRun,
  minGap,
  noRepeat,
  sequence,
  startWith,
} from "../src";

const setSeed = (seed: string) => {
  Math.random = seedrandom(seed);
};

describe("sequence basics", () => {
  it("runs the README example", () => {
    const items = [...Array(170).fill("S"), ...Array(30).fill("T")];
    const isTarget = (x: string) => x === "T";
    const rules = [
      startWith<string>({ key: isTarget, values: [false], count: 15 }),
      minGap<string>({ key: isTarget, values: [true], gap: 2 }),
      maxGap<string>({ key: isTarget, values: [true], gap: 7 }),
    ];
    const order = sequence(items, rules);
    expect(checkSequence(order, rules).ok).toBe(true);
    expect(order.filter(isTarget)).toHaveLength(30);
  });

  it("is reproducible with the rng option, without touching Math.random", () => {
    const items = "aabbccdd".split("");
    const original = Math.random;
    const a = sequence(items, [noRepeat<string>()], { rng: seedrandom("y") });
    const b = sequence(items, [noRepeat<string>()], { rng: seedrandom("y") });
    expect(b).toEqual(a);
    expect(Math.random).toBe(original);
    const cs = [noRepeat<string>()];
    for (const solver of ["backtrack", "repair", "rejection"] as const) {
      expect(sequence(items, cs, { solver, rng: seedrandom("z") })).toEqual(
        sequence(items, cs, { solver, rng: seedrandom("z") })
      );
    }
  });

  it("createSequencer is reproducible with the rng option", () => {
    const run = () => {
      const s = createSequencer("aabbccdd".split(""), [noRepeat<string>()], {
        rng: seedrandom("w"),
      });
      return Array.from({ length: 8 }, () => s.next());
    };
    expect(run()).toEqual(run());
  });

  it("is reproducible under setSeed", () => {
    const items = "aabbccdd".split("");
    setSeed("x");
    const a = sequence(items, [noRepeat<string>()]);
    setSeed("x");
    expect(sequence(items, [noRepeat<string>()])).toEqual(a);
  });

  it("all solvers satisfy the constraints and keep the items", () => {
    const items = "aaaabbbbcccc".split("");
    const cs = [maxRun<string>({ max: 2 })];
    for (const solver of ["auto", "backtrack", "repair", "rejection"] as const) {
      const out = sequence(items, cs, { solver });
      expect(checkSequence(out, cs).ok).toBe(true);
      expect([...out].sort()).toEqual([...items].sort());
    }
  });

  it("after: constraints see earlier items", () => {
    const after = ["a", "a"];
    for (let s = 0; s < 20; s++) {
      setSeed("after" + s);
      const out = sequence(["a", "b", "b"], [maxRun<string>({ max: 2 })], { after });
      expect(out[0]).not.toBe("a");
    }
    expect(
      checkSequence(["a"], [maxRun<string>({ max: 2 })], { after }).failures[0].positions
    ).toEqual([0]);
  });

  it("checkSequence reports where", () => {
    const r = checkSequence(
      ["a", "b", "b", "b", "c"],
      [maxRun<string>({ max: 2 }), noRepeat<string>()]
    );
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0].positions).toEqual([1, 2, 3]);
  });

  it("a constraint with only violations() works", () => {
    const evenFirst = {
      name: "evenFirst",
      violations: (s: number[], st: number) => (s[st] % 2 === 0 ? 0 : 1),
    };
    expect(sequence([1, 2, 3, 4], [evenFirst])[0] % 2).toBe(0);
  });

  it("createSequencer draws a multiset; one-step lookahead may corner itself and then says so", () => {
    const items = "aabbccdd".split("");
    const cs = [noRepeat<string>(), startWith<string>({ values: ["a"] })];
    let cornered = 0;
    for (let s = 0; s < 40; s++) {
      setSeed("seq" + s);
      const q = createSequencer(items, cs);
      try {
        for (let i = 0; i < items.length; i++) q.next();
      } catch (e) {
        expect(e).toBeInstanceOf(SequenceError);
        cornered++;
        continue;
      }
      expect(checkSequence(q.issued, cs).ok).toBe(true);
    }
    console.log("sequencer cornered in", cornered, "of 40 runs");
  });
});
