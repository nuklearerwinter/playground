"use strict";
// Pure puzzle logic, no DOM. Loaded before logicals.app.js (which builds
// WORKER_SRC from workerCode.toString()). Node-testable as a whole.

// === Main-thread constants & helpers ===
const N = 6;
const ROW_LABELS = ["A","B","C","D","E","F"];
const COL_LABELS = ["1","2","3","4","5","6"];
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PUBLIC_URL = "https://nuklearerwinter.github.io/playground/logicals.html";

function shareUrl(code) {
  const base = (location.protocol === "http:" || location.protocol === "https:")
    ? location.origin + location.pathname
    : PUBLIC_URL;
  return base + "?code=" + encodeURIComponent(code);
}

function makeQrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, scalable: true });
}

function cellLabel(r, c) { return ROW_LABELS[r] + COL_LABELS[c]; }

function clueText(clue) {
  switch (clue.type) {
    case "duplicate":
      return `Die ${clue.value} kommt doppelt vor.`;
    case "pairSum": {
      const [a, b] = clue.cells;
      return `${cellLabel(a[0],a[1])} plus ${cellLabel(b[0],b[1])} ergibt ${clue.value}.`;
    }
    case "totalSum":
      return `Die Summe aller sechs Zahlen lautet ${clue.value}.`;
    case "directSequence":
      return clue.scope === "row"
        ? "Die Zahlen sind von links nach rechts direkt aufeinanderfolgend angeordnet."
        : "Die Zahlen sind von oben nach unten direkt aufeinanderfolgend angeordnet.";
    case "directDescending":
      return clue.scope === "row"
        ? "Die Zahlen sind von links nach rechts direkt absteigend angeordnet."
        : "Die Zahlen sind von oben nach unten direkt absteigend angeordnet.";
    case "ascending":
      return clue.scope === "row"
        ? "Die Zahlen sind von links nach rechts aufsteigend angeordnet (ggf. mit Lücken)."
        : "Die Zahlen sind von oben nach unten aufsteigend angeordnet (ggf. mit Lücken).";
    case "descending":
      return clue.scope === "row"
        ? "Die Zahlen sind von links nach rechts absteigend angeordnet (ggf. mit Lücken)."
        : "Die Zahlen sind von oben nach unten absteigend angeordnet (ggf. mit Lücken).";
  }
  return "?";
}


// === Puzzle-code (clues) encoding ===
//
// Wire format (Crockford-Base32, dash-grouped every 4 chars):
//   4 bits  version (0)
//   60 bits pairSum bitmap  (indices 0..29 = horizontal pairs in row-major (r*5+c),
//                            indices 30..59 = vertical pairs in col-major (c*5+r))
//     + 4 bits per set bit: pairSum value − 3  (range 3..17 → 0..14)
//   12 bits totalSum bitmap (lines 0..5 = rows, 6..11 = cols)
//     + 6 bits per set bit: totalSum value − 6  (range 6..54 → 0..48)
//   12 bits duplicate bitmap (same line ordering)
//     + 4 bits per set bit: duplicate value − 1  (range 1..9 → 0..8)
//   12 bits sequence bitmap  (same line ordering)
//     + 2 bits per set bit: type code (0=directSequence, 1=ascending,
//                                       2=descending, 3=directDescending)
//   8  bits checksum: sum of all preceding data bytes (8-bit groups, last padded
//                     with zeros) mod 256
// Total size: 152–200 bits → 31–40 base32 chars depending on clue density.
// Round-tripping: encode(decode(code)) === code (canonical clue ordering preserved).

const PAIR_HORIZ_COUNT = N * (N - 1);  // 30
const PAIR_TOTAL = 2 * PAIR_HORIZ_COUNT; // 60

function pairIndexOf(cells) {
  const [[r1, c1], [r2, c2]] = cells;
  if (r1 === r2) return r1 * (N - 1) + Math.min(c1, c2);
  return PAIR_HORIZ_COUNT + c1 * (N - 1) + Math.min(r1, r2);
}
function pairCellsFromIndex(idx) {
  if (idx < PAIR_HORIZ_COUNT) {
    const r = (idx / (N - 1)) | 0, c = idx % (N - 1);
    return [[r, c], [r, c + 1]];
  }
  const off = idx - PAIR_HORIZ_COUNT;
  const c = (off / (N - 1)) | 0, r = off % (N - 1);
  return [[r, c], [r + 1, c]];
}

function pushBits(bits, val, n) {
  for (let b = n - 1; b >= 0; b--) bits.push((val >> b) & 1);
}
function readBits(bits, pos, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | bits[pos + i];
  return v;
}
function checksum8(bits) {
  let s = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8 && i + b < bits.length; b++) byte = (byte << 1) | bits[i + b];
    s = (s + byte) & 0xFF;
  }
  return s;
}
function bitsToBase32(bits) {
  const buf = bits.slice();
  while (buf.length % 5 !== 0) buf.push(0);
  let out = "";
  for (let i = 0; i < buf.length; i += 5) {
    const v = (buf[i] << 4) | (buf[i + 1] << 3) | (buf[i + 2] << 2) | (buf[i + 3] << 1) | buf[i + 4];
    out += ALPHABET[v];
  }
  return out;
}
function base32ToBits(s) {
  const bits = [];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    for (let b = 4; b >= 0; b--) bits.push((v >> b) & 1);
  }
  return bits;
}

const SEQ_TYPES = ["directSequence", "ascending", "descending", "directDescending"];

function encodePuzzle(clues) {
  // Bucket clues by type, keyed by their compact index.
  const pairVal = new Map();    // pairIndex (0..59)  -> value (3..17)
  const totalVal = new Map();   // lineIndex (0..11) -> value (6..54)
  const dupVal = new Map();     // lineIndex (0..11) -> value (1..9)
  const seqVal = new Map();     // lineIndex (0..11) -> type code (0/1/2)
  const lineIdx = (scope, idx) => scope === "row" ? idx : N + idx;

  for (const list of clues.rowClues.concat(clues.colClues)) for (const cl of list) {
    if (cl.type === "pairSum")            pairVal.set(pairIndexOf(cl.cells), cl.value);
    else if (cl.type === "totalSum")      totalVal.set(lineIdx(cl.scope, cl.index), cl.value);
    else if (cl.type === "duplicate")     dupVal.set(lineIdx(cl.scope, cl.index), cl.value);
    else {
      const tc = SEQ_TYPES.indexOf(cl.type);
      if (tc >= 0) seqVal.set(lineIdx(cl.scope, cl.index), tc);
    }
  }

  const bits = [];
  pushBits(bits, 0, 4); // version
  // pairSum bitmap + values
  for (let i = 0; i < PAIR_TOTAL; i++) bits.push(pairVal.has(i) ? 1 : 0);
  for (let i = 0; i < PAIR_TOTAL; i++) if (pairVal.has(i)) pushBits(bits, pairVal.get(i) - 3, 4);
  // totalSum bitmap + values
  for (let i = 0; i < 2 * N; i++) bits.push(totalVal.has(i) ? 1 : 0);
  for (let i = 0; i < 2 * N; i++) if (totalVal.has(i)) pushBits(bits, totalVal.get(i) - 6, 6);
  // duplicate bitmap + values
  for (let i = 0; i < 2 * N; i++) bits.push(dupVal.has(i) ? 1 : 0);
  for (let i = 0; i < 2 * N; i++) if (dupVal.has(i)) pushBits(bits, dupVal.get(i) - 1, 4);
  // sequence bitmap + types
  for (let i = 0; i < 2 * N; i++) bits.push(seqVal.has(i) ? 1 : 0);
  for (let i = 0; i < 2 * N; i++) if (seqVal.has(i)) pushBits(bits, seqVal.get(i), 2);
  // checksum
  pushBits(bits, checksum8(bits), 8);

  return bitsToBase32(bits).match(/.{1,4}/g).join("-");
}

function decodePuzzle(code) {
  if (!code) return null;
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean) return null;
  const bits = base32ToBits(clean);
  if (!bits) return null;

  let pos = 0;
  const need = (n) => { if (pos + n > bits.length) throw new Error("eof"); };
  try {
    need(4);
    const ver = readBits(bits, pos, 4); pos += 4;
    if (ver !== 0) return null;

    // pairSum
    need(PAIR_TOTAL);
    const pairBits = bits.slice(pos, pos + PAIR_TOTAL); pos += PAIR_TOTAL;
    const pairs = [];
    for (let i = 0; i < PAIR_TOTAL; i++) if (pairBits[i]) {
      need(4); const v = readBits(bits, pos, 4) + 3; pos += 4;
      pairs.push({ idx: i, value: v });
    }
    // totalSum
    need(2 * N);
    const tsBits = bits.slice(pos, pos + 2 * N); pos += 2 * N;
    const tsList = [];
    for (let i = 0; i < 2 * N; i++) if (tsBits[i]) {
      need(6); const v = readBits(bits, pos, 6) + 6; pos += 6;
      if (v < 6 || v > 54) return null;
      tsList.push({ line: i, value: v });
    }
    // duplicate
    need(2 * N);
    const dupBits = bits.slice(pos, pos + 2 * N); pos += 2 * N;
    const dupList = [];
    for (let i = 0; i < 2 * N; i++) if (dupBits[i]) {
      need(4); const v = readBits(bits, pos, 4) + 1; pos += 4;
      if (v < 1 || v > 9) return null;
      dupList.push({ line: i, value: v });
    }
    // sequence
    need(2 * N);
    const seqBits = bits.slice(pos, pos + 2 * N); pos += 2 * N;
    const seqList = [];
    for (let i = 0; i < 2 * N; i++) if (seqBits[i]) {
      need(2); const t = readBits(bits, pos, 2); pos += 2;
      if (t > 3) return null;
      seqList.push({ line: i, type: t });
    }
    // checksum
    need(8);
    const expected = checksum8(bits.slice(0, pos));
    const actual = readBits(bits, pos, 8); pos += 8;
    if (expected !== actual) return null;

    // Assemble clues (matching the worker's display order:
    // duplicate, sequence, pairSums left-to-right / top-to-bottom, totalSum)
    const rowClues = Array.from({ length: N }, () => []);
    const colClues = Array.from({ length: N }, () => []);
    const addLine = (line, cl) => {
      if (line < N) rowClues[line].push({ ...cl, scope: "row", index: line });
      else colClues[line - N].push({ ...cl, scope: "col", index: line - N });
    };
    for (const p of pairs) {
      const cells = pairCellsFromIndex(p.idx);
      const cl = { type: "pairSum", cells, value: p.value };
      if (cells[0][0] === cells[1][0]) rowClues[cells[0][0]].push(cl);
      else colClues[cells[0][1]].push(cl);
    }
    for (const ts of tsList) addLine(ts.line, { type: "totalSum", value: ts.value });
    for (const d of dupList) addLine(d.line, { type: "duplicate", value: d.value, mandatory: true });
    for (const s of seqList) addLine(s.line, { type: SEQ_TYPES[s.type] });

    const rank = (cl) => {
      if (cl.type === "duplicate") return 0;
      if (cl.type === "directSequence" || cl.type === "directDescending" || cl.type === "ascending" || cl.type === "descending") return 1;
      if (cl.type === "pairSum") return 2 + cl.cells[0][0] * N + cl.cells[0][1];
      return 100; // totalSum last
    };
    for (const list of rowClues.concat(colClues)) list.sort((a, b) => rank(a) - rank(b));

    return { rowClues, colClues };
  } catch (e) {
    return null;
  }
}

function countClues(clues) {
  let n = 0;
  for (const list of clues.rowClues.concat(clues.colClues)) n += list.length;
  return n;
}

