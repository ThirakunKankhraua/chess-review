// App entry point: load a game (chess.com username or pasted PGN), analyse it, step through it.

import { Chess } from '../vendor/chess.js/chess.js';
import { Board } from './board.js';
import { Engine } from './engine.js';
import { buildAnalysis, formatEval, LABEL_THRESHOLDS } from './analysis.js';
import { cacheAll, cacheGet, cachePut } from './cache.js';
import { CATEGORIES, PHASES, computeStats } from './stats.js';

const USERNAME_KEY = 'chessReview.username';
const ENGINE_PATH = 'vendor/stockfish/stockfish-19-lite-single.js';
const ENGINE_TAG = 'sf19-lite';
/** Search depth per position; phones get a shallower search to keep the wait reasonable. */
const DEPTH = window.matchMedia('(pointer: coarse)').matches ? 12 : 14;

const DRAW_CODES = new Set([
  'agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient',
]);
const LABEL_TEXT = {
  best: 'Best', good: 'Good', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder',
};
const LABEL_MARK = { inaccuracy: '?!', mistake: '?', blunder: '??' };
const MATE_TAGS = ['missed_mate', 'allowed_mate'];

/**
 * Mark to show beside a move: its label mark, or, in an already-decided game where the label
 * stays quiet, '#' for a mate-related slip and 'x' for a piece left to be taken.
 * @param {object | null} rec Move record.
 * @returns {{text: string, cls: string} | null}
 */
function markFor(rec) {
  if (!rec) return null;
  if (LABEL_MARK[rec.label]) return { text: LABEL_MARK[rec.label], cls: `lbl-${rec.label}` };
  if (rec.tags.some((t) => MATE_TAGS.includes(t))) return { text: '#', cls: 'lbl-mate' };
  if (rec.tags.includes('hung_piece')) return { text: 'x', cls: 'lbl-hung' };
  return null;
}
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const board = new Board($('board'));

/** The game being reviewed; null while the loader view is showing. */
let game = null;
/** Index into game.positions: 0 = start position, n = after the n-th half-move. */
let ply = 0;
/** When true the board shows the position before the current move, with the better move drawn. */
let showBetter = false;
/** Created on first use so the loader view stays light. */
let engine = null;
/** Incremented whenever an analysis run should be abandoned. */
let analysisToken = 0;

// ---------- small helpers ----------

/**
 * Read the saved username, tolerating blocked storage.
 * @returns {string}
 */
function loadSavedUsername() {
  try { return localStorage.getItem(USERNAME_KEY) || ''; } catch { return ''; }
}

/**
 * Remember the username for next visit, tolerating blocked storage.
 * @param {string} name
 */
function saveUsername(name) {
  try { localStorage.setItem(USERNAME_KEY, name); } catch { /* storage unavailable */ }
}

/**
 * Show a status line under a form.
 * @param {string} id Element id.
 * @param {string} text Message.
 * @param {boolean} isError Colour it as an error.
 */
