# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository nature

Pure static HTML — no build system, no package manager, no tests. Each `*.html`
file is a self-contained application: open it in a browser, done. They share
no code or assets. If you touch one, you don't risk the others.

## Logicals generator (`logicals.html`)

This is the only non-trivial file. Before editing it, read
[LOGICALS_ALGORITHM.md](LOGICALS_ALGORITHM.md) — it covers the puzzle rules,
the propagation-only `logicalSolve` acceptance gate, the REDUCE+rebalance clue
selection, and the three difficulty presets.

Architectural points that are non-obvious from the code:

- **Worker code is shipped as a function source string.** The function
  `workerCode()` in the main (second) `<script>` is never called directly;
  it's `.toString()`'d, wrapped in `(...)()`, blob-URL'd, and loaded into a
  `Worker`. That means **anything inside `workerCode` cannot reference
  outer-scope variables** — it lives in a different JavaScript realm at
  runtime. Constants (`N`, helpers) are duplicated on purpose. (The first
  `<script>` is a vendored minified QR-code library used by the main thread.)
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
- **Configurable clue types via a `keep` flag.** A collapsible settings panel
  feeds a config (`readConfig`) that the main thread sends to every worker and
  reuses on "Weiter suchen": `numSequences` (`"random"` or 0–3), `minTotalSum`
  (0–3), `maxDupLines` (0–5). `pickClues` marks up to that many sequence and
  totalSum clues with `keep`; kept clues (like mandatory duplicates) are never
  removed. **Sequences are NOT auto-protected anymore** — only the marked ones
  are, so coincidental sequence lines from the random fill get minimised away
  and the shown count matches the setting (rarely +1 if load-bearing).
  `maxDupLines` is passed to `generateGrid`/`gridQualityOK`. `pairSum` is
  deliberately not configurable (it's the deducibility backbone).
- **Difficulty = clue count = search time (no fixed presets).** The worker
  loops forever, generating + minimising and posting a puzzle only when it
  beats its fewest-clue count so far; the main thread runs ~4 such workers as
  a **time-budget tournament** (`startSearch`/`searchTick`/`finishSearch`),
  keeps the global minimum, shows it live, and runs the full budget (~6 s) or
  until "Übernehmen". "Weiter suchen" extends by +10 s. Fewer clues ⇒ harder.
  Workers are stopped via `terminate()` (the loop has no exit).
- **Grid generation injects sequences first.** Random fills almost never
  produce sequence lines (`directSequence`/`ascending`/`descending`), so the
  generator pre-fixes 0–3 lines (count from config / random) as sequences
  before backtracking the rest; `pickClues` protects up to `cfg.numSequences`
  of them (see the clue-config bullet above).
- **The solution code is a 31-char Crockford-Base32 string with an 8-bit
  checksum.** If you change the grid size or value range, the code format
  has to change too (`encodeGrid`/`decodeCode` in the main thread).
- **Step-by-step solution view (`solveWithTrace`).** A main-thread mirror of
  `logicalSolve` that solves from the **clues only** (never reads
  `currentPuzzle.grid`) and records each rule application as a step
  `{ reason, removals:[{idx,vals}], solved:[idx] }` — i.e. *which candidates got
  eliminated and why*, not just final cell placements (~100–120 steps/puzzle).
  The UI (`enterStepMode`/`renderStep`/`stepNext`/…) shows **Sudoku-style
  candidate pencil-marks** per cell (`td.pencil .cands`); `renderStep` replays
  `removals` onto full domains to get the candidate state at any step, struck-
  out for the current step, and a running clickable step list with reasons.
  **`solveWithTrace` must mirror `logicalSolve`'s rules** — change both
  together; a safety net falls back to a plain reveal if its grid ≠ the known
  solution. Validate with a Node copy (extract by brace-matching;
  `/tmp/lt/trace.js`: assert solved, replayed removals == solution, no removal
  of an absent value, no emptied domain).

## Running and testing

- **Smoke test**: open the file directly (`xdg-open logicals.html` or
  double-click). No server needed.
- **No automated tests in-repo, but the worker logic is testable in Node.**
  Extract the `workerCode()` body (regex from `function workerCode() {` to the
  `// === Main-thread` marker), wrap it in `new Function("self", body + "; return {
  generateGrid, pickClues, logicalSolve, buildCandidateClues };")`, and you can
  batch-generate puzzles headlessly (mirror the worker: random `numSequences`
  1–3, `pickClues(grid, {targetClues:0})`). The critical assertions when
  changing the generator/solver: for every emitted puzzle (a)
  `logicalSolve(clues).solved` is true and (b) its returned grid **equals** the
  real grid (this checks soundness, and soundness ⇒ uniqueness). Also confirm
  yield stays high and every puzzle keeps a sequence. In the browser, also
  check hints render, print fits one A4 page (incl. the clue count), and the
  code round-trips. (Node is installed in this environment.)
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
