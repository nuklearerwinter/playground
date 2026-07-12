"use strict";
// DOM, worker orchestration, UI. Requires logicals.solver.js loaded first.

// === Main-thread: worker management + UI ===
const WORKER_SRC = `(${workerCode.toString()})();`;
let workerBlobUrl = null;
function getWorkerUrl() {
  if (!workerBlobUrl) {
    const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}

let currentPuzzle = null;
let activeWorkers = [];

// === Difficulty-level tournament ===
// Several workers stream puzzles generated with the level's config; the main
// thread classifies each by difficulty LEVEL (puzzleLevel on the trace), keeps
// the fewest-clue in-band representative, shows it live, and early-stops once
// the best is stable (or accept / hard cap).
const DEFAULT_BUDGET_MS = 15 * 1000; // hard cap; early-stop usually finishes much sooner
const MIN_SEARCH_MS = 1200;          // search at least this long (gather a few in-band puzzles)
const STALL_MS = 1500;               // …then stop once the best hasn't improved for this long

let bestInBand = null;   // candidate matching the target (level OR calib profile), fewest clues
let bestFallback = null; // closest candidate (only used if none in-band)
let targetLevel = 3;
let calibMode = false;   // calibration mode: target a raw hard-step profile, not a level
let calibT = 4, calibN = 6; // b-threshold + target hard-step count (calib mode)
const CALIB_TOL = 1;     // a puzzle counts as "on target" within ±1 hard step
let lastImproveAt = 0;   // when chosenBest last improved (for early-stop)
let searchTimer = null;
let searchStart = 0, searchDeadline = 0, totalAttempts = 0;
let searching = false;
let searchConfig = null; // generation config for the current/most-recent search
function chosenBest() { return bestInBand || bestFallback; }

function el(id) { return document.getElementById(id); }
function killWorkers() {
  activeWorkers.forEach(w => { try { w.terminate(); } catch (_){} });
  activeWorkers = [];
}

// The selected difficulty level (1–6) and the generation config that biases
// generation toward its band. The actual gate is puzzleLevel() on the trace.
// In CALIBRATION mode the target is instead a raw profile (b-threshold + hard-
// step count); the gate is countHardSteps(trace, threshold) ≈ hardCount.
function readConfig() {
  const modeBtn = document.querySelector('#mode-picker button[aria-selected="true"]');
  const mode = modeBtn ? modeBtn.dataset.mode : "level";
  if (mode === "calib") {
    const threshold = clampInt(el("calib-threshold").value, 2, 9, 4);
    const hardCount = clampInt(el("calib-count").value, 0, 30, 6);
    return {
      mode: "calib", threshold, hardCount,
      config: Object.assign({ numSequences: "random" }, calibrationConfig(hardCount)),
    };
  }
  const sel = el("level-slider");
  const level = sel ? clampInt(sel.value, 1, 6, 3) : 3;
  return {
    mode: "level", level,
    config: Object.assign({ numSequences: "random" }, LEVELS[level - 1].cfg),
  };
}
function clampInt(v, lo, hi, dflt) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = dflt;
  return Math.max(lo, Math.min(hi, n));
}
// cfg is only a generation BIAS (the profile-match filter does the real gating):
// more target hard steps ⇒ borrow a higher level's clue mix (more sums/dups), so
// the stream actually contains enough hard-step puzzles to filter from.
function calibrationConfig(hardCount) {
  let lv;
  if (hardCount <= 1) lv = 2; else if (hardCount <= 4) lv = 4; else if (hardCount <= 8) lv = 5; else lv = 6;
  return LEVELS[lv - 1].cfg;
}

function updateSearchStatus() {
  const now = Date.now();
  const bar = el("progress-bar");
  bar.max = 1000;
  const span = searchDeadline - searchStart;
  bar.value = span > 0 ? Math.round(Math.min(1, (now - searchStart) / span) * 1000) : 0;
  const b = chosenBest();
  let best;
  if (!b) best = "suche …";
  else {
    const mb = b.profile.maxB === Infinity ? "∞" : b.profile.maxB;
    if (calibMode) {
      const miss = b.hardCount !== calibN ? ` (Ziel: ${calibN})` : "";
      best = `${b.hardCount} harte Schritte (b≥${calibT})${miss} · ${b.clueCount} Hinweise · maxB ${mb}`;
    } else {
      const miss = b.level !== targetLevel ? ` (Ziel: ${LEVELS[targetLevel - 1].name})` : "";
      best = `${LEVELS[b.level - 1].name}${miss} · ${b.clueCount} Hinweise · maxB ${mb}`;
    }
  }
  const secsLeft = Math.max(0, Math.ceil((searchDeadline - now) / 1000));
  const countdown = secsLeft >= 60 ? `noch ${Math.floor(secsLeft / 60)}m ${secsLeft % 60}s` : `noch ${secsLeft}s`;
  el("status").textContent = `Bestes Rätsel: ${best} · ${totalAttempts} Versuche · ${countdown}`;
  el("accept-btn").disabled = !b;
}

function onWorkerMessage(e) {
  if (!searching) return;
  const d = e.data;
  if (d.type === "tick") {
    totalAttempts += d.attempts;
  } else if (d.type === "candidate") {
    const trace = solveWithTrace(d.clues);
    if (!trace.solved) return; // safety net; should not happen if worker accepted.
    const profile = puzzleProfile(trace);
    const level = puzzleLevel(profile, clueFeatures(d.clues));
    const cand = { grid: d.grid, clues: d.clues, clueCount: d.clueCount, trace, profile, level };
    // Target = a difficulty band (level mode) or a hard-step count (calib mode).
    let dist;
    if (calibMode) { cand.hardCount = countHardSteps(trace, calibT); dist = Math.abs(cand.hardCount - calibN); }
    else dist = Math.abs(level - targetLevel);
    const onTarget = calibMode ? dist <= CALIB_TOL : level === targetLevel;
    if (onTarget) {
      // On target: keep the fewest-clue representative (mild elegance preference).
      if (!bestInBand || d.clueCount < bestInBand.clueCount) { bestInBand = cand; lastImproveAt = Date.now(); updateSearchStatus(); }
    } else if (!bestInBand) {
      // No on-target match yet: track the closest one as a fallback.
      if (!bestFallback || dist < bestFallback._dist || (dist === bestFallback._dist && d.clueCount < bestFallback.clueCount)) {
        cand._dist = dist; bestFallback = cand; lastImproveAt = Date.now(); updateSearchStatus();
      }
    }
  }
}

function spawnWorkers() {
  const url = getWorkerUrl();
  const n = Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 4));
  for (let i = 0; i < n; i++) {
    let w;
    try { w = new Worker(url); }
    catch (err) { console.error("Worker konnte nicht gestartet werden:", err); continue; }
    w.onmessage = onWorkerMessage;
    w.onerror = (err) => console.error("Worker error:", err);
    w.postMessage({ config: searchConfig });
    activeWorkers.push(w);
  }
}

function searchTick() {
  updateSearchStatus();
  const now = Date.now();
  // Early stop: once we have an in-band puzzle that has been stable for STALL_MS
  // (and we've searched the minimum), there's little point continuing. Without
  // an in-band match, keep going to the hard cap to maximise the chance of one.
  const stable = bestInBand && now - searchStart >= MIN_SEARCH_MS && now - lastImproveAt >= STALL_MS;
  if (stable || now >= searchDeadline) finishSearch();
}

