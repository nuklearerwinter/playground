# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository nature

Pure static HTML — no build system, no package manager, no tests. Each `*.html`
file is a self-contained application: open it in a browser, done. They share
no code or assets. If you touch one, you don't risk the others.

The one exception is `logicals.html`, which (given its size) loads three local
scripts in order — `qrcode.min.js` (vendored QR lib), `logicals.solver.js`
(pure puzzle logic, DOM-free, Node-testable), and `logicals.app.js`
(DOM/worker-orchestration/UI). They are **classic** scripts (not ES modules) so
the "just open the file over `file://`" smoke test keeps working. Load order
matters: `logicals.app.js` builds `WORKER_SRC` from `workerCode.toString()` at
load time, so `logicals.solver.js` must load first.

## Logicals generator (`logicals.html`)

This is the only non-trivial file. Before editing it, read
[LOGICALS_ALGORITHM.md](LOGICALS_ALGORITHM.md) — it covers the puzzle rules,
the propagation-only `logicalSolve` acceptance gate, clue selection, and the
trace-based 6-level difficulty system (per-step branching factor `b`).

Architectural points that are non-obvious from the code:

- **Worker code is shipped as a function source string.** The function
  `workerCode()` in `logicals.solver.js` is never called directly; it's
  `.toString()`'d (in `logicals.app.js`), wrapped in `(...)()`, blob-URL'd, and
  loaded into a `Worker`. That means **anything inside `workerCode` cannot
  reference outer-scope variables** — it lives in a different JavaScript realm
  at runtime. Constants (`N`, helpers) are duplicated on purpose. (The QR-code
  library lives in `qrcode.min.js`.)
- **Acceptance = deducible, not just unique.** A unique solution can still
  require guessing; that produces puzzles a human can't finish ("used every
  clue, still stuck"). The gate is `logicalSolve` — a propagation-only solver
  that never branches. If it determines all 36 cells, the puzzle is solvable
  by pure deduction *and* provably unique (every elimination is valid in all
  solutions). **There is no backtracking solver anymore** — the old one was
  removed; it was unreliable in the sparse-clue regime (timed out and
  reported "no solution" for solvable puzzles). Don't reintroduce a
  uniqueness-only check.
- **Every `logicalSolve` rule must be SOUND** (never remove a value present
  in some real solution). Soundness is what makes "fully determined" equal
  "unique". Note the non-Sudoku trap: a 6-cell line holds only 6 of the 9
  values, so there is **no** per-line "every value appears" lower bound —
  hidden-single reasoning is valid only for explicitly-clued values (duplicate
  = exactly 2×, `once` = exactly 1×) and globally (each value exactly 4×).
- **Count clues come in three kinds — `duplicate` (Vx2), `once` (Vx1),
  `absent` (Vx0).** Only `duplicate` is `mandatory` (its absence is what makes
  the all-distinct default valid); once/absent are pure extra information.
  `absent` = a one-time strike of V from the line's six cells (before the
  fixpoint loop, and a leading `"absent"` trace step, b=1); `once` = a lower
  bound of 1 handled by the generalized `unitElim`/`unit` minCount (trace
  ruleType `"once-hidden-row/col"`, b=1) plus a `usage[v]===1` final check in
  the feasibility DFS via `lineSearches[].onceMask`. **A once/absent clue
  alone does NOT put a line into `lineSearches`** — a plain line's combination
  enumeration would explode `b` and wreck the difficulty classification (the
  hidden single covers the human-reasonable deduction; rules only need to be
  sound, not complete). Per (line, value) dup/once/absent are pairwise
  exclusive — editor and `decodePuzzle` validate, both solvers carry a
  disjointness guard. NB: the feasibility DFS exists in THREE places that must
  mirror: `logicalSolve`, `solveWithTrace`, and `combosHtmlForStep` (app.js).
