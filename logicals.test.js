"use strict";
// Regression harness for logicals.solver.js — pure Node, NO build, NO deps.
//   node logicals.test.js [perLevel]      (default 40)
//
// It loads the DOM-free solver by vm-evaluating logicals.solver.js, grabbing
// its top-level symbols, and reconstructing the worker internals from
// workerCode().toString() (the worker runs in its own realm; see CLAUDE.md).
// Then, per difficulty cfg, it generates puzzles the way the worker does and
// asserts the invariants that make the generator correct:
//   (a) worker logicalSolve (the acceptance GATE) solves it AND its grid equals
//       the real grid  — soundness, and soundness ⇒ uniqueness;
//   (b) solveWithTrace (the trace mirror) reaches the same grid;
//   (c) the trace never strikes a value present in the real solution, and its
//       replayed removals reproduce the solution;
//   (d) every emitted puzzle keeps at least one sequence clue.
// Plus: the calibration fixtures decode and classify to their expected level.
//
// Exit code 0 = all green, 1 = at least one failure.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SOLVER = path.join(__dirname, "logicals.solver.js");

function loadSolver(file) {
  const src = fs.readFileSync(file, "utf8") +
    ";Object.assign(this,{workerCode,solveWithTrace,encodePuzzle,decodePuzzle," +
    "countClues,N,puzzleProfile,puzzleLevel,clueFeatures,LEVELS});";
  const ctx = { console, Math };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  const fnSrc = ctx.workerCode.toString();
  const body = fnSrc.slice(fnSrc.indexOf("{") + 1, fnSrc.lastIndexOf("}"));
  const worker = new Function("self",
    body + "\n;return { generateGrid, pickClues, logicalSolve, buildCandidateClues };")({});
  return { top: ctx, worker };
}

const { top, worker } = loadSolver(SOLVER);
const N = top.N;
const gridStr = g => g.map(r => r.join("")).join("");
const isSeq = t => t === "directSequence" || t === "directDescending" || t === "ascending" || t === "descending";
function hasSequence(clues) {
  for (const list of clues.rowClues.concat(clues.colClues)) for (const cl of list) if (isSeq(cl.type)) return true;
  return false;
}

let fails = 0;
function fail(msg) { fails++; console.error("  FAIL: " + msg); }

// ---- Batch soundness / trace-mirror / sequence invariants ----
const perLevel = parseInt(process.argv[2] || "40", 10);
const levelDist = {};
let total = 0;
for (const lvl of top.LEVELS) {
  const cfg = lvl.cfg;
  let made = 0, attempts = 0;
  while (made < perLevel && attempts < perLevel * 200) {
    attempts++;
    const numSeq = 1 + ((Math.random() * 3) | 0);
    const grid = worker.generateGrid(numSeq, cfg.maxDupLines, cfg.minDupLines);
    if (!grid) continue;
    const clues = worker.pickClues(grid, { targetClues: 0, minTotalSum: cfg.minTotalSum,
      maxTotalSum: cfg.maxTotalSum, numSequences: numSeq, fewerPairSums: cfg.fewerPairSums,
      maxOnceClues: cfg.maxOnceClues, maxAbsentClues: cfg.maxAbsentClues });
    if (!clues) continue;
    made++; total++;
    const real = gridStr(grid);

    // (a) gate solves + grid equals real
    const g = worker.logicalSolve(clues);
    if (!g.solved) { fail(`L${lvl.id}: logicalSolve did not solve an emitted puzzle`); continue; }
    if (gridStr(g.grid) !== real) { fail(`L${lvl.id}: logicalSolve grid != real grid (UNSOUND)`); continue; }

    // (b)+(c) trace mirror reaches same grid; replay never strikes a solution value
    const tr = top.solveWithTrace(clues);
    if (!tr.solved || gridStr(tr.grid) !== real) { fail(`L${lvl.id}: solveWithTrace grid != real grid`); continue; }
    const dom = new Array(N * N).fill(0x1FF);
    let replayBad = false;
    for (const step of tr.steps) for (const rm of step.removals) {
      for (const v of rm.vals) {
        const solV = grid[(rm.idx / N) | 0][rm.idx % N];
        if (v === solV) { replayBad = true; }
        dom[rm.idx] &= ~(1 << (v - 1));
      }
    }
    if (replayBad) { fail(`L${lvl.id}: trace struck a SOLUTION value`); continue; }
    for (let i = 0; i < N * N; i++) {
      const solBit = 1 << (grid[(i / N) | 0][i % N] - 1);
      if ((dom[i] & solBit) === 0) { fail(`L${lvl.id}: replayed removals eliminated the solution at cell ${i}`); replayBad = true; break; }
    }
    if (replayBad) continue;

    // (d) sequence present
    if (!hasSequence(clues)) fail(`L${lvl.id}: emitted puzzle has no sequence clue`);

    // level classification sanity (must be 1..6)
    const cl = top.puzzleLevel(top.puzzleProfile(tr), top.clueFeatures(clues));
    levelDist[cl] = (levelDist[cl] || 0) + 1;
  }
  if (made < perLevel) fail(`L${lvl.id}: yield too low (${made}/${perLevel} in ${attempts} attempts)`);
}

// ---- Calibration fixtures: decode + classify to expected level ----
const FIXTURES = [
  { code: "0G1G-0004-M015-2XWS-2T17-SC26-B9GQ-1J2N-0025-JG", level: 4, note: "0G1G hard-B anchor" },
  { code: "0WH0-0402-M020-0HBW-5749-4H2N-BXAW-0GV4-C400-W0", level: 4, note: "0WH0 Schwer" },
  { code: "2R0M-0208-0000-57GB-Q305-8NAN-88GN-2M17-0000-406V-0", level: 4, note: "2R0M dup-pair" },
];
for (const f of FIXTURES) {
  const clues = top.decodePuzzle(f.code);
  if (!clues) { fail(`fixture ${f.note}: decode failed`); continue; }
  const tr = top.solveWithTrace(clues);
  if (!tr.solved) { fail(`fixture ${f.note}: not solvable by trace`); continue; }
  const lvl = top.puzzleLevel(top.puzzleProfile(tr), top.clueFeatures(clues));
  if (lvl !== f.level) fail(`fixture ${f.note}: level ${lvl}, expected ${f.level}`);
}

console.log(`Puzzles tested: ${total} | classified level dist: ${JSON.stringify(levelDist)}`);
if (fails === 0) { console.log("ALL GREEN ✓"); process.exit(0); }
else { console.error(`${fails} FAILURE(S)`); process.exit(1); }