// === Worker code (self-contained; runs in a Web Worker) ===
function workerCode() {
  "use strict";
  const N = 6;
  const FULL_DOMAIN = 0x1FF;

  const POPCOUNT = new Int8Array(512);
  for (let i = 0; i < 512; i++) {
    let n = 0, x = i;
    while (x) { n++; x &= x - 1; }
    POPCOUNT[i] = n;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function sumOf(arr) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s; }
  function rowOf(grid, r) { return grid[r].slice(); }
  function colOf(grid, c) { return grid.map(row => row[c]); }

  function findDuplicate(vals) {
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    for (const k in counts) if (counts[k] === 2) return parseInt(k);
    return null;
  }
  function isDirectSequence(vals) {
    for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i-1] + 1) return false;
    return true;
  }
  function isDirectDescending(vals) {
    for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i-1] - 1) return false;
    return true;
  }
  function isAscending(vals) {
    for (let i = 1; i < vals.length; i++) if (vals[i] <= vals[i-1]) return false;
    return true;
  }
  function isDescending(vals) {
    for (let i = 1; i < vals.length; i++) if (vals[i] >= vals[i-1]) return false;
    return true;
  }
  function atMostOneDoubled(arr) {
    const counts = {};
    for (const v of arr) counts[v] = (counts[v] || 0) + 1;
    let doubled = 0;
    for (const k in counts) {
      if (counts[k] >= 3) return false;
      if (counts[k] === 2) doubled++;
    }
    return doubled <= 1;
  }
  function gridQualityOK(grid, maxDupLines, minDupLines) {
    const cap = (typeof maxDupLines === "number") ? maxDupLines : 5;
    const floor = (typeof minDupLines === "number") ? minDupLines : 0;
    let dupLines = 0;
    for (let r = 0; r < N; r++) {
      const arr = rowOf(grid, r);
      if (!atMostOneDoubled(arr)) return false;
      if (findDuplicate(arr) !== null) dupLines++;
    }
    for (let c = 0; c < N; c++) {
      const arr = colOf(grid, c);
      if (!atMostOneDoubled(arr)) return false;
      if (findDuplicate(arr) !== null) dupLines++;
    }
    return dupLines <= cap && dupLines >= floor;
  }

  function decideSequences(numSequences) {
    const result = [];
    const used = new Set();
    let attempts = 0;
    while (result.length < numSequences && attempts++ < 200) {
      const isRow = Math.random() < 0.5;
      const lineIdx = Math.floor(Math.random() * N);
      const key = (isRow ? "r" : "c") + lineIdx;
      if (used.has(key)) continue;
      used.add(key);
      // Distribution: ~17.5% direct asc, ~17.5% direct desc, ~33% asc-w-gaps,
      // ~32% desc-w-gaps — same overall "direct vs gappy" balance as before,
      // but the direct half is now split between both directions.
      const roll = Math.random();
      let type, values;
      if (roll < 0.175) {
        const k = 1 + Math.floor(Math.random() * 4);
        values = [k, k+1, k+2, k+3, k+4, k+5];
        type = "directSequence";
      } else if (roll < 0.35) {
        const k = 1 + Math.floor(Math.random() * 4);
        values = [k+5, k+4, k+3, k+2, k+1, k];
        type = "directDescending";
      } else {
        const all = [1,2,3,4,5,6,7,8,9];
        for (let i = all.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = all[i]; all[i] = all[j]; all[j] = t;
        }
        values = all.slice(0, 6).sort((a, b) => a - b);
        if (roll >= 0.68) {
          values.reverse();
          type = "descending";
        } else {
          type = "ascending";
        }
      }
      result.push({ isRow: isRow, lineIdx: lineIdx, type: type, values: values });
    }
    return result;
  }

  function applySequencesToGrid(grid, counts, sequences) {
    for (const seq of sequences) {
      for (let i = 0; i < N; i++) {
        const r = seq.isRow ? seq.lineIdx : i;
        const c = seq.isRow ? i : seq.lineIdx;
        const v = seq.values[i];
        const existing = grid[r][c];
        if (existing !== 0) {
          if (existing !== v) return false;
          continue;
        }
        if (counts[v] >= 4) return false;
        if (r > 0 && grid[r-1][c] === v) return false;
        if (r < N-1 && grid[r+1][c] === v) return false;
        if (c > 0 && grid[r][c-1] === v) return false;
        if (c < N-1 && grid[r][c+1] === v) return false;
        grid[r][c] = v;
        counts[v]++;
      }
    }
    return true;
  }

  function generateGrid(numSequences, maxDupLines, minDupLines) {
    const MAX_OUTER = 20;
    const MAX_INNER = 8;
    for (let outer = 0; outer < MAX_OUTER; outer++) {
      const sequences = numSequences > 0 ? decideSequences(numSequences) : [];
      for (let inner = 0; inner < MAX_INNER; inner++) {
        const grid = Array.from({length: N}, () => Array(N).fill(0));
        const counts = Array(10).fill(0);
        if (!applySequencesToGrid(grid, counts, sequences)) break;
        function fill(idx) {
          if (idx === N*N) return true;
          const r = (idx / N) | 0;
          const c = idx % N;
          if (grid[r][c] !== 0) return fill(idx + 1);
          const cands = [];
          for (let v = 1; v <= 9; v++) {
            if (counts[v] >= 4) continue;
            if (r > 0 && grid[r-1][c] === v) continue;
            if (c > 0 && grid[r][c-1] === v) continue;
            if (r < N-1 && grid[r+1][c] === v) continue;
            if (c < N-1 && grid[r][c+1] === v) continue;
            let rc = 0;
            for (let cc = 0; cc < N; cc++) if (grid[r][cc] === v) rc++;
            if (rc >= 2) continue;
            let cc_ = 0;
            for (let rr = 0; rr < N; rr++) if (grid[rr][c] === v) cc_++;
            if (cc_ >= 2) continue;
            cands.push({ v: v, s: rc + cc_ });
          }
          for (let i = cands.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = cands[i]; cands[i] = cands[j]; cands[j] = t;
          }
          cands.sort((a, b) => a.s - b.s);
          for (let k = 0; k < cands.length; k++) {
            const v = cands[k].v;
            grid[r][c] = v;
            counts[v]++;
            if (fill(idx + 1)) return true;
            grid[r][c] = 0;
            counts[v]--;
          }
          return false;
        }
        if (fill(0) && gridQualityOK(grid, maxDupLines, minDupLines)) return grid;
      }
    }
    return null;
  }

  function rowCandidates(grid, r) {
    const vals = rowOf(grid, r);
    const list = [];
    const dup = findDuplicate(vals);
    if (dup !== null) list.push({ type: "duplicate", scope: "row", index: r, value: dup, mandatory: true });
    for (let c = 0; c < N - 1; c++) {
      list.push({ type: "pairSum", cells: [[r,c],[r,c+1]], value: vals[c] + vals[c+1] });
    }
    list.push({ type: "totalSum", scope: "row", index: r, value: sumOf(vals) });
    if (isDirectSequence(vals)) list.push({ type: "directSequence", scope: "row", index: r });
    else if (isDirectDescending(vals)) list.push({ type: "directDescending", scope: "row", index: r });
    else if (isAscending(vals)) list.push({ type: "ascending", scope: "row", index: r });
    else if (isDescending(vals)) list.push({ type: "descending", scope: "row", index: r });
    return list;
  }
  function colCandidates(grid, c) {
    const vals = colOf(grid, c);
    const list = [];
    const dup = findDuplicate(vals);
    if (dup !== null) list.push({ type: "duplicate", scope: "col", index: c, value: dup, mandatory: true });
    for (let r = 0; r < N - 1; r++) {
      list.push({ type: "pairSum", cells: [[r,c],[r+1,c]], value: vals[r] + vals[r+1] });
    }
    list.push({ type: "totalSum", scope: "col", index: c, value: sumOf(vals) });
    if (isDirectSequence(vals)) list.push({ type: "directSequence", scope: "col", index: c });
    else if (isDirectDescending(vals)) list.push({ type: "directDescending", scope: "col", index: c });
    else if (isAscending(vals)) list.push({ type: "ascending", scope: "col", index: c });
    else if (isDescending(vals)) list.push({ type: "descending", scope: "col", index: c });
    return list;
  }
  function buildCandidateClues(grid) {
    const rowCands = [], colCands = [];
    for (let r = 0; r < N; r++) rowCands.push(rowCandidates(grid, r));
    for (let c = 0; c < N; c++) colCands.push(colCandidates(grid, c));
    return { rowCands, colCands };
  }

  function clueCells(clue) {
    if (clue.type === "pairSum") return clue.cells.map(([r,c]) => r*N+c);
    const cells = [];
    if (clue.scope === "row") {
      for (let c = 0; c < N; c++) cells.push(clue.index*N + c);
    } else {
      for (let r = 0; r < N; r++) cells.push(r*N + clue.index);
    }
    return cells;
  }

  // Propagation-only ("logical") solver: applies sound deductions to a
  // fixpoint WITHOUT ever guessing/branching. If it determines every cell,
  // the puzzle is solvable by pure reasoning — i.e. a human never has to
  // guess. Used as the acceptance gate so we only emit deducible puzzles.
  // (A complete solve here also proves uniqueness, since every elimination
  // is valid in every solution.)
  function logicalSolve(selected) {
    const rowDup = new Int32Array(N);
    const colDup = new Int32Array(N);
    const pairs = [];
    const totals = [];
    const seqs = [];
    function reg(cl) {
      if (cl.type === "duplicate") {
        if (cl.scope === "row") rowDup[cl.index] |= 1 << (cl.value - 1);
        else colDup[cl.index] |= 1 << (cl.value - 1);
      } else if (cl.type === "pairSum") {
        const a = cl.cells[0][0]*N + cl.cells[0][1];
        const b = cl.cells[1][0]*N + cl.cells[1][1];
        pairs.push({ a: a, b: b, value: cl.value });
      } else if (cl.type === "totalSum") {
        totals.push({ cells: clueCells(cl), value: cl.value, scope: cl.scope, index: cl.index });
      } else if (cl.type === "directSequence" || cl.type === "directDescending" || cl.type === "ascending" || cl.type === "descending") {
        seqs.push({ cells: clueCells(cl), type: cl.type });
      }
    }
    for (let r = 0; r < N; r++) for (const cl of selected.rowClues[r]) reg(cl);
    for (let c = 0; c < N; c++) for (const cl of selected.colClues[c]) reg(cl);
    // Attach the line's duplicate-value mask to each totalSum (used by the
    // distinct-sum propagator below). Must run after all reg() calls so the
    // duplicate clues on the same line have been registered.
    for (const t of totals) t.dupMask = t.scope === "row" ? rowDup[t.index] : colDup[t.index];

    // Lines that need feasibility-DFS: any row/column constrained by a totalSum
    // and/or a duplicate clue. Unconstrained lines yield no reduction. Each
    // entry also carries a per-line snapshot of cell domains from its previous
    // DFS run; if no domain changed since then the run is skipped (the search
    // is deterministic in the domains, so the result would be identical).
    const lineSearches = [];
    function totalSumFor(scope, idx) {
      for (const t of totals) if (t.scope === scope && t.index === idx) return t.value;
      return -1;
    }
    for (let r = 0; r < N; r++) {
      const ts = totalSumFor("row", r), dm = rowDup[r];
      if (ts < 0 && dm === 0) continue;
      const cells = []; for (let c = 0; c < N; c++) cells.push(r * N + c);
      lineSearches.push({ cells: cells, dupMask: dm, totalSum: ts, snap: null });
    }
    for (let c = 0; c < N; c++) {
      const ts = totalSumFor("col", c), dm = colDup[c];
      if (ts < 0 && dm === 0) continue;
      const cells = []; for (let r = 0; r < N; r++) cells.push(r * N + c);
      lineSearches.push({ cells: cells, dupMask: dm, totalSum: ts, snap: null });
    }

    const domains = new Int32Array(N*N).fill(FULL_DOMAIN);
    let progress = true;
    let bad = false;

    function clearBit(idx, v) {
      const bit = 1 << (v - 1);
      if (domains[idx] & bit) {
        domains[idx] &= ~bit;
        progress = true;
        if (domains[idx] === 0) bad = true;
      }
    }
    function restrict(idx, mask) {
      const nd = domains[idx] & mask;
      if (nd !== domains[idx]) {
        domains[idx] = nd;
        progress = true;
        if (nd === 0) bad = true;
      }
    }
    function minV(mask) { for (let v = 1; v <= 9; v++) if (mask & (1 << (v-1))) return v; return 0; }
    function maxV(mask) { for (let v = 9; v >= 1; v--) if (mask & (1 << (v-1))) return v; return 0; }
    function isSingle(idx) { return POPCOUNT[domains[idx]] === 1; }

    // A row/col holds only 6 of the 9 values, so most values appear 0 or 1
    // times — there is NO "every value appears" lower bound (unlike Sudoku).
    // The only per-line lower bound is the explicit duplicate value, which
    // must appear exactly twice. So hidden-single reasoning applies solely to
    // the duplicate value; for everything else we enforce just distinctness.
    function unitElim(getIdx, dupMask) {
      for (let v = 1; v <= 9; v++) {
        const bit = 1 << (v - 1);
        const isDup = (dupMask & bit) !== 0;
        const maxCount = isDup ? 2 : 1;
        let single = 0;
        const open = [];
        for (let k = 0; k < N; k++) {
          const idx = getIdx(k);
          if (domains[idx] & bit) { if (isSingle(idx)) single++; else open.push(idx); }
        }
        if (single > maxCount) { bad = true; return; }
        if (single >= maxCount) {
          for (const idx of open) clearBit(idx, v); // distinctness: no more copies allowed
        } else if (isDup) {
          // Duplicate value must appear exactly twice -> lower bound applies.
          if (single + open.length < maxCount) { bad = true; return; }
          if (open.length === maxCount - single) for (const idx of open) restrict(idx, bit);
        }
      }
    }

    // Duplicate placement (adjacency-aware): the doubled value fits only in the
    // cells that still list it, and two of them must sit at NON-adjacent line
    // positions. So a cell that lies in every valid non-adjacent pair is forced
    // to the value, and a cell with no non-adjacent partner can't hold it. This
    // is the cheap human shortcut the full feasibility DFS would otherwise find
    // by brute force (e.g. 5×2 fits B5/C5/F5, B5–C5 adjacent ⇒ F5 = 5).
    function nonAdjPair(arr) {
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) if (arr[j] - arr[i] >= 2) return true;
      return false;
    }
    function dupPlacement(cells, dupMask) {
      for (let v = 1; v <= 9 && !bad; v++) {
        const b = 1 << (v - 1);
        if (!(dupMask & b)) continue;
        const hosts = [];
        for (let p = 0; p < 6; p++) if (domains[cells[p]] & b) hosts.push(p);
        if (!nonAdjPair(hosts)) { bad = true; return; }
        for (const p of hosts) {
          const hasPartner = hosts.some(q => q !== p && Math.abs(q - p) >= 2);
          if (!hasPartner) { clearBit(cells[p], v); continue; }
          if (!nonAdjPair(hosts.filter(q => q !== p))) restrict(cells[p], b);
        }
      }
    }

    // Min/max sum of distinct values (one per domain in `doms`, none equal
    // `forbidden`, all distinct) via DP over (cellIndex, usedMask). The
    // distinctness-aware sum bound — strictly stronger than the per-cell min/max
    // totalSum rule, and the cheap shortcut behind many feasibility eliminations.
    function distinctSumRange(doms, forbidden) {
      const n = doms.length, fb = forbidden ? 1 << (forbidden - 1) : 0;
      const memo = new Map();
      function go(i, used, wantMin) {
        if (i === n) return 0;
        const key = (i << 10) | (used << 1) | (wantMin ? 1 : 0);
        if (memo.has(key)) return memo.get(key);
        let best = wantMin ? Infinity : -Infinity;
        for (let v = 1; v <= 9; v++) {
          const b = 1 << (v - 1);
          if (!(doms[i] & b) || (used & b) || (b & fb)) continue;
          const sub = go(i + 1, used | b, wantMin);
          if (sub === Infinity || sub === -Infinity) continue;
          const tot = v + sub;
          if (wantMin ? tot < best : tot > best) best = tot;
        }
        memo.set(key, best); return best;
      }
      return [go(0, 0, true), go(0, 0, false)];
    }
    // Naked pair: two cells of a line restricted to the SAME 2-set {a,b} (and
    // neither the line's duplicate) must be a and b between them -> strike a,b
    // from the rest of the line. Mirror of solveWithTrace's nakedPairLine; sound
    // (confluent, same fixpoint) so the acceptance gate is unchanged.
    function nakedPair(cells, dupMask) {
      const groups = new Map();
      for (let p = 0; p < 6; p++) { const d = domains[cells[p]]; if (POPCOUNT[d] === 2) { if (!groups.has(d)) groups.set(d, []); groups.get(d).push(p); } }
      for (const [mask, pos] of groups) {
        if (pos.length !== 2 || (mask & dupMask)) continue;
        for (let p = 0; p < 6 && !bad; p++) {
          if (p === pos[0] || p === pos[1]) continue;
          for (let v = 1; v <= 9; v++) if (mask & (1 << (v - 1))) clearBit(cells[p], v);
        }
      }
    }
    function sumBound(cells, target) {
      for (let k = 0; k < 6 && !bad; k++) {
        const idx = cells[k];
        if (POPCOUNT[domains[idx]] === 1) continue;
        for (let v = 1; v <= 9; v++) {
          if (!(domains[idx] & (1 << (v - 1)))) continue;
          const others = []; for (let j = 0; j < 6; j++) if (j !== k) others.push(domains[cells[j]]);
          const r = distinctSumRange(others, v), rest = target - v;
          if (r[0] === Infinity || rest < r[0] || rest > r[1]) clearBit(idx, v);
        }
      }
    }

    let guard = 0;
    while (progress && !bad && guard++ < 200) {
      progress = false;

      // Adjacency: a fixed value forbids itself in the 4 orthogonal neighbours.
      for (let r = 0; r < N && !bad; r++) for (let c = 0; c < N; c++) {
        const idx = r*N + c;
        if (!isSingle(idx)) continue;
        const v = minV(domains[idx]);
        if (r > 0) clearBit((r-1)*N+c, v);
        if (r < N-1) clearBit((r+1)*N+c, v);
        if (c > 0) clearBit(r*N+c-1, v);
        if (c < N-1) clearBit(r*N+c+1, v);
      }
      if (bad) break;

      // Per-row / per-col uniqueness elimination + hidden singles.
      for (let r = 0; r < N && !bad; r++) unitElim(k => r*N + k, rowDup[r]);
      if (bad) break;
      for (let c = 0; c < N && !bad; c++) unitElim(k => k*N + c, colDup[c]);
      if (bad) break;

      // Global count: each value appears exactly 4×. Three sub-rules per V:
      //   (a) basic capacity check + 4-singletons-elsewhere elimination.
      //   (b) hidden-single global: placed + open == 4 ⇒ every open is forced V.
      //   (c) dup-saturation: if V has 2 duplicate rows (or cols), all 4 V's
      //       must lie in those rows (resp. cols) since each dup line commits
      //       exactly 2 V's. Strip V from every other row (resp. col). If V has
      //       both two dup rows AND two dup cols, V is fixed to the four
      //       intersection cells.
      for (let v = 1; v <= 9 && !bad; v++) {
        const bit = 1 << (v - 1);
        let single = 0, possible = 0;
        const open = [];
        for (let i = 0; i < N*N; i++) {
          if (domains[i] & bit) { possible++; if (isSingle(i)) single++; else open.push(i); }
        }
        if (single > 4 || possible < 4) { bad = true; break; }
        if (single >= 4) for (const idx of open) clearBit(idx, v);
        else if (single + open.length === 4) for (const idx of open) restrict(idx, bit);

        // Collect dup rows/cols carrying V.
        const dRows = [], dCols = [];
        for (let r = 0; r < N; r++) if (rowDup[r] & bit) dRows.push(r);
        for (let c = 0; c < N; c++) if (colDup[c] & bit) dCols.push(c);
        if (dRows.length > 2 || dCols.length > 2) { bad = true; break; }
        if (dRows.length === 2) {
          const ok = new Set(dRows);
          for (let r = 0; r < N; r++) if (!ok.has(r)) for (let c = 0; c < N; c++) clearBit(r*N+c, v);
        }
        if (dCols.length === 2) {
          const ok = new Set(dCols);
          for (let c = 0; c < N; c++) if (!ok.has(c)) for (let r = 0; r < N; r++) clearBit(r*N+c, v);
        }
      }
      if (bad) break;

      // pairSum: arc consistency on A + B = value. The two cells are always
      // adjacent (parser guarantees this), so v === w is forbidden too.
      for (const p of pairs) {
        const da = domains[p.a], db = domains[p.b];
        let maskA = 0, maskB = 0;
        for (let v = 1; v <= 9; v++) {
          const w = p.value - v;
          if (w < 1 || w > 9 || w === v) continue;
          if ((da & (1 << (v-1))) && (db & (1 << (w-1)))) { maskA |= 1 << (v-1); maskB |= 1 << (w-1); }
        }
        restrict(p.a, maskA);
        restrict(p.b, maskB);
        if (bad) break;
      }
      if (bad) break;

      // totalSum: bounds propagation on the six cells of a row/col.
      for (const t of totals) {
        const cells = t.cells;
        for (let k = 0; k < cells.length; k++) {
          let minOther = 0, maxOther = 0;
          for (let j = 0; j < cells.length; j++) {
            if (j === k) continue;
            minOther += minV(domains[cells[j]]);
            maxOther += maxV(domains[cells[j]]);
          }
          const lo = t.value - maxOther, hi = t.value - minOther;
          let mask = 0;
          for (let v = Math.max(1, lo); v <= Math.min(9, hi); v++) mask |= 1 << (v-1);
          restrict(cells[k], mask);
          if (bad) break;
        }
        if (bad) break;
      }
      if (bad) break;

      // Naked pairs per row/col — cheap distinctness; runs before the DFS.
      for (let r = 0; r < N && !bad; r++) { const cs = []; for (let k = 0; k < N; k++) cs.push(r*N + k); nakedPair(cs, rowDup[r]); }
      if (bad) break;
      for (let c = 0; c < N && !bad; c++) { const cs = []; for (let k = 0; k < N; k++) cs.push(k*N + c); nakedPair(cs, colDup[c]); }
      if (bad) break;
      // Duplicate placement (adjacency-aware) — cheap; runs before the DFS.
      for (const ls of lineSearches) { if (ls.dupMask) dupPlacement(ls.cells, ls.dupMask); if (bad) break; }
      if (bad) break;
      // Distinctness-aware sum bound (non-dup totalSum lines) — cheap; pre-DFS.
      for (const t of totals) { if (!t.dupMask) sumBound(t.cells, t.value); if (bad) break; }
      if (bad) break;

      // Line feasibility: for any row/column constrained by a totalSum or
      // duplicate clue, enumerate feasible value assignments by DFS — six
      // distinct values from 1..9, except the duplicate value (if any) appears
      // exactly twice and at non-adjacent positions in the line. If a totalSum
      // is given, the assignment must hit it. Then restrict each cell to values
      // that appear in at least one feasible assignment.
      //   Captures: (a) extreme sums collapsing the value set (Σ=39 ⇒
      //   {4,5,6,7,8,9}), (b) duplicate-with-adjacency placements (e.g. if 5×2
      //   in row A only has candidates A4/A5/A6, the only non-adjacent pair is
      //   (A4,A6) → both must be 5).
      for (const ls of lineSearches) {
        const cells = ls.cells;
        // Skip if no cell in this line has changed since its last DFS run.
        if (ls.snap) {
          let dirty = false;
          for (let j = 0; j < 6; j++) if (domains[cells[j]] !== ls.snap[j]) { dirty = true; break; }
          if (!dirty) continue;
        }
        const dupMask = ls.dupMask;
        const target = ls.totalSum; // -1 if no totalSum clue
        const support = [0, 0, 0, 0, 0, 0];
        const assigned = [0, 0, 0, 0, 0, 0];
        const usage = new Int8Array(10);
        function search(i, sumSoFar, dupLastPos) {
          if (i === 6) {
            if (target >= 0 && sumSoFar !== target) return;
            // Each duplicate value must appear EXACTLY twice (not 0 or 1).
            for (let v = 1; v <= 9; v++) if ((dupMask & (1 << (v - 1))) && usage[v] !== 2) return;
            for (let j = 0; j < 6; j++) support[j] |= 1 << (assigned[j] - 1);
            return;
          }
          if (target >= 0) {
            const rem = 6 - i;
            if (sumSoFar + rem * 9 < target) return;
            if (sumSoFar + rem * 1 > target) return;
          }
          const d = domains[cells[i]];
          for (let v = 1; v <= 9; v++) {
            const b = 1 << (v - 1);
            if (!(d & b)) continue;
            const maxCount = (dupMask & b) ? 2 : 1;
            if (usage[v] >= maxCount) continue;
            if ((dupMask & b) && dupLastPos === i - 1) continue;
            assigned[i] = v;
            usage[v]++;
            const newDupLast = (dupMask & b) ? i : dupLastPos;
            search(i + 1, sumSoFar + v, newDupLast);
            usage[v]--;
          }
        }
        search(0, 0, -2);
        for (let j = 0; j < 6 && !bad; j++) restrict(cells[j], support[j]);
        if (bad) break;
        // Snapshot post-DFS domains so the next iteration can skip if nothing
        // else changed any of these cells.
        if (!ls.snap) ls.snap = new Int32Array(6);
        for (let j = 0; j < 6; j++) ls.snap[j] = domains[cells[j]];
      }
      if (bad) break;

      // Sequences: relational propagation along the line.
      for (const s of seqs) {
        const cells = s.cells;
        if (s.type === "directSequence") {
          for (let k = 0; k < cells.length - 1; k++) {
            restrict(cells[k+1], (domains[cells[k]] << 1) & FULL_DOMAIN);
            restrict(cells[k], domains[cells[k+1]] >> 1);
          }
        } else if (s.type === "directDescending") {
          for (let k = 0; k < cells.length - 1; k++) {
            restrict(cells[k+1], domains[cells[k]] >> 1);
            restrict(cells[k], (domains[cells[k+1]] << 1) & FULL_DOMAIN);
          }
        } else if (s.type === "ascending") {
          for (let k = 0; k < cells.length - 1; k++) {
            const mn = minV(domains[cells[k]]);
            let m1 = 0; for (let v = mn + 1; v <= 9; v++) m1 |= 1 << (v-1);
            restrict(cells[k+1], m1);
            const mx = maxV(domains[cells[k+1]]);
            let m2 = 0; for (let v = 1; v <= mx - 1; v++) m2 |= 1 << (v-1);
            restrict(cells[k], m2);
          }
        } else { // descending
          for (let k = 0; k < cells.length - 1; k++) {
            const mx = maxV(domains[cells[k]]);
            let m1 = 0; for (let v = 1; v <= mx - 1; v++) m1 |= 1 << (v-1);
            restrict(cells[k+1], m1);
            const mn = minV(domains[cells[k+1]]);
            let m2 = 0; for (let v = mn + 1; v <= 9; v++) m2 |= 1 << (v-1);
            restrict(cells[k], m2);
          }
        }
        if (bad) break;
      }
      if (bad) break;
    }

    if (bad) return { solved: false, grid: null };
    for (let i = 0; i < N*N; i++) if (POPCOUNT[domains[i]] !== 1) return { solved: false, grid: null };
    const out = Array.from({ length: N }, () => Array(N).fill(0));
    for (let i = 0; i < N*N; i++) {
      let v = 1; while (!(domains[i] & (1 << (v-1)))) v++;
      out[(i / N) | 0][i % N] = v;
    }
    return { solved: true, grid: out };
  }

  function emptyClueSet() {
    const r = [], c = [];
    for (let i = 0; i < N; i++) { r.push([]); c.push([]); }
    return { rowClues: r, colClues: c };
  }
  // A puzzle is "acceptable" iff logicalSolve fully determines the grid by
  // pure deduction. Because every elimination logicalSolve makes is valid in
  // EVERY solution, a fully-determined grid is also a proof of uniqueness — so
  // logicalSolve is the single source of truth here (no backtracking needed).
  function pickClues(grid, cfg) {
    const cands = buildCandidateClues(grid);
    function isSeqType(t) { return t === "directSequence" || t === "directDescending" || t === "ascending" || t === "descending"; }

    // Start with ALL candidate clues, then remove as many as possible while
    // the puzzle stays deducible. Fewer remaining clues ⇒ harder.
    const selected = emptyClueSet();
    for (let r = 0; r < N; r++) for (const cl of cands.rowCands[r]) selected.rowClues[r].push(cl);
    for (let c = 0; c < N; c++) for (const cl of cands.colCands[c]) selected.colClues[c].push(cl);

    // Gate: even the maximal clue set must be deducible. (It nearly always is,
    // since every adjacent pairSum plus every totalSum is present.)
    if (!logicalSolve(selected).solved) return null;

    function totalClues() {
      let n = 0;
      for (const list of selected.rowClues) n += list.length;
      for (const list of selected.colClues) n += list.length;
      return n;
    }
    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }
    // Configurable totalSum cap. Magazine puzzles average ~4 totalSums per
    // puzzle, our solver tends to keep many more because the line-feasibility
    // DFS makes them load-bearing. The cap lets us match the magazine mix:
    // grids whose minimisation can't get under MAX_TOTAL_SUMS are rejected,
    // forcing pickClues to favour pairSum/duplicate scaffolding instead. A
    // very high cap (≥ 12) effectively disables the rule.
    const MAX_TOTAL_SUMS = (cfg && typeof cfg.maxTotalSum === "number") ? cfg.maxTotalSum : 99;
    function countTotalSums() {
      let n = 0;
      for (const list of selected.rowClues) for (const cl of list) if (cl.type === "totalSum") n++;
      for (const list of selected.colClues) for (const cl of list) if (cl.type === "totalSum") n++;
      return n;
    }
    // Removal preference during reduction. Mandatory (duplicate) clues are
    // never removed — without them the default "all distinct" assumption is
    // wrong — and sequence clues are kept for visual variety.
    //
    // Two modes:
    //   default: drop totalSum first (greedy wipes them out almost entirely),
    //            then pairSum. Yields puzzles with ~13 pair / ~2 sum / ~1 dup.
    //   fewerPairSums: drop pairSum first, then totalSum. Yields ~9 pair /
    //                  ~5 sum / similar dup. Reduction yield drops ~10×
    //                  (pairSums are mostly load-bearing) but still works
    //                  within the tournament budget.
    function removeRank(cl) {
      if (cfg.fewerPairSums) {
        if (cl.type === "pairSum") return 0;
        if (cl.type === "totalSum") return 1;
        return 2;
      }
      if (cl.type === "totalSum") return 0;
      if (cl.type === "pairSum") return 1;
      return 2;
    }

    // Protected clues (`keep`) survive reduction. We protect:
    //  - up to cfg.minTotalSum totalSum hints (force this type as variety), and
    //  - up to cfg.numSequences sequence hints. The grid may contain extra,
    //    *coincidental* sequence lines; protecting only N lets minimisation
    //    strip the rest so the shown count matches the setting. If
    //    cfg.numSequences is absent, all sequences are kept (legacy behaviour).
    function markKeep(pred, limit) {
      const pool = [];
      for (const list of selected.rowClues) for (const cl of list) if (pred(cl)) pool.push(cl);
      for (const list of selected.colClues) for (const cl of list) if (pred(cl)) pool.push(cl);
      shuffle(pool);
      for (let i = 0; i < pool.length && i < limit; i++) pool[i].keep = true;
    }
    const minTS = (cfg && cfg.minTotalSum) || 0;
    if (minTS > 0) markKeep(cl => cl.type === "totalSum", minTS);
    const seqKeep = (cfg && typeof cfg.numSequences === "number") ? cfg.numSequences : Infinity;
    markKeep(cl => isSeqType(cl.type), seqKeep);

    // PHASE 1 — reduce as far as possible. Walk every removable clue (fullest
    // lines first, so the distribution flattens) and drop it whenever the
    // puzzle stays fully deducible. This yields a near-minimal, evenly spread
    // clue set with no heavy lines.
    let pass = 0;
    while (pass++ < 30) {
      const entries = [];
      for (let r = 0; r < N; r++) for (const cl of selected.rowClues[r]) entries.push({ list: selected.rowClues[r], cl });
      for (let c = 0; c < N; c++) for (const cl of selected.colClues[c]) entries.push({ list: selected.colClues[c], cl });
      shuffle(entries);
      entries.sort((a, b) => (b.list.length - a.list.length) || (removeRank(a.cl) - removeRank(b.cl)));

      let removedAny = false;
      for (const { list, cl } of entries) {
        if (cl.mandatory || cl.keep) continue; // duplicates + protected clues stay
        const idx = list.indexOf(cl);
        if (idx < 0) continue;
        list.splice(idx, 1);
        if (logicalSolve(selected).solved) removedAny = true;
        else list.splice(idx, 0, cl); // removal broke deducibility — keep it
      }
      if (!removedAny) break;
    }

    // PHASE 2 — for easier levels, add redundant clues back onto the emptiest
    // lines until the difficulty's clue target is met. Re-adding clues can
    // never break deducibility, and targeting sparse lines keeps the layout
    // balanced (no line ends up overloaded). Hard uses target 0 → stays minimal.
    if (cfg.targetClues > totalClues()) {
      const lineOf = e => e.kind === "row" ? selected.rowClues[e.i] : selected.colClues[e.i];
      const pool = [];
      for (let r = 0; r < N; r++) for (const cl of cands.rowCands[r]) if (selected.rowClues[r].indexOf(cl) < 0) pool.push({ kind: "row", i: r, cl });
      for (let c = 0; c < N; c++) for (const cl of cands.colCands[c]) if (selected.colClues[c].indexOf(cl) < 0) pool.push({ kind: "col", i: c, cl });
      shuffle(pool);
      while (totalClues() < cfg.targetClues && pool.length) {
        let bestK = -1, bestLen = Infinity;
        for (let k = 0; k < pool.length; k++) {
          const len = lineOf(pool[k]).length;
          if (len < bestLen) { bestLen = len; bestK = k; }
        }
        const e = pool.splice(bestK, 1)[0];
        // Don't let add-back push totalSums past the cap; prefer pairSums.
        if (e.cl.type === "totalSum" && countTotalSums() >= MAX_TOTAL_SUMS) continue;
        lineOf(e).push(e.cl);
      }
    }

    // Enforce the totalSum cap: if reduction still left more than the cap
    // (some were needed for deducibility), try to shed the extras while the
    // puzzle stays deducible. If that's impossible, reject this grid.
    if (countTotalSums() > MAX_TOTAL_SUMS) {
      const ts = [];
      for (let r = 0; r < N; r++) for (const cl of selected.rowClues[r]) if (cl.type === "totalSum") ts.push({ list: selected.rowClues[r], cl });
      for (let c = 0; c < N; c++) for (const cl of selected.colClues[c]) if (cl.type === "totalSum") ts.push({ list: selected.colClues[c], cl });
      shuffle(ts);
      for (const { list, cl } of ts) {
        if (countTotalSums() <= MAX_TOTAL_SUMS) break;
        if (cl.keep) continue; // never drop a force-kept totalSum
        const idx = list.indexOf(cl);
        if (idx < 0) continue;
        list.splice(idx, 1);
        if (!logicalSolve(selected).solved) list.splice(idx, 0, cl);
      }
      if (countTotalSums() > MAX_TOTAL_SUMS) return null;
    }

    // Tidy display order within each line: duplicate, sequence, pairSums
    // (left-to-right / top-to-bottom), then totalSum.
    function displayRank(cl) {
      if (cl.type === "duplicate") return 0;
      if (isSeqType(cl.type)) return 1;
      if (cl.type === "pairSum") return 2 + cl.cells[0][0]*N + cl.cells[0][1];
      return 100; // totalSum
    }
    for (let r = 0; r < N; r++) selected.rowClues[r].sort((a, b) => displayRank(a) - displayRank(b));
    for (let c = 0; c < N; c++) selected.colClues[c].sort((a, b) => displayRank(a) - displayRank(b));

    // Final guarantee: the emitted puzzle is solvable by deduction alone.
    if (!logicalSolve(selected).solved) return null;
    return selected;
  }

  function clueCountOf(clues) {
    let n = 0;
    for (const list of clues.rowClues) n += list.length;
    for (const list of clues.colClues) n += list.length;
    return n;
  }

  // Continuous minimisation loop. The worker keeps generating grids and
  // reducing them to a minimal deducible clue set (`targetClues: 0` ⇒ no
  // rebalancing), and posts a puzzle only when it beats the fewest-clue count
  // seen so far (`best`). The main thread runs several of these in parallel
  // for a time budget and keeps the global minimum; it terminates the workers
  // when the budget elapses. `threshold` lets a follow-up search ignore
  // anything not better than the puzzle already on screen (currently unused
  // by the main thread — kept for reuse).
  self.onmessage = function(e) {
    const data = e.data || {};
    const cfg = data.config || {};
    const seqMode = cfg.numSequences;                              // "random" or 0–3
    const maxDup = (typeof cfg.maxDupLines === "number") ? cfg.maxDupLines : 5;
    const minDup = (typeof cfg.minDupLines === "number") ? cfg.minDupLines : 0;
    const minTS = (typeof cfg.minTotalSum === "number") ? cfg.minTotalSum : 0;
    const maxTS = (typeof cfg.maxTotalSum === "number") ? cfg.maxTotalSum : 99;
    const fewerPairSums = !!cfg.fewerPairSums;
    // The main thread classifies each candidate by difficulty LEVEL (via the
    // trace), so the worker just streams VARIETY: it posts the latest accepted
    // puzzle, throttled to ~8/sec, regardless of clue count. (Posting every
    // generated puzzle would flood the main thread; the clue-count gate is
    // gone because fewest-clues is no longer the objective.) Tick ~250ms for
    // the attempt counter.
    let sinceTick = 0, nextTickAt = Date.now() + 250;
    let pending = null, nextPostAt = 0;
    for (;;) {
      sinceTick++;
      const numSeq = (typeof seqMode === "number") ? seqMode : 1 + ((Math.random() * 3) | 0);
      const grid = generateGrid(numSeq, maxDup, minDup);
      if (grid) {
        const clues = pickClues(grid, { targetClues: 0, minTotalSum: minTS, maxTotalSum: maxTS, numSequences: numSeq, fewerPairSums: fewerPairSums });
        if (clues) pending = { grid: grid, clues: clues, clueCount: clueCountOf(clues) };
      }
      const now = Date.now();
      if (pending && now >= nextPostAt) {
        self.postMessage({ type: "candidate", grid: pending.grid, clues: pending.clues, clueCount: pending.clueCount });
        pending = null;
        nextPostAt = now + 120;
      }
      if (now >= nextTickAt) {
        self.postMessage({ type: "tick", attempts: sinceTick });
        sinceTick = 0;
        nextTickAt = now + 250;
      }
    }
  };
}

