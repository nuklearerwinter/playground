# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository nature

Pure static HTML — no build system, no package manager, no tests. Each `*.html`
file is a self-contained application: open it in a browser, done. They share
no code or assets. If you touch one, you don't risk the others.

## Logicals generator (`logicals.html`)

This is the only non-trivial file. Before editing it, read
[LOGICALS_ALGORITHM.md](LOGICALS_ALGORITHM.md) — it covers the puzzle rules,
the REDUCE-from-all-clues clue selection, the bitmask/MRV/pairSum-propagation
solver, and the three difficulty presets.

Architectural points that are non-obvious from the code:

- **Worker code is shipped as a function source string.** The function
  `workerCode()` in the main `<script>` is never called directly; it's
  `.toString()`'d, wrapped in `(...)()`, blob-URL'd, and loaded into a
  `Worker`. That means **anything inside `workerCode` cannot reference
  outer-scope variables** — it lives in a different JavaScript realm at
  runtime. Constants (`N`, helpers) are duplicated on purpose.
- **The solver's speed is load-bearing.** It uses bitmask domains, forward
  checking, MRV, and pairSum-propagation for a reason. Earlier iterations
  that omitted any of these took minutes per puzzle on hard difficulty.
  Don't simplify the solver "for clarity" — verify with a hard-mode run
  before merging.
- **Clue selection runs REDUCE, not ADD.** Starting with all candidate
  clues keeps the solver heavily constrained (fast); selectively removing
  them keeps it inside its fast regime. An ADD strategy ran the solver
  with very few clues, which is the slow regime.
- **Grid generation injects sequences first.** Random fills almost never
  produce sequence lines (`directSequence`/`ascending`/`descending`), so
  the generator pre-fixes 1–3 lines as sequences before backtracking the
  rest. Difficulty is parameterised on the *number* of injected sequences,
  not on caps alone.
- **The solution code is a 31-char Crockford-Base32 string with an 8-bit
  checksum.** If you change the grid size or value range, the code format
  has to change too (`encodeGrid`/`decodeCode` in the main thread).

## Running and testing

- **Smoke test**: open the file directly (`xdg-open logicals.html` or
  double-click). No server needed.
- **No automated tests.** When changing the generator or solver, generate
  ≥10 puzzles per difficulty in the browser and confirm: (a) solutions
  exist and are unique, (b) hints render correctly, (c) the printed
  output fits on a single A4 page, (d) the solution code round-trips
  through the input field.
- **Performance baseline**: first puzzle on hard difficulty should appear
  within a few seconds. If it takes >30s, the algorithm has regressed —
  most likely the solver lost an optimization.

## Other apps

- `index.html` — STL viewer (3D model display).
- `pacman.html` — Pacman browser game.

Neither has interesting cross-cutting structure. Treat them as independent.

## Git conventions

Commits use this trailer:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Local repo identity is set per-repository (not global). Don't change it
without confirming with the user.