function startSearch(budgetMs) {
  bestInBand = null;
  bestFallback = null;
  const rc = readConfig();
  calibMode = rc.mode === "calib";
  if (calibMode) { calibT = rc.threshold; calibN = rc.hardCount; }
  else targetLevel = rc.level;
  searchConfig = rc.config;
  killWorkers();
  searching = true;
  totalAttempts = 0;
  searchStart = Date.now();
  lastImproveAt = searchStart;
  searchDeadline = searchStart + budgetMs;

  el("generate-btn").disabled = true;
  el("print-btn").disabled = true;
  el("accept-btn").disabled = true;
  el("progress").hidden = false;
  el("error").textContent = "";
  el("steps-btn").disabled = true;
  el("solution-btn").disabled = true;
  exitStepMode();
  el("puzzle").hidden = true; // don't show a stale puzzle while searching
  updateSearchStatus();

  spawnWorkers();
  searchTimer = setInterval(searchTick, 120);
}

function finishSearch() {
  if (!searching) return;
  searching = false;
  if (searchTimer) { clearInterval(searchTimer); searchTimer = null; }
  killWorkers();
  el("progress").hidden = true; // accept-btn lives inside #progress, so it hides with it
  el("generate-btn").disabled = false;

  const best = chosenBest();
  if (!best) {
    el("error").textContent = `Kein lösbares Rätsel gefunden. Bitte „Rätsel generieren" erneut versuchen.`;
    return;
  }
  if (calibMode) {
    if (best.hardCount !== calibN)
      el("error").textContent = `Kein Rätsel mit ${calibN} harten Schritten (b≥${calibT}) gefunden — zeige das nächstliegende (${best.hardCount}). „Rätsel generieren" erneut versuchen oder Werte anpassen.`;
  } else if (best.level !== targetLevel) {
    el("error").textContent = `Keine ${LEVELS[targetLevel - 1].name}-Stufe gefunden — zeige die nächstliegende (${LEVELS[best.level - 1].name}). „Rätsel generieren" erneut versuchen oder Stufe wechseln.`;
  }
  const code = encodePuzzle(best.clues);
  currentPuzzle = { grid: best.grid, clues: best.clues, code, clueCount: best.clueCount, trace: best.trace, level: best.level };
  if (calibMode) currentPuzzle.calib = { threshold: calibT, hardCount: best.hardCount };
  renderPuzzle(currentPuzzle);
  el("print-btn").disabled = false;
  el("steps-btn").disabled = false;
  el("solution-btn").disabled = false;
}

function newSearch() { startSearch(DEFAULT_BUDGET_MS); }
function acceptNow() { if (chosenBest()) finishSearch(); } // ignore until first candidate

function buildGridTable() {
  const tbl = document.getElementById("grid");
  tbl.innerHTML = "";
  const header = document.createElement("tr");
  header.appendChild(document.createElement("th"));
  for (let c = 0; c < N; c++) {
    const th = document.createElement("th");
    th.textContent = COL_LABELS[c];
    header.appendChild(th);
  }
  const corner = document.createElement("th"); corner.className = "badge-cell";
  header.appendChild(corner); // top-right corner above row-end column (hidden outside step mode)
  tbl.appendChild(header);
  for (let r = 0; r < N; r++) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = ROW_LABELS[r];
    tr.appendChild(th);
    for (let c = 0; c < N; c++) {
      const td = document.createElement("td");
      td.dataset.r = r;
      td.dataset.c = c;
      tr.appendChild(td);
    }
    const endTd = document.createElement("td");
    endTd.className = "badge-cell row-end";
    endTd.dataset.rowEnd = r;
    tr.appendChild(endTd);
    tbl.appendChild(tr);
  }
  // Bottom row carries column-end badges (Σ / sequence / duplicate icons).
  const bot = document.createElement("tr");
  bot.className = "col-end-row";
  const lhs = document.createElement("th"); lhs.className = "badge-cell";
  bot.appendChild(lhs);
  for (let c = 0; c < N; c++) {
    const td = document.createElement("td");
    td.className = "badge-cell col-end";
    td.dataset.colEnd = c;
    bot.appendChild(td);
  }
  const rhs = document.createElement("th"); rhs.className = "badge-cell";
  bot.appendChild(rhs);
  tbl.appendChild(bot);
}

function ensureGridTable() {
  const tbl = document.getElementById("grid");
  if (!tbl.children.length) buildGridTable();
}

function renderPuzzle(p) {
  // Frisch-generiert-Zustand: kein alter Schritt-Modus, keine gezeigte Lösung —
  // egal ob das Rätsel aus Suche, Editor oder Rätselcode kommt.
  exitStepMode();
  document.getElementById("puzzle").hidden = false;
  document.getElementById("hints-block").hidden = false;
  document.getElementById("code-block").hidden = false;
  document.getElementById("difficulty-display").hidden = false;
  // Show the puzzle's actual difficulty level (computed from its own trace, so
  // it's correct for generated AND code-loaded puzzles) plus the clue count.
  let lvl = p.level;
  if (!lvl && p.trace) lvl = puzzleLevel(puzzleProfile(p.trace), clueFeatures(p.clues));
  const lvlName = lvl ? LEVELS[lvl - 1].name : "?";
  if (p.calib) {
    // Calibration mode: show the achieved raw profile (the tester rates by feel;
    // the old computed level is shown in brackets only for comparison).
    const mb = p.trace ? puzzleProfile(p.trace).maxB : "?";
    document.getElementById("difficulty-label").textContent =
      `Kalibrierung: ${p.calib.hardCount} harte Schritte (b≥${p.calib.threshold}) · maxB ${mb} · ${p.clueCount} Hinweise · [Level: ${lvlName}]`;
  } else {
    document.getElementById("difficulty-label").textContent = `${lvlName} · ${p.clueCount} Hinweise`;
  }

  const rowHints = document.getElementById("row-hints");
  rowHints.innerHTML = "";
  for (let r = 0; r < N; r++) {
    const li = document.createElement("li");
    const cs = p.clues.rowClues[r];
    li.innerHTML = `<span class="label">${ROW_LABELS[r]}:</span> ${cs.length ? cs.map(clueText).join(" ") : "<em>(keine Hinweise)</em>"}`;
    rowHints.appendChild(li);
  }
  const colHints = document.getElementById("col-hints");
  colHints.innerHTML = "";
  for (let c = 0; c < N; c++) {
    const li = document.createElement("li");
    const cs = p.clues.colClues[c];
    li.innerHTML = `<span class="label">${COL_LABELS[c]}:</span> ${cs.length ? cs.map(clueText).join(" ") : "<em>(keine Hinweise)</em>"}`;
    colHints.appendChild(li);
  }

  buildGridTable();
  decorateGrid(p);
  // Render the code with a <wbr> after every dash so print can wrap between
  // 4-char blocks (and never inside one). Safe to use innerHTML because
  // p.code only contains [A-Z0-9-].
  document.getElementById("code").innerHTML = p.code.replace(/-/g, "-<wbr>");
  document.getElementById("code-input").value = p.code;
  // Wrap the QR in a relative-link <a> so clicking (or right-click → copy
  // address) navigates to ?code=… on the current page. The SVG inside the QR
  // encodes the absolute share URL (for scanners); the <a> uses the relative
  // form so the link works regardless of where the file is hosted.
  document.getElementById("qr-wrap").innerHTML =
    `<a class="qr-link" href="?code=${encodeURIComponent(p.code)}" title="Diesen Rätsel-Link öffnen">${makeQrSvg(shareUrl(p.code))}</a>`;
  document.getElementById("error").textContent = "";
  const codeErr = document.getElementById("code-error"); if (codeErr) codeErr.textContent = "";
  clearGridCells();
  // Mirror the loaded puzzle into the manual-entry fields so users can study
  // the syntax against a concrete example and tweak clues for re-solving.
  syncManualFieldsFromCurrent(p);
}

