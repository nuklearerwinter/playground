# Logicals Difficulty Roadmap — Phases 2 + 3

Self-contained plan to bring our generated puzzles up to the difficulty of
the LOGISCH-Spezial magazine puzzles. Phase 1 (clue-mix rebalancing) has been
landed already — see commit history. Phases 2 and 3 follow.

Read `CLAUDE.md` and `LOGICALS_ALGORITHM.md` before starting any phase; this
plan assumes the conventions there.

---

## Context for a fresh session

We compared 15 magazine puzzles against our current generator output:

| Cluetyp     | Magazine Ø | Magazine range | Pre-phase-1 Ø |
|-------------|------------|----------------|---------------|
| pairSum     | 6.4        | 1–12           | 6.9           |
| duplicate   | 4.0        | 2–7            | 2.0           |
| totalSum    | 3.87       | 2–7            | 7.8           |
| sequence    | 1.13       | 0–2            | 1.9 (with random-seq)  |

Phase 1 already shifted the mix by raising `minDupLines`/`maxDupLines` defaults
and capping totalSum via a configurable `maxTotalSum`. **Validate that Phase 1
is in effect before starting Phase 2**:

```bash
cd /tmp/lt && node regression.js | tail -10
```

Should report avg `duplicate ≈ 4`, `totalSum ≈ 4`, `pairSum ≈ 6`, `sequence ≈ 1`
(some tolerance OK). If not, re-do Phase 1 first.

