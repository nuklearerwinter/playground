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
- **Clue selection: REDUCE fully, then rebalance up.** Start with all
  candidate clues (gated by `logicalSolve`), greedily remove while still
  deducible (fullest lines first, totalSum before pairSum), then for easier
  levels add clues back onto the emptiest lines up to `cfg.targetClues`.
  Deducibility needs redundancy, so lines carry ~3–4 clues (sometimes 5),
  not the 2–3 of earlier versions. `totalSum` is capped at 5 per puzzle.
- **Grid generation injects sequences first.** Random fills almost never
  produce sequence lines (`directSequence`/`ascending`/`descending`), so
  the generator pre-fixes 1–3 lines as sequences before backtracking the
  rest. Difficulty is parameterised on `numSequences` and `targetClues`
  (higher target ⇒ more redundant clues ⇒ easier).
- **The solution code is a 31-char Crockford-Base32 string with an 8-bit
  checksum.** If you change the grid size or value range, the code format
  has to change too (`encodeGrid`/`decodeCode` in the main thread).

## Running and testing

- **Smoke test**: open the file directly (`xdg-open logicals.html` or
  double-click). No server needed.
- **No automated tests in-repo, but the worker logic is testable in Node.**
  Extract the `workerCode()` body (regex from `function workerCode() {` to the
  `// === Main-thread` marker), wrap it in `new Function(..., "...; return {
  generateGrid, pickClues, logicalSolve, buildCandidateClues, DIFFICULTY_CONFIG
  };")`, and you can batch-generate puzzles headlessly. The critical assertions
  when changing the generator/solver: for every emitted puzzle (a)
  `logicalSolve(clues).solved` is true and (b) its returned grid **equals** the
  real grid (this checks soundness, and soundness ⇒ uniqueness). Also confirm
  per-difficulty yield stays high and `totalSum` ≤ 5. In the browser, also
  check hints render, print fits one A4 page, and the code round-trips.
- **Performance baseline**: `logicalSolve` runs in ~5–9 ms per attempt, so the
  first puzzle should appear near-instantly. If hard takes >5 s, something
  regressed (e.g. a `logicalSolve` rule got weaker, tanking the yield).

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