function setStatus(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/**
 * Shorten a PGN clock value such as "0:09:55.6" to "9:55".
 * @param {string} clk
 * @returns {string}
 */
function formatClock(clk) {
  const [h, m, s] = clk.split(':');
  const sec = String(Math.floor(Number(s))).padStart(2, '0');
  return Number(h) > 0 ? `${Number(h)}:${m}:${sec}` : `${Number(m)}:${sec}`;
}

/**
 * Small stable hash, used to give pasted PGNs a cache key.
 * @param {string} text
 * @returns {string}
 */
function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Create an element with a class and text in one call.
 * @param {string} tag
 * @param {string} className
 * @param {string} text
 * @returns {HTMLElement}
 */
function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// ---------- parsing a game ----------

/**
 * Turn PGN text into the structure the review view needs.
 * @param {string} pgn Raw PGN text.
 * @param {{url?: string, accuracies?: {white: number, black: number}}} meta Extra data from chess.com.
 * @returns {object} Parsed game: headers, moves, positions, clocks.
 * @throws {Error} If the PGN cannot be read or contains no moves.
 */
function parseGame(pgn, meta = {}) {
  const chess = new Chess();
  chess.loadPgn(pgn.trim());
  const moves = chess.history({ verbose: true });
  if (moves.length === 0) throw new Error('no moves');

  const headers = typeof chess.getHeaders === 'function' ? chess.getHeaders() : chess.header();
  const positions = [moves[0].before, ...moves.map((m) => m.after)];
  // chess.com stores the remaining clock after every move as {[%clk h:mm:ss.d]}.
  const clockMatches = [...pgn.matchAll(/\[%clk\s+([\d:.]+)\]/g)].map((m) => m[1]);
  const clocks = clockMatches.length === moves.length ? clockMatches : null;
  const firstToMove = moves[0].before.split(' ')[1];
  const id = meta.url || headers.Link || `pgn:${hashText(pgn.trim())}`;

  return { id, pgn, headers, moves, positions, clocks, firstToMove, meta, analysis: null, userColour: null };
}

// ---------- engine analysis ----------

/**
 * Evaluate one position, from White's point of view.
 * Finished positions are scored directly instead of being sent to the engine.
 * @param {string} fen
 * @returns {Promise<{cp?: number, mate?: number, winner?: 'w' | 'b', best: string | null, pv: string[]}>}
 */
async function evaluatePosition(fen) {
  const turn = fen.split(' ')[1];
  const pos = new Chess(fen);
  if (pos.isCheckmate()) return { mate: 0, winner: turn === 'w' ? 'b' : 'w', best: null, pv: [] };
  if (pos.isGameOver()) return { cp: 0, best: null, pv: [] };

  const res = await engine.analyse(fen, DEPTH);
  // UCI scores are for the side to move; flip them when Black is to move.
  const sign = turn === 'w' ? 1 : -1;
  const out = { best: res.best, pv: res.pv };
  if (res.type === 'mate') out.mate = sign * res.value;
  else out.cp = sign * res.value;
  return out;
}

/**
 * Get the engine evaluations for every position of a game: from the saved cache if present,
 * otherwise by running the engine and saving the result.
 * @param {object} g Parsed game.
 * @param {number} token Value of analysisToken when the caller started; a change means "abandon".
 * @param {(done: number, total: number) => void} onProgress Called after each position.
 * @returns {Promise<object[] | null>} Evaluations, or null if abandoned.
 */
async function ensureEvals(g, token, onProgress) {
  const key = `${g.id}|${ENGINE_TAG}|d${DEPTH}`;
  const saved = await cacheGet(key);
  // Entries saved without the PGN cannot be rebuilt for cross-game statistics, so redo them.
  if (saved && saved.pgn && saved.evals.length === g.positions.length) return saved.evals;

  if (!engine) engine = new Engine(ENGINE_PATH);
  await engine.newGame();
  const evals = [];
  for (let i = 0; i < g.positions.length; i++) {
    if (token !== analysisToken) return null;
    evals.push(await evaluatePosition(g.positions[i]));
    onProgress(i + 1, g.positions.length);
  }
  if (token !== analysisToken) return null;
  await cachePut({
    key, gameId: g.id, engine: ENGINE_TAG, depth: DEPTH, evals,
    pgn: g.pgn, meta: g.meta, headers: g.headers, savedAt: Date.now(),
  });
  return evals;
}

/**
 * Analyse every position of a game (or load the saved result) and show it.
 * @param {object} g Parsed game.
 */
async function runAnalysis(g) {
  const token = ++analysisToken;
  $('summaryBox').hidden = true;
  $('progressBox').hidden = false;
  $('progressFill').style.width = '0%';
  setStatus('progressText', 'กำลังเตรียม engine...');

  try {
    const evals = await ensureEvals(g, token, (done, total) => {
      $('progressFill').style.width = `${Math.round((done / total) * 100)}%`;
      setStatus('progressText', `กำลังวิเคราะห์ ${done}/${total} ตำแหน่ง`);
    });
    if (!evals || token !== analysisToken) return;

    g.analysis = buildAnalysis(g, evals);
    $('progressBox').hidden = true;
    renderSummary();
    renderMoveList();
    $('summaryBox').hidden = false;
    $('evalBar').hidden = false;
    // A game opened from the statistics page jumps straight to the move that was clicked.
    goTo(g.startPly || ply);
    g.startPly = 0;
  } catch (err) {
    console.error(err);
    if (token === analysisToken) setStatus('progressText', 'เริ่ม engine ไม่ได้ ลองโหลดหน้านี้ใหม่', true);
  }
}

/** Abandon any analysis in progress. */
function cancelAnalysis() {
  analysisToken += 1;
  if (engine) engine.stop();
}

// ---------- review view ----------

/**
 * Open a parsed game in the review view and start analysing it.
 * @param {object} parsed Result of parseGame().
 */
function openGame(parsed) {
  cancelAnalysis();
  game = parsed;
  const me = loadSavedUsername().toLowerCase();
  if (me !== '' && (game.headers.Black || '').toLowerCase() === me) game.userColour = 'b';
  else if (me !== '' && (game.headers.White || '').toLowerCase() === me) game.userColour = 'w';
  board.setFlipped(game.userColour === 'b');

  renderGameInfo();
  renderMoveList();
  $('evalBar').hidden = true;
  showView('review');
  goTo(0);
  runAnalysis(game);
}

/**
 * Show one of the three views and set the header buttons to match.
 * @param {'loader' | 'review' | 'stats'} name
 */
function showView(name) {
  $('loaderView').hidden = name !== 'loader';
  $('reviewView').hidden = name !== 'review';
  $('statsView').hidden = name !== 'stats';
  $('backBtn').hidden = name === 'loader';
  $('statsBtn').hidden = name === 'stats';
}

/** Fill the info card with players, time control and how the game ended. */
function renderGameInfo() {
  const h = game.headers;
  const info = $('gameInfo');
  info.replaceChildren(el('strong', '', `${h.White || 'White'} vs ${h.Black || 'Black'}`));
  const lines = [];
  if (h.Date) lines.push(`วันที่ ${h.Date}`);
  if (h.Result) lines.push(`ผล ${h.Result}`);
  if (h.Termination) lines.push(h.Termination);
  for (const line of lines) info.appendChild(el('div', '', line));
}

/** Build the clickable move list, one row per full move, with label marks once analysed. */
function renderMoveList() {
  const list = $('moveList');
  list.replaceChildren();
  const startNum = Number(game.positions[0].split(' ')[5]) || 1;
  const offset = game.firstToMove === 'b' ? 1 : 0;
  let row = null;

  game.moves.forEach((move, i) => {
    const slot = (i + offset) % 2; // 0 = White's column, 1 = Black's column
    if (row === null || slot === 0) {
      row = document.createElement('li');
      row.appendChild(el('span', 'move-num', `${startNum + Math.floor((i + offset) / 2)}.`));
      if (slot === 1) row.appendChild(document.createElement('span')); // empty White cell
      list.appendChild(row);
    }
    const btn = el('button', '', move.san);
    btn.type = 'button';
    btn.dataset.ply = String(i + 1);
    const rec = game.analysis ? game.analysis.records[i] : null;
    const mark = markFor(rec);
    if (mark) btn.appendChild(el('span', `mark ${mark.cls}`, mark.text));
    row.appendChild(btn);
  });
}

/** Fill the summary table, the eval graph and the methodology note. */
function renderSummary() {
  const a = game.analysis;
  const h = game.headers;
  $('sumWhiteName').textContent = h.White || 'White';
  $('sumBlackName').textContent = h.Black || 'Black';
  const body = $('summaryBody');
  body.replaceChildren();

  const addRow = (label, white, black, cls = '', dotLabel = null) => {
    const tr = el('tr', cls);
    const first = el('td');
    if (dotLabel) first.appendChild(el('span', `dot lbl-${dotLabel}`));
    first.appendChild(document.createTextNode(label));
    tr.append(first, el('td', '', white), el('td', '', black));
    body.appendChild(tr);
  };
  const fmt = (x) => (x === null || x === undefined ? '-' : x.toFixed(1));

  addRow('Accuracy (สูตร Lichess)', fmt(a.accuracy.w), fmt(a.accuracy.b), 'acc');
  const ref = game.meta.accuracies;
  if (ref) addRow('Accuracy จาก chess.com', fmt(ref.white), fmt(ref.black));
  for (const label of ['best', 'good', 'inaccuracy', 'mistake', 'blunder']) {
    addRow(LABEL_TEXT[label], String(a.counts.w[label]), String(a.counts.b[label]), '', label);
  }

  $('analysisNote').textContent =
    `วิเคราะห์ด้วย ${engine ? engine.name : 'Stockfish 19 Lite'} ที่ depth ${DEPTH} ` +
    `Accuracy คำนวณตามสูตรที่ Lichess เผยแพร่ จึงไม่ตรงกับ chess.com เป๊ะ ` +
    `ป้ายกำกับคิดจากโอกาสชนะที่ลดลง: Inaccuracy ${LABEL_THRESHOLDS.inaccuracy}, ` +
    `Mistake ${LABEL_THRESHOLDS.mistake}, Blunder ${LABEL_THRESHOLDS.blunder} จุดเปอร์เซ็นต์ขึ้นไป`;
  renderGraph();
}

/** Draw White's win chance across the game, with a tick for every mistake and blunder. */
function renderGraph() {
  const a = game.analysis;
  const svg = $('evalGraph');
  const n = a.whiteWin.length - 1;
  svg.setAttribute('viewBox', `0 0 ${n} 100`);
  svg.replaceChildren();

  const pts = a.whiteWin.map((w, i) => `${i},${(100 - w).toFixed(2)}`).join(' ');
  const area = document.createElementNS(SVG_NS, 'polygon');
  area.setAttribute('points', `0,100 ${pts} ${n},100`);
  area.setAttribute('fill', '#f2f2f2');
  svg.appendChild(area);

  const addLine = (x, y1, y2, colour, width, id = '') => {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', y1); line.setAttribute('y2', y2);
    line.setAttribute('stroke', colour);
    line.setAttribute('stroke-width', width);
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    if (id) line.id = id;
    svg.appendChild(line);
    return line;
  };
  const mid = document.createElementNS(SVG_NS, 'line');
  mid.setAttribute('x1', 0); mid.setAttribute('x2', n);
  mid.setAttribute('y1', 50); mid.setAttribute('y2', 50);
  mid.setAttribute('stroke', '#888'); mid.setAttribute('stroke-width', 1);
  mid.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(mid);

  const colours = { mistake: 'var(--c-mistake)', blunder: 'var(--c-blunder)' };
  for (const rec of a.records) {
    if (colours[rec.label]) addLine(rec.ply, 0, 100, colours[rec.label], 2);
  }
  addLine(ply, 0, 100, '#4aa3ff', 2, 'graphCursor');
}

/**
 * Latest known clock for one colour at the current ply.
 * @param {'w' | 'b'} colour
 * @returns {string} Formatted clock, or '' when unknown.
 */
function clockFor(colour) {
  if (!game.clocks) return '';
  for (let i = ply - 1; i >= 0; i--) {
    if (game.moves[i].color === colour) return formatClock(game.clocks[i]);
  }
  return '';
}

/** Update the two player bars (name, rating, clock, side to move). */
function renderPlayers() {
  const h = game.headers;
  const toMove = game.positions[ply].split(' ')[1];
  const sides = {
    w: { name: h.White || 'White', elo: h.WhiteElo },
    b: { name: h.Black || 'Black', elo: h.BlackElo },
  };
  const bottom = board.flipped ? 'b' : 'w';
  const top = bottom === 'w' ? 'b' : 'w';
  for (const [id, colour] of [['playerTop', top], ['playerBottom', bottom]]) {
    const bar = $(id);
    const side = sides[colour];
    bar.querySelector('.player-name').textContent = side.elo ? `${side.name} (${side.elo})` : side.name;
    bar.querySelector('.player-clock').textContent = clockFor(colour);
    bar.classList.toggle('to-move', toMove === colour && ply < game.moves.length);
  }
}

/** Update the eval bar for the current position. */
function renderEvalBar() {
  if (!game.analysis) return;
  const whiteShare = game.analysis.whiteWin[ply];
  const bottomIsWhite = !board.flipped;
  const share = bottomIsWhite ? whiteShare : 100 - whiteShare;
  const bar = $('evalBar');
  bar.classList.toggle('white-bottom', bottomIsWhite);
  bar.classList.toggle('black-bottom', !bottomIsWhite);
  $('evalFill').style.height = `${Math.max(5, Math.min(95, share))}%`;
  $('evalText').textContent = formatEval(game.analysis.evals[ply]);
}

/** Describe the current move: label, win-chance change, and the engine's preferred move. */
function renderMoveDetail() {
  const box = $('moveDetail');
  box.replaceChildren();
  const status = $('moveStatus');
  if (ply === 0) { status.textContent = 'ตำแหน่งเริ่มต้น'; return; }

  const move = game.moves[ply - 1];
  const side = move.color === 'w' ? 'ขาว' : 'ดำ';
  status.replaceChildren(document.createTextNode(`ตาที่ ${ply} จาก ${game.moves.length}: ${side}เดิน ${move.san}`));
  if (!game.analysis) return;

  const rec = game.analysis.records[ply - 1];
  status.appendChild(el('span', `chip lbl-${rec.label}`, LABEL_TEXT[rec.label]));

  box.appendChild(el('div', '',
    `โอกาสชนะของ${side}: ${Math.round(rec.winBefore)}% เป็น ${Math.round(rec.winAfter)}% ` +
    `(eval ${formatEval(rec.evalBefore)} เป็น ${formatEval(rec.evalAfter)})`));

  for (const note of rec.notes) box.appendChild(el('div', 'why', note));

  const flagged = Boolean(LABEL_MARK[rec.label]);
  if (flagged && rec.notes.length === 0) {
    box.appendChild(el('div', '', 'ตัวอธิบายอัตโนมัติยังระบุสาเหตุของตานี้ไม่ได้ ลองเทียบกับตาที่ engine เลือก'));
  }
  if (showsReply(rec) && !showBetter) {
    const reply = el('div');
    reply.append(`${move.color === 'w' ? 'ดำ' : 'ขาว'}ตอบได้ด้วย `, el('strong', '', rec.replySan), ' (ลูกศรสีส้ม)');
    box.appendChild(reply);
  }
  if (rec.label !== 'best' && rec.bestSan) {
    const line = el('div');
    line.append('Engine ชอบ ', el('strong', '', rec.bestSan), ' มากกว่า');
    box.appendChild(line);
    const btn = el('button', 'ghost', showBetter ? 'กลับไปดูตาที่เดินจริง' : 'ดูตาที่ดีกว่าบนกระดาน');
    btn.type = 'button';
    btn.id = 'betterBtn';
    btn.addEventListener('click', toggleBetter);
    box.appendChild(btn);
  }
}

/**
 * Whether a move's detail should point out the other side's best answer.
 * The sentence and the orange arrow both use this, so one never appears without the other.
 * @param {object | null} rec Move record.
 * @returns {boolean}
 */
function showsReply(rec) {
  return Boolean(rec && rec.replySan && rec.replyLine[0] && (markFor(rec) !== null || rec.notes.length > 0));
}

/** Switch between the position after the move and the "what should have been played" view. */
function toggleBetter() {
  if (!game || !game.analysis || ply === 0) return;
  const rec = game.analysis.records[ply - 1];
  if (rec.label === 'best' || !rec.bestUci) return;
  showBetter = !showBetter;
  renderBoard();
  renderMoveDetail();
}

/** Draw the board for the current ply, with badge or comparison arrows as needed. */
function renderBoard() {
  const last = ply > 0 ? game.moves[ply - 1] : null;
  const rec = game.analysis && ply > 0 ? game.analysis.records[ply - 1] : null;

  if (showBetter && rec && rec.bestUci) {
    board.render(rec.fenBefore, null, {
      arrows: [
        { from: last.from, to: last.to, colour: '#e05656' },
        { from: rec.bestUci.slice(0, 2), to: rec.bestUci.slice(2, 4), colour: '#4f9d3a' },
      ],
    });
    return;
  }
  const mark = markFor(rec);
  const badge = mark ? { square: last.to, text: mark.text, cls: mark.cls } : null;
  // For a flagged move, draw the opponent's best answer so the punishment is visible.
  const reply = showsReply(rec) ? rec.replyLine[0] : null;
  const arrows = reply ? [{ from: reply.slice(0, 2), to: reply.slice(2, 4), colour: '#e58f2a' }] : [];
  board.render(game.positions[ply], last ? { from: last.from, to: last.to } : null, { badge, arrows });
}

/**
 * Show the position after a given half-move.
 * @param {number} target Ply to show; clamped to the game's range.
 */
function goTo(target) {
  if (!game) return;
  ply = Math.max(0, Math.min(game.moves.length, target));
  showBetter = false;
  renderBoard();
  renderPlayers();
  renderEvalBar();
  renderMoveDetail();

  for (const btn of $('moveList').querySelectorAll('button')) {
    const active = Number(btn.dataset.ply) === ply;
    btn.classList.toggle('active', active);
    if (active) scrollMoveIntoView(btn);
  }
  if (ply === 0) $('moveList').scrollTop = 0;

  const cursor = $('graphCursor');
  if (cursor) { cursor.setAttribute('x1', ply); cursor.setAttribute('x2', ply); }

  $('firstBtn').disabled = $('prevBtn').disabled = ply === 0;
  $('nextBtn').disabled = $('lastBtn').disabled = ply === game.moves.length;
  updateMistakeButtons();
}

/**
 * Scroll the move list (only the list, never the page) so a move button is visible.
 * @param {HTMLElement} btn
 */
function scrollMoveIntoView(btn) {
  const list = $('moveList');
  const top = btn.offsetTop - list.offsetTop;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + btn.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = top + btn.offsetHeight - list.clientHeight;
  }
}