- **Clue selection minimises; `pickClues` is always called with
  `{ targetClues: 0, ... }`.** Start with all candidate clues (gated by
  `logicalSolve`), greedily remove while still deducible (fullest lines first,
  totalSum before pairSum). That removes totalSum hints almost entirely and
  yields ~11–20 clues depending on luck. The `targetClues > 0` rebalance path
  still exists but is unused by the app. **once/absent candidates are NOT
  minimised**: `buildCandidateClues` emits them all (~9/line), but `pickClues`
  picks a small random keep-protected subset up front (0..`maxOnceClues` /
  0..`maxAbsentClues` from the level cfg, ≤1 of each kind per line) and drops
  the rest before the gate — trial-removing ~100 extra candidates would double
  the ~6 ms/attempt baseline (measured: the subset scheme costs only ~10–30%).
- **Difficulty = 6 levels, classified from the solve trace (the level is
  derived, not a knob the user tunes).** The old per-knob settings panel is
  gone; the UI is a single discrete 1–6 slider (`#level-slider`, with a live
  level-name label) in the "Stufe" tab — it only picks the *target* level;
  difficulty itself is still classified from the trace: Sehr leicht / Leicht /
  Mittel / Schwer / Sehr schwer / Extrem. (Stufe / Kalibrierung / Editor /
  Rätselcode are four `role="tablist"` tabs — `data-mode` values stay
  `level/calib/manual/code`; `readConfig`/`syncModeUI` read the active tab.
  "Editor" is the manual-entry panel, "Rätselcode" the puzzle-code input +
  "Rätsel laden" (loads via `loadPuzzleFromCode`, i.e. same fresh state as a
  generated puzzle, then scrolls to the clues; load errors go to the
  panel-local `#code-error`, NOT the global `#error` — that sits below the
  puzzle, off-viewport at click time). Code-loaded puzzles ALSO get a
  `calib` profile attached (threshold from the Kalibrierung tab's select,
  `countHardSteps` fresh from the trace), so the difficulty display shows the
  full calibration line for fixture codes — by design, even on ?code= URL
  loads; both hide the global "Rätsel
  generieren" button and load via their own panel buttons, and the Rätselcode
  tab also hides "Drucken". Lösung zeigen/verbergen is a single toggle button
  `#solution-btn` below the grid next to "Lösungsweg" — state lives in
  `solutionShown`/`setSolutionShown`, and `showSolution`/`exitStepMode`/
  `renderPuzzle` keep it consistent: solution view and step mode are mutually
  exclusive, and every `renderPuzzle` resets both.)
  The real difficulty signal is **`b`, the per-step branching factor** —
  how many candidate configurations a human must survey to justify a step
  (recorded on every trace step by `commit`; the `lineFeasibility` step counts
  the **distinct value-COMBINATIONS** (multisets) that fill the line — NOT the
  ordered cell-assignments: a person surveys "which sets of values fit", not
  their permutations. Counting orderings inflated `b` ~3–10× — e.g. a dup line's
  two equal values plus the distinct rest permute many ways for one combination —
  and made forced lines look far harder than they are. **Exception — a dup-ONLY
  line (duplicate clue, NO totalSum): `b` is the dup-PLACEMENT survey = the number
  of non-adjacent position pairs the doubled value can still occupy, NOT the
  value-multiset count.** The multiset count over-inflated `b` there (observed up
  to ~70) for what a person reads as "where do the two d's go?" (a handful of
  slots) — that was the cause of dup-only lines being mis-rated Extrem/Sehr
  schwer. dup+sum and plain/once totalSum lines keep the multiset survey. All
  cheap/forced rules are `b=1`; `sumBound` and `sequence` steps are `1+openCells`
  resp. `~half` of that — sequences are easier). `puzzleProfile` →
  `{ maxB, bands, nFeas, nFeasHard }` (band counts of `#(b>3/5/8/12/20/30)`;
  `nFeas` = all lineFeasibility steps, `nFeasHard` = those with `b≥3` **excluding
  dup-placement surveys** (`clue.dupPos`) — a dup-only placement survey is much
  lighter than a genuine multi-VALUE combination survey, so it does NOT stack into
  byWork; its difficulty still surfaces via `maxB`). A level is `puzzleLevel(profile,
  clueFeatures(clues)) = max(byMaxB, byWork, floorByClueType)`:
  - **byMaxB** (single hardest survey): on plain lines `maxB` is small, but a
    sum-constrained line's combination survey can reach the tens (observed up to
    ~70). It gates the EASY end (`>4 ⇒ 2`, absorbing the ~4 sequence baseline),
    caps Mittel at `maxB=6` (any 7+-combination survey jumps straight to Schwer),
    AND drives the whole hard end: `>6 ⇒ 4 (Schwer), >14 ⇒ 5 (Sehr schwer),
    >25 ⇒ 6 (Extrem)`. There is no byMaxB ⇒ 3 — Mittel is reached via the sum-clue
    floor. **The `>25` cut is what split off Extrem**: the old single top band lumped
    `maxB` 15→70 into one "Sehr schwer" (a 4.6× range that testers found extreme),
    so the genuine single-giant-survey outliers now get their own level (~50/50
    split of the old L5 lands at ~`maxB=25`).
  - **byWork** = `nFeasHard`, how many lines forced a genuine ≥3-combination survey
    — a secondary hard-end signal: `≥1 ⇒ Schwer, ≥2 ⇒ Sehr schwer`. **It caps at 5
    (Sehr schwer) — Extrem is maxB-only**, by design: a "many surveys, none giant"
    puzzle is Sehr schwer, not Extrem (the chosen anchor for Extrem is the single
    hardest survey, not their count). **`b≤2` feasibility
    steps are essentially forced and DON'T count** (this is why a puzzle with many
    sum/dup lines but only forced deductions, e.g. fixture `0WH0` = maxB 7 / nFeas 8
    / nFeasHard 1, is Schwer not Sehr schwer — its 8 lines mostly resolve at b≤2).
  - **clue-type FLOOR** (`sum ⇒ ≥3, duplicate/once ⇒ ≥2`; `absent` sets NO
    floor — a plain strike-out is trivial) gates the easy end;
    `clueFeatures` reads the clue SET, not the trace (a sum/dup counts even if
    cheap rules dissolve it to `b=1`).
