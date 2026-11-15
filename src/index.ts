/**
 * @jspsych/sequencer: constrained random orders for experiment trials (or anything else).
 * Pure logic: no DOM, no timing, no dependency on jsPsych.
 *
 * A sequence is built from a set of items (or a sampler) and a list of constraints. A constraint
 * is an open protocol (`SequenceConstraint`): anything with a `violations()` function is one, and
 * the optional `allows()` / `feasible()` / `positions()` hooks let a solver prune the search or
 * focus its repairs. The built-in constraints below are factories over that protocol.
 *
 * Randomness comes from the `rng` option (a function returning a number in [0, 1)). The default
 * is `Math.random`, read at call time, so a seeded global such as `jsPsych.randomization.setSeed()`
 * also makes every result reproducible.
 *
 * Continuity: `after` is the list of items that were already presented. Constraints see
 * `after.concat(candidate)` plus `start = after.length`, the index where the new items begin.
 * Neighbour-type rules (runs, gaps) look across the boundary; counting rules only count the new
 * items (indices >= start).
 */

// ---------------------------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------------------------

export interface SequenceConstraint<T> {
  /** Shown in error messages and by `checkSequence()`. */
  name: string;
  /**
   * Incremental check used for pruning: may `next` be appended to `prefix`? `prefix` includes any
   * `after` items; `start` is the index of the first new item. Must not mutate `prefix`.
   * Return `true` when unsure. A constraint without `allows` can still be used (the repair and
   * rejection solvers, and a final check in backtracking).
   */
  allows?(prefix: T[], next: T, start: number): boolean;
  /** Number of violations in a complete sequence (0 = satisfied). Required. */
  violations(seq: T[], start: number): number;
  /**
   * Optional early failure: given `prefix` (already placed) and the items `remaining` to place,
   * return `false` if no completion can satisfy this constraint. Must be cheap and may be
   * incomplete (return `true` when unsure).
   */
  feasible?(prefix: T[], remaining: T[], start: number): boolean;
  /** Optional: indices (into `seq`) implicated in violations. Used by `repair` and `checkSequence`. */
  positions?(seq: T[], start: number): number[];
}

/** A property name, or a function of the item (and its index in the full sequence). */
export type Key<T> = string | ((item: T, index: number) => unknown);
/** Restrict a rule to some key values: an array of values or a predicate. */
export type Values = unknown[] | ((value: unknown) => boolean);

/** A source of items drawn with replacement, e.g. `trial_order: 'random'`. */
export interface SequenceSampler<T> {
  /** Number of items to draw. */
  n: number;
  draw(): T;
}

export type SequenceSolver = "auto" | "backtrack" | "repair" | "rejection";

export interface SequenceOptions<T> {
  /**
   * `'backtrack'`: randomized depth-first search with restarts, using `allows`/`feasible`.
   * Fast; not exactly uniform. `'repair'`: shuffle, then swap items to reduce total violations.
   * Handles whole-sequence rules; not uniform. `'rejection'`: reshuffle until there are no
   * violations; exactly uniform over valid orders, but only practical for loose constraints.
   * `'auto'` (default): backtrack if every constraint has `allows`, otherwise repair; if
   * backtracking fails it falls back to repair.
   */
  solver?: SequenceSolver;
  /** Items already presented (earlier block, earlier chunk) that the constraints should see. */
  after?: T[];
  /** Restarts (backtrack, repair) or reshuffles (rejection). Default 30 / 10 / 20000. */
  max_attempts?: number;
  /** Backtrack: search nodes per attempt. Default `10 * n + 500`. */
  max_nodes?: number;
  /**
   * Safety net: give up (with a SequenceError) after this many milliseconds. Default 3000. Only
   * matters for inputs that are infeasible or very hard; it does not affect which sequence a
   * feasible input produces unless it fires.
   */
  time_limit?: number;
  /** Random number source returning values in [0, 1). Default `Math.random` (read at call time). */
  rng?: () => number;
}

/** The random number source for the call in progress (see `withRng`). */
let random: () => number = () => Math.random();

/** Run `fn` with `rng` as the random source; synchronous, restores the previous source after. */
function withRng<R>(rng: (() => number) | undefined, fn: () => R): R {
  const prev = random;
  random = rng ?? (() => Math.random());
  try {
    return fn();
  } finally {
    random = prev;
  }
}