function fmtClueForInput(cl) {
  if (cl.type === "pairSum") {
    const a = ROW_LABELS[cl.cells[0][0]] + COL_LABELS[cl.cells[0][1]];
    const b = ROW_LABELS[cl.cells[1][0]] + COL_LABELS[cl.cells[1][1]];
    return `${a}+${b}=${cl.value}`;
  }
  switch (cl.type) {
    case "totalSum":         return `SUM=${cl.value}`;
    case "duplicate":        return `${cl.value}x2`;
    case "once":             return `${cl.value}x1`;
    case "absent":           return `${cl.value}x0`;
    case "directSequence":   return "RUN ASC";
    case "directDescending": return "RUN DESC";
    case "ascending":        return "ASC";
    case "descending":       return "DESC";
  }
  return "";
}
function fmtLineForInput(clues) {
  return clues.map(fmtClueForInput).filter(s => s).join("; ");
}
function syncManualFieldsFromCurrent(p) {
  // Tolerant: called from renderPuzzle, may be called before the manual-entry
  // markup exists (unlikely, but stay defensive).
  if (!p || !p.clues) return;
  for (let r = 0; r < N; r++) {
    const inp = document.getElementById("m-r-" + r); if (!inp) return;
    inp.value = fmtLineForInput(p.clues.rowClues[r]);
    inp.classList.remove("field-bad");
  }
  for (let c = 0; c < N; c++) {
    const inp = document.getElementById("m-c-" + c); if (!inp) return;
    inp.value = fmtLineForInput(p.clues.colClues[c]);
    inp.classList.remove("field-bad");
  }
  const errBox = document.getElementById("manual-error"); if (errBox) errBox.textContent = "";
}

// Lösung-Toggle (unter dem Gitter, neben "Lösungsweg"): EIN Button wechselt
// zwischen Zeigen und Verbergen; Zustand und Beschriftung zentral hier.
let solutionShown = false;
function setSolutionShown(on) {
  solutionShown = on;
  const btn = document.getElementById("solution-btn");
  if (btn) btn.textContent = on ? "Lösung verbergen" : "Lösung zeigen";
}

function showSolution(grid) {
  ensureGridTable();
  document.getElementById("grid").classList.remove("pencil");
  document.getElementById("puzzle").hidden = false;
  document.getElementById("hints-block").hidden = !currentPuzzle;
  document.getElementById("code-block").hidden = !currentPuzzle;
  document.getElementById("difficulty-display").hidden = !currentPuzzle;
  const cells = document.getElementById("grid").querySelectorAll("td");
  for (const td of cells) {
    if (td.dataset.r === undefined) continue; // skip badge cells
    td.textContent = grid[+td.dataset.r][+td.dataset.c];
  }
  setSolutionShown(true);
}
function clearGridCells() {
  const cells = document.getElementById("grid").querySelectorAll("td");
  for (const td of cells) {
    if (td.dataset.r === undefined) continue; // leave badge cells intact
    td.textContent = "";
  }
}

// Pair-connector dots between adjacent linked cells, and Σ / sequence / duplicate
// chips in the right-/below-grid badge cells. Called from renderPuzzle.
function decorateGrid(p) {
  const grid = document.getElementById("grid");
  grid.querySelectorAll("td").forEach(td => td.classList.remove("pair-r", "pair-b"));
  for (const list of p.clues.rowClues.concat(p.clues.colClues)) for (const cl of list) {
    if (cl.type !== "pairSum") continue;
    const [[r1, c1], [r2, c2]] = cl.cells;
    if (r1 === r2 && Math.abs(c1 - c2) === 1) {
      const cc = Math.min(c1, c2);
      const td = grid.querySelector(`td[data-r="${r1}"][data-c="${cc}"]`);
      if (td) td.classList.add("pair-r");
    } else if (c1 === c2 && Math.abs(r1 - r2) === 1) {
      const rr = Math.min(r1, r2);
      const td = grid.querySelector(`td[data-r="${rr}"][data-c="${c1}"]`);
      if (td) td.classList.add("pair-b");
    }
  }
  // Two pairs of arrow icons. The line in front of the arrowhead conveys the
  // semantics on its own (no extra label needed):
  //   - solid bar  ──► : continuous = "direct" (consecutive integers, no gaps)
  //   - dotted    ⋯⋯► : interrupted = "with gaps" (ascending / descending)
  // Direction = direction of increasing values (so ascending col = ↓, descending col = ↑).
  const ICON = {
    solidR: '<svg class="rb-arr h" viewBox="0 0 22 10" aria-hidden="true"><rect x="1" y="3.5" width="11" height="3" fill="currentColor"/><path fill="currentColor" d="M10 0 l11 5 -11 5 z"/></svg>',
    solidL: '<svg class="rb-arr h" viewBox="0 0 22 10" aria-hidden="true"><rect x="10" y="3.5" width="11" height="3" fill="currentColor"/><path fill="currentColor" d="M12 0 l-11 5 11 5 z"/></svg>',
    solidD: '<svg class="rb-arr v" viewBox="0 0 10 22" aria-hidden="true"><rect x="3.5" y="1" width="3" height="11" fill="currentColor"/><path fill="currentColor" d="M0 10 l5 11 5 -11 z"/></svg>',
    solidU: '<svg class="rb-arr v" viewBox="0 0 10 22" aria-hidden="true"><rect x="3.5" y="10" width="3" height="11" fill="currentColor"/><path fill="currentColor" d="M0 12 l5 -11 5 11 z"/></svg>',
    dotR:   '<svg class="rb-arr h" viewBox="0 0 22 10" aria-hidden="true"><circle cx="2.5" cy="5" r="1.5" fill="currentColor"/><circle cx="7" cy="5" r="1.5" fill="currentColor"/><circle cx="11.5" cy="5" r="1.5" fill="currentColor"/><path fill="currentColor" d="M10 0 l11 5 -11 5 z"/></svg>',
    dotL:   '<svg class="rb-arr h" viewBox="0 0 22 10" aria-hidden="true"><circle cx="19.5" cy="5" r="1.5" fill="currentColor"/><circle cx="15" cy="5" r="1.5" fill="currentColor"/><circle cx="10.5" cy="5" r="1.5" fill="currentColor"/><path fill="currentColor" d="M12 0 l-11 5 11 5 z"/></svg>',
    dotD:   '<svg class="rb-arr v" viewBox="0 0 10 22" aria-hidden="true"><circle cx="5" cy="2.5" r="1.5" fill="currentColor"/><circle cx="5" cy="7" r="1.5" fill="currentColor"/><circle cx="5" cy="11.5" r="1.5" fill="currentColor"/><path fill="currentColor" d="M0 10 l5 11 5 -11 z"/></svg>',
    dotU:   '<svg class="rb-arr v" viewBox="0 0 10 22" aria-hidden="true"><circle cx="5" cy="19.5" r="1.5" fill="currentColor"/><circle cx="5" cy="15" r="1.5" fill="currentColor"/><circle cx="5" cy="10.5" r="1.5" fill="currentColor"/><path fill="currentColor" d="M0 12 l5 -11 5 11 z"/></svg>',
  };
  function chipHtml(cl) {
    switch (cl.type) {
      case "totalSum":   return `<span class="rb sum" title="Summe aller sechs Zahlen"><b>Σ</b>${cl.value}</span>`;
      case "directSequence":
        return `<span class="rb seq" title="direkt aufsteigend (lückenlos)">${cl.scope === "row" ? ICON.solidR : ICON.solidD}</span>`;
      case "directDescending":
        return `<span class="rb seq" title="direkt absteigend (lückenlos)">${cl.scope === "row" ? ICON.solidL : ICON.solidU}</span>`;
      case "ascending":
        return `<span class="rb seq" title="aufsteigend (mit Lücken erlaubt)">${cl.scope === "row" ? ICON.dotR : ICON.dotD}</span>`;
      case "descending":
        return `<span class="rb seq" title="absteigend (mit Lücken erlaubt)">${cl.scope === "row" ? ICON.dotL : ICON.dotU}</span>`;
      case "duplicate":  return `<span class="rb dup" title="Zahl kommt doppelt vor"><b>${cl.value}</b><sup>×2</sup></span>`;
      case "once":       return `<span class="rb dup once" title="Zahl kommt genau einmal vor"><b>${cl.value}</b><sup>×1</sup></span>`;
      case "absent":     return `<span class="rb dup abs" title="Zahl kommt nicht vor"><b>${cl.value}</b><sup>×0</sup></span>`;
      default: return "";
    }
  }
  function chipsFor(list) {
    // NB: types missing from this map are silently dropped — every renderable
    // clue type must be listed here.
    const order = { duplicate: 0, once: 1, absent: 2, totalSum: 3, directSequence: 4, directDescending: 4, ascending: 4, descending: 4 };
    return list.filter(cl => cl.type in order).slice().sort((a, b) => order[a.type] - order[b.type]).map(chipHtml).join("");
  }
  for (let r = 0; r < N; r++) {
    const endTd = grid.querySelector(`td[data-row-end="${r}"]`);
    if (endTd) endTd.innerHTML = '<div class="rb-stack">' + chipsFor(p.clues.rowClues[r]) + '</div>';
  }
  for (let c = 0; c < N; c++) {
    const endTd = grid.querySelector(`td[data-col-end="${c}"]`);
    if (endTd) endTd.innerHTML = '<div class="rb-stack">' + chipsFor(p.clues.colClues[c]) + '</div>';
  }
}
function hideSolution() {
  exitStepMode();
  clearGridCells();
  if (!currentPuzzle) {
    document.getElementById("puzzle").hidden = true;
  }
}



