---
"@jspsych/sequencer": minor
---

New package: `@jspsych/sequencer` generates random orders that satisfy constraints (run limits, gaps, fixed starts, counts, forbidden patterns, balanced transitions, per-block uniqueness, or your own rules). It has no dependency on jsPsych and works in any JavaScript project. Pass `rng` for a seeded random source; by default it uses `Math.random`, so `jsPsych.randomization.setSeed()` also makes results reproducible.