- **Three cheap rules keep `b` honest** (all in `logicalSolve` AND
  `solveWithTrace`, run BEFORE the feasibility DFS, mirror together): `dupPlacement`
  (adjacency-aware duplicate placement — the doubled value fits only in cells
  that list it, two must be non-adjacent); `sumBound` (distinctness-aware
  totalSum bound via `distinctSumRange`'s DP — strike `v` from a cell when, with
  it placed and the rest DISTINCT, the target sum is unreachable); and `nakedPair`
  (two cells of a line restricted to the SAME 2-set `{a,b}` must BE `a` and `b`
  between them ⇒ strike `a,b` from the rest of the line — the obvious "these two
  cells are the 8 and the 9, so nothing else here is 8 or 9" move, `b=1`). They
  reproduce the cheap human shortcuts the brute-force feasibility DFS was finding
  with a hugely inflated `b`; without them `maxB`/`b` over-classified sum puzzles
  as too hard. **The plain both-values strike is sound only when the pair
  EXCLUDES the line's duplicate value** (the two cells could both be the doubled
  value, so neither value is necessarily consumed). **If the pair CONTAINS the
  dup value `a`** (`{a,b}`, `b` non-dup — so at least one pair cell is `a`,
  since `b` fits at most once), two dup-aware deductions apply instead:
  *adjacent* pair cells can't both be `a` either ⇒ one `a`, one `b` ⇒ strike
  `b` (only) from the rest; pair cells with exactly ONE cell between them ⇒
  that middle cell can't be `a` (adjacency would force both pair cells to `b`,
  twice) — trace ruleType `"dup-sandwich"`, all `b=1`. (Two dup bits in the
  mask ⇒ skip. These two came from a user report: a `{6,8}` pairSum pair and a
  `{4,5}/{4,5}` sandwich were each being claimed by the feasibility DFS at
  `b=15`.) nakedPair fires on EVERY line (not just sum/dup lines), so unlike
  the other two it can let the gate accept a
  few more puzzles (ones needing a naked-pair on a plain pairSum/distinct line —
  genuinely human-deducible, so correct); the dup-aware cases fire only on dup
  lines (⊆ `lineSearches`), which the DFS already fixpoints — so they change
  classification (`b`), never acceptance. **Soundness is preserved by
  confluence** — these reorder which rule gets credit; the fixpoint is unchanged.
  In `solveWithTrace`, `nakedPairLine` is also re-run per line directly before
  that line's feasibility DFS (with `unit`/`dupPlaceLine`, see below) so a pair
  formed mid-pass (e.g. by pairSum arc consistency) is still credited cheaply.