// === Lösungsweg: Schritt-Modus (UI) ===
let stepMode = false, stepTrace = null, stepIndex = 0;

function gridsMatch(a, b) {
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (a[r][c] !== b[r][c]) return false;
  return true;
}
function enterStepMode() {
  if (!currentPuzzle || !currentPuzzle.clues) return;
  if (!currentPuzzle.trace) currentPuzzle.trace = solveWithTrace(currentPuzzle.clues);
  const tr = currentPuzzle.trace;
  if (!tr.solved || !gridsMatch(tr.grid, currentPuzzle.grid)) {
    // Sicherheitsnetz (sollte nie eintreten): kein Schritt-Modus, Lösung direkt zeigen.
    showSolution(currentPuzzle.grid);
    return;
  }
  stepTrace = tr; stepMode = true; stepIndex = 0;
  setSolutionShown(false); // Pencil-Marks ersetzen eine ggf. gezeigte Lösung
  document.getElementById("puzzle").hidden = false;
  el("step-panel").hidden = false;
  el("steps-btn").textContent = "Lösungsweg ausblenden";
  renderStep();
  document.getElementById("grid").scrollIntoView({ behavior: "smooth", block: "center" });
}
// Kandidaten-Bitmasken nach Anwendung der ersten `upto` Schritte.
function stepCandidates(upto) {
  const dom = new Array(N * N).fill(0x1FF);
  for (let i = 0; i < upto; i++) for (const rm of stepTrace.steps[i].removals) {
    let mask = 0; for (const v of rm.vals) mask |= 1 << (v - 1);
    dom[rm.idx] &= ~mask;
  }
  return dom;
}
// Header chip for a step (clue type as title; styling by ruleType).
function clueHeadHtml(step) {
  const cl = step.clue;
  const lab = idx => cellLabel((idx / N) | 0, idx % N);
  const scopeLabel = c => c.scope === "row" ? "Reihe " + ROW_LABELS[c.index] : "Spalte " + COL_LABELS[c.index];
  switch (step.ruleType) {
    case "adjacency":
      return `<span class="chip adj"><b>${lab(cl.srcIdx)} = ${cl.value}</b> · keine ${cl.value} nebenan</span>`;
    case "distinct-row":
    case "distinct-col":
      return `<span class="chip dist"><b>${cl.value}</b> fest in ${cl.fixedAt.map(lab).join(", ")} · ${cl.label}</span>`;
    case "global":
      return `<span class="chip glob"><b>${cl.value}</b> ist 4× voll</span>`;
    case "global-hidden":
      return `<span class="chip glob"><b>${cl.value}</b> · noch genau 4 globale Plätze</span>`;
    case "global-dup-rows":
      return `<span class="chip glob"><b>${cl.value}</b> · zwei Duplikat-Reihen (${cl.rows.map(r => ROW_LABELS[r]).join(", ")})</span>`;
    case "global-dup-cols":
      return `<span class="chip glob"><b>${cl.value}</b> · zwei Duplikat-Spalten (${cl.cols.map(c => COL_LABELS[c]).join(", ")})</span>`;
    case "pairSum":
      return `<span class="chip sum"><b>${lab(cl.a)} + ${lab(cl.b)} = ${cl.value}</b></span>`;
    case "totalSum":
      return `<span class="chip sum"><b>Σ ${scopeLabel(cl)} = ${cl.value}</b></span>`;
    case "sumBound":
      return `<span class="chip sum"><b>Σ ${scopeLabel(cl)} = ${cl.value}</b> · Summenschranke</span>`;
    case "lineFeasibility": {
      // This rule fuses EVERY constraint on the line — name all that are active
      // (totalSum, the duplicate value and/or once values), not just one, so the
      // head isn't misleading. (The candidate state it works on also reflects
      // earlier deductions from crossing clues; those aren't repeated here.)
      let dv = 0; if (cl.dupMask) for (let v = 1; v <= 9; v++) if (cl.dupMask & (1 << (v - 1))) dv = v;
      const parts = [];
      if (cl.value >= 0) parts.push(`Σ ${scopeLabel(cl)} = ${cl.value}`);
      if (dv) parts.push(cl.value >= 0 ? `${dv} doppelt` : `${scopeLabel(cl)} · ${dv} doppelt`);
      if (cl.onceMask) for (let v = 1; v <= 9; v++) if (cl.onceMask & (1 << (v - 1))) parts.push(`${v} genau 1×`);
      if (!parts.length) parts.push(scopeLabel(cl));
      return `<span class="chip ${cl.value >= 0 ? "sum" : "dup"}"><b>${parts.join(" · ")}</b> · zulässige Belegungen</span>`;
    }
    case "sequence": {
      const arrow = (cl.kind === "directSequence" || cl.kind === "ascending") ? "↑"
                  : (cl.kind === "directDescending" || cl.kind === "descending") ? "↓" : "→";
      const word = cl.kind === "directSequence" ? "direkt aufsteigend"
                 : cl.kind === "directDescending" ? "direkt absteigend"
                 : cl.kind === "ascending" ? "aufsteigend (mit Lücken)"
                 : "absteigend (mit Lücken)";
      return `<span class="chip seq">${arrow} <b>${scopeLabel(cl)}</b> · ${word}</span>`;
    }
    case "dup-hidden-row":
    case "dup-hidden-col":
      return `<span class="chip dup">doppelte <b>${cl.value}</b> in ${cl.label}</span>`;
    case "once-hidden-row":
    case "once-hidden-col":
      return `<span class="chip dup">einmalige <b>${cl.value}</b> in ${cl.label}</span>`;
    case "absent":
      return `<span class="chip dup">keine <b>${cl.value}</b> in ${cl.label}</span>`;
    case "dup-place":
      return `<span class="chip dup"><b>${cl.value} doppelt in ${scopeLabel(cl)}</b> · Platzierung</span>`;
    case "naked-pair":
      return `<span class="chip dist"><b>${cl.pair.map(lab).join(", ")} = ${cl.values.join("/")}</b> · nacktes Paar · ${cl.label}</span>`;
    default: return `<span class="chip">${step.ruleType || ""}</span>`;
  }
}
function strikeStripHtml(vals) {
  let h = '<span class="strikes">';
  for (const v of vals) h += '<span class="d">' + v + '</span>';
  return h + '</span>';
}
// Enumerate valid combinations remaining for the clue of `step`, given the
// candidate state `dom` AFTER this step's removals. Lets the user see why this
// step is justified — e.g. for "A5+B5=14 → A5=9", the partner B5's still-valid
// candidates explain it. Capped to keep enumeration fast.
function combosHtmlForStep(step, dom) {
  const cl = step.clue; if (!cl) return null;
  const popc = m => { let n=0,t=m; while(t){n++;t&=t-1;} return n; };
  const minV = m => { for (let v=1;v<=9;v++) if (m&(1<<(v-1))) return v; return 0; };
  const maxV = m => { for (let v=9;v>=1;v--) if (m&(1<<(v-1))) return v; return 0; };
  function fmtTuple(t, sep) { return t.join(sep || "–"); }
  function listOrCount(items, fmt, kind) {
    if (!items.length) return `<span class="lbl">Keine ${kind} mehr möglich.</span>`;
    if (items.length <= 4) return `<span class="lbl">Noch möglich:</span> ${items.map(fmt).join(", ")}`;
    return `<span class="lbl">Noch ${items.length} ${kind} möglich.</span>`;
  }
  // For an elimination step (totalSum/lineFeasibility), spell out the bridge the
  // raw enumeration leaves implicit: the struck values appear in NONE of those
  // possibilities at the marked cells — which is exactly why they're removed.
  function whyStruck(kind) {
    const s = new Set();
    for (const rm of (step.removals || [])) for (const v of rm.vals) s.add(v);
    if (!s.size) return "";
    const list = [...s].sort((a, b) => a - b).join(", ");
    return ` <span class="lbl">Die gestrichenen Werte (${list}) kommen in keiner dieser ${kind} an den markierten Zellen vor – deshalb werden sie entfernt.</span>`;
  }
  if (step.ruleType === "pairSum") {
    const da = dom[cl.a], db = dom[cl.b]; const combos = [];
    for (let v=1;v<=9;v++) { const w = cl.value-v; if (w<1||w>9) continue; if ((da&(1<<(v-1)))&&(db&(1<<(w-1)))) combos.push([v,w]); }
    return listOrCount(combos, c => `<b>${c[0]}+${c[1]}</b>`, "Kombinationen");
  }
  if (step.ruleType === "totalSum") {
    const doms = cl.cells.map(idx => dom[idx]);
    const minsL = new Array(7).fill(0), maxsL = new Array(7).fill(0);
    for (let i=5;i>=0;i--){ minsL[i]=minsL[i+1]+minV(doms[i]); maxsL[i]=maxsL[i+1]+maxV(doms[i]); }
    // Cap high enough to report the exact count (sum-bounded enumeration is
    // small in practice); "über N" only in pathological cases.
    const cap = 5000, out = [];
    function rec(k, sum, t) {
      if (out.length >= cap) return;
      if (k === 6) { if (sum === cl.value) out.push(t.slice()); return; }
      const lo = cl.value - sum - maxsL[k+1], hi = cl.value - sum - minsL[k+1];
      for (let v = Math.max(1, lo); v <= Math.min(9, hi); v++) {
        if (doms[k] & (1<<(v-1))) { t.push(v); rec(k+1, sum+v, t); t.pop(); if (out.length >= cap) return; }
      }
    }
    rec(0, 0, []);
    const tail = whyStruck("Summenkombinationen");
    if (out.length >= cap) return `<span class="lbl">Es gibt noch über ${cap} mögliche Summenkombinationen.</span>` + tail;
    return listOrCount(out, t => `<b>${fmtTuple(t, "+")}</b>`, "Summenkombinationen") + tail;
  }
  if (step.ruleType === "lineFeasibility") {
    // Enumerate up to `cap` complete feasible 6-tuples for this line:
    // six distinct values from 1..9, except the duplicate value (if any in
    // dupMask) appears exactly twice at non-adjacent positions and each once
    // value (onceMask) exactly once; if cl.value (the totalSum target) is
    // >= 0, the sum must match. Mirrors the solver DFS (third copy!).
    const cells = cl.cells;
    if (!cells || cells.length !== 6) return null;
    const doms = cells.map(idx => dom[idx]);
    const target = (typeof cl.value === "number") ? cl.value : -1;
    const dupMask = cl.dupMask | 0;
    const onceMask = cl.onceMask | 0;
    // List distinct value-COMBINATIONS (multisets), not ordered assignments —
    // matches the B metric (combos.size in solveWithTrace) and how a person
    // surveys the line. Dedup orderings via a sorted-key set.
    const cap = 30, out = [], seenCombo = new Set();
    const usage = new Int8Array(10);
    const assigned = [0, 0, 0, 0, 0, 0];
    function rec(i, sumSoFar, dupLastPos) {
      if (out.length >= cap) return;
      if (i === 6) {
        if (target >= 0 && sumSoFar !== target) return;
        for (let v = 1; v <= 9; v++) {
          const b = 1 << (v - 1);
          if ((dupMask & b) && usage[v] !== 2) return;
          if ((onceMask & b) && usage[v] !== 1) return;
        }
        const sorted = assigned.slice().sort((a, b) => a - b), key = sorted.join(",");
        if (!seenCombo.has(key)) { seenCombo.add(key); out.push(sorted); }
        return;
      }
      if (target >= 0) {
        const rem = 6 - i;
        if (sumSoFar + rem * 9 < target) return;
        if (sumSoFar + rem * 1 > target) return;
      }
      const d = doms[i];
      for (let v = 1; v <= 9; v++) {
        const b = 1 << (v - 1);
        if (!(d & b)) continue;
        const maxCount = (dupMask & b) ? 2 : 1;
        if (usage[v] >= maxCount) continue;
        if ((dupMask & b) && dupLastPos === i - 1) continue;
        assigned[i] = v;
        usage[v]++;
        rec(i + 1, sumSoFar + v, (dupMask & b) ? i : dupLastPos);
        usage[v]--;
        if (out.length >= cap) return;
      }
    }
    rec(0, 0, -2);
    const kind = target >= 0 ? "Summenkombinationen" : "Belegungen";
    const tail = whyStruck(kind);
    // The exact count is step.b (the solver's uncapped leaf count = the number
    // of valid assignments). The local enumeration above only lists the small
    // cases; for larger ones show the concrete number instead of "über N".
    if (out.length >= cap) return `<span class="lbl">Es gibt noch ${step.b || out.length} mögliche ${kind}.</span>` + tail;
    return listOrCount(out, t => `<b>${fmtTuple(t, "+")}</b>`, kind) + tail;
  }
  if (step.ruleType === "sequence") {
    const doms = cl.cells.map(idx => dom[idx]);
    const cap = 30, out = [];
    if (cl.kind === "directSequence") {
      for (let s=1; s<=4; s++) {
        let ok = true;
        for (let k=0; k<6; k++) if (!(doms[k] & (1<<(s+k-1)))) { ok=false; break; }
        if (ok) out.push([s, s+5]);
      }
      return listOrCount(out, c => `<b>${c[0]}–${c[1]}</b>`, "Sequenzen");
    }
    if (cl.kind === "directDescending") {
      // Start at the highest value s (6..9); cell k must hold s-k.
      for (let s=6; s<=9; s++) {
        let ok = true;
        for (let k=0; k<6; k++) if (!(doms[k] & (1<<(s-k-1)))) { ok=false; break; }
        if (ok) out.push([s, s-5]);
      }
      return listOrCount(out, c => `<b>${c[0]}–${c[1]}</b>`, "Sequenzen");
    }
    if (cl.kind === "ascending") {
      function rec(k, prev, t) {
        if (out.length >= cap) return;
        if (k === 6) { out.push(t.slice()); return; }
        for (let v=prev+1; v<=9; v++) if (doms[k] & (1<<(v-1))) { t.push(v); rec(k+1, v, t); t.pop(); if (out.length >= cap) return; }
      }
      rec(0, 0, []);
    } else { // descending
      function rec(k, prev, t) {
        if (out.length >= cap) return;
        if (k === 6) { out.push(t.slice()); return; }
        for (let v=prev-1; v>=1; v--) if (doms[k] & (1<<(v-1))) { t.push(v); rec(k+1, v, t); t.pop(); if (out.length >= cap) return; }
      }
      rec(0, 10, []);
    }
    if (out.length >= cap) return `<span class="lbl">Noch viele Anordnungen möglich (≥ ${cap}).</span>`;
    return listOrCount(out, t => `<b>${fmtTuple(t, "‧")}</b>`, "Anordnungen");
  }
  return null;
}
function renderStep() {
  ensureGridTable();
  const grid = document.getElementById("grid");
  grid.classList.add("pencil");
  const lab = idx => cellLabel((idx / N) | 0, idx % N);
  const dom = stepCandidates(stepIndex);
  const step = stepIndex > 0 ? stepTrace.steps[stepIndex - 1] : null;
  const removedThis = new Map(), solvedThis = new Set(), changed = new Set();
  if (step) {
    for (const rm of step.removals) { removedThis.set(rm.idx, rm.vals); changed.add(rm.idx); }
    for (const idx of step.solved) solvedThis.add(idx);
  }
  grid.querySelectorAll("td").forEach(td => {
    if (td.dataset.r === undefined) return; // skip badge cells
    const idx = (+td.dataset.r) * N + (+td.dataset.c);
    td.classList.remove("changed", "solved-now");
    const d = dom[idx];
    let count = 0, t = d; while (t) { count++; t &= t - 1; }
    if (count === 1) {
      let v = 1; while (!(d & (1 << (v - 1)))) v++;
      td.innerHTML = '<div class="solved">' + v + '</div>';
    } else {
      const rem = removedThis.get(idx) || [];
      let html = '<div class="cands">';
      for (let v = 1; v <= 9; v++) {
        if (d & (1 << (v - 1))) html += '<span>' + v + '</span>';
        else if (rem.indexOf(v) >= 0) html += '<span class="removed">' + v + '</span>';
        else html += '<span></span>';
      }
      td.innerHTML = html + '</div>';
    }
    if (changed.has(idx)) td.classList.add(solvedThis.has(idx) ? "solved-now" : "changed");
  });
  const list = el("step-list");
  list.innerHTML = "";
  // Compute combos for every step that has them, by replaying removals forward
  // and querying combosHtmlForStep at the post-step state. Done in one O(N) pass
  // so list rendering itself can stay newest-first.
  const stepCombos = new Array(stepIndex).fill(null);
  if (stepIndex > 0) {
    const FULL = 0x1FF;
    const scratch = new Int32Array(N * N);
    for (let k = 0; k < N * N; k++) scratch[k] = FULL;
    for (let i = 0; i < stepIndex; i++) {
      const st = stepTrace.steps[i];
      for (const rm of st.removals) {
        let mask = 0;
        for (const v of rm.vals) mask |= 1 << (v - 1);
        scratch[rm.idx] &= ~mask;
      }
      stepCombos[i] = combosHtmlForStep(st, scratch);
    }
  }
  // Latest step on TOP so the buttons + most-recent reasoning stay in view.
  for (let i = stepIndex - 1; i >= 0; i--) {
    const s = stepTrace.steps[i];
    const li = document.createElement("li");
    li.dataset.step = i + 1;
    li.className = "step-card" + (i === stepIndex - 1 ? " current" : "");
    const b = s.b || 1;
    const bClass = "step-b" + (b > 8 ? " hard" : "");
    const bBadge = '<span class="' + bClass + '" title="Verzweigungsfaktor: so viele mögliche Belegungen müsste man hier überblicken (1 = eindeutig erzwungen)">B = ' + b + '</span>';
    let html = '<header class="step-head">' + clueHeadHtml(s) + bBadge + '</header>';
    if (s.reason) html += '<div class="step-desc">' + s.reason + '</div>';
    if (s.removals && s.removals.length) {
      html += '<ul class="step-rmv">';
      for (const rm of s.removals) {
        html += '<li><span class="cell-tag">' + lab(rm.idx) + '</span>' + strikeStripHtml(rm.vals) + '</li>';
      }
      html += '</ul>';
    }
    if (stepCombos[i]) html += '<div class="step-combos">' + stepCombos[i] + '</div>';
    li.innerHTML = html;
    list.appendChild(li);
  }
  list.scrollTop = 0;
  el("step-counter").textContent = `Schritt ${stepIndex} / ${stepTrace.steps.length}`;
  el("step-prev").disabled = stepIndex <= 0;
  el("step-next").disabled = stepIndex >= stepTrace.steps.length;
  el("step-reset").disabled = stepIndex <= 0;
  const steps = stepTrace.steps;
  el("step-prev-hard").disabled = !steps.slice(0, Math.max(0, stepIndex - 1)).some(isNontrivial);
  el("step-next-hard").disabled = !steps.slice(stepIndex).some(isNontrivial);
}
function stepNext() { if (stepTrace && stepIndex < stepTrace.steps.length) { stepIndex++; renderStep(); } }
function stepPrev() { if (stepTrace && stepIndex > 0) { stepIndex--; renderStep(); } }
function stepReset() { stepIndex = 0; renderStep(); }
// Skip targets: any step that wasn't outright forced (b > 1) — i.e. where the
// player has to weigh more than one option (b = 1 steps are pure propagation).
function isNontrivial(s) { return (s.b || 1) > 1; }
function stepNextHard() {
  if (!stepTrace) return;
  for (let i = stepIndex; i < stepTrace.steps.length; i++) {
    if (isNontrivial(stepTrace.steps[i])) { stepIndex = i + 1; renderStep(); return; }
  }
}
function stepPrevHard() {
  if (!stepTrace) return;
  for (let i = stepIndex - 2; i >= 0; i--) {
    if (isNontrivial(stepTrace.steps[i])) { stepIndex = i + 1; renderStep(); return; }
  }
}
function exitStepMode() {
  stepMode = false; stepTrace = null; stepIndex = 0;
  const panel = document.getElementById("step-panel"); if (panel) panel.hidden = true;
  const stepsBtn = document.getElementById("steps-btn"); if (stepsBtn) stepsBtn.textContent = "Lösungsweg";
  const grid = document.getElementById("grid");
  if (grid) {
    grid.classList.remove("pencil");
    grid.querySelectorAll("td").forEach(td => td.classList.remove("changed", "solved-now"));
  }
  clearGridCells();
  setSolutionShown(false);
}
function toggleSteps() { if (stepMode) exitStepMode(); else enterStepMode(); }