/**
 * Plies of the mistakes and blunders worth jumping to: the user's own when known, otherwise both sides'.
 * @returns {number[]}
 */
function mistakePlies() {
  if (!game || !game.analysis) return [];
  return game.analysis.records
    .filter((r) => (r.label === 'mistake' || r.label === 'blunder' || markFor(r) !== null && !LABEL_MARK[r.label])
      && (game.userColour === null || r.color === game.userColour))
    .map((r) => r.ply);
}

/** Enable or disable the mistake jump buttons for the current ply. */
function updateMistakeButtons() {
  const plies = mistakePlies();
  $('prevMistakeBtn').disabled = !plies.some((p) => p < ply);
  $('nextMistakeBtn').disabled = !plies.some((p) => p > ply);
}

/**
 * Jump to the nearest mistake before or after the current ply.
 * @param {1 | -1} direction
 */
function jumpMistake(direction) {
  const plies = mistakePlies();
  const target = direction > 0 ? plies.find((p) => p > ply) : [...plies].reverse().find((p) => p < ply);
  if (target !== undefined) goTo(target);
}

/** Flip the board and everything that depends on its orientation. */
function flipBoard() {
  board.setFlipped(!board.flipped);
  renderPlayers();
  renderEvalBar();
}

/** Leave the review view and return to the game picker. */
function showLoader() {
  cancelAnalysis();
  game = null;
  showView('loader');
  refreshAnalysed().then(renderGameList); // the game just reviewed now has a saved analysis
}