// Phase 2B difficulty weighting. Approximates how much manual work a human
// would invest to reproduce one application of the rule. Higher = harder.
// The variety bonus rewards puzzles that exercise many distinct rule kinds.
// The clue-count penalty offsets the natural bias of counting steps: more
// clues mean more rule applications, but each clue also gives the human more
// to start from. Calibrated empirically against the magazine demo (which sits
// near the 80th percentile of generated puzzles at penalty 10).
const RULE_WEIGHT = {
  "adjacency": 1,
  "distinct-row": 1, "distinct-col": 1,
  "dup-hidden-row": 2, "dup-hidden-col": 2,
  "global": 2,
  "global-hidden": 2,
  "global-dup-rows": 5, "global-dup-cols": 5,
  "dup-place": 2,
  "sumBound": 2,
  "pairSum": 2,
  "totalSum": 2,
  "sequence": 3,
  "lineFeasibility": 8,
};
const RULE_VARIETY_BONUS = 5;
const CLUE_PENALTY = 10;
function puzzleDifficulty(trace, clueCount) {
  if (!trace || !trace.steps) return 0;
  let score = 0;
  const types = new Set();
  for (const s of trace.steps) {
    score += RULE_WEIGHT[s.ruleType] || 1;
    types.add(s.ruleType);
  }
  return score + RULE_VARIETY_BONUS * types.size - CLUE_PENALTY * (clueCount || 0);
}