document.getElementById("generate-btn").addEventListener("click", newSearch);
document.getElementById("accept-btn").addEventListener("click", acceptNow);
// Mode switch: "Stufe" shows the level slider, "Kalibrierung" the raw b-threshold
// + hard-step-count inputs, "Editor" the manual-entry panel. Exclusive — only one
// panel is visible/used at a time.
function syncModeUI() {
  const active = document.querySelector('#mode-picker button[aria-selected="true"]');
  const mode = active ? active.dataset.mode : "level";
  el("difficulty-picker").hidden = mode !== "level";
  el("calib-inputs").hidden = mode !== "calib";
  el("manual-entry").hidden = mode !== "manual";
  el("reveal").hidden = mode !== "code";
  el("hint-level").hidden = mode !== "level";
  el("hint-calib").hidden = mode !== "calib";
  // In Editor-/Rätselcode-Modus lädt man per panel-eigenem "Rätsel laden"-Button;
  // der globale "Rätsel generieren"-Button passt dort nicht. Drucken wird im
  // Rätselcode-Tab ebenfalls nicht gebraucht.
  el("generate-btn").hidden = mode === "manual" || mode === "code";
  el("print-btn").hidden = mode === "code";
}
// Modus-Tabs: den geklickten Tab als aria-selected markieren, dann die
// mode-abhängige UI (Slider ↔ Kalibrier-Inputs) synchronisieren.
function setMode(mode) {
  Array.prototype.forEach.call(document.querySelectorAll('#mode-picker button'), b => {
    b.setAttribute("aria-selected", b.dataset.mode === mode ? "true" : "false");
  });
  syncModeUI();
}
Array.prototype.forEach.call(document.querySelectorAll('#mode-picker button'), b => b.addEventListener("click", () => setMode(b.dataset.mode)));
syncModeUI();
// Difficulty slider: reflect the current level's name live as it's dragged.
function syncLevelName() {
  const lvl = clampInt(el("level-slider").value, 1, 6, 3);
  el("level-name").textContent = LEVELS[lvl - 1].name;
}
el("level-slider").addEventListener("input", syncLevelName);
syncLevelName();
// Load a puzzle from a code: decode → solve → set as currentPuzzle and render.
// Returns the grid on success, null on failure (with error message side-effect
// into errEl, default das globale #error — das sitzt unterm Rätsel und ist beim
// Klick im Rätselcode-Tab nicht im Viewport, daher reicht der Button dort sein
// panelnahes #code-error herein).
function loadPuzzleFromCode(code, errPrefix, errEl) {
  const err = errEl || document.getElementById("error");
  const clues = decodePuzzle(code);
  if (!clues) { err.textContent = (errPrefix || "Code") + " ungültig."; return null; }
  const tr = solveWithTrace(clues);
  if (!tr.solved) { err.textContent = (errPrefix || "Code") + " entspricht keinem eindeutig lösbaren Rätsel."; return null; }
  err.textContent = "";
  const canon = encodePuzzle(clues);
  currentPuzzle = { grid: tr.grid, clues, code: canon, clueCount: countClues(clues), trace: tr };
  // Kalibrierungsinfo auch für Code-Loads (Fixture-Codes vergleichbar machen):
  // Schwelle aus dem Kalibrier-Tab, hardCount frisch aus dem Trace — dieselbe
  // Rechnung wie bei der Kalibrier-Generierung (dort: countHardSteps(trace, calibT)).
  const threshold = clampInt(el("calib-threshold").value, 2, 9, 4);
  currentPuzzle.calib = { threshold, hardCount: countHardSteps(tr, threshold) };
  renderPuzzle(currentPuzzle);
  document.getElementById("print-btn").disabled = false;
  document.getElementById("steps-btn").disabled = false;
  document.getElementById("solution-btn").disabled = false;
  return tr.grid;
}