export class SequenceError extends Error {
  /** Names of the constraints that blocked the search or were still violated. */
  readonly constraints: string[];
  /** `true` if the search was exhausted, i.e. no valid order exists (backtrack only). */
  readonly proven_infeasible: boolean;
  constructor(message: string, constraints: string[], proven_infeasible = false) {
    super(message);
    this.name = "SequenceError";
    this.constraints = constraints;
    this.proven_infeasible = proven_infeasible;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function shuffled<T>(a: T[]): T[] {
  const c = a.slice();
  for (let m = c.length; m > 1; ) {
    const i = Math.floor(random() * m--);
    const t = c[m];
    c[m] = c[i];
    c[i] = t;
  }
  return c;
}

/**
 * Items that are interchangeable for the search: primitives by value, flat objects (all values
 * primitive) by content, anything else by reference. Lets backtracking skip duplicate branches
 * when a multiset contains many copies of the same trial object.
 */
const signatures = new WeakMap<object, string>();
function signature(item: unknown): unknown {
  if (typeof item !== "object" || item === null) return item;
  let s = signatures.get(item);
  if (s === undefined) {
    const vals = Object.values(item);
    if (vals.every((v) => typeof v !== "object" && typeof v !== "function"))
      s = JSON.stringify(item);
    else return item;
    signatures.set(item, s);
  }
  return s;
}

function keyFn<T>(key?: Key<T>): (item: T, index: number) => unknown {
  if (key === undefined) return (item) => item;
  if (typeof key === "function") return key;
  return (item) => (item as any)?.[key];
}

function keyName(key: Key<any> | undefined) {
  return key === undefined ? "item" : typeof key === "string" ? key : key.name || "key()";
}

function valueTest(values?: Values): (v: unknown) => boolean {
  if (values === undefined) return () => true;
  if (typeof values === "function") return values;
  return (v) => values.includes(v);
}

/** Membership of the key value in `values`: used by the counting rules, which require `values`. */
function matcher<T>(
  rule: string,
  key: Key<T> | undefined,
  values: Values | undefined
): (item: T, index: number) => boolean {
  if (values === undefined)
    throw new TypeError(
      `${rule}(): \`values\` is required: the key values to count, e.g. { key: isTarget, values: [true] }.`
    );
  const k = keyFn(key);
  const t = valueTest(values);
  return (item, i) => t(k(item, i));
}

const fmt = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x));
const valuesName = (v?: Values) =>
  v === undefined ? "" : typeof v === "function" ? "|filter" : `|${fmt(v)}`;

// ---------------------------------------------------------------------------------------------
// Built-in constraints
// ---------------------------------------------------------------------------------------------

export interface RunOptions<T> {
  key?: Key<T>;
  /** Only runs of these key values are constrained. */
  values?: Values;
}

export interface RunLengthOptions<T> extends RunOptions<T> {
  /** Minimum length of a completed run (the final run of the sequence is exempt). */
  min?: number;
  /** Maximum run length. */
  max?: number;
  /** Completed runs must have one of these lengths (the final run is exempt). */
  allowed?: number[];
}