// Difficulty PROFILE from the per-step branching factor `b` (see commit()).
// `maxB` is the single hardest survey a solver must do; `bands` counts how many
// steps exceed each B threshold. A difficulty LEVEL is a ceiling on maxB plus
// caps on these band counts (set empirically from the measured distribution).
const B_BANDS = [3, 5, 8, 12, 20, 30];
function puzzleProfile(trace) {
  const prof = { maxB: 1, steps: (trace && trace.steps) ? trace.steps.length : 0, bands: {}, nFeas: 0, nFeasHard: 0 };
  for (const t of B_BANDS) prof.bands[t] = 0;
  if (trace && trace.steps) for (const s of trace.steps) {
    const b = s.b || 1;
    if (b > prof.maxB) prof.maxB = b;
    for (const t of B_BANDS) if (b > t) prof.bands[t]++;
    // Feasibility lines split by whether they took real WORK. Since B is now
    // combination-counted (bounded ~≤15), the single worst survey (maxB) barely
    // separates the hard levels; what does is how many lines forced a genuine
    // multi-combination survey. nFeasHard counts feasibility steps with b≥3 (a
    // real "which of ≥3 value-sets fits?" decision); b≤2 feasibility steps are
    // essentially forced and don't make a puzzle hard (per-level nFeasHard means
    // ≈ L3:0.4 / L4:0.6 / L5:1.3). nFeas (all feasibility steps) is kept for info.
    if (s.ruleType === "lineFeasibility") { prof.nFeas++; if (b >= 3) prof.nFeasHard++; }
  }
  return prof;
}