// === Manuelle Rätseleingabe ===
//
// Pro Reihe/Spalte ein Input-Feld; mehrere Clues mit ';' oder ',' getrennt.
// Grammar (case-insensitive, whitespace-flexible):
//   line     = clue ((';'|',') clue)*
//   clue     = pairSum | totalSum | duplicate | sequence
//   pairSum  = CELL '+' CELL '=' INT       e.g. A3+A4=11
//   totalSum = ('SUM'|'Σ') '=' INT          e.g. SUM=29
//   duplicate = INT 'x' INT? | INT '²'      e.g. 5x2 / 5x / 2x5 / 5²
//   sequence = 'RUN' 'ASC' | 'RUN' 'DESC' | 'ASC' | 'DESC'
//   CELL     = [A-F] [1-6]
//
// parseManualLine returns { ok, clues, errors }. The line context (kind, idx)
// determines which pairs are accepted (row-A field → only A?+A? pairs; col-3
// field → only ?3+?3 pairs).

function parseCell(s) {
  // s is a string like "A3" (case already normalised). Returns [r, c] or null.
  if (s.length !== 2) return null;
  const r = s.charCodeAt(0) - 65;       // 'A'..'F' → 0..5
  const c = s.charCodeAt(1) - 49;       // '1'..'6' → 0..5
  if (r < 0 || r >= N || c < 0 || c >= N) return null;
  return [r, c];
}

