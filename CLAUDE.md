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
trace-based 5-level difficulty system (per-step branching factor `b`).

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
  hidden-single reasoning is valid only for the duplicate value (exactly 2×)
  and globally (each value exactly 4×).
- **Clue selection minimises; `pickClues` is always called with
  `{ targetClues: 0, ... }`.** Start with all candidate clues (gated by
  `logicalSolve`), greedily remove while still deducible (fullest lines first,
  totalSum before pairSum). That removes totalSum hints almost entirely and
  yields ~11–20 clues depending on luck. The `targetClues > 0` rebalance path
  still exists but is unused by the app.
- **Difficulty = 5 levels, classified from the solve trace (no sliders).** The
  old per-knob settings panel is gone; the UI is one radio group (`name="level"`,
  1–5). The real difficulty signal is **`b`, the per-step branching factor** —
  how many candidate configurations a human must survey to justify a step
  (recorded on every trace step by `commit`; the `lineFeasibility` DFS counts
  its leaves, all cheap/forced rules are `b=1`; `sumBound` and `sequence` steps
  are `1+openCells` resp. `~half` of that — sequences are easier). `puzzleProfile`
  → `{ maxB, bands }` (band counts of `#(b>3/5/8/12/20/30)`). A level is
  `puzzleLevel(profile, clueFeatures(clues)) = max(tierByMaxB, floorByClueType)`:
  tier-by-maxB `>40` (or many `b>12`) ⇒ 5, `>16` ⇒ 4, `>8` ⇒ 3, `>4` ⇒ 2, else
  1; floor `sum ⇒ ≥3, duplicate ⇒ ≥2`. The maxB tiers sit high because every
  sequence-bearing puzzle gets a ~4 baseline from the first full-line sequence
  propagation. The clue-type FLOOR is needed because maxB is otherwise bimodal
  (it can't split the easy levels alone); `clueFeatures` reads the clue SET, not
  the trace (a sum/dup counts even if cheap rules dissolve it to `b=1`).
- **Two cheap rules keep `b` honest** (both in `logicalSolve` AND
  `solveWithTrace`, run BEFORE the feasibility DFS, mirror together): `dupPlacement`
  (adjacency-aware duplicate placement — the doubled value fits only in cells
  that list it, two must be non-adjacent) and `sumBound` (distinctness-aware
  totalSum bound via `distinctSumRange`'s DP — strike `v` from a cell when, with
  it placed and the rest DISTINCT, the target sum is unreachable). They reproduce
  the cheap human shortcuts the brute-force feasibility DFS was finding with a
  hugely inflated `b` (~40 % of feasibility eliminations); without them `maxB`
  over-classified ~40 % of sum puzzles as too hard. **Soundness is preserved by
  confluence** — these only reorder which rule gets credit; the fixpoint is
  unchanged, so the acceptance gate is untouched.
- **`LEVELS` carries each level's generation `cfg`** (`minTotalSum`,
  `maxTotalSum`, `minDupLines`, `maxDupLines`, `fewerPairSums`) which BIASES
  generation toward the band (e.g. L1 = no sums/dups ⇒ `maxB=1`; L5 =
  `minTotalSum:3` for big enumerations). `cfg` is only a bias; `puzzleLevel` is
  the gate. **Avoid `fewerPairSums:true`** — it tanks generator yield ~10× (it's
  why L5 escalates via `minTotalSum` instead). `pickClues` is still always called
  with `{ targetClues: 0 }` (full minimisation); clue count is no longer a
  difficulty knob.
- **Tournament targets a band, doesn't maximise** (`startSearch` /
  `onWorkerMessage` / `searchTick` / `finishSearch`). ~4 workers stream puzzles
  (latest-accepted, throttled ~8/s — VARIETY, not fewest-clues); the main thread
  `solveWithTrace`s each, classifies by level, and keeps the fewest-clue
  **in-band** representative (`bestInBand`), with a closest-level `bestFallback`
  if none match. **Early-stop** once the best is stable (`MIN_SEARCH_MS` +
  `STALL_MS`); hard cap `DEFAULT_BUDGET_MS` (15 s). Per-level hit rates ≈
  100/94/78/16/42 % (L4 leaks down to L3 — fine, the filter + ample yield handle
  it). The shown puzzle displays its own level (computed from its trace, so it's
  correct for code-loaded puzzles too).
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
  to v1 — 2 bits are already saturated). Length 31–42 chars depending on
  clue density. The grid is **never** stored in the code; the recipient
  reconstructs it by running `solveWithTrace` on the decoded clues (the
  generator guarantees deducibility). See `encodePuzzle` / `decodePuzzle` in
  the main thread.
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
- **Manual puzzle entry (`parseManualLine` / `loadManualPuzzle`).** A
  collapsible `<details>` panel with 12 inputs (rows A–F + cols 1–6) lets
  users transcribe magazine puzzles. Syntax per field (case-insensitive,
  `;` or `,` separated): `A3+A4=11` (pairSum, both cells must be in the
  current line and adjacent), `SUM=29`, `5x2`/`5x`/`2x5`/`5²` (all 4 forms
  mean "value 5 appears twice"), `RUN ASC`/`RUN DESC`/`ASC`/`DESC`. After
  parsing, the clues run through `solveWithTrace`; **non-deducible inputs are
  hard-rejected** (no backtracking fallback — magazines are expected to be
  deducible, and our solver's coverage is the contract). On success it goes
  through `renderPuzzle` like any generated puzzle, including a freshly
  generated `encodePuzzle`-code that makes it shareable. The "Beispiel laden"
  button fills in `MANUAL_EXAMPLE`, a real generator output kept in the file
  for syntax orientation. Validate with `/tmp/lt/parser.js`: assert the
  example parses + solves, and a handful of malformed inputs are rejected
  with the right error message. The fields are also **auto-synced** from the
  current puzzle (via `fmtLineForInput`/`syncManualFieldsFromCurrent` called
  at the end of `renderPuzzle`) — generated puzzles, QR loads and manual
  entries all reformat into canonical syntax in the editor, so any loaded
  puzzle is a working example, edit-and-reload works, and the
  format-then-parse round-trip is lossless (validated by
  `/tmp/lt/sync-roundtrip.js`).

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