// Five difficulty levels. Classification takes the MAX of three axes, because no
// single axis spans all five. Since B is combination-counted (bounded ~≤15), the
// single hardest survey (maxB) separates the easy end and caps Mittel at B=6
// (any 7+-combination survey ⇒ Schwer); the HARD end (4–5) is otherwise driven
// by how many lines forced a genuine multi-combination survey
// (nFeasHard = feasibility steps with b≥3). Clue TYPES set a floor for the easy
// end (a duplicate to track ⇒ ≥"Leicht"; a line-sum to reason about ⇒ ≥"Mittel").
// `cfg` biases generation toward the band (clue-type mix + the per-level
// maxTotalSum/duplicate counts); the actual gate is puzzleLevel() on the solved
// trace + clue features.
const LEVELS = [
  { id: 1, name: "Sehr leicht", cfg: { minTotalSum: 0, maxTotalSum: 0, minDupLines: 0, maxDupLines: 0, fewerPairSums: false } },
  { id: 2, name: "Leicht",      cfg: { minTotalSum: 0, maxTotalSum: 0, minDupLines: 1, maxDupLines: 1, fewerPairSums: false } },
  { id: 3, name: "Mittel",      cfg: { minTotalSum: 1, maxTotalSum: 2, minDupLines: 1, maxDupLines: 1, fewerPairSums: false } },
  { id: 4, name: "Schwer",      cfg: { minTotalSum: 2, maxTotalSum: 4, minDupLines: 1, maxDupLines: 2, fewerPairSums: false } },
  { id: 5, name: "Sehr schwer", cfg: { minTotalSum: 3, maxTotalSum: 6, minDupLines: 2, maxDupLines: 2, fewerPairSums: false } },
];
// Clue-type features that gate the easy end (read from the clue SET, not the
// trace — a sum/duplicate clue counts even if cheap rules dissolve it to b=1).
function clueFeatures(clues) {
  let hasSum = false, dupCount = 0;
  for (const list of clues.rowClues.concat(clues.colClues)) for (const cl of list) {
    if (cl.type === "totalSum") hasSum = true;
    else if (cl.type === "duplicate") dupCount++;
  }
  return { hasSum, dupCount };
}
// Difficulty level (1–5) = max of three axes. (1) maxB (single hardest survey):
// with combination-counting it tops out ~15; separates the easy end (sequences
// give a ~4 baseline, so >4⇒2; Mittel ends at 6) and pushes any survey of 7+
// combinations straight to Schwer (>6⇒4, >14⇒5 — Mittel itself is reached via
// the sum-clue floor, axis 3). (2) WORK = nFeasHard, how many lines forced a
// genuine ≥3-combination survey: ≥1 ⇒ Schwer, ≥2 ⇒ Sehr schwer (b≤2 feasibility
// steps are essentially forced and don't count). (3) clue-type floor (sum ⇒ ≥3,
// dup ⇒ ≥2). Calibrated empirically; hit rates ≈ 100/92/39/59/41 % (L3 is the
// weak spot since Schwer absorbed the maxB 7–9 band; yield + filter cover it).
function puzzleLevel(profile, feat) {
  const maxB = profile.maxB, hard = profile.nFeasHard || 0;
  let byB = 1;
  if (maxB > 14) byB = 5; else if (maxB > 6) byB = 4; else if (maxB > 4) byB = 2;
  let byWork = 1;
  if (hard >= 2) byWork = 5; else if (hard >= 1) byWork = 4;
  const byFeat = (feat && feat.hasSum) ? 3 : (feat && feat.dupCount >= 1) ? 2 : 1;
  return Math.max(byB, byWork, byFeat);
}