function parseManualClue(raw, kind, idx) {
  // raw: one chunk between separators. kind: "row"|"col". idx: 0..5.
  const s = raw.replace(/\s+/g, " ").trim().toUpperCase();
  if (!s) return null; // caller will skip empty chunks
  // PairSum: CELL+CELL=N
  let m = s.match(/^([A-F])\s*([1-6])\s*\+\s*([A-F])\s*([1-6])\s*=\s*(\d+)$/);
  if (m) {
    const a = [m[1].charCodeAt(0) - 65, m[2].charCodeAt(0) - 49];
    const b = [m[3].charCodeAt(0) - 65, m[4].charCodeAt(0) - 49];
    const value = parseInt(m[5], 10);
    // Adjacency
    const dr = Math.abs(a[0]-b[0]), dc = Math.abs(a[1]-b[1]);
    if (dr + dc !== 1) return { error: `Zellen ${ROW_LABELS[a[0]]}${COL_LABELS[a[1]]} und ${ROW_LABELS[b[0]]}${COL_LABELS[b[1]]} sind nicht benachbart` };
    // Line match
    if (kind === "row") {
      if (a[0] !== idx || b[0] !== idx) return { error: `Paar muss in Reihe ${ROW_LABELS[idx]} liegen (beide Zellen mit ${ROW_LABELS[idx]}…)` };
    } else {
      if (a[1] !== idx || b[1] !== idx) return { error: `Paar muss in Spalte ${COL_LABELS[idx]} liegen (beide Zellen mit …${COL_LABELS[idx]})` };
    }
    // Value range
    if (value < 3 || value > 17) return { error: `Paarsumme ${value} außerhalb von 3–17` };
    // Canonical cell order (smaller first)
    const cells = (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) ? [a, b] : [b, a];
    return { clue: { type: "pairSum", cells, value } };
  }
  // TotalSum: SUM=N or Σ=N
  m = s.match(/^(?:SUM|Σ)\s*=\s*(\d+)$/);
  if (m) {
    const value = parseInt(m[1], 10);
    if (value < 6 || value > 54) return { error: `Gesamtsumme ${value} außerhalb von 6–54` };
    return { clue: { type: "totalSum", scope: kind, index: idx, value } };
  }
  // Count clues: 5x2 (duplicate) / 5x1 (exactly once) / 5x0 (absent),
  // legacy forms 5x / 5² (duplicate) and 2x5 (count-first duplicate).
  m = s.match(/^(\d)\s*²$/) || s.match(/^(\d)\s*[X×]\s*$/);
  if (m) {
    const value = parseInt(m[1], 10);
    if (value < 1 || value > 9) return { error: `Ziffer ${value} im Duplikat außerhalb von 1–9` };
    return { clue: { type: "duplicate", scope: kind, index: idx, value } };
  }
  m = s.match(/^(\d)\s*[X×]\s*(\d)$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    // Value first: AxB with B ∈ {0,1,2} means "value A appears B times".
    // (This deliberately re-reads the previously valid "2x1" as "once 2", not
    // "dup 1".) The legacy count-first form AnzahlxWert survives only as 2xB
    // with B ≥ 3, where it is unambiguous.
    if (b <= 2) {
      if (a < 1 || a > 9) return { error: `Ziffer ${a} außerhalb von 1–9` };
      const type = b === 2 ? "duplicate" : b === 1 ? "once" : "absent";
      return { clue: { type, scope: kind, index: idx, value: a } };
    }
    if (a === 2) return { clue: { type: "duplicate", scope: kind, index: idx, value: b } };
    return { error: `Anzahl ${b} ungültig — erlaubt sind Wertx0 (kommt nicht vor), Wertx1 (genau einmal), Wertx2 (doppelt) oder die Legacy-Form 2xWert` };
  }
  // Sequences
  if (/^RUN\s+ASC$/.test(s)) return { clue: { type: "directSequence", scope: kind, index: idx } };
  if (/^RUN\s+DESC$/.test(s)) return { clue: { type: "directDescending", scope: kind, index: idx } };
  if (/^ASC$/.test(s)) return { clue: { type: "ascending", scope: kind, index: idx } };
  if (/^DESC$/.test(s)) return { clue: { type: "descending", scope: kind, index: idx } };
  return { error: `Hinweis nicht erkannt: ${raw.trim()}` };
}

