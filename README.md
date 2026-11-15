# @jspsych/sequencer

Random orders that satisfy constraints: no more than 3 incongruent trials in a row, at least 2 trials between targets, the first 15 trials are standards, each condition follows every other equally often, or any rule you write yourself.

It has no dependency on jsPsych and works in any JavaScript or TypeScript project.

```sh
npm install @jspsych/sequencer
```

```js
import { sequence, startWith, minGap, maxGap } from "@jspsych/sequencer";

const items = [...Array(170).fill("S"), ...Array(30).fill("T")];
const isTarget = (x) => x === "T";

const order = sequence(items, [
  startWith({ key: isTarget, values: [false], count: 15 }),
  minGap({ key: isTarget, values: [true], gap: 2 }),
  maxGap({ key: isTarget, values: [true], gap: 7 }),
]);
```

In the browser without a bundler:

```html
<script src="https://unpkg.com/@jspsych/sequencer"></script>
<script>
  const { sequence, noRepeat } = jsPsychSequencer;
</script>
```

## Development

```sh
npm install
npm test          # jest
npm run tsc       # type check
npm run build     # dist/: ESM, CommonJS, browser (global jsPsychSequencer), types
npx changeset     # describe a change for the next release
```

Releases go through changesets: merging to `main` opens a version PR, and merging that PR publishes to npm from CI.

## Concepts

- **Items** are permuted (`sequence(items, ...)`), or drawn with replacement from a sampler (`sequence(sampler(items, 200), ...)`).
- **Constraints** are plain objects with a `violations(seq, start)` function. Optional `allows`, `feasible` and `positions` hooks let solvers prune or focus repairs. The built-in rules are factories over this interface; your own rules use the same interface.
- **`key`** picks what a rule compares: omitted (the item itself), a property name, or a function of the item. **`values`** limits the rule to some key values (an array, or a predicate). The run and gap rules apply to every key value when `values` is omitted. The counting rules (`startWith`, `exactCount`, `countBetween`, `windowCount`) require `values`: `exactCount({ key: isTarget, values: [true], count: 40 })`.
- **`after`** passes items already presented (an earlier block), so rules hold across the boundary. `sequenceBlocks()` does this for a list of blocks.

Orders are generated before the trials run. Rules that depend on the participant's responses (for example, reversing after 8 correct in a row) are not covered; write those as task logic.

## Built-in rules

`maxRun`, `runLength`, `noRepeat`, `minGap`, `maxGap`, `startWith`, `exactCount`, `countBetween`, `windowCount`, `uniqueWithin` (with `blocksOf`, `column`), `forbidPattern`, `balancedTransitions`.

## Solvers

| `solver`           | Method                                                                         | Uniform over valid orders?              |
| ------------------ | ------------------------------------------------------------------------------ | --------------------------------------- |
| `"backtrack"`      | randomized depth-first search with restarts                                    | no                                      |
| `"repair"`         | shuffle, then swap to remove violations                                        | no                                      |
| `"rejection"`      | reshuffle until valid                                                          | yes, but only practical for loose rules |
| `"auto"` (default) | backtrack when every rule has `allows`, otherwise repair; falls back to repair | no                                      |

The default, `"auto"`, is fast, but some valid orders come up more often than others (in small tests, up to about 4 times as often). If exact uniformity matters (for example, when transition statistics are themselves a measure), use `"rejection"` or check the realized statistics. See French & Perruchet (2009), _Behavior Research Methods_, 41(4), 1233–1241, on how constrained generation biases frequencies.

## Reproducibility

Pass `rng`, a function returning numbers in [0, 1):

```js
import seedrandom from "seedrandom";
sequence(items, rules, { rng: seedrandom("participant-12") });
```

Without `rng`, `Math.random` is used, so in jsPsych `jsPsych.randomization.setSeed()` also applies.

## Errors

`sequence()` throws a `SequenceError` naming the rules that block it. `proven_infeasible` is `true` when counting shows no valid order exists. A `time_limit` (default 3000 ms) stops searches that are infeasible or very hard. `checkSequence(seq, rules)` reports which rules a given order breaks, and where.