// === Lösungsweg: Schritt-für-Schritt-Solver (Trace) ===
// Eigenständige, tracende Variante von logicalSolve (Worker). Gleiche Regeln,
// aber sie protokolliert pro Zelle den Schritt + Grund. Liefert die Lösung
// allein aus den Clues — sie wird NIE aus currentPuzzle.grid abgelesen.
function solveWithTrace(clues) {
  const FULL = 0x1FF;
  const rowLabel = r => "Reihe " + ROW_LABELS[r];
  const colLabel = c => "Spalte " + COL_LABELS[c];
  function clueCellList(cl) {
    if (cl.type === "pairSum") return cl.cells.map(([r, c]) => r * N + c);
    const cells = [];
    if (cl.scope === "row") { for (let c = 0; c < N; c++) cells.push(cl.index * N + c); }
    else { for (let r = 0; r < N; r++) cells.push(r * N + cl.index); }
    return cells;
  }
  const rowDup = new Array(N).fill(0), colDup = new Array(N).fill(0);
  const pairs = [], totals = [], seqs = [];
  function reg(cl) {
    if (cl.type === "duplicate") {
      if (cl.scope === "row") rowDup[cl.index] |= 1 << (cl.value - 1); else colDup[cl.index] |= 1 << (cl.value - 1);
    } else if (cl.type === "pairSum") {
      pairs.push({ a: cl.cells[0][0] * N + cl.cells[0][1], b: cl.cells[1][0] * N + cl.cells[1][1], value: cl.value });
    } else if (cl.type === "totalSum") {
      totals.push({ cells: clueCellList(cl), value: cl.value, scope: cl.scope, index: cl.index });
    } else if (cl.type === "directSequence" || cl.type === "directDescending" || cl.type === "ascending" || cl.type === "descending") {
      seqs.push({ cells: clueCellList(cl), type: cl.type, scope: cl.scope, index: cl.index });
    }
  }
  for (let r = 0; r < N; r++) for (const cl of clues.rowClues[r]) reg(cl);
  for (let c = 0; c < N; c++) for (const cl of clues.colClues[c]) reg(cl);
  // Attach duplicate-value mask to each totalSum line for the distinct-sum rule.
  for (const t of totals) t.dupMask = t.scope === "row" ? rowDup[t.index] : colDup[t.index];

  // Lines that need feasibility-DFS (have totalSum and/or duplicate). Each
  // also carries a post-run domain snapshot so repeat invocations on unchanged
  // domains are skipped.
  const lineSearches = [];
  function lineTotalSum(scope, idx) {
    for (const t of totals) if (t.scope === scope && t.index === idx) return t.value;
    return -1;
  }
  for (let r = 0; r < N; r++) {
    const ts = lineTotalSum("row", r), dm = rowDup[r];
    if (ts < 0 && dm === 0) continue;
    const cells = []; for (let c = 0; c < N; c++) cells.push(r * N + c);
    lineSearches.push({ cells, dupMask: dm, totalSum: ts, scope: "row", index: r, snap: null });
  }
  for (let c = 0; c < N; c++) {
    const ts = lineTotalSum("col", c), dm = colDup[c];
    if (ts < 0 && dm === 0) continue;
    const cells = []; for (let r = 0; r < N; r++) cells.push(r * N + c);
    lineSearches.push({ cells, dupMask: dm, totalSum: ts, scope: "col", index: c, snap: null });
  }

  const domains = new Array(N * N).fill(FULL);
  const steps = [];                 // each: { reason, removals:[{idx,vals}], solved:[idx] }
  let bad = false, cur = null;      // cur = Map idx -> removed-bitmask for the in-progress step

  const bit = v => 1 << (v - 1);
  const isSingle = idx => { const d = domains[idx]; return d !== 0 && (d & (d - 1)) === 0; };
  const valOf = idx => { const d = domains[idx]; for (let v = 1; v <= 9; v++) if (d & bit(v)) return v; return 0; };
  const minV = m => { for (let v = 1; v <= 9; v++) if (m & bit(v)) return v; return 0; };
  const maxV = m => { for (let v = 9; v >= 1; v--) if (m & bit(v)) return v; return 0; };
  const cl2 = idx => cellLabel((idx / N) | 0, idx % N);
  function rmBit(idx, v) {
    if (domains[idx] & bit(v)) { domains[idx] &= ~bit(v); cur.set(idx, (cur.get(idx) || 0) | bit(v)); if (domains[idx] === 0) bad = true; }
  }
  function keep(idx, mask) {
    const removed = domains[idx] & ~mask;
    if (removed) { domains[idx] &= mask; cur.set(idx, (cur.get(idx) || 0) | removed); if (domains[idx] === 0) bad = true; }
  }
  function begin() { cur = new Map(); }
  function commit(reason, ruleType, clueInfo, b) {
    if (cur && cur.size) {
      const removals = [], solved = [];
      for (const [idx, mask] of cur) {
        const vals = []; for (let v = 1; v <= 9; v++) if (mask & bit(v)) vals.push(v);
        removals.push({ idx, vals });
        if (isSingle(idx)) solved.push(idx);
      }
      // b = branching factor: how many candidate configurations a human must
      // survey to justify this step (1 for forced/cheap rules; the feasibility
      // leaf count for lineFeasibility). The difficulty metric is built from it.
      steps.push({ reason, ruleType, clue: clueInfo || null, removals, solved, b: b || 1 });
    }
    cur = null;
  }
  function unit(getIdx, dupMask, label, scope) {
    const rt = scope === "row" ? "distinct-row" : "distinct-col";
    const rtDup = scope === "row" ? "dup-hidden-row" : "dup-hidden-col";
    for (let v = 1; v <= 9 && !bad; v++) {
      const b = bit(v), isDup = (dupMask & b) !== 0, maxC = isDup ? 2 : 1;
      let single = 0; const open = [], fixedAt = [];
      for (let k = 0; k < N; k++) { const idx = getIdx(k); if (domains[idx] & b) { if (isSingle(idx)) { single++; fixedAt.push(idx); } else open.push(idx); } }
      if (single > maxC) { bad = true; return; }
      if (single >= maxC && open.length) {
        begin(); for (const idx of open) rmBit(idx, v);
        commit("Jede Zahl höchstens einmal pro " + (scope === "row" ? "Reihe" : "Spalte") + ".", rt,
          { value: v, fixedAt: fixedAt.slice(), label, scope });
      } else if (isDup && single < maxC) {
        if (single + open.length < maxC) { bad = true; return; }
        if (open.length === maxC - single) {
          begin(); for (const idx of open) keep(idx, b);
          commit("Die " + v + " muss zweimal in " + label + " stehen — nur diese Plätze bleiben übrig.", rtDup,
            { value: v, cells: open.slice(), label, scope });
        }
      }
    }
  }

  // Human-style cascade: when a cell is finalised, a person immediately strikes
  // that value from its neighbours and the rest of its row/column, and — for a
  // GAPLESS (direct) sequence — fills the whole run in one go. We model that as
  // a worklist drained to exhaustion, before and after every batched rule that
  // can place a cell, so the trace reads in the order a person would work.
  // Soundness and the fixpoint are unchanged (confluent monotone propagation);
  // only the order in which steps are emitted differs.
  const directSeqByCell = new Map();
  for (const s of seqs) if (s.type === "directSequence" || s.type === "directDescending") {
    s.cells.forEach((idx, pos) => {
      if (!directSeqByCell.has(idx)) directSeqByCell.set(idx, []);
      directSeqByCell.get(idx).push({ seq: s, pos });
    });
  }
  const cascaded = new Uint8Array(N * N);
  const queue = [];
  function enqueueSingles() {
    for (let i = 0; i < N * N; i++) if (!cascaded[i] && isSingle(i) && queue.indexOf(i) < 0) queue.push(i);
  }
  // Distinct strike for one value (dup-aware): mirrors unit's distinct branch.
  function strikeLine(getIdx, dupMask, v, scope, label) {
    const b = bit(v), maxC = (dupMask & b) ? 2 : 1;
    let single = 0; const open = [], fixedAt = [];
    for (let k = 0; k < N; k++) { const idx = getIdx(k); if (domains[idx] & b) { if (isSingle(idx)) { single++; fixedAt.push(idx); } else open.push(idx); } }
    if (single > maxC) { bad = true; return; }
    if (single >= maxC && open.length) {
      begin(); for (const idx of open) rmBit(idx, v);
      commit("Jede Zahl höchstens einmal pro " + (scope === "row" ? "Reihe" : "Spalte") + ".", scope === "row" ? "distinct-row" : "distinct-col",
        { value: v, fixedAt: fixedAt.slice(), label, scope });
    }
  }
  // Gapless sequence: one known cell fixes every other cell — emit as ONE step.
  function fillDirectSequence(seq, pos) {
    const anchor = seq.cells[pos], anchorVal = valOf(anchor), dir = seq.type === "directSequence" ? 1 : -1;
    begin();
    for (let k = 0; k < seq.cells.length && !bad; k++) {
      const v = anchorVal + dir * (k - pos);
      if (v < 1 || v > 9) { bad = true; break; }
      keep(seq.cells[k], bit(v));
    }
    commit("Lückenlose Sequenz: ab " + cl2(anchor) + "=" + anchorVal + " liegt die ganze Linie fest.", "sequence",
      { cells: seq.cells.slice(), kind: seq.type, scope: seq.scope, index: seq.index });
  }
  function cascade() {
    enqueueSingles();
    while (queue.length && !bad) {
      const idx = queue.shift();
      if (cascaded[idx] || !isSingle(idx)) continue;
      cascaded[idx] = 1;
      const v = valOf(idx), r = (idx / N) | 0, c = idx % N;
      // Adjacency: forbid v in the four orthogonal neighbours.
      begin();
      if (r > 0) rmBit(idx - N, v);
      if (r < N - 1) rmBit(idx + N, v);
      if (c > 0) rmBit(idx - 1, v);
      if (c < N - 1) rmBit(idx + 1, v);
      commit("Gleiche Zahlen dürfen nicht direkt nebeneinander stehen.", "adjacency", { srcIdx: idx, value: v });
      enqueueSingles();
      // Distinct: strike v from the rest of the row, then the column.
      strikeLine(k => r * N + k, rowDup[r], v, "row", rowLabel(r)); enqueueSingles();
      strikeLine(k => k * N + c, colDup[c], v, "col", colLabel(c)); enqueueSingles();
      // Gapless sequence: fill the whole run from this anchor.
      if (directSeqByCell.has(idx)) for (const e of directSeqByCell.get(idx)) { fillDirectSequence(e.seq, e.pos); enqueueSingles(); if (bad) break; }
    }
  }

  // Min and max sum of choosing DISTINCT values (one per cell-domain in `doms`,
  // none equal `forbidden`, all distinct), via DP over (cellIndex, usedMask).
  // [Infinity, -Infinity] if no distinct system of representatives exists.
  function distinctSumRange(doms, forbidden) {
    const n = doms.length, fb = forbidden ? bit(forbidden) : 0;
    const memo = new Map();
    function go(i, used, wantMin) {
      if (i === n) return 0;
      const key = (i << 10) | (used << 1) | (wantMin ? 1 : 0);
      if (memo.has(key)) return memo.get(key);
      let best = wantMin ? Infinity : -Infinity;
      for (let v = 1; v <= 9; v++) {
        const b = bit(v);
        if (!(doms[i] & b) || (used & b) || (b & fb)) continue;
        const sub = go(i + 1, used | b, wantMin);
        if (sub === Infinity || sub === -Infinity) continue;
        const tot = v + sub;
        if (wantMin ? tot < best : tot > best) best = tot;
      }
      memo.set(key, best); return best;
    }
    return [go(0, 0, true), go(0, 0, false)];
  }
  // Witness for distinctSumRange: the actual distinct assignment of `cellIdxs`
  // (one value each, all different, none = `forbidden`) achieving the min (or
  // max) total — so the sumBound reason can NAME why the bound is what it is
  // ("kleinste freie Belegung: D1=3, D2=4, …"), instead of an unexplained number
  // a tester reads as the generic 1+2+3+4+5. Brute over ≤6 cells; returns
  // [{idx,v}] or null.
  function distinctSumWitness(cellIdxs, forbidden, wantMin) {
    const n = cellIdxs.length, fb = forbidden ? bit(forbidden) : 0;
    let best = wantMin ? Infinity : -Infinity, bestPick = null;
    const pick = new Array(n);
    (function go(i, used, sum) {
      if (i === n) { if (wantMin ? sum < best : sum > best) { best = sum; bestPick = pick.slice(); } return; }
      const d = domains[cellIdxs[i]];
      for (let v = 1; v <= 9; v++) { const b = bit(v); if (!(d & b) || (used & b) || (b & fb)) continue; pick[i] = v; go(i + 1, used | b, sum + v); }
    })(0, 0, 0);
    return bestPick ? cellIdxs.map((idx, i) => ({ idx, v: bestPick[i] })) : null;
  }

  // Naked pair: two cells of a line whose candidate sets are the SAME 2-set
  // {a,b} must take a and b between them, so a and b are used up in this line —
  // strike both from the other cells. The obvious human move ("these two cells
  // are the 8 and the 9, so no other cell here can be 8 or 9"), b=1. Sound only
  // when the pair EXCLUDES the line's duplicate value: if a (or b) were the
  // doubled value, the two cells could both be it, and the other value need not
  // be placed here at all. (3+ cells sharing a 2-set are left to feasibility.)
  function bitCount(d) { let n = 0; for (let v = 1; v <= 9; v++) if (d & bit(v)) n++; return n; }
  function nakedPairLine(cells, dupMask, label, scope) {
    const groups = new Map();
    for (let p = 0; p < 6; p++) { const d = domains[cells[p]]; if (bitCount(d) === 2) { if (!groups.has(d)) groups.set(d, []); groups.get(d).push(p); } }
    for (const [mask, pos] of groups) {
      if (pos.length !== 2 || (mask & dupMask)) continue;
      const vals = []; for (let v = 1; v <= 9; v++) if (mask & bit(v)) vals.push(v);
      begin();
      for (let p = 0; p < 6 && !bad; p++) { if (p === pos[0] || p === pos[1]) continue; for (const v of vals) rmBit(cells[p], v); }
      commit(cl2(cells[pos[0]]) + " und " + cl2(cells[pos[1]]) + " können in " + label + " nur " + vals.join(" oder ") +
        " sein — zwei Zellen für zwei Werte. Damit sind " + vals.join(" und ") + " hier vergeben und fallen in den übrigen Zellen weg.",
        "naked-pair", { cells: cells.slice(), pair: [cells[pos[0]], cells[pos[1]]], values: vals, scope, label });
      if (bad) return;
    }
  }

  // Propagation bis zum Fixpunkt. Jede Regelanwendung, die mindestens einen
  // Kandidaten entfernt, ergibt EINEN Schritt (mit Begründung + entfernten Werten).
  let guard = 0;
  while (!bad && guard++ < 400) {
    const before = steps.length;
    // 1. Kaskade: erst die menschlich-offensichtlichen Folgen jeder frisch
    //    gesetzten Zelle (Adjazenz + Reihe/Spalte-Distinktheit + Sequenzfüllung).
    cascade(); if (bad) break;
    // 2. Distinktheit / Dup-Hidden je Reihe, dann Spalte. (Die Distinktheit
    //    erledigt meist schon die Kaskade; unit liefert zusätzlich Dup-Hidden.)
    for (let r = 0; r < N && !bad; r++) unit(k => r * N + k, rowDup[r], rowLabel(r), "row");
    if (bad) break;
    cascade(); if (bad) break;
    for (let c = 0; c < N && !bad; c++) unit(k => k * N + c, colDup[c], colLabel(c), "col");
    if (bad) break;
    cascade(); if (bad) break;
    // 2b. Naked Pairs je Reihe/Spalte (vor Summen/Feasibility, damit der billige
    //     Schritt die Streichung beansprucht statt sumBound mit aufgeblähtem b).
    for (let r = 0; r < N && !bad; r++) { const cs = []; for (let k = 0; k < N; k++) cs.push(r * N + k); nakedPairLine(cs, rowDup[r], rowLabel(r), "row"); }
    if (bad) break;
    cascade(); if (bad) break;
    for (let c = 0; c < N && !bad; c++) { const cs = []; for (let k = 0; k < N; k++) cs.push(k * N + c); nakedPairLine(cs, colDup[c], colLabel(c), "col"); }
    if (bad) break;
    cascade(); if (bad) break;
    // 3. Globale Zählung: jede Zahl genau 4×, plus zwei Verschärfungen pro Wert:
    //    – Hidden-Single global: wenn Singletons + offene Kandidaten = 4, sind
    //      alle offenen Kandidaten erzwungen.
    //    – Dup-Sättigung: hat ein Wert zwei Duplikat-Reihen (oder -Spalten),
    //      sind alle 4 Vorkommen in diesen Reihen (bzw. Spalten), weil jede
    //      Duplikat-Linie genau 2 Vorkommen bindet. ⇒ Wert aus allen anderen
    //      Reihen (bzw. Spalten) entfernen.
    for (let v = 1; v <= 9 && !bad; v++) {
      const b = bit(v); let single = 0; const open = [];
      for (let i = 0; i < N * N; i++) if (domains[i] & b) { if (isSingle(i)) single++; else open.push(i); }
      if (single > 4 || single + open.length < 4) { bad = true; break; }
      if (single >= 4 && open.length) { begin(); for (const idx of open) rmBit(idx, v); commit("Die " + v + " ist bereits viermal platziert — überall sonst entfernen.", "global", { value: v }); }
      else if (single + open.length === 4 && open.length) {
        begin(); for (const idx of open) keep(idx, b);
        commit("Die " + v + " hat global nur noch genau vier Plätze — alle übrigen erzwungen.", "global-hidden", { value: v });
      }
      if (bad) break;
      // Dup-Sättigung
      const dRows = [], dCols = [];
      for (let r = 0; r < N; r++) if (rowDup[r] & b) dRows.push(r);
      for (let c = 0; c < N; c++) if (colDup[c] & b) dCols.push(c);
      if (dRows.length > 2 || dCols.length > 2) { bad = true; break; }
      if (dRows.length === 2) {
        const ok = new Set(dRows);
        begin();
        for (let r = 0; r < N; r++) if (!ok.has(r)) for (let c = 0; c < N; c++) rmBit(r * N + c, v);
        commit("Die " + v + " hat zwei Duplikat-Reihen — alle vier Vorkommen liegen dort, anderswo entfernen.", "global-dup-rows",
          { value: v, rows: dRows.slice() });
        if (bad) break;
      }
      if (dCols.length === 2) {
        const ok = new Set(dCols);
        begin();
        for (let c = 0; c < N; c++) if (!ok.has(c)) for (let r = 0; r < N; r++) rmBit(r * N + c, v);
        commit("Die " + v + " hat zwei Duplikat-Spalten — alle vier Vorkommen liegen dort, anderswo entfernen.", "global-dup-cols",
          { value: v, cols: dCols.slice() });
        if (bad) break;
      }
    }
    if (bad) break;
    cascade(); if (bad) break;
    // 4. pairSum: A + B = S (adjacent cells, so v !== w)
    for (const p of pairs) {
      const da = domains[p.a], db = domains[p.b]; let mA = 0, mB = 0;
      for (let v = 1; v <= 9; v++) { const w = p.value - v; if (w < 1 || w > 9 || w === v) continue; if ((da & bit(v)) && (db & bit(w))) { mA |= bit(v); mB |= bit(w); } }
      begin(); keep(p.a, mA); keep(p.b, mB);
      commit("Diese Werte haben keinen passenden Partner mehr.", "pairSum", { a: p.a, b: p.b, value: p.value });
      if (bad) break;
    }
    if (bad) break;
    cascade(); if (bad) break;
    // 5. totalSum: Summe einer Reihe/Spalte
    for (const t of totals) {
      const cells = t.cells; begin();
      for (let k = 0; k < cells.length; k++) {
        let minO = 0, maxO = 0;
        for (let j = 0; j < cells.length; j++) { if (j === k) continue; minO += minV(domains[cells[j]]); maxO += maxV(domains[cells[j]]); }
        const lo = t.value - maxO, hi = t.value - minO;
        let mask = 0; for (let v = Math.max(1, lo); v <= Math.min(9, hi); v++) mask |= bit(v);
        keep(cells[k], mask);
      }
      commit("Mit diesen Werten ließe sich die geforderte Summe nicht mehr erreichen.", "totalSum",
        { cells: t.cells.slice(), value: t.value, scope: t.scope, index: t.index });
      if (bad) break;
    }
    if (bad) break;
    cascade(); if (bad) break;
    // 5a. Duplikat-Platzierung (nachbarschaftsbewusst): die doppelte Zahl passt
    //     nur in die Zellen, die sie noch führen, und zwei davon müssen NICHT
    //     benachbart liegen. Eine Zelle, die in jedem zulässigen nicht-benachbarten
    //     Paar steckt, ist erzwungen; eine ohne nicht-benachbarten Partner scheidet
    //     aus. Das ist die billige menschliche Abkürzung, die die Feasibility-DFS
    //     sonst per Brute Force fände (5×2 passt B5/C5/F5, B5–C5 benachbart ⇒ F5=5).
    {
      const nonAdjPair = arr => { for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) if (arr[j] - arr[i] >= 2) return true; return false; };
      for (const ls of lineSearches) {
        if (!ls.dupMask) continue;
        const cells = ls.cells, lineLabel = ls.scope === "row" ? rowLabel(ls.index) : colLabel(ls.index);
        for (let v = 1; v <= 9 && !bad; v++) {
          if (!(ls.dupMask & bit(v))) continue;
          const hosts = []; for (let p = 0; p < 6; p++) if (domains[cells[p]] & bit(v)) hosts.push(p);
          if (!nonAdjPair(hosts)) { bad = true; break; }
          const forced = [], stripped = [];
          for (const p of hosts) {
            if (!hosts.some(q => q !== p && Math.abs(q - p) >= 2)) { stripped.push(p); continue; }
            if (!nonAdjPair(hosts.filter(q => q !== p))) forced.push(p);
          }
          const hostLabels = hosts.map(p => cl2(cells[p])).join(", ");
          const clue = { value: v, cells: cells.slice(), hosts: hosts.slice(), scope: ls.scope, index: ls.index };
          if (forced.length) {
            begin(); for (const p of forced) keep(cells[p], bit(v));
            commit("Die " + v + " kommt in " + lineLabel + " doppelt vor und passt nur in " + hostLabels + ". Weil zwei benachbarte Zellen nicht beide die " + v + " sein können, ist " + forced.map(p => cl2(cells[p])).join(", ") + " = " + v + " erzwungen.", "dup-place", clue);
          }
          if (stripped.length && !bad) {
            begin(); for (const p of stripped) rmBit(cells[p], v);
            commit("Die " + v + " kommt in " + lineLabel + " doppelt vor; in " + stripped.map(p => cl2(cells[p])).join(", ") + " hätte sie keinen nicht-benachbarten Partner — hier ausgeschlossen.", "dup-place", clue);
          }
        }
        if (bad) break;
      }
    }
    if (bad) break;
    cascade(); if (bad) break;
    // 5a2. Distinktheits-Summen-Schranke: für jede Summen-Linie OHNE Duplikat
    //      streiche Wert v aus Zelle k, wenn mit k=v und sonst lauter
    //      verschiedenen Werten die geforderte Summe nicht erreichbar ist (die
    //      übrigen fünf verschiedenen Zellen ergäben dann zu wenig/zu viel).
    //      Das ist das billige menschliche „extreme Summe"-Argument, das die
    //      Feasibility-DFS sonst per Brute Force fände.
    for (const t of totals) {
      if (t.dupMask) continue; // dup lines: left to dup-place + feasibility
      const cells = t.cells, lineLabel = t.scope === "row" ? rowLabel(t.index) : colLabel(t.index);
      // This rule is harder for a human than a plain min/max sum (b=1): one must
      // reason about the distinct-sum range of the still-open cells. Weight it by
      // how many cells are still open (more unknowns to juggle = harder).
      const openCount = cells.filter(idx => !isSingle(idx)).length;
      const sumBoundB = 1 + openCount; // 3–7 in practice; stays ≤10 ⇒ level ≤ Mittel
      begin();
      let ex = null; // first struck (cell,value) + its bound, for a concrete reason
      const struck = []; // every (cell,value) struck in this step, to explain ALL strikes
      for (let k = 0; k < 6 && !bad; k++) {
        const idx = cells[k];
        if (isSingle(idx)) continue;
        for (let v = 1; v <= 9; v++) {
          if (!(domains[idx] & bit(v))) continue;
          const others = []; for (let j = 0; j < 6; j++) if (j !== k) others.push(domains[cells[j]]);
          const [mn, mx] = distinctSumRange(others, v);
          const rest = t.value - v;
          if (mn === Infinity || rest < mn || rest > mx) {
            if (!ex) {
              // Capture the witness NOW (same domain state + forbidden v as the
              // bound), since later strikes in this same step shrink other cells.
              const otherIdx = []; for (let j = 0; j < 6; j++) if (j !== k) otherIdx.push(cells[j]);
              const witness = (mn === Infinity) ? null : distinctSumWitness(otherIdx, v, rest < mn);
              ex = { label: cl2(idx), v, rest, mn, mx, witness };
            }
            struck.push({ idx, v });
            rmBit(idx, v);
          }
        }
      }
      // Reason = ONE worked example (the representative `ex` with its witness),
      // then a tail explaining why ALL the listed strikes follow — the same
      // per-cell arithmetic, checked at every position. (Testers were confused
      // that one example justified striking the value from several cells.)
      let reason = "Summe " + lineLabel + " = " + t.value + ".";
      if (ex) {
        const head = "In " + lineLabel + " sind alle sechs Zahlen verschieden und ergeben " + t.value + ". Mit " + ex.label + "=" + ex.v + " ";
        const witnessTxt = (label, total) =>
          ex.witness ? " (" + label + ": " + ex.witness.map(p => cl2(p.idx) + "=" + p.v).join(", ") + " = " + total + ")" : "";
        let core;
        if (ex.mn === Infinity)
          core = head + "blieben für die übrigen fünf keine fünf verschiedenen Werte übrig";
        else if (ex.rest < ex.mn)
          core = head + "müssten die übrigen fünf zusammen " + ex.rest + " ergeben — die kleinsten dort noch möglichen verschiedenen Werte ergeben aber schon " + ex.mn + witnessTxt("kleinstmöglich", ex.mn);
        else
          core = head + "müssten die übrigen fünf zusammen " + ex.rest + " ergeben — die größten dort noch möglichen verschiedenen Werte ergeben aber höchstens " + ex.mx + witnessTxt("größtmöglich", ex.mx);
        const valSet = new Set(struck.map(s => s.v));
        let tail;
        if (struck.length <= 1)
          tail = ". Also kann " + ex.label + " keine " + ex.v + " sein.";
        else if (valSet.size === 1)
          tail = ". Dieselbe Rechnung schließt die " + ex.v + " auch in den übrigen unten markierten Zellen aus — jedes Mal würde die " + ex.v + " die geforderte Summe sprengen.";
        else
          tail = ". Nach derselben Prüfung — Stelle für Stelle — sprengen auch die übrigen unten markierten Kandidaten die Summe " + t.value + " und fallen weg.";
        reason = core + tail;
      }
      commit(reason, "sumBound", { cells: cells.slice(), value: t.value, scope: t.scope, index: t.index }, sumBoundB);
      if (bad) break;
    }
    if (bad) break;
    cascade(); if (bad) break;
    // 5b. Linien-Feasibility: für jede Reihe/Spalte mit totalSum und/oder
    // Duplikat-Hinweis alle zulässigen 6-Wert-Belegungen per DFS aufzählen
    // (6 verschiedene Ziffern aus 1..9, der Duplikat-Wert ggf. 2× und nicht
    // direkt benachbart; bei totalSum muss die Summe stimmen). Anschließend
    // jede Zelle auf die Werte einschränken, die in mindestens einer
    // Belegung vorkommen. Deckt extreme Summen (Σ=39 ⇒ {4,5,6,7,8,9}) und
    // erzwungene Duplikat-Platzierungen (z. B. wenn nur ein nicht-benachbartes
    // Paar von Kandidaten übrig bleibt) gemeinsam ab.
    for (const ls of lineSearches) {
      const cells = ls.cells;
      // Drain the cheap cascade BEFORE this line's expensive DFS, so that the
      // consequences of a cell solved by an earlier line (e.g. distinctness
      // striking a now-fixed value from this line) are credited to the cheap
      // rule — not re-derived by the feasibility enumeration with an inflated B.
      cascade(); if (bad) break;
      if (ls.snap) {
        let dirty = false;
        for (let j = 0; j < 6; j++) if (domains[cells[j]] !== ls.snap[j]) { dirty = true; break; }
        if (!dirty) continue;
      }
      const dupMask = ls.dupMask;
      const target = ls.totalSum;
      const support = [0, 0, 0, 0, 0, 0];
      const assigned = [0, 0, 0, 0, 0, 0];
      const usage = new Int8Array(10);
      // B = the human's survey size = the number of distinct value-COMBINATIONS
      // (multisets) that fill this line, NOT the number of ordered cell
      // assignments. A person reasons "which sets of values fit here?", then
      // places them; they don't re-survey every permutation. Counting orderings
      // inflated B ~3-10× (e.g. a duplicate line's two equal values plus the
      // distinct rest permute many ways for one and the same combination), which
      // made forced/near-forced lines look far harder than they are.
      const combos = new Set();
      function search(i, sumSoFar, dupLastPos) {
        if (i === 6) {
          if (target >= 0 && sumSoFar !== target) return;
          for (let v = 1; v <= 9; v++) if ((dupMask & (1 << (v - 1))) && usage[v] !== 2) return;
          combos.add(assigned.slice().sort((x, y) => x - y).join(","));
          for (let j = 0; j < 6; j++) support[j] |= 1 << (assigned[j] - 1);
          return;
        }
        if (target >= 0) {
          const rem = 6 - i;
          if (sumSoFar + rem * 9 < target) return;
          if (sumSoFar + rem * 1 > target) return;
        }
        const d = domains[cells[i]];
        for (let v = 1; v <= 9; v++) {
          const b = 1 << (v - 1);
          if (!(d & b)) continue;
          const maxCount = (dupMask & b) ? 2 : 1;
          if (usage[v] >= maxCount) continue;
          if ((dupMask & b) && dupLastPos === i - 1) continue;
          assigned[i] = v;
          usage[v]++;
          const newDupLast = (dupMask & b) ? i : dupLastPos;
          search(i + 1, sumSoFar + v, newDupLast);
          usage[v]--;
        }
      }
      search(0, 0, -2);
      begin();
      for (let j = 0; j < 6 && !bad; j++) keep(cells[j], support[j]);
      commit("Diese Werte passen in keine gültige Belegung dieser Linie.", "lineFeasibility",
        { cells: cells.slice(), value: target, dupMask: dupMask, scope: ls.scope, index: ls.index }, combos.size);
      if (bad) break;
      if (!ls.snap) ls.snap = new Array(6);
      for (let j = 0; j < 6; j++) ls.snap[j] = domains[cells[j]];
    }
    if (bad) break;
    cascade(); if (bad) break;
    // 6. Sequenzen
    for (const s of seqs) {
      const cells = s.cells;
      // Reasoning along an ordered line is more than a forced single, but
      // EASIER than a sumBound (the consecutive/monotone rule is intuitive), so
      // its b is ~half of sumBound's (1 + openCells). Counts toward the level.
      const seqB = Math.max(1, Math.round((1 + cells.filter(idx => !isSingle(idx)).length) / 2));
      begin();
      // Reason follows the sumBound pattern: ONE worked example (the first
      // strike, naming the neighbour cell that makes the value impossible),
      // plus a tail when the same chain check strikes further candidates.
      // seqKeep = keep + capture that example; the kept masks are identical,
      // so the fixpoint (and the logicalSolve mirror) is untouched.
      let ex = null, nStruck = 0;
      const seqKeep = (idx, mask, explain) => {
        const removed = domains[idx] & ~mask;
        for (let v = 1; v <= 9; v++) if (removed & bit(v)) { nStruck++; if (!ex) ex = explain(v); }
        keep(idx, mask);
      };
      // For the gapless types: cell `idx`=v forces neighbour `nbr` to `need` —
      // which is either gone from nbr's candidates or outside 1–9 entirely.
      const directEx = (idx, v, nbr, need) => "Mit " + cl2(idx) + "=" + v + " müsste " + cl2(nbr) + "=" + need + " sein — " +
        (need >= 1 && need <= 9 ? "das ist dort nicht mehr möglich" : "diesen Wert gibt es nicht");
      if (s.type === "directSequence") {
        for (let k = 0; k < cells.length - 1; k++) {
          const L = cells[k], R = cells[k + 1];
          seqKeep(R, (domains[L] << 1) & FULL, v => directEx(R, v, L, v - 1));
          seqKeep(L, domains[R] >> 1, v => directEx(L, v, R, v + 1));
        }
      } else if (s.type === "directDescending") {
        for (let k = 0; k < cells.length - 1; k++) {
          const L = cells[k], R = cells[k + 1];
          seqKeep(R, domains[L] >> 1, v => directEx(R, v, L, v + 1));
          seqKeep(L, (domains[R] << 1) & FULL, v => directEx(L, v, R, v - 1));
        }
      } else if (s.type === "ascending") {
        for (let k = 0; k < cells.length - 1; k++) {
          const L = cells[k], R = cells[k + 1];
          const mn = minV(domains[L]); let m1 = 0; for (let v = mn + 1; v <= 9; v++) m1 |= bit(v);
          seqKeep(R, m1, v => cl2(R) + " muss größer als " + cl2(L) + " sein, und " + cl2(L) + " ist mindestens " + mn + " — die " + v + " ist zu klein");
          const mx = maxV(domains[R]); let m2 = 0; for (let v = 1; v <= mx - 1; v++) m2 |= bit(v);
          seqKeep(L, m2, v => cl2(L) + " muss kleiner als " + cl2(R) + " sein, und " + cl2(R) + " ist höchstens " + mx + " — die " + v + " ist zu groß");
        }
      } else { // descending (with gaps)
        for (let k = 0; k < cells.length - 1; k++) {
          const L = cells[k], R = cells[k + 1];
          const mx = maxV(domains[L]); let m1 = 0; for (let v = 1; v <= mx - 1; v++) m1 |= bit(v);
          seqKeep(R, m1, v => cl2(R) + " muss kleiner als " + cl2(L) + " sein, und " + cl2(L) + " ist höchstens " + mx + " — die " + v + " ist zu groß");
          const mn = minV(domains[R]); let m2 = 0; for (let v = mn + 1; v <= 9; v++) m2 |= bit(v);
          seqKeep(L, m2, v => cl2(L) + " muss größer als " + cl2(R) + " sein, und " + cl2(R) + " ist mindestens " + mn + " — die " + v + " ist zu klein");
        }
      }
      let reason = "Diese Werte passen nicht mehr in die geforderte Reihenfolge.";
      if (ex) {
        const lineLabel = s.scope === "row" ? rowLabel(s.index) : colLabel(s.index);
        const seqDesc = s.type === "directSequence" ? "steigt lückenlos um je 1"
          : s.type === "directDescending" ? "fällt lückenlos um je 1"
          : s.type === "ascending" ? "steigt von Zelle zu Zelle (Lücken erlaubt)"
          : "fällt von Zelle zu Zelle (Lücken erlaubt)";
        reason = lineLabel + " " + seqDesc + ". " + ex +
          (nStruck > 1 ? ". Dieselbe Prüfung entlang der Kette streicht auch die übrigen unten markierten Kandidaten." : ".");
      }
      commit(reason, "sequence",
        { cells: s.cells.slice(), kind: s.type, scope: s.scope, index: s.index }, seqB);
      if (bad) break;
    }
    if (bad) break;
    cascade(); if (bad) break;
    if (steps.length === before) break; // Fixpunkt erreicht
  }

  let solved = !bad;
  if (solved) for (let i = 0; i < N * N; i++) if (!isSingle(i)) { solved = false; break; }
  const grid = Array.from({ length: N }, () => Array(N).fill(0));
  if (solved) for (let i = 0; i < N * N; i++) grid[(i / N) | 0][i % N] = valOf(i);
  return { solved, steps, grid };
}