- **`LEVELS` carries each level's generation `cfg`** (`minTotalSum`,
  `maxTotalSum`, `minDupLines`, `maxDupLines`, `fewerPairSums`, `maxOnceClues`,
  `maxAbsentClues`) which BIASES
  generation toward the band (e.g. L1 = no sums/dups ⇒ `maxB=1`; L5 =
  `minTotalSum:3` for big enumerations). `cfg` is only a bias; `puzzleLevel` is
  the gate. **L1 must keep `maxOnceClues: 0`** (a once clue floors the level at
  2 and would empty the L1 band); absent is allowed everywhere (no floor).
  **Avoid `fewerPairSums:true`** — it tanks generator yield ~10× (it's
  why L5 escalates via `minTotalSum` instead). `pickClues` is still always called
  with `{ targetClues: 0 }` (full minimisation); clue count is no longer a
  difficulty knob.
- **Tournament targets a band, doesn't maximise** (`startSearch` /
  `onWorkerMessage` / `searchTick` / `finishSearch`). ~4 workers stream puzzles
  (latest-accepted, throttled ~8/s — VARIETY, not fewest-clues); the main thread
  `solveWithTrace`s each, classifies by level, and keeps the fewest-clue
  **in-band** representative (`bestInBand`), with a closest-level `bestFallback`
  if none match. **Early-stop** once the best is stable (`MIN_SEARCH_MS` +
  `STALL_MS`); hard cap `DEFAULT_BUDGET_MS` (15 s). Per-level in-band hit rates ≈
  100/93/39 % for L1–L3; the hard end now spans THREE bands (Schwer / Sehr schwer /
  Extrem), split out of what used to be one top band, so L4–L6 each have lower
  in-band yield handled by the in-band filter + ample yield. L3 is still the weak
  spot — since Schwer starts at `maxB>6`, much of its config's stream classifies as
  Schwer (and a slice now reaches Sehr schwer / Extrem). The shown puzzle displays
  its own level (computed from its trace, so it's correct for code-loaded puzzles too).
- **Grid generation injects sequences first.** Random fills almost never
  produce sequence lines, so the generator pre-fixes 0–3 lines (count from
  config / random) as sequences before backtracking the rest; `pickClues`
  protects up to `cfg.numSequences` of them (see the clue-config bullet above).
- **Four sequence types.** `directSequence` (consecutive ascending, e.g.
  3-4-5-6-7-8), `directDescending` (consecutive descending, 8-7-6-5-4-3),
  `ascending` (with gaps), `descending` (with gaps). `decideSequences` rolls
  among them ~17.5/17.5/33/32 %, and `buildCandidateClues` classifies most-
  specific-first (direct asc → direct desc → asc → desc) so a 3-4-5-6-7-8 line
  is *only* labelled `directSequence`, never both. The `logicalSolve` /
  `solveWithTrace` propagators for the direct types are pure bit shifts
  (`<<1` / `>>1`), the gapped types use min/max bounds.
- **The shareable code is a *puzzle* code (not a solution code).** It encodes
  all clues — pairSum bitmap (60 bits) + 4-bit values, totalSum/duplicate/
  sequence bitmaps (12 bits each) + their values, 4-bit version, 8-bit
  checksum — in Crockford-Base32, dash-grouped every 4 chars. Sequence type
  codes: 0=directSequence, 1=ascending, 2=descending, 3=directDescending
  (codes 0-2 are the original v0 alphabet, 3 was added without a version bump
  since v0 was only minutes old; if you ever need a 5th sequence type, bump
  the version — 2 bits are already saturated). **v1 appends two sections after
  the sequence section** (each: 12-bit line bitmap + 9-bit value MASK per set
  line): `once`, then `absent` — masks, not single values, so several
  once/absent values per line encode canonically. `encodePuzzle` emits **v0
  whenever no once/absent clue exists** (old puzzles keep byte-identical
  codes; old deployed pages still open them); `decodePuzzle` accepts 0 and 1
  and rejects per-line dup/once/absent overlaps. Length 31–42 chars (v0)
  depending on clue density. The grid is **never** stored in the code; the
  recipient reconstructs it by running `solveWithTrace` on the decoded clues
  (the generator guarantees deducibility). See `encodePuzzle` /
  `decodePuzzle` in the main thread.
- **Step-by-step solution view (`solveWithTrace`).** A main-thread mirror of
  `logicalSolve` that solves from the **clues only** (never reads
  `currentPuzzle.grid`) and records each rule application as a step
  `{ reason, removals:[{idx,vals}], solved:[idx] }` — i.e. *which candidates got
  eliminated and why*, not just final cell placements (~100–120 steps/puzzle).
  The UI (`enterStepMode`/`renderStep`/`stepNext`/…) shows **Sudoku-style
  candidate pencil-marks** per cell (`td.pencil .cands`); `renderStep` replays
  `removals` onto full domains to get the candidate state at any step, struck-
  out for the current step, and a running clickable step list with reasons.
  **`solveWithTrace` must mirror `logicalSolve`'s set of rules** — change both
  together; a safety net falls back to a plain reveal if its grid ≠ the known
  solution. **Step ORDER intentionally differs from `logicalSolve`'s phase
  order**, to read like a person solving: a `cascade()` worklist drains the
  human-obvious consequences of every freshly placed cell (adjacency, then
  row/column distinct) to exhaustion before — and again after — each heavier
  batched rule, and a **gapless (direct) sequence is filled in ONE bundled
  `"sequence"` step** from a single placed anchor (`fillDirectSequence`). This
  is sound because the propagation is confluent/monotone (same fixpoint
  regardless of order), so `logicalSolve` (the acceptance gate) is left
  untouched. A new rule must be added to BOTH and slotted into the cascade/loop
  consciously. Validate with a Node copy (extract by brace-matching;
  `/tmp/lt/trace.js`: assert solved, replayed `removals` == solution, no removal
  of an absent value, no removal of the SOLUTION value, no emptied domain, and
  that direct-sequence puzzles get a bundled fill).
- **Manual puzzle entry (`parseManualLine` / `loadManualPuzzle`).** The
  **"Editor" tab** — one of the four mode tabs (Stufe / Kalibrierung /
  Editor / Rätselcode) — is a `<div>` panel with 12 inputs (rows A–F + cols 1–6) that lets
  users transcribe magazine puzzles. (It used to be a collapsible `<details>`
  panel; it became a tab in the UI facelift, and `syncModeUI` shows exactly one
  panel per mode and hides the global "Rätsel generieren" button in Editor
  mode.) Syntax per field (case-insensitive, `;` or `,` separated): `A3+A4=11`
  (pairSum, both cells must be in the current line and adjacent), `SUM=29`,
  count clues **value-first** `5x2`/`5x1`/`5x0` (twice / exactly once / not
  at all; legacy `5x`/`5²` = dup, `2xV` = dup only for V ≥ 3 — **known
  accepted break**: `2x1` used to mean "dup 1", now means "once 2"; several
  once/absent per line are fine but at most one of Vx0/Vx1/Vx2 per value),
  `RUN ASC`/`RUN DESC`/`ASC`/`DESC`. After parsing, the clues run through
  `solveWithTrace`; **non-deducible inputs are hard-rejected** (no backtracking
  fallback — magazines are expected to be deducible, and our solver's coverage
  is the contract). On success it goes through `renderPuzzle` like any
  generated puzzle, including a freshly generated `encodePuzzle`-code that makes
  it shareable. Validate with `/tmp/lt/parser.js`: assert a representative
  puzzle parses + solves, and a handful of malformed inputs are rejected with
  the right error message. The fields are **auto-synced** from the current
  puzzle (via `fmtLineForInput`/`syncManualFieldsFromCurrent` called at the end
  of `renderPuzzle`) — generated puzzles, QR loads and manual entries all
  reformat into canonical syntax in the editor, so any loaded puzzle is a
  working example. (This auto-sync is why the old "Beispiel laden" button and
  its `MANUAL_EXAMPLE` fixture were removed — a real example is always present.)
  Edit-and-reload works, and the format-then-parse round-trip is lossless
  (validated by `/tmp/lt/sync-roundtrip.js`).

## Running and testing

- **Smoke test**: open the file directly (`xdg-open logicals.html` or
  double-click). No server needed.
- **No automated tests in-repo, but the logic is testable in Node** — and the
  file split makes it easy. `logicals.solver.js` is DOM-free, so `vm`-eval the
  whole file and grab its top-level symbols (append
  `;Object.assign(this,{workerCode,solveWithTrace,encodePuzzle,decodePuzzle,puzzleDifficulty,countClues,N})`).
  For the worker internals, extract the `workerCode()` body from the loaded
  function (`workerCode.toString()`, strip the outer `function(){…}`) and wrap
  it in `new Function("self", body + "; return { generateGrid, pickClues,
  logicalSolve, buildCandidateClues };")({})`. Then batch-generate (mirror the
  worker: random `numSequences` 1–3, `pickClues(grid, {targetClues:0})`).
  **Gotcha:** `pickClues` returns the *structured* clue set
  `{rowClues, colClues}` (lists per line) — not a flat array — and
  `logicalSolve` / `solveWithTrace` / `encodePuzzle` / `countClues` all consume
  that shape directly. The critical assertions when changing the
  generator/solver: for every emitted puzzle (a) `logicalSolve(clues).solved`
  is true and (b) its returned grid **equals** the real grid (this checks
  soundness, and soundness ⇒ uniqueness); plus (c) `solveWithTrace(clues).grid`
  equals it too (the trace mirror). Also confirm yield stays high and every
  puzzle keeps a sequence. A ready harness lives at `/tmp/lt/test.js`. In the
  browser, also check hints render, print fits one A4 page (incl. the clue
  count), and the code round-trips. (Node is installed in this environment.)
- **Performance baseline**: one minimise attempt runs in ~6 ms; the tournament
  reaches ~11–12 clues in a few seconds with 4 workers. If a single attempt
  takes much longer or yield collapses, something regressed (e.g. a
  `logicalSolve` rule got weaker).

## Other apps

- `stlviewer.html` — STL viewer (3D model display).
- `pacman.html` — Pacman browser game.

Neither has interesting cross-cutting structure. Treat them as independent.

## Git conventions

Commits use this trailer:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Local repo identity is set per-repository (not global). Don't change it
without confirming with the user.