/** Header "back" button: a game opened from the statistics page returns there. */
function goBack() {
  if (game && reviewOrigin === 'stats') showStats();
  else showLoader();
}

// ---------- statistics across games ----------

/** Where the current review was opened from, so "back" returns to the right place. */
let reviewOrigin = 'loader';
/** Saved analyses behind the statistics page, by game id, for opening an example. */
let statsSaved = new Map();
/** Parsed game and move records per saved analysis, kept in memory between visits to the page. */
const statsMemo = new Map();
/** Incremented on every visit to the statistics page so an older, slower run cannot draw over a newer one. */
let statsRun = 0;

/** Build and show the statistics page from every saved analysis the player took part in. */
async function showStats() {
  const run = ++statsRun;
  cancelAnalysis();
  game = null;
  showView('stats');
  for (const id of ['statsFocusCard', 'statsCatCard', 'statsMoreCard']) $(id).hidden = true;
  $('statsTiles').replaceChildren();
  setStatus('statsStatus', 'กำลังคำนวณ...');
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the message paint first

  const me = loadSavedUsername().toLowerCase();
  if (!me) {
    setStatus('statsStatus', 'ยังไม่รู้ว่าคุณคือผู้เล่นคนไหน กลับไปโหลดเกมด้วย username ก่อน', true);
    return;
  }
  // One analysis per game: if a game was analysed at two depths, keep the deeper one.
  statsSaved = new Map();
  for (const rec of await cacheAll()) {
    if (!rec.pgn) continue;
    const kept = statsSaved.get(rec.gameId);
    if (!kept || kept.depth < rec.depth) statsSaved.set(rec.gameId, rec);
  }

  const entries = [];
  let seen = 0;
  for (const rec of statsSaved.values()) {
    seen += 1;
    // Rebuilding a game's move records takes a moment, so keep them while the page stays open.
    const memoKey = `${rec.key}|${rec.savedAt}`;
    let built = statsMemo.get(memoKey);
    if (!built) {
      // Yield between games so the page stays responsive and the count is visible.
      setStatus('statsStatus', `กำลังคำนวณ ${seen}/${statsSaved.size} เกม...`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Stop if the user left the page, or left and came back (a newer run is now in charge).
      if ($('statsView').hidden || run !== statsRun) return;
      let parsed;
      try { parsed = parseGame(rec.pgn, rec.meta || {}); } catch { continue; }
      if (rec.evals.length !== parsed.positions.length) continue;
      built = { game: parsed, analysis: buildAnalysis(parsed, rec.evals) };
      statsMemo.set(memoKey, built);
    }
    let colour = null;
    if ((built.game.headers.White || '').toLowerCase() === me) colour = 'w';
    else if ((built.game.headers.Black || '').toLowerCase() === me) colour = 'b';
    if (!colour) continue; // someone else's game
    entries.push({ ...built, colour });
  }

  if (entries.length === 0) {
    setStatus('statsStatus', 'ยังไม่มีเกมของคุณที่วิเคราะห์แล้ว กลับไปกด "วิเคราะห์ทุกเกมในรายการ" ก่อน', true);
    return;
  }
  renderStats(computeStats(entries));
}

/**
 * Draw the statistics page.
 * @param {object} stats Result of computeStats().
 */
function renderStats(stats) {
  setStatus('statsStatus', `คำนวณจากตาเดินของคุณ ${stats.moves} ตา ใน ${stats.games} เกม`);

  const tiles = $('statsTiles');
  tiles.replaceChildren();
  const addTile = (big, small) => {
    const tile = el('div', 'tile');
    tile.append(el('div', 'big', big), el('div', 'small', small));
    tiles.appendChild(tile);
  };
  const serious = stats.labels.mistake + stats.labels.blunder;
  addTile(String(stats.games), 'เกมที่วิเคราะห์');
  addTile(`${stats.results.win} / ${stats.results.loss} / ${stats.results.draw}`, 'ชนะ / แพ้ / เสมอ');
  addTile(stats.meanAccuracy === null ? '-' : stats.meanAccuracy.toFixed(1), 'Accuracy เฉลี่ย (สูตร Lichess)');
  addTile((serious / stats.games).toFixed(1), 'Mistake + Blunder ต่อเกม');

  // Categories, most frequent first.
  const rows = CATEGORIES
    .map((c) => ({ ...c, ...stats.categories.get(c.tag) }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
  const cats = $('statsCats');
  cats.replaceChildren();
  const max = rows.length ? rows[0].count : 1;

  for (const row of rows) {
    const btn = el('button', 'cat-row');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    const bar = el('div', 'cat-bar');
    const fill = el('div');
    fill.style.width = `${Math.round((row.count / max) * 100)}%`;
    bar.appendChild(fill);
    const count = el('span', 'cat-count', `${row.count} ครั้ง `);
    count.appendChild(el('small', '', `ใน ${row.games.size} เกม`));
    btn.append(el('span', '', row.name), bar, count);

    const list = el('ul', 'examples');
    list.hidden = true;
    for (const ex of row.examples.slice(0, 8)) {
      const exBtn = el('button');
      exBtn.type = 'button';
      exBtn.append(
        el('div', 'where', `พบ ${ex.opponent} | ตาที่ ${ex.moveNumber}: ${ex.san}`),
        el('div', '', ex.note),
      );
      exBtn.addEventListener('click', () => openFromStats(ex.gameId, ex.ply));
      const li = document.createElement('li');
      li.appendChild(exBtn);
      list.appendChild(li);
    }
    btn.addEventListener('click', () => {
      list.hidden = !list.hidden;
      btn.setAttribute('aria-expanded', String(!list.hidden));
    });
    cats.append(btn, list);
  }
  $('statsCatCard').hidden = rows.length === 0;

  // The single habit to work on first: the most frequent category that costs a piece or the game.
  const focus = rows.find((r) => r.tag !== 'hung_pawn') || rows[0];
  if (focus) {
    const box = $('statsFocus');
    box.replaceChildren(
      el('strong', '', focus.name),
      el('div', '', `เกิดขึ้น ${focus.count} ครั้งใน ${stats.games} เกม ` +
        `(เฉลี่ย ${(focus.count / stats.games).toFixed(1)} ครั้งต่อเกม)`),
      el('div', '', focus.advice),
    );
  }
  $('statsFocusCard').hidden = !focus;

  // Phase table.
  const table = $('statsPhases');
  table.replaceChildren();
  const head = document.createElement('tr');
  head.append(el('th', '', ''), el('th', '', 'ข้อผิดพลาดร้ายแรง'), el('th', '', 'อัตรา'), el('th', '', 'ตาที่ผลแทบตัดสินแล้ว'));
  table.appendChild(head);
  const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(0)}%` : '-');
  for (const phase of PHASES) {
    const bucket = stats.phases.get(phase.key);
    const tr = document.createElement('tr');
    tr.append(
      el('td', '', phase.name),
      el('td', '', `${bucket.serious} ครั้ง ใน ${bucket.moves} ตา`),
      el('td', '', pct(bucket.serious, bucket.moves)),
      el('td', '', pct(bucket.decided, bucket.moves)),
    );
    table.appendChild(tr);
  }

  const a = stats.medianBlunderSeconds;
  const b = stats.medianOtherSeconds;
  $('statsTime').textContent = a === null || b === null
    ? 'ไม่มีข้อมูลนาฬิกาเพียงพอ'
    : `ตาที่เป็น Mistake หรือ Blunder คุณใช้เวลาคิด ${a.toFixed(0)} วินาที (ค่ามัธยฐาน) ` +
      `ส่วนตาอื่นใช้ ${b.toFixed(0)} วินาที`;
  $('statsNote').textContent =
    'ข้อผิดพลาดร้ายแรง คือตาที่ติดป้าย Mistake หรือ Blunder รวมกับตาที่มีเครื่องหมาย # และ x ' +
    'ตาที่ผลแทบตัดสินแล้ว คือตาที่โอกาสชนะเกิน 90% หรือต่ำกว่า 10% ก่อนเดิน ซึ่งแทบไม่ถูกติดป้าย ' +
    'ช่วงที่สัดส่วนนี้สูง อัตราข้อผิดพลาดจึงต่ำกว่าความจริง อย่าอ่านว่าเล่นช่วงนั้นได้ดี ' +
    'ประเภทข้อผิดพลาดนับเฉพาะที่กฎอัตโนมัติจับได้ ข้อผิดพลาดเชิงตำแหน่งไม่ถูกนับ ' +
    'ช่วงของเกมแบ่งตามเลขตาแบบง่าย ไม่ได้ดูหมากบนกระดาน ' +
    (stats.games < 20 ? `จำนวนเกมยังน้อย (${stats.games} เกม) ตัวเลขจึงแกว่งได้มาก` : '');
  $('statsMoreCard').hidden = false;
}

/**
 * Open a game from the statistics page at a specific move.
 * @param {string} gameId
 * @param {number} atPly
 */
function openFromStats(gameId, atPly) {
  const rec = statsSaved.get(gameId);
  if (!rec) return;
  const parsed = parseGame(rec.pgn, rec.meta || {});
  parsed.startPly = atPly;
  reviewOrigin = 'stats';
  openGame(parsed);
}

// ---------- analysing every listed game ----------

let batchRunning = false;

/** Analyse every listed game that has no saved analysis yet; a second click stops it. */
async function batchAnalyse() {
  if (batchRunning) { cancelAnalysis(); return; }
  const todo = listing.games.filter((g) => !listing.analysed.has(g.url));
  if (todo.length === 0) { setStatus('batchStatus', 'ทุกเกมในรายการวิเคราะห์แล้ว'); return; }

  batchRunning = true;
  $('statsBtn').disabled = true; // opening the statistics page would silently stop the batch
  $('batchBtn').textContent = 'หยุดวิเคราะห์';
  const token = ++analysisToken;
  let done = 0;
  try {
    for (const g of todo) {
      let parsed;
      try { parsed = parseGame(g.pgn, { url: g.url, accuracies: g.accuracies }); } catch { continue; }
      setStatus('batchStatus', `กำลังวิเคราะห์เกมที่ ${done + 1} จาก ${todo.length}`);
      const evals = await ensureEvals(parsed, token, (d, t) => {
        setStatus('batchStatus', `กำลังวิเคราะห์เกมที่ ${done + 1} จาก ${todo.length} (ตำแหน่ง ${d}/${t})`);
      });
      if (!evals) break;
      done += 1;
      listing.analysed.add(g.url);
    }
    setStatus('batchStatus', done === todo.length
      ? `วิเคราะห์ครบแล้ว ${done} เกม กด "สถิติจุดอ่อน" ด้านบนเพื่อดูผล`
      : `หยุดแล้ว วิเคราะห์เพิ่มได้ ${done} จาก ${todo.length} เกม`);
  } catch (err) {
    console.error(err);
    setStatus('batchStatus', 'เริ่ม engine ไม่ได้ ลองโหลดหน้านี้ใหม่', true);
  } finally {
    batchRunning = false;
    $('statsBtn').disabled = false;
    $('batchBtn').textContent = 'วิเคราะห์ทุกเกมในรายการ';
    renderGameList();
  }
}

// ---------- loading games ----------

/**
 * Try to open PGN text, reporting failure on the given status line.
 * @param {string} pgn
 * @param {string} statusId
 * @param {object} meta Extra data from chess.com, if any.
 */
function tryOpenPgn(pgn, statusId, meta = {}) {
  if (!pgn.trim()) { setStatus(statusId, 'ยังไม่มี PGN', true); return; }
  let parsed;
  try {
    parsed = parseGame(pgn, meta);
  } catch (err) {
    console.error(err);
    setStatus(statusId, 'อ่าน PGN นี้ไม่ได้ ตรวจว่าคัดลอกมาครบทั้งเกม', true);
    return;
  }
  setStatus(statusId, '');
  reviewOrigin = 'loader';
  openGame(parsed);
}

/**
 * Describe one chess.com game from the user's point of view.
 * @param {object} g Game object from the chess.com API.
 * @param {string} me Lower-case username.
 * @returns {{cls: string, label: string, text: string, meta: string}}
 */
function summariseGame(g, me) {
  const iAmWhite = g.white.username.toLowerCase() === me;
  const mine = iAmWhite ? g.white : g.black;
  const theirs = iAmWhite ? g.black : g.white;
  let cls = 'draw';
  let label = 'เสมอ';
  if (mine.result === 'win') { cls = 'win'; label = 'ชนะ'; }
  else if (theirs.result === 'win') { cls = 'loss'; label = 'แพ้'; }
  else if (!DRAW_CODES.has(mine.result)) { label = mine.result; }

  const when = new Date(g.end_time * 1000).toLocaleString('th-TH', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  return {
    cls,
    label,
    colour: iAmWhite ? 'w' : 'b',
    text: `${iAmWhite ? 'ขาว' : 'ดำ'} พบ ${theirs.username} (${theirs.rating})`,
    meta: `${g.time_class} | ${when}`,
  };
}

/** Everything the game picker has loaded for the current username. */
const listing = {
  me: '',            // lower-case username
  archives: [],      // monthly archive URLs from chess.com, oldest first
  nextIndex: -1,     // index into archives of the next (older) month to load; -1 = none left
  oldestLabel: '',   // "MM/YYYY" of the oldest month loaded so far
  games: [],         // loaded games, newest first
  analysed: new Set(), // ids of games with a saved analysis
};

/**
 * Report a loading failure on the picker's status line.
 * @param {Error} err
 */
function showLoadError(err) {
  console.error(err);
  const offline = err instanceof TypeError;
  setStatus('loadStatus', offline ? 'เชื่อมต่อ chess.com ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่' : err.message, true);
}

/** Re-read which games already have a saved analysis. */
async function refreshAnalysed() {
  const saved = await cacheAll();
  listing.analysed = new Set(saved.filter((r) => r.pgn).map((r) => r.gameId));
}

/**
 * Load the next older month that contains at least one standard game, and add it to the listing.
 * Empty months (or months of variants only) are skipped so one click always shows something new.
 */
async function loadOlderMonth() {
  $('olderBtn').disabled = true;
  try {
    let added = 0;
    while (added === 0 && listing.nextIndex >= 0) {
      const url = listing.archives[listing.nextIndex];
      listing.nextIndex -= 1;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`chess.com ตอบกลับ HTTP ${res.status}`);
      const { games } = await res.json();
      const playable = games.filter((g) => g.rules === 'chess' && typeof g.pgn === 'string' && g.pgn.length > 0);
      listing.games.push(...playable);
      added = playable.length;
      const [year, month] = url.split('/').slice(-2);
      listing.oldestLabel = `${month}/${year}`;
    }
    listing.games.sort((a, b) => b.end_time - a.end_time);
    renderGameList();
  } catch (err) {
    showLoadError(err);
  } finally {
    $('olderBtn').disabled = false;
  }
}

/** Draw the game list, applying the result and colour filters. */
function renderGameList() {
  const list = $('gameList');
  list.replaceChildren();
  if (!listing.me) return;
  const wantResult = $('filterResult').value;
  const wantColour = $('filterColour').value;
  let shown = 0;

  for (const g of listing.games) {
    const s = summariseGame(g, listing.me);
    if ((wantResult !== 'all' && s.cls !== wantResult) || (wantColour !== 'all' && s.colour !== wantColour)) continue;
    shown += 1;
    const btn = document.createElement('button');
    btn.type = 'button';
    const text = el('span', '', s.text);
    if (listing.analysed.has(g.url)) text.appendChild(el('span', 'analysed-tag', 'วิเคราะห์แล้ว'));
    btn.append(el('span', `result-tag ${s.cls}`, s.label), text, el('span', 'game-meta', s.meta));
    btn.addEventListener('click', () => {
      tryOpenPgn(g.pgn, 'loadStatus', { url: g.url, accuracies: g.accuracies });
    });
    const li = document.createElement('li');
    li.appendChild(btn);
    list.appendChild(li);
  }

  $('listTools').hidden = false;
  $('batchBox').hidden = listing.games.length === 0;
  $('olderBtn').hidden = listing.nextIndex < 0;
  const range = listing.oldestLabel ? ` ย้อนถึงเดือน ${listing.oldestLabel}` : '';
  const more = listing.nextIndex < 0 ? ' (ครบทุกเดือนแล้ว)' : '';
  setStatus('loadStatus', `แสดง ${shown} จาก ${listing.games.length} เกม${range}${more}`);
}

/**
 * Start a fresh listing for a username: fetch the archive index and the most recent month.
 * @param {string} username
 */
async function loadFromChessCom(username) {
  const me = username.trim().toLowerCase();
  $('gameList').replaceChildren();
  $('listTools').hidden = true;
  if (!me) { setStatus('loadStatus', 'ใส่ username ก่อน', true); return; }
  setStatus('loadStatus', 'กำลังโหลด...');

  try {
    const base = `https://api.chess.com/pub/player/${encodeURIComponent(me)}/games/archives`;
    const archivesRes = await fetch(base);
    if (archivesRes.status === 404) throw new Error('ไม่พบ username นี้บน chess.com');
    if (!archivesRes.ok) throw new Error(`chess.com ตอบกลับ HTTP ${archivesRes.status}`);
    const { archives } = await archivesRes.json();
    if (!archives || archives.length === 0) throw new Error('บัญชีนี้ยังไม่มีเกม');

    Object.assign(listing, {
      me, archives, nextIndex: archives.length - 1, oldestLabel: '', games: [],
    });
    saveUsername(username.trim());
    await refreshAnalysed();
    await loadOlderMonth();
  } catch (err) {
    showLoadError(err);
  }
}

// ---------- wiring ----------

$('userForm').addEventListener('submit', (e) => {
  e.preventDefault();
  loadFromChessCom($('username').value);
});
$('olderBtn').addEventListener('click', loadOlderMonth);
$('filterResult').addEventListener('change', renderGameList);
$('filterColour').addEventListener('change', renderGameList);
$('pgnBtn').addEventListener('click', () => tryOpenPgn($('pgnInput').value, 'pgnStatus'));
$('backBtn').addEventListener('click', goBack);
$('statsBtn').addEventListener('click', showStats);
$('batchBtn').addEventListener('click', batchAnalyse);

$('firstBtn').addEventListener('click', () => goTo(0));
$('prevBtn').addEventListener('click', () => goTo(ply - 1));
$('nextBtn').addEventListener('click', () => goTo(ply + 1));
$('lastBtn').addEventListener('click', () => goTo(game.moves.length));
$('flipBtn').addEventListener('click', flipBoard);
$('prevMistakeBtn').addEventListener('click', () => jumpMistake(-1));
$('nextMistakeBtn').addEventListener('click', () => jumpMistake(1));
$('moveList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ply]');
  if (btn) goTo(Number(btn.dataset.ply));
});
$('evalGraph').addEventListener('click', (e) => {
  if (!game || !game.analysis) return;
  const rect = $('evalGraph').getBoundingClientRect();
  goTo(Math.round(((e.clientX - rect.left) / rect.width) * game.moves.length));
});

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof Element && e.target.matches('input, textarea');
  if (!game || typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const actions = {
    ArrowLeft: () => goTo(ply - 1),
    ArrowRight: () => goTo(ply + 1),
    Home: () => goTo(0),
    End: () => goTo(game.moves.length),
    KeyF: flipBoard,
    KeyB: toggleBetter,
  };
  // e.code names the physical key, so F and B still work while a Thai keyboard layout is active.
  const action = actions[e.key] || actions[e.code];
  if (action) { e.preventDefault(); action(); }
});

// The explanation card must be visible without scrolling: beside the board on wide screens,
// directly under the board controls on phones. Must match the breakpoint in style.css.
const narrowScreen = window.matchMedia('(max-width: 920px)');

/** Move the explanation card to the right place for the current screen width. */
function placeMoveCard() {
  const card = document.querySelector('.move-card');
  if (narrowScreen.matches) document.querySelector('.mistake-nav').after(card);
  else document.querySelector('.side-col').prepend(card);
}
narrowScreen.addEventListener('change', placeMoveCard);
placeMoveCard();

$('username').value = loadSavedUsername();