The user's feedback that motivates further work: **same clue count, easier
than the magazine**. The root cause is that magazine clues lean on
cross-line couplings (especially around duplicates and the global "each digit
appears 4×" rule) that our solver does not exploit early. So our generator
greedy-reduces away clues that *would* be needed if those couplings were used,
leaving redundancy that humans don't perceive as such.

Two structural moves close this gap:

1. **Strengthen the solver's global-count reasoning** so that dup-rich grids
   become harder for the solver too → the reduce phase keeps fewer scaffolding
   clues and the survivors couple more tightly.
2. **Pick puzzles by difficulty score, not just clue count**. Two clue-minimal
   sets can differ massively in deduction depth — score the trace and let the
   tournament prefer the deeper one.

That's Phase 2. Phase 3 adds new clue types for variety, ordered by ROI.

---

## Phase 2A — Global duplicate-count reasoning

### Why

Magazines lean hard on duplicate clues (avg 4.0). Each `dup V` in a line
commits 2 of V's 4 grid-wide occurrences to that line. Two non-overlapping
`dup V` clues commit all 4 → V is forbidden everywhere else. Our solver's
`global = 4×` rule today only fires when 4 singletons of V exist, which is
much too late: it doesn't propagate the *capacity* of partially-determined
lines. This makes dup-heavy puzzles solvable for us only via accidental
deductions from other clue types, so the reducer drops dup-driven clues that
a magazine designer would have considered load-bearing.

### Rule design

For each value `V ∈ 1..9`:

1. **Compute committed occurrences from duplicate clues** — count lines with
   `dup V` whose two V-positions are *forced* (already singletons in the
   line). Call this `forced(V)`.
2. **Compute remaining demand** = `4 - forced(V)`. If 0, V is fully placed →
   strip V from every other open cell (we already do this when 4 singletons
   exist; the new rule generalises to "4 effectively-determined").
3. **Compute remaining capacity** — for each *open* line, the max V's it can
   still hold:
   - line has `dup V` → can hold up to `2 - already-singletons-in-line` more.
   - line has no `dup V` → can hold up to `1 - already-singletons` more.
   Cap further by the count of cells in the line with V in domain.
4. If `sum of remaining capacities == remaining demand`, every open V-candidate
   cell is forced (mark all). Mirror of the line `dup-hidden` rule, lifted
   to the global scope.
5. If a line's `dup V` requires 2 placements but its remaining capacity is
   `< 2`, the puzzle is contradictory (`bad = true`).

### Implementation

Both `logicalSolve` (worker, ~line 905) and `solveWithTrace` (main thread,
~line 1690) need the rule. Mirror it carefully — they must agree.

Add the rule **after** the existing `// Global count: each value appears
exactly 4×.` block. Suggested function name `globalDupBalance(v)`. Wrap in
the `for v=1..9` loop so each value is handled symmetrically.

For `solveWithTrace`, emit a step with `ruleType: "global-dup"` and clue
metadata `{ value: v }`. Add a chip case in `clueHeadHtml`
(`logicals.html:~2016`):
```js
case "global-dup":
  return `<span class="chip glob">Globale Bilanz für <b>${cl.value}</b></span>`;
```

### Performance

Per call: 9 values × O(N²) cell scans = trivial (<0.1ms). No DFS, no caching
needed. Add to the standard propagation loop.

### Validation

1. Demo puzzle (`example-logical.txt`) must still solve via
   `/tmp/lt/example-test.js`. Step count may rise (more inferences captured).
2. Regression suite `/tmp/lt/regression.js` must still be sound — every
   emitted puzzle's `logicalSolve(clues).grid === grid`.
3. **Expected effect on generation**: with dup-heavy grids (Phase 1 settings),
   the reducer should drop further pairSums / totalSums because the solver
   can now coast on dup chains. Avg clue count should drop by 1–2 vs Phase 1
   alone.

If the rule turns out to be unsound (some grid fails the round-trip), the
likely culprit is the capacity formula treating an already-committed V-cell
twice — guard by tracking which cells are accounted for.

---

## Phase 2B — Difficulty-scored tournament

### Why

The minimization tournament currently picks "fewest clues". Two
clue-minimal puzzles can differ by ~3× in deduction depth — pick the
deeper one and the puzzle *feels* harder without changing clue count.

### Scoring

In `solveWithTrace`, every `commit()` already records a `ruleType`. Weight
them:

```js
const RULE_WEIGHT = {
  "adjacency":         1,
  "distinct-row":      1,
  "distinct-col":      1,
  "dup-hidden-row":    2,
  "dup-hidden-col":    2,
  "global":            2,
  "global-dup":        5,   // new in Phase 2A
  "pairSum":           2,
  "totalSum":          2,
  "sequence":          3,
  "lineFeasibility":   8,
};
```

(Weights are calibrated to match how many sub-steps a human would take to
reproduce the inference manually. Tune empirically — these are starting
guesses.)

Define `puzzleDifficulty(trace) = sum of RULE_WEIGHT[step.ruleType] over all steps`.

Tweak: also reward *variety* — bonus 5 per distinct `ruleType` appearing in
the trace. Encourages puzzles that exercise multiple inference kinds.

### Pipeline change

1. **Worker** (`workerCode`): after `pickClues` succeeds, run
   `solveWithTrace`-equivalent (port the rule weighting into the worker — it
   currently only has the non-tracing `logicalSolve`). Compute `difficulty`.
   Post message becomes `{ type: "candidate", grid, clues, clueCount,
   difficulty }`.

   Implementation choice: instead of duplicating `solveWithTrace`, refactor
   `logicalSolve` into a thin wrapper that optionally collects step counts
   by ruleType (only the counts, not the full removal log — cheaper). Add
   `cfg.collectStats = true` for the worker path.

2. **Main thread**: change "global best" criterion. Today:
   ```js
   if (!globalBest || d.clueCount < globalBest.clueCount) { … }
   ```
   New: order by `(difficulty desc, clueCount asc)` — prefer higher
   difficulty; tiebreak on fewer clues. Implement as:
   ```js
   const isBetter = !globalBest
     || d.difficulty > globalBest.difficulty
     || (d.difficulty === globalBest.difficulty && d.clueCount < globalBest.clueCount);
   ```

3. **Status string**: display difficulty next to clue count, e.g.
   `Bestes Rätsel: 15 Hinweise · Score 142 · …`.

4. **Worker threshold protocol** is now over difficulty, not clue count.
   `spawnWorkers` currently sends nothing (since Phase 1's flow always
   starts fresh) — keep that.

### Risk

The score is heuristic. If it picks puzzles that *look* hard to the solver
but are still easy for humans (e.g., 50 single-cell adjacency steps), the
weights need adjustment. Iterate with the user.

### Validation

1. Generate 20 puzzles with the scored tournament. Show user 5 of them
   sorted by score. Ask whether high-score correlates with perceived
   difficulty.
2. Spot-check: a magazine-style puzzle imported via the manual editor
   should produce a high score under our metric. If not, the weighting is
   off.

---

## Phase 3 — New clue types

Order: cheapest + highest-impact first. Each type needs:
- A parser entry (`parseManualClue` in `logicals.html:~2230`).
- A solver propagator in both `logicalSolve` and `solveWithTrace`.
- A candidate-generation entry in `buildCandidateClues`
  (`workerCode`, `logicalSolve.html:~880`).
- A render entry in `clueText` / `clueChip` (`logicals.html:~1620, ~1770`).
- A step-mode chip case in `clueHeadHtml`.
- An encoding slot in `encodePuzzle` / `decodePuzzle` — bump the format
  version (see `CLAUDE.md` note about the `v0`/`v1` boundary).
- A `fmtLineForInput` case so manual round-trip stays lossless.
- A weight in `RULE_WEIGHT` (Phase 2B).

Test plan for each new type (per `CLAUDE.md`'s validation rules):
- A Node harness similar to `/tmp/lt/parser.js` verifying parse + solve.
- A handcrafted puzzle (or extract one from the magazine collection) that
  the new rule unlocks but the old solver couldn't deduce.

### 3.1 `alle ungerade` / `alle gerade` (line parity)

- **Magazine usage**: 2 puzzles, 1 instance each.
- **Semantics**: every cell in the line is odd (∈ {1,3,5,7,9}) or even
  (∈ {2,4,6,8}).
- **Implementation**:
  - Clue object: `{ type: "lineParity", scope, index, parity: "odd"|"even" }`.
  - Propagator: trivial `restrict(cell, parityMask)` for each cell in the line.
  - Encoding: 2 bits — 12-bit bitmap (which lines) × 1 bit (odd/even) per
    bit-set line, similar to sequence encoding.
  - Parser: regex `^(?:ALLE\s+)?(UNGERADE|GERADE|ODD|EVEN)$`.
- **Estimated cost**: ~2 hours including tests.
- **Expected impact on difficulty score**: medium — eliminates 4–5
  candidates per cell in one stroke, valuable filler clue.

### 3.2 `tripleSum` (three-cell sum)

- **Magazine usage**: 4 puzzles, 1–2 instances each.
- **Semantics**: `A1+A2+A3 = N` for three *consecutive* cells in a line
  (assumed — verify against the magazines we have). Magazine usually uses
  the first three or middle three.
- **Implementation**:
  - Clue object: `{ type: "tripleSum", cells: [[r,c],[r,c],[r,c]], value }`.
    Cells must be co-linear and consecutive.
  - Propagator: arc-consistency over three cells. Same shape as pairSum but
    nested:
    ```js
    for v1 in da: for v2 in db (v2 != v1): for v3 in dc (v3 != v1, v2):
      if v1+v2+v3 === target: mark (v1,v2,v3) as feasible
    ```
    For each cell, mask = union of values found in any feasible triple.
    O(9³) = 729 per call → fine.
  - Adjacency: triples within a line have cells `i,i+1,i+2`. Within the
    line, distinctness rules already forbid equal cells; for non-dup lines
    all three must differ. For dup lines, two may match the dup value (but
    not adjacently — same nuance as pairSum). Enforce `v_i != v_{i+1}` in
    the cube.
  - Encoding: position bitmap (60 bits — one per possible triple, similar
    to pairSum's 60-bit map for adjacent pairs, but indexed by `(line,
    start)`), plus 5-bit values per active triple.
  - Parser: `^([A-F])\s*([1-6])\s*\+\s*([A-F])\s*([1-6])\s*\+\s*([A-F])\s*([1-6])\s*=\s*(\d+)$`.
- **Estimated cost**: ~4 hours.
- **Expected impact**: medium — three-cell coupling is genuinely harder
  than pair-cell. Good RULE_WEIGHT candidate at ~4.

### 3.3 `cellParity` (a single cell is even/odd)

- **Magazine usage**: 1 puzzle, 2 instances.
- **Semantics**: cell `A3` is even (or odd).
- **Implementation**:
  - Clue object: `{ type: "cellParity", cell: [r,c], parity }`.
  - Propagator: one-shot `restrict(cell, mask)` then never re-fires.
  - Encoding: 36-bit position bitmap × 1 bit parity per set bit.
  - Parser: `^([A-F])\s*([1-6])\s+(GERADE|UNGERADE|EVEN|ODD)$` or
    `IST GERADE` syntax.
- **Estimated cost**: ~1 hour.
- **Expected impact**: small — narrow constraint, only affects 1 cell.
  Useful filler.

### 3.4 `valueAbsent` and `valueExactlyOnce` (per-line value count)

- **Magazine usage**: 1 puzzle each.
- **Semantics**:
  - `valueAbsent V in line L`: V does not appear in L.
  - `valueExactlyOnce V in line L`: V appears exactly once in L (which would
    otherwise be 0 or 1 by default).
- **Implementation**:
  - Object: `{ type: "valueAbsent"|"valueExactlyOnce", scope, index, value }`.
  - Propagators:
    - absent: remove V from every cell in the line.
    - exactly-once: identical to the distinctness rule for that V; the
      *teeth* is the implication that V *must* appear once. If only one
      candidate cell remains → force.
  - Combine into the existing `unitElim` machinery for clarity.
  - Encoding: 12-bit line bitmap × 4-bit value per set bit, one channel per
    type.
- **Estimated cost**: ~2 hours together.
- **Expected impact**: small individually, but cheap to ship.

### 3.5 `cellRelation` (e.g. B2·3=B3)

- **Magazine usage**: 1 puzzle, 4 instances. Likely all multiplicative on
  the same pattern.
- **Semantics**: `cell_a OP n = cell_b` for `OP ∈ {*, +, -}` and small `n`.
- **Implementation choice**: rather than baking in every operator, define
  a generic *allowed-pair table* — a length-9 bitmask per `v_a` giving the
  allowed `v_b`. Multiplication, addition, equality, factor-of-N all fit.
  The puzzle stores the table identifier (4 bits for ~16 prebuilt relations).
  - Propagator: arc-consistency on `(a, b)` with the lookup table.
  - Encoding: cells `(r,c) x 2` + 4-bit relation id.
  - Parser: hardcode the common forms — `B2*3=B3`, `B2=B3+5`, etc. —
    and translate to relation ids.
- **Estimated cost**: ~6 hours (relation registry + parser + UI).
- **Expected impact**: medium — multiplicative constraints feel
  meaningfully different to humans, even though the solver handles them
  trivially.

### 3.6 `valueTriple` (skip until clarified)

- "Zahl x dreifach" appears once in the dataset.
- Semantics unclear without seeing the puzzle. Two readings:
  1. Value V appears 3× globally (instead of the default 4×).
  2. Value V appears 3× in one specific line — but our rules forbid >2
     per line, so this would be a rule-violation in our framework.
- **Do not implement** without asking the user / scanning the source
  magazine first. Document and move on.

---

## Acceptance for "we're done"

Phase 2 and 3 are jointly successful when:
1. A generated puzzle and a manually-entered magazine puzzle (e.g.
   `example-logical.txt`) get **comparable difficulty scores** under the
   Phase 2B metric.
2. Statistical mix matches magazine ranges within ±20%:
   - duplicate ≈ 4 ± 1
   - totalSum ≈ 4 ± 1
   - pairSum ≈ 6 ± 2
   - sequence ≈ 1 ± 1
3. User-perceived difficulty in a blind side-by-side test (user solves 3
   magazine puzzles and 3 generated puzzles, doesn't know which is which)
   is indistinguishable.

If (3) fails after Phase 2B, the levers to pull next:
- Tighter weights in `RULE_WEIGHT`.
- Variety bonus tuning.
- Phase 3 types making it into the keep-pool (their high weights would pull
  the tournament toward including them).

---

## Files touched (cheat sheet)

- `logicals.html` — everything (single-file app).
- `LOGICALS_ALGORITHM.md` — update if any of these phases change the
  algorithmic invariants documented there.
- `/tmp/lt/regression.js`, `/tmp/lt/example-test.js` — Node test harnesses
  re-extracted from `workerCode` body; mirror any new propagator in the
  test file's `solveWithTrace` copy.

## Background invariants to preserve

Per `CLAUDE.md`:
- **Soundness**: every elimination must hold in *every* solution.
- **No backtracking solver**. All new rules must be pure propagation.
- **Worker is shipped as a `.toString()`d function** — no outer-scope refs.
- **`pickClues` is always called with `targetClues: 0`**. Phase 2B should
  preserve this; the tournament selects among clue-minimal puzzles by
  difficulty.