/** Runs (consecutive items with the same key value) have length within `min`/`max`/`allowed`. */
export function runLength<T>(opts: RunLengthOptions<T>): SequenceConstraint<T> {
  const k = keyFn(opts.key);
  const applies = valueTest(opts.values);
  const { min, max, allowed } = opts;
  const cap = Math.min(max ?? Infinity, allowed ? Math.max(...allowed) : Infinity);
  const trailing = (p: T[]) => {
    let r = 1;
    const v = k(p[p.length - 1], p.length - 1);
    while (r < p.length && k(p[p.length - 1 - r], p.length - 1 - r) === v) r++;
    return r;
  };
  const okCompleted = (len: number) =>
    (min === undefined || len >= min) && (!allowed || allowed.includes(len));
  const scan = (seq: T[], start: number) => {
    const bad: { count: number; from: number; to: number }[] = [];
    let i = 0;
    while (i < seq.length) {
      const v = k(seq[i], i);
      let j = i;
      while (j + 1 < seq.length && k(seq[j + 1], j + 1) === v) j++;
      if (applies(v) && j >= start) {
        const len = j - i + 1;
        let count = 0;
        if (max !== undefined && len > max) {
          for (let x = i + max; x <= j; x++) if (x >= start) count++;
        }
        if (j < seq.length - 1 && !okCompleted(len)) count += Math.max(1, (min ?? 0) - len);
        if (count) bad.push({ count, from: i, to: j });
      }
      i = j + 1;
    }
    return bad;
  };
  const parts = [
    min !== undefined && `>=${min}`,
    max !== undefined && `<=${max}`,
    allowed && `in ${fmt(allowed)}`,
  ].filter(Boolean);
  return {
    name: `runLength(${keyName(opts.key)}${valuesName(opts.values)} ${parts.join(",")})`,
    allows(prefix, next) {
      if (prefix.length === 0) return true;
      const li = prefix.length - 1;
      const lv = k(prefix[li], li);
      if (lv === k(next, prefix.length)) {
        return !applies(lv) || trailing(prefix) + 1 <= cap;
      }
      return !applies(lv) || okCompleted(trailing(prefix));
    },
    feasible(prefix, remaining) {
      if (remaining.length === 0) return true;
      if (cap !== Infinity) {
        // Pigeonhole: the remaining items of a value must fit into runs of at most `cap`,
        // separated by the other remaining items.
        const counts = new Map<unknown, number>();
        for (let i = 0; i < remaining.length; i++) {
          const v = k(remaining[i], prefix.length + i);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const li = prefix.length - 1;
        const lv = prefix.length ? k(prefix[li], li) : undefined;
        for (const [v, c] of counts) {
          if (!applies(v)) continue;
          const first = prefix.length && lv === v ? cap - trailing(prefix) : cap;
          if (c > first + (remaining.length - c) * cap) return false;
        }
      }
      if (prefix.length === 0 || (min === undefined && !allowed)) return true;
      const li = prefix.length - 1;
      const lv = k(prefix[li], li);
      if (!applies(lv)) return true;
      const len = trailing(prefix);
      let more = 0; // same-valued items left to extend the run
      for (let i = 0; i < remaining.length; i++)
        if (k(remaining[i], prefix.length + i) === lv) more++;
      // The run can end at any length in [len, len + more] (after the last candidate it ends).
      for (let l = len; l <= len + more; l++) if (l <= cap && okCompleted(l)) return true;
      return false;
    },
    violations: (seq, start) => scan(seq, start).reduce((s, b) => s + b.count, 0),
    positions(seq, start) {
      const out: number[] = [];
      for (const b of scan(seq, start)) for (let x = b.from; x <= b.to; x++) out.push(x);
      return out;
    },
  };
}

/** At most `max` consecutive items with the same key value. */
export function maxRun<T>(opts: RunOptions<T> & { max: number }): SequenceConstraint<T> {
  const c = runLength<T>({ key: opts.key, values: opts.values, max: opts.max });
  return { ...c, name: `maxRun(${keyName(opts.key)}${valuesName(opts.values)}<=${opts.max})` };
}

export interface GapOptions<T> extends RunOptions<T> {
  gap: number;
}

/** Between two items with the same key value there are at least `gap` other items. */
export function minGap<T>(opts: GapOptions<T>): SequenceConstraint<T> {
  const k = keyFn(opts.key);
  const applies = valueTest(opts.values);
  const gap = opts.gap;
  const bad = (seq: T[], i: number) => {
    const v = k(seq[i], i);
    if (!applies(v)) return false;
    for (let j = Math.max(0, i - gap); j < i; j++) if (k(seq[j], j) === v) return true;
    return false;
  };
  return {
    name: `minGap(${keyName(opts.key)}${valuesName(opts.values)}>=${gap})`,
    allows(prefix, next) {
      const i = prefix.length;
      const v = k(next, i);
      if (!applies(v)) return true;
      for (let j = Math.max(0, i - gap); j < i; j++) if (k(prefix[j], j) === v) return false;
      return true;
    },
    feasible(prefix, remaining) {
      // Counting bound: c items of one value need (c - 1) * (gap + 1) + 1 positions.
      const counts = new Map<unknown, number>();
      for (let i = 0; i < remaining.length; i++) {
        const v = k(remaining[i], prefix.length + i);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      for (const [v, c] of counts) {
        if (!applies(v)) continue;
        let offset = 0; // earliest slot, given the last occurrence in the prefix
        for (let j = prefix.length - 1; j >= Math.max(0, prefix.length - gap); j--) {
          if (k(prefix[j], j) === v) {
            offset = gap - (prefix.length - 1 - j);
            break;
          }
        }
        if ((c - 1) * (gap + 1) + 1 + offset > remaining.length) return false;
      }
      return true;
    },
    violations(seq, start) {
      let n = 0;
      for (let i = start; i < seq.length; i++) if (bad(seq, i)) n++;
      return n;
    },
    positions(seq, start) {
      const out: number[] = [];
      for (let i = start; i < seq.length; i++) if (bad(seq, i)) out.push(i);
      return out;
    },
  };
}

/** No item has the same key value as one of the previous `within` items (default 1: no immediate repeat). */
export function noRepeat<T>(opts: RunOptions<T> & { within?: number } = {}): SequenceConstraint<T> {
  const within = opts.within ?? 1;
  const c = minGap<T>({ key: opts.key, values: opts.values, gap: within });
  return {
    ...c,
    name: `noRepeat(${keyName(opts.key)}${valuesName(opts.values)}, within ${within})`,
  };
}

/** Between consecutive items with the same key value there are at most `gap` other items. */
export function maxGap<T>(opts: GapOptions<T>): SequenceConstraint<T> {
  const k = keyFn(opts.key);
  const applies = valueTest(opts.values);
  const gap = opts.gap;
  const lastIndex = (seq: T[], v: unknown, before: number) => {
    for (let j = before - 1; j >= 0; j--) if (k(seq[j], j) === v) return j;
    return -1;
  };
  const bad = (seq: T[], i: number) => {
    const v = k(seq[i], i);
    if (!applies(v)) return false;
    const j = lastIndex(seq, v, i);
    return j >= 0 && i - j - 1 > gap;
  };
  return {
    name: `maxGap(${keyName(opts.key)}${valuesName(opts.values)}<=${gap})`,
    allows(prefix, next) {
      const i = prefix.length;
      const v = k(next, i);
      if (!applies(v)) return true;
      const j = lastIndex(prefix, v, i);
      return j < 0 || i - j - 1 <= gap;
    },
    feasible(prefix, remaining) {
      // A value whose current gap already exceeds the limit must not appear again.
      const seen = new Set<unknown>();
      for (let r = 0; r < remaining.length; r++) {
        const v = k(remaining[r], prefix.length + r);
        if (seen.has(v)) continue;
        seen.add(v);
        if (!applies(v)) continue;
        const j = lastIndex(prefix, v, prefix.length);
        if (j >= 0 && prefix.length - j > gap) return false;
      }
      return true;
    },
    violations(seq, start) {
      let n = 0;
      for (let i = start; i < seq.length; i++) if (bad(seq, i)) n++;
      return n;
    },
    positions(seq, start) {
      const out: number[] = [];
      for (let i = start; i < seq.length; i++) if (bad(seq, i)) out.push(i);
      return out;
    },
  };
}

/** The first `count` new items (default 1) have a key value in `values`. */
export function startWith<T>(opts: {
  key?: Key<T>;
  /** Required: the key values the first items must have. */
  values: Values;
  count?: number;
}): SequenceConstraint<T> {
  const m = matcher("startWith", opts.key, opts.values);
  const count = opts.count ?? 1;
  return {
    name: `startWith(${keyName(opts.key)}${valuesName(opts.values)} x${count})`,
    allows(prefix, next, start) {
      const r = prefix.length - start;
      return r >= count || m(next, prefix.length);
    },
    feasible(prefix, remaining, start) {
      const need = count - (prefix.length - start);
      if (need <= 0) return true;
      let have = 0;
      for (let i = 0; i < remaining.length && have < need; i++)
        if (m(remaining[i], prefix.length + i)) have++;
      return have >= need;
    },
    violations(seq, start) {
      let n = 0;
      for (let i = start; i < Math.min(seq.length, start + count); i++) if (!m(seq[i], i)) n++;
      return n;
    },
    positions(seq, start) {
      const out: number[] = [];
      for (let i = start; i < Math.min(seq.length, start + count); i++)
        if (!m(seq[i], i)) out.push(i);
      return out;
    },
  };
}

export interface CountOptions<T> {
  key?: Key<T>;
  /** Required: the key values to count. */
  values: Values;
  min?: number;
  max?: number;
  exactly?: number;
  /** Count only positions in [from, to) of the new items (`to` may be `Infinity`). Default: all. */
  range?: [number, number];
  /** Apply to every window of `size` new items, moving `step` at a time (default 1 = sliding). */
  window?: { size: number; step?: number };
}

function countConstraint<T>(name: string, opts: CountOptions<T>): SequenceConstraint<T> {
  const m = matcher(name.slice(0, name.indexOf("(")), opts.key, opts.values);
  const min = opts.exactly ?? opts.min ?? 0;
  const max = opts.exactly ?? opts.max ?? Infinity;
  // Windows [a, b) in new-item coordinates that contain relative position r.
  const containing = (r: number): [number, number][] => {
    if (opts.window) {
      const { size, step = 1 } = opts.window;
      const out: [number, number][] = [];
      for (let k = Math.max(0, Math.ceil((r - size + 1) / step)); k * step <= r; k++)
        out.push([k * step, k * step + size]);
      return out;
    }
    const [from, to] = opts.range ?? [0, Infinity];
    return r >= from && r < to ? [[from, to]] : [];
  };
  const evaluate = (seq: T[], start: number) => {
    const n = seq.length - start;
    const hits = new Array<boolean>(n);
    for (let r = 0; r < n; r++) hits[r] = m(seq[start + r], start + r);
    const wins: [number, number][] = [];
    if (opts.window) {
      const { size, step = 1 } = opts.window;
      for (let a = 0; a < n; a += step) wins.push([a, a + size]);
    } else {
      wins.push(opts.range ?? [0, Infinity]);
    }
    let total = 0;
    const where: number[] = [];
    for (const [a, b] of wins) {
      const e = Math.min(b, n);
      let c = 0;
      for (let r = a; r < e; r++) if (hits[r]) c++;
      const complete = b <= n || b === Infinity;
      const v = Math.max(0, c - max) + (complete ? Math.max(0, min - c) : 0);
      if (v) {
        total += v;
        for (let r = a; r < e; r++) where.push(start + r);
      }
    }
    return { total, where };
  };
  return {
    name,
    allows(prefix, next, start) {
      const r = prefix.length - start;
      const mine = m(next, prefix.length);
      for (const [a, b] of containing(r)) {
        let c = mine ? 1 : 0;
        for (let x = a; x < r; x++) if (m(prefix[start + x], start + x)) c++;
        if (c > max) return false;
        if (b !== Infinity && r === b - 1 && c < min) return false;
      }
      return true;
    },
    feasible(prefix, remaining, start) {
      const r = prefix.length - start; // next position to fill
      const n = r + remaining.length;
      let remMatch = 0;
      for (let i = 0; i < remaining.length; i++) if (m(remaining[i], prefix.length + i)) remMatch++;
      const remNon = remaining.length - remMatch;
      for (const [a, b] of containing(r)) {
        const e = Math.min(b, n);
        let c = 0;
        for (let x = a; x < r; x++) if (m(prefix[start + x], start + x)) c++;
        const slots = Math.max(0, e - Math.max(r, a));
        const complete = b <= n || b === Infinity;
        if (complete && c + Math.min(slots, remMatch) < min) return false;
        if (c + Math.max(0, slots - remNon) > max) return false;
      }
      return true;
    },
    violations: (seq, start) => evaluate(seq, start).total,
    positions: (seq, start) => evaluate(seq, start).where,
  };
}

/** Exactly `count` of the new items have a key value in `values`; optionally within `range`. */
export function exactCount<T>(
  opts: Omit<CountOptions<T>, "min" | "max" | "exactly" | "window"> & { count: number }
): SequenceConstraint<T> {
  return countConstraint(
    `exactCount(${keyName(opts.key)}${valuesName(opts.values)}=${opts.count})`,
    {
      ...opts,
      exactly: opts.count,
    }
  );
}

/** Between `min` and `max` of the new items match; optionally within `range`. */
export function countBetween<T>(
  opts: Omit<CountOptions<T>, "exactly" | "window">
): SequenceConstraint<T> {
  return countConstraint(
    `countBetween(${keyName(opts.key)}${valuesName(opts.values)} in [${opts.min ?? 0},${
      opts.max ?? "inf"
    }])`,
    opts
  );
}

/**
 * Every window of `size` new items (sliding by `step`, default 1; use `step: size` for aligned
 * chunks) has between `min` and `max` (or exactly `exactly`) matching items. Only complete
 * windows are held to `min`.
 */
export function windowCount<T>(
  opts: Omit<CountOptions<T>, "window" | "range"> & { size: number; step?: number }
): SequenceConstraint<T> {
  return countConstraint(
    `windowCount(${keyName(opts.key)}${valuesName(opts.values)} size ${opts.size}${
      opts.step ? " step " + opts.step : ""
    } in [${opts.exactly ?? opts.min ?? 0},${opts.exactly ?? opts.max ?? "inf"}])`,
    { ...opts, window: { size: opts.size, step: opts.step } }
  );
}

/** Group function for `uniqueWithin`: consecutive blocks of `size` new items. */
export const blocksOf = (size: number) => (r: number) => Math.floor(r / size);
/** Group function for `uniqueWithin`: every `k`-th position (the columns of a k-wide table). */
export const column = (k: number) => (r: number) => r % k;

/**
 * No two items in the same group have the same key value. `group` maps the index of a new item
 * (0 = first new item) to a group id; see `blocksOf` and `column`.
 */
export function uniqueWithin<T>(
  opts: RunOptions<T> & { group: (r: number) => unknown }
): SequenceConstraint<T> {
  const k = keyFn(opts.key);
  const applies = valueTest(opts.values);
  const dup = (seq: T[], start: number, i: number) => {
    const v = k(seq[i], i);
    if (!applies(v)) return false;
    const g = opts.group(i - start);
    for (let j = start; j < i; j++)
      if (opts.group(j - start) === g && k(seq[j], j) === v) return true;
    return false;
  };
  return {
    name: `uniqueWithin(${keyName(opts.key)}${valuesName(opts.values)})`,
    allows: (prefix, next, start) => !dup([...prefix, next], start, prefix.length),
    violations(seq, start) {
      let n = 0;
      for (let i = start; i < seq.length; i++) if (dup(seq, start, i)) n++;
      return n;
    },
    positions(seq, start) {
      const out: number[] = [];
      for (let i = start; i < seq.length; i++) if (dup(seq, start, i)) out.push(i);
      return out;
    },
  };
}

/**
 * Forbid a pattern in any `size` consecutive items (default 2: adjacent pairs). `bad` receives the
 * window (oldest first) and returns `true` if it is not allowed. Items before `start` can be part
 * of a window, so patterns are checked across block boundaries.
 */
export function forbidPattern<T>(opts: {
  size?: number;
  bad: (window: T[]) => boolean;
  name?: string;
}): SequenceConstraint<T> {
  const size = opts.size ?? 2;
  const badAt = (seq: T[], end: number) =>
    end + 1 >= size && opts.bad(seq.slice(end + 1 - size, end + 1));
  return {
    name: opts.name ?? `forbidPattern(size ${size})`,
    allows: (prefix, next) => !badAt(prefix.concat([next]), prefix.length),
    violations(seq, start) {
      let n = 0;
      for (let i = start; i < seq.length; i++) if (badAt(seq, i)) n++;
      return n;
    },
    positions(seq, start) {
      const out: number[] = [];
      for (let i = start; i < seq.length; i++) if (badAt(seq, i)) out.push(i);
      return out;
    },
  };
}

/**
 * First-order transition balance: every kind of transition (previous item -> current item) occurs
 * equally often, within `tolerance` of the mean. By default a transition is the ordered pair of
 * key values; pass `classify` (and `cells`, the labels that must be balanced; transitions with other labels are ignored) to define
 * your own, e.g. "task repeat/switch x cue repeat/switch". Whole-sequence rule: no `allows`,
 * so it uses the repair solver. The boundary pair (last `after` item -> first new item) counts.
 */
export function balancedTransitions<T>(
  opts: {
    key?: Key<T>;
    classify?: (prev: T, cur: T) => string;
    cells?: string[];
    tolerance?: number;
  } = {}
): SequenceConstraint<T> {
  const k = keyFn(opts.key);
  const tol = opts.tolerance ?? 0;
  const label = (seq: T[], i: number) =>
    opts.classify
      ? opts.classify(seq[i - 1], seq[i])
      : JSON.stringify([k(seq[i - 1], i - 1), k(seq[i], i)]);
  const tally = (seq: T[], start: number) => {
    const counts = new Map<string, number>();
    let pairs = 0;
    for (let i = Math.max(1, start); i < seq.length; i++) {
      const id = label(seq, i);
      if (opts.cells && !opts.cells.includes(id)) continue; // only the listed kinds are balanced
      counts.set(id, (counts.get(id) ?? 0) + 1);
      pairs++;
    }
    let cells = opts.cells;
    if (!cells) {
      const vals = new Set<unknown>();
      for (let i = start; i < seq.length; i++) vals.add(k(seq[i], i));
      cells = [];
      for (const a of vals) for (const b of vals) cells.push(JSON.stringify([a, b]));
    }
    return { counts, pairs, cells };
  };
  return {
    name: `balancedTransitions(${opts.classify ? "custom" : keyName(opts.key)})`,
    violations(seq, start) {
      const { counts, pairs, cells } = tally(seq, start);
      if (!cells.length) return 0;
      const mean = pairs / cells.length;
      const hi = Math.ceil(mean + tol);
      const lo = Math.floor(mean - tol);
      let v = 0;
      for (const cell of cells) {
        const c = counts.get(cell) ?? 0;
        v += Math.max(0, c - hi) + Math.max(0, lo - c);
      }
      return v;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------------------------

/**
 * Split `n` into integer counts proportional to `weights` (largest remainder method). Counts sum
 * to exactly `n`; ties in the remainders go to the earlier entry. Accepts an array or an object.
 */
export function allocate(weights: number[], n: number): number[];
export function allocate(weights: Record<string, number>, n: number): Record<string, number>;
export function allocate(weights: number[] | Record<string, number>, n: number) {
  const keys = Array.isArray(weights) ? weights.map((_, i) => i) : Object.keys(weights);
  const w = keys.map((key) => (weights as any)[key] as number);
  if (w.some((x) => !(x >= 0)) || !w.some((x) => x > 0)) {
    throw new Error("allocate(): weights must be non-negative numbers and not all zero.");
  }
  const total = w.reduce((a, b) => a + b, 0);
  const quota = w.map((x) => (x / total) * n);
  const base = quota.map(Math.floor);
  const frac = quota.map((q, i) => Math.round((q - base[i]) * 1e9));
  let left = n - base.reduce((a, b) => a + b, 0);
  const order = frac.map((_, i) => i).sort((a, b) => frac[b] - frac[a] || a - b);
  for (const i of order) {
    if (left-- <= 0) break;
    base[i]++;
  }
  if (Array.isArray(weights)) return base;
  const out: Record<string, number> = {};
  keys.forEach((key, i) => (out[key] = base[i]));
  return out;
}

/** Repeat each item `counts[i]` times: `expand(['a','b'], [3,1])` is `['a','a','a','b']`. */
export function expand<T>(items: T[], counts: number[]): T[] {
  return items.flatMap((item, i) => new Array<T>(counts[i]).fill(item));
}

/** A sampler that draws `n` items with replacement (optionally weighted). */
export function sampler<T>(items: T[], n: number, weights?: number[]): SequenceSampler<T> {
  const total = weights ? weights.reduce((a, b) => a + b, 0) : items.length;
  return {
    n,
    draw() {
      if (!weights) return items[Math.floor(random() * items.length)];
      let u = random() * total;
      for (let i = 0; i < items.length; i++) if ((u -= weights[i]) < 0) return items[i];
      return items[items.length - 1];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------------

export interface SequenceCheck {
  ok: boolean;
  failures: { name: string; violations: number; positions?: number[] }[];
}

/** Which constraints a sequence violates, and (when the constraint can say) where. Positions index `seq`. */
export function checkSequence<T>(
  seq: T[],
  constraints: SequenceConstraint<T>[],
  options: { after?: T[] } = {}
): SequenceCheck {
  const after = options.after ?? [];
  const full = after.concat(seq);
  const failures: SequenceCheck["failures"] = [];
  for (const c of constraints) {
    const v = c.violations(full, after.length);
    if (v > 0) {
      failures.push({
        name: c.name,
        violations: v,
        positions: c
          .positions?.(full, after.length)
          .map((p) => p - after.length)
          .filter((p) => p >= 0),
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------------------------
// Solvers
// ---------------------------------------------------------------------------------------------

const isSampler = <T>(s: T[] | SequenceSampler<T>): s is SequenceSampler<T> => !Array.isArray(s);

function total<T>(cs: SequenceConstraint<T>[], seq: T[], start: number) {
  let t = 0;
  for (const c of cs) t += c.violations(seq, start);
  return t;
}

function violated<T>(cs: SequenceConstraint<T>[], seq: T[], start: number) {
  return cs.filter((c) => c.violations(seq, start) > 0).map((c) => c.name);
}

class Fail extends Error {
  constructor(public blame: string[], public proven: boolean, public detail: string) {
    super(detail);
  }
}

function backtrackItems<T>(
  items: T[],
  cs: SequenceConstraint<T>[],
  after: T[],
  o: Required<Pick<SequenceOptions<T>, "max_attempts" | "max_nodes">> & { deadline: number }
): T[] {
  const start = after.length;
  for (const c of cs) {
    if (c.feasible && !c.feasible(after, items, start)) {
      throw new Fail([c.name], true, `"${c.name}" cannot be satisfied by these items`);
    }
  }
  const blame = new Map<string, number>();
  let bestDepth = -1;
  let exhausted = false;
  let timedOut = false;
  for (let attempt = 0; attempt < o.max_attempts; attempt++) {
    if (Date.now() > o.deadline) {
      timedOut = true;
      break;
    }
    const ctx = after.slice();
    const rem = items.slice();
    let nodes = 0;
    let budgetHit = false;
    type Frame = {
      order: number[];
      pos: number;
      tried: Set<unknown>;
      idx: number;
      item: T | undefined;
      placed: boolean;
      local: Map<string, number>;
    };
    const stack: Frame[] = [];
    const open = () =>
      stack.push({
        order: shuffled(rem.map((_, i) => i)),
        pos: 0,
        tried: new Set(),
        idx: -1,
        item: undefined,
        placed: false,
        local: new Map(),
      });
    if (rem.length) open();
    while (stack.length && rem.length) {
      const f = stack[stack.length - 1];
      if (f.placed) {
        ctx.pop();
        rem.splice(f.idx, 0, f.item as T);
        f.placed = false;
      }
      let advanced = false;
      while (f.pos < f.order.length) {
        const idx = f.order[f.pos++];
        const item = rem[idx];
        const sig = signature(item);
        if (f.tried.has(sig)) continue;
        f.tried.add(sig);
        let rejectedBy: string | undefined;
        for (const c of cs) {
          if (c.allows && !c.allows(ctx, item, start)) {
            rejectedBy = c.name;
            break;
          }
        }
        if (rejectedBy) {
          f.local.set(rejectedBy, (f.local.get(rejectedBy) ?? 0) + 1);
          continue;
        }
        ctx.push(item);
        rem.splice(idx, 1);
        let bad: string | undefined;
        for (const c of cs) {
          if (c.feasible && !c.feasible(ctx, rem, start)) {
            bad = c.name;
            break;
          }
        }
        if (bad) {
          f.local.set(bad, (f.local.get(bad) ?? 0) + 1);
          ctx.pop();
          rem.splice(idx, 0, item);
          continue;
        }
        f.idx = idx;
        f.item = item;
        f.placed = true;
        advanced = true;
        break;
      }
      if (advanced) {
        if (++nodes > o.max_nodes || ((nodes & 255) === 0 && Date.now() > o.deadline)) {
          budgetHit = true;
          break;
        }
        if (rem.length) open();
        continue;
      }
      // dead end at this depth
      const depth = stack.length - 1;
      if (depth >= bestDepth) {
        if (depth > bestDepth) blame.clear();
        bestDepth = depth;
        for (const [name, n] of f.local) blame.set(name, (blame.get(name) ?? 0) + n);
      }
      stack.pop();
    }
    if (!budgetHit && !stack.length && rem.length) {
      exhausted = true;
      break;
    }
    if (!rem.length) {
      if (total(cs, ctx, start) === 0) return ctx.slice(start);
      // a rule without allows() (or an incomplete allows) failed at the end: restart
      for (const n of violated(cs, ctx, start)) blame.set(n, (blame.get(n) ?? 0) + 1);
    }
  }
  const names = [...blame.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const main = names.slice(0, 3);
  throw new Fail(
    main,
    exhausted && cs.every((c) => c.allows),
    exhausted
      ? `no valid order exists (search exhausted after placing ${bestDepth} of ${
          items.length
        } items); blocked by ${main.map((n) => `"${n}"`).join(", ") || "the constraints"}`
      : `no valid order found in ${
          timedOut ? "the time limit" : o.max_attempts + " attempts"
        } (got ${Math.max(bestDepth, 0)} of ${items.length} items in place); mostly blocked by ${
          main.map((n) => `"${n}"`).join(", ") || "the constraints"
        }`
  );
}

function backtrackSampled<T>(
  src: SequenceSampler<T>,
  cs: SequenceConstraint<T>[],
  after: T[],
  o: Required<Pick<SequenceOptions<T>, "max_attempts" | "max_nodes">> & { deadline: number }
): T[] {
  const start = after.length;
  const blame = new Map<string, number>();
  let best = 0;
  for (let attempt = 0; attempt < o.max_attempts && Date.now() <= o.deadline; attempt++) {
    const ctx = after.slice();
    let nodes = 0;
    let stuck = 0;
    while (ctx.length - start < src.n && nodes++ < o.max_nodes) {
      let placed = false;
      for (let t = 0; t < 100 && !placed; t++) {
        const item = src.draw();
        const rej = cs.find((c) => c.allows && !c.allows(ctx, item, start));
        if (rej) blame.set(rej.name, (blame.get(rej.name) ?? 0) + 1);
        else {
          ctx.push(item);
          placed = true;
        }
      }
      if (!placed) {
        if (ctx.length > start) ctx.pop();
        if (++stuck > 50) break;
      }
      best = Math.max(best, ctx.length - start);
    }
    if (ctx.length - start === src.n) {
      if (total(cs, ctx, start) === 0) return ctx.slice(start);
      for (const n of violated(cs, ctx, start)) blame.set(n, (blame.get(n) ?? 0) + 1);
    }
  }
  const names = [...blame.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n)
    .slice(0, 3);
  throw new Fail(
    names,
    false,
    `no valid sequence found in ${o.max_attempts} attempts (got ${best} of ${
      src.n
    }); mostly blocked by ${names.map((n) => `"${n}"`).join(", ") || "the constraints"}`
  );
}

function repair<T>(
  source: T[] | SequenceSampler<T>,
  cs: SequenceConstraint<T>[],
  after: T[],
  o: { max_attempts: number; deadline: number }
): T[] {
  const start = after.length;
  const n = isSampler(source) ? source.n : source.length;
  const draw = isSampler(source) ? () => source.draw() : undefined;
  let bestSeq: T[] | undefined;
  let bestCost = Infinity;
  const withPos = cs.filter((c) => c.positions);
  for (let attempt = 0; attempt < o.max_attempts; attempt++) {
    if (attempt > 0 && Date.now() > o.deadline) break;
    let cur = draw ? Array.from({ length: n }, draw) : shuffled(source as T[]);
    let full = after.concat(cur);
    let cost = total(cs, full, start);
    const budget = 30 * n + 500;
    for (let it = 0; it < budget && cost > 0; it++) {
      if ((it & 63) === 63 && Date.now() > o.deadline) break;
      let i: number;
      // Focus on positions implicated in violations (when constraints can say), else random.
      if (withPos.length && random() < 0.8) {
        const pool: number[] = [];
        for (const c of withPos)
          if (c.violations(full, start) > 0)
            for (const p of c.positions!(full, start)) if (p >= start) pool.push(p - start);
        i = pool.length ? pool[Math.floor(random() * pool.length)] : Math.floor(random() * n);
      } else i = Math.floor(random() * n);
      if (draw) {
        const old = cur[i];
        cur[i] = draw();
        full[start + i] = cur[i];
        const c2 = total(cs, full, start);
        if (c2 <= cost) cost = c2;
        else {
          cur[i] = old;
          full[start + i] = old;
        }
      } else {
        const j = Math.floor(random() * n);
        if (i === j || cur[i] === cur[j]) continue;
        const a = cur[i];
        cur[i] = cur[j];
        cur[j] = a;
        full[start + i] = cur[i];
        full[start + j] = cur[j];
        const c2 = total(cs, full, start);
        if (c2 <= cost) cost = c2;
        else {
          cur[j] = cur[i];
          cur[i] = a;
          full[start + i] = a;
          full[start + j] = cur[j];
        }
      }
    }
    if (cost === 0) return cur;
    if (cost < bestCost) {
      bestCost = cost;
      bestSeq = cur;
    }
  }
  const names = violated(cs, after.concat(bestSeq as T[]), start);
  throw new Fail(
    names,
    false,
    `repair could not remove all violations in ${
      o.max_attempts
    } attempts (best had ${bestCost}); still violated: ${names.map((x) => `"${x}"`).join(", ")}`
  );
}

function rejection<T>(
  source: T[] | SequenceSampler<T>,
  cs: SequenceConstraint<T>[],
  after: T[],
  o: { max_attempts: number; deadline: number }
): T[] {
  const start = after.length;
  const make = () =>
    isSampler(source) ? Array.from({ length: source.n }, () => source.draw()) : shuffled(source);
  const tally = new Map<string, number>();
  for (let a = 0; a < o.max_attempts; a++) {
    if ((a & 63) === 63 && Date.now() > o.deadline) break;
    const cand = make();
    const full = after.concat(cand);
    const bad = violated(cs, full, start);
    if (!bad.length) return cand;
    for (const b of bad) tally.set(b, (tally.get(b) ?? 0) + 1);
  }
  const names = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n)
    .slice(0, 3);
  throw new Fail(
    names,
    false,
    `rejection sampling found no valid order in ${
      o.max_attempts
    } shuffles; most often violated: ${names.map((x) => `"${x}"`).join(", ")}`
  );
}

/**
 * Build a sequence from `source` (an array of items to permute, or a sampler) that satisfies
 * every constraint. Throws `SequenceError` naming the blocking constraint(s) if it cannot.
 */
export function sequence<T>(
  source: T[] | SequenceSampler<T>,
  constraints: SequenceConstraint<T>[],
  options: SequenceOptions<T> = {}
): T[] {
  return withRng(options.rng, () => solve(source, constraints, options));
}

function solve<T>(
  source: T[] | SequenceSampler<T>,
  constraints: SequenceConstraint<T>[],
  options: SequenceOptions<T>
): T[] {
  const after = options.after ?? [];
  const n = isSampler(source) ? source.n : source.length;
  const solver = options.solver ?? "auto";
  const max_nodes = options.max_nodes ?? 10 * n + 500;
  const deadline = Date.now() + (options.time_limit ?? 3000);
  const run = (which: Exclude<SequenceSolver, "auto">) => {
    switch (which) {
      case "backtrack":
        return isSampler(source)
          ? backtrackSampled(source, constraints, after, {
              max_attempts: options.max_attempts ?? 30,
              max_nodes,
              deadline,
            })
          : backtrackItems(source, constraints, after, {
              max_attempts: options.max_attempts ?? 30,
              max_nodes,
              deadline,
            });
      case "repair":
        return repair(source, constraints, after, {
          max_attempts: options.max_attempts ?? 10,
          deadline,
        });
      case "rejection":
        return rejection(source, constraints, after, {
          max_attempts: options.max_attempts ?? 20000,
          deadline,
        });
    }
  };
  try {
    if (solver !== "auto") return run(solver);
    if (constraints.every((c) => c.allows)) {
      try {
        return run("backtrack");
      } catch (e) {
        if (!(e instanceof Fail) || e.proven) throw e;
        try {
          return run("repair");
        } catch (e2) {
          if (e2 instanceof Fail) throw e; // report the backtracking diagnosis
          throw e2;
        }
      }
    }
    return run("repair");
  } catch (e) {
    if (e instanceof Fail) {
      throw new SequenceError(`sequence(): ${e.detail}.`, e.blame, e.proven);
    }
    throw e;
  }
}

/** Which solver `solver: 'auto'` tries first for these constraints. */
export function autoSolver<T>(constraints: SequenceConstraint<T>[]): "backtrack" | "repair" {
  return constraints.every((c) => c.allows) ? "backtrack" : "repair";
}

/**
 * Generate several blocks in order. Each block sees the items of all earlier blocks as `after`,
 * so neighbour rules (and `after`-aware counts) carry across block boundaries. `constraints`
 * may be a function of the block index (e.g. to apply `startWith` only to block 0).
 * Returns one array per block. This is a loop over `sequence()`, kept for its error context.
 */
export function sequenceBlocks<T>(
  blocks: (T[] | SequenceSampler<T>)[],
  constraints: SequenceConstraint<T>[] | ((block: number) => SequenceConstraint<T>[]),
  options: Omit<SequenceOptions<T>, "after"> & { after?: T[] } = {}
): T[][] {
  const out: T[][] = [];
  let history = (options.after ?? []).slice();
  blocks.forEach((b, i) => {
    try {
      const cs = typeof constraints === "function" ? constraints(i) : constraints;
      const block = sequence(b, cs, { ...options, after: history });
      out.push(block);
      history = history.concat(block);
    } catch (e) {
      if (e instanceof SequenceError) {
        throw new SequenceError(`block ${i}: ${e.message}`, e.constraints, e.proven_infeasible);
      }
      throw e;
    }
  });
  return out;
}