function parseManualLine(text, kind, idx) {
  const errors = [];
  const clues = [];
  if (!text.trim()) return { clues, errors };
  for (const chunk of text.split(/[;,]/)) {
    const parsed = parseManualClue(chunk, kind, idx);
    if (!parsed) continue;            // empty chunk
    if (parsed.error) { errors.push(parsed.error); continue; }
    clues.push(parsed.clue);
  }
  // Line-level uniqueness: at most one totalSum/duplicate/sequence per line.
  // (once/absent are NOT sequences — several per line are fine, see below.)
  const counts = { totalSum: 0, duplicate: 0, sequence: 0 };
  for (const cl of clues) {
    if (cl.type === "totalSum") counts.totalSum++;
    else if (cl.type === "duplicate") counts.duplicate++;
    else if (cl.type !== "pairSum" && cl.type !== "once" && cl.type !== "absent") counts.sequence++;
  }
  if (counts.totalSum > 1) errors.push("mehrere SUM-Hinweise — höchstens einer pro Linie");
  if (counts.duplicate > 1) errors.push("mehrere Duplikat-Hinweise — höchstens einer pro Linie");
  if (counts.sequence > 1) errors.push("mehrere Sequenz-Hinweise — höchstens einer pro Linie");
  // Count clues about the same value contradict each other (or repeat):
  // at most one of Vx0 / Vx1 / Vx2 per value and line.
  const countByValue = new Map();
  for (const cl of clues) {
    if (cl.type !== "duplicate" && cl.type !== "once" && cl.type !== "absent") continue;
    countByValue.set(cl.value, (countByValue.get(cl.value) || 0) + 1);
  }
  for (const [v, n] of countByValue) if (n > 1)
    errors.push(`widersprüchliche Hinweise zur ${v} — höchstens einer von ${v}x0 / ${v}x1 / ${v}x2 pro Linie`);
  return { clues, errors };
}

function readManualFields() {
  // Returns { clues, errors, perField }
  const rowClues = Array.from({ length: N }, () => []);
  const colClues = Array.from({ length: N }, () => []);
  const perField = [];   // { id, errors }
  let totalErrors = 0;
  for (let r = 0; r < N; r++) {
    const inp = document.getElementById("m-r-" + r);
    const { clues, errors } = parseManualLine(inp.value, "row", r);
    rowClues[r].push(...clues);
    inp.classList.toggle("field-bad", errors.length > 0);
    perField.push({ id: inp.id, label: "Reihe " + ROW_LABELS[r], errors });
    totalErrors += errors.length;
  }
  for (let c = 0; c < N; c++) {
    const inp = document.getElementById("m-c-" + c);
    const { clues, errors } = parseManualLine(inp.value, "col", c);
    colClues[c].push(...clues);
    inp.classList.toggle("field-bad", errors.length > 0);
    perField.push({ id: inp.id, label: "Spalte " + COL_LABELS[c], errors });
    totalErrors += errors.length;
  }
  // Sort each line into the canonical display order (clueDisplayRank from
  // logicals.solver.js) so re-encode produces a stable code.
  for (const list of rowClues.concat(colClues)) list.sort((a, b) => clueDisplayRank(a) - clueDisplayRank(b));
  return { clues: { rowClues, colClues }, perField, totalErrors };
}

function loadManualPuzzle() {
  const errBox = document.getElementById("manual-error");
  errBox.textContent = "";
  const { clues, perField, totalErrors } = readManualFields();

  if (totalErrors > 0) {
    const lines = [];
    for (const f of perField) for (const e of f.errors) lines.push(`${f.label}: ${e}`);
    errBox.textContent = lines.join("\n");
    return;
  }
  if (countClues(clues) === 0) {
    errBox.textContent = "Bitte mindestens einen Hinweis eingeben.";
    return;
  }

  const tr = solveWithTrace(clues);
  if (!tr.solved) {
    errBox.textContent = "Rätsel ist mit den implementierten Regeln nicht eindeutig per Deduktion lösbar — bitte Eingabe prüfen.";
    return;
  }

  const code = encodePuzzle(clues);
  currentPuzzle = { grid: tr.grid, clues, code, clueCount: countClues(clues), trace: tr };
  renderPuzzle(currentPuzzle);
  document.getElementById("print-btn").disabled = false;
  document.getElementById("steps-btn").disabled = false;
  document.getElementById("solution-btn").disabled = false;
  document.getElementById("error").textContent = "";
}

function clearManualFields() {
  for (let r = 0; r < N; r++) {
    const inp = document.getElementById("m-r-" + r);
    inp.value = ""; inp.classList.remove("field-bad");
  }
  for (let c = 0; c < N; c++) {
    const inp = document.getElementById("m-c-" + c);
    inp.value = ""; inp.classList.remove("field-bad");
  }
  document.getElementById("manual-error").textContent = "";
}

document.getElementById("manual-load-btn").addEventListener("click", loadManualPuzzle);
document.getElementById("manual-clear-btn").addEventListener("click", clearManualFields);
document.getElementById("syntax-help-btn").addEventListener("click", () => {
  const dlg = document.getElementById("syntax-dialog");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
});

// "Rätsel laden" im Rätselcode-Tab: Code decodieren und die Seite in den
// Frisch-generiert-Zustand bringen (leeres Gitter, Hinweise, QR, Editor-Sync).
// Fehler landen panelnah in #code-error; nur bei gültigem Code zu den
// Hinweisen scrollen.
document.getElementById("code-load-btn").addEventListener("click", () => {
  const grid = loadPuzzleFromCode(document.getElementById("code-input").value, "Code",
    document.getElementById("code-error"));
  if (!grid) return;
  document.getElementById("hints-block").scrollIntoView({ behavior: "smooth", block: "start" });
});
// Lösung-Toggle unter dem Gitter: zeigt/verbirgt die Lösung des aktuellen Rätsels.
document.getElementById("solution-btn").addEventListener("click", () => {
  if (!currentPuzzle) return;
  if (solutionShown) {
    hideSolution();
  } else {
    exitStepMode();
    showSolution(currentPuzzle.grid);
  }
});
document.getElementById("print-btn").addEventListener("click", () => window.print());
document.getElementById("steps-btn").addEventListener("click", toggleSteps);
document.getElementById("step-prev").addEventListener("click", stepPrev);
document.getElementById("step-next").addEventListener("click", stepNext);
document.getElementById("step-reset").addEventListener("click", stepReset);
document.getElementById("step-prev-hard").addEventListener("click", stepPrevHard);
document.getElementById("step-next-hard").addEventListener("click", stepNextHard);
document.getElementById("step-list").addEventListener("click", (e) => {
  const li = e.target.closest("li"); if (!li) return;
  const k = parseInt(li.dataset.step, 10); if (!k) return;
  stepIndex = k; renderStep();
});

// If URL contains ?code=…, auto-fill the input and load the puzzle.
// The puzzle is shown empty — the recipient solves it (or uses the
// "Lösung zeigen" toggle below the grid).
(function applyCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return;
  document.getElementById("code-input").value = code;
  loadPuzzleFromCode(code, "Code aus URL");
})();
