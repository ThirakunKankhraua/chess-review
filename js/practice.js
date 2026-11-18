// Practice mode: replay the positions where the player went wrong, and let them find a better move.
//
// A move counts as solved if it is the engine's choice, or if a fresh engine check shows it gives
// away less than an Inaccuracy's worth of win chance. A wrong try is explained with the same rules
// as the review screen, so the feedback says what the try allows rather than just "wrong".

import { Chess } from '../vendor/chess.js/chess.js';
import { Board } from './board.js';
import { LABEL_THRESHOLDS, classify, evalToCp, winPercent } from './analysis.js';
import { explainMove, hangingSquares } from './explain.js';

const SOLVED_KEY = 'chessReview.solved';
const THREATS_KEY = 'chessReview.showThreats';
const LABEL_TEXT = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };
const ARROW = { best: '#7fb33f', reply: '#f39a24' };

/** Puzzle groups the player can pick from. */
const FILTERS = [
  { key: 'all', name: 'ทุกโจทย์', test: () => true },
  { key: 'hung', name: 'ระวังหมากถูกกิน', test: (p) => p.tags.some((t) => t.startsWith('hung')) },
  { key: 'capture', name: 'หาหมากที่กินได้ฟรี', test: (p) => p.tags.includes('missed_capture') },
  { key: 'mate', name: 'เกี่ยวกับ mate', test: (p) => p.tags.some((t) => t === 'missed_mate' || t === 'allowed_mate') },
  { key: 'tactic', name: 'tactic สองตา', test: (p) => p.tags.some((t) => t === 'missed_tactic' || t === 'allowed_tactic') },
];

const $ = (id) => document.getElementById(id);
const board = new Board($('practiceBoard'));

/** Everything about the current session; replaced by startPractice(). */
const s = {
  deps: null,
  all: [],          // every puzzle
  list: [],         // puzzles in the chosen group
  index: 0,
  puzzle: null,
  selected: null,   // square of the piece picked up
  state: 'idle',    // 'idle' | 'checking' | 'wrong' | 'solved' | 'revealed'
  hint: 0,          // hints shown so far
  attempt: null,    // { fen, move, replyUci } after a try
  token: 0,         // incremented to abandon an engine check in flight
  lastId: null,     // puzzle to return to after visiting its game
};

// ---------- small helpers ----------

/**
 * Create an element with a class and text.
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

/**
 * Read the set of solved puzzle ids, tolerating blocked storage.
 * @returns {Set<string>}
 */
function loadSolved() {
  try { return new Set(JSON.parse(localStorage.getItem(SOLVED_KEY) || '[]')); } catch { return new Set(); }
}

/**
 * Remember that a puzzle was solved.
 * @param {string} id
 */
function markSolved(id) {
  const solved = loadSolved();
  solved.add(id);
  try { localStorage.setItem(SOLVED_KEY, JSON.stringify([...solved])); } catch { /* storage unavailable */ }
}

/**
 * Whether threat rings are switched on (shared with the review screen).
 * @returns {boolean}
 */
function threatsOn() {
  try { return localStorage.getItem(THREATS_KEY) === '1'; } catch { return false; }
}

/**
 * Win chance for one side from a White-POV evaluation.
 * @param {object} ev
 * @param {'w' | 'b'} colour
 * @returns {number}
 */
function winFor(ev, colour) {
  const white = winPercent(evalToCp(ev));
  return colour === 'w' ? white : 100 - white;
}

// ---------- building the puzzle list ----------

/**
 * Turn the player's own mistakes into puzzles.
 * @param {{game: object, analysis: object, colour: 'w' | 'b'}[]} entries
 * @returns {object[]}
 */
function buildPuzzles(entries) {
  const puzzles = [];
  for (const { game, analysis, colour } of entries) {
    const h = game.headers;
    const opponent = colour === 'w' ? h.Black : h.White;
    const when = `${h.UTCDate || h.Date || ''} ${h.UTCTime || ''}`;
    for (const rec of analysis.records) {
      if (rec.color !== colour || !rec.bestUci || rec.bestUci === rec.uci || !rec.bestSan) continue;
      if (rec.label !== 'mistake' && rec.label !== 'blunder') continue;
      // Positions that were already lost teach little, unless a mate was there to be found.
      if (rec.winBefore < 15 && !rec.tags.includes('missed_mate')) continue;
      puzzles.push({
        id: `${game.id}#${rec.ply}`,
        gameId: game.id,
        ply: rec.ply,
        moveNumber: Math.ceil(rec.ply / 2),
        colour,
        fen: rec.fenBefore,
        bestUci: rec.bestUci,
        bestSan: rec.bestSan,
        bestLine: rec.bestLine,
        playedSan: rec.san,
        playedLabel: rec.label,
        notes: rec.notes,
        outcome: rec.outcome,
        tags: rec.tags,
        evalBefore: rec.evalBefore,
        winBefore: rec.winBefore,
        opponent: opponent || '',
        date: h.Date || '',
        when,
      });
    }
  }
  return puzzles;
}

/** Order the chosen group: unsolved first, newest games first, then in move order. */
function applyFilter() {
  const filter = FILTERS.find((f) => f.key === $('practiceFilter').value) || FILTERS[0];
  const solved = loadSolved();
  s.list = s.all
    .filter(filter.test)
    // Puzzles with a concrete reason (a piece left hanging, a missed mate...) come before purely
    // positional ones: they have a clear answer a beginner can find and check.
    .sort((a, b) => (solved.has(a.id) - solved.has(b.id))
      || ((b.notes.length > 0) - (a.notes.length > 0))
      || b.when.localeCompare(a.when) || a.ply - b.ply);
}

// ---------- session ----------

/**
 * Start practice with the player's analysed games.
 * @param {{entries: object[], evaluate: (fen: string) => Promise<object>,
 *          openGame: (gameId: string, ply: number) => void}} deps
 *   evaluate returns a White-POV evaluation with `pv`; openGame shows a game in the review screen.
 */
export function startPractice(deps) {
  s.deps = deps;
  s.all = buildPuzzles(deps.entries);
  const select = $('practiceFilter');
  if (!select.options.length) {
    for (const f of FILTERS) select.appendChild(new Option(f.name, f.key));
    select.addEventListener('change', () => { applyFilter(); loadPuzzle(0); });
  }
  applyFilter();
  if (s.list.length === 0) {
    $('practiceStatus').textContent = 'ยังไม่มีโจทย์ วิเคราะห์เกมของคุณก่อน แล้วกลับมาที่หน้านี้';
    $('practiceCard').hidden = true;
    return;
  }
  $('practiceCard').hidden = false;
  const back = s.lastId ? s.list.findIndex((p) => p.id === s.lastId) : -1;
  loadPuzzle(back >= 0 ? back : 0);
}

/** Abandon any engine check in flight (called when leaving the page). */
export function stopPractice() {
  s.token += 1;
}

/**
 * Show one puzzle.
 * @param {number} index Position in the current group.
 */
function loadPuzzle(index) {
  s.token += 1;
  s.index = ((index % s.list.length) + s.list.length) % s.list.length;
  s.puzzle = s.list[s.index];
  s.lastId = s.puzzle.id;
  s.selected = null;
  s.state = 'idle';
  s.hint = 0;
  s.attempt = null;
  board.setFlipped(s.puzzle.colour === 'b');
  render();
}

// ---------- moving pieces ----------

/**
 * Handle a click on the practice board: pick up a piece, or play it to a target square.
 * @param {string} square
 */
function onSquare(square) {
  if (s.state !== 'idle') return;
  const chess = new Chess(s.puzzle.fen);
  if (s.selected) {
    const move = chess.moves({ square: s.selected, verbose: true }).find((m) => m.to === square
      && (!m.promotion || m.promotion === 'q')); // promotions always become a queen here
    if (move) { tryMove(move); return; }
  }
  const piece = chess.get(square);
  s.selected = piece && piece.color === s.puzzle.colour && s.selected !== square ? square : null;
  render();
}
board.onSquare = onSquare;

/**
 * Check a move the player tried.
 * @param {object} move chess.js move from the puzzle position.
 */
async function tryMove(move) {
  const p = s.puzzle;
  const after = new Chess(p.fen);
  after.move({ from: move.from, to: move.to, promotion: move.promotion });
  const uci = move.from + move.to + (move.promotion || '');
  s.selected = null;
  s.attempt = { fen: after.fen(), move, replyUci: null };

  if (uci === p.bestUci) { solved(null); return; }

  s.state = 'checking';
  render();
  const token = ++s.token;
  let ev;
  try {
    ev = await s.deps.evaluate(after.fen());
  } catch {
    if (token === s.token) { s.state = 'idle'; renderFeedback([el('div', 'bad', 'ตรวจด้วย engine ไม่ได้ ลองใหม่อีกครั้ง')]); }
    return;
  }
  if (token !== s.token) return; // the player moved on

  const winAfter = winFor(ev, p.colour);
  const drop = Math.max(0, p.winBefore - winAfter);
  if (drop < LABEL_THRESHOLDS.inaccuracy) { solved({ winAfter }); return; }

  // Explain the try with the review screen's rules, as if it had been played in the game.
  const rec = {
    ply: p.ply, color: p.colour, san: move.san, uci, piece: move.piece,
    captured: move.captured || null, promotion: move.promotion || null, from: move.from, to: move.to,
    fenBefore: p.fen, fenAfter: after.fen(), evalBefore: p.evalBefore, evalAfter: ev,
    winBefore: p.winBefore, winAfter, drop, label: classify(drop, false),
    bestUci: p.bestUci, bestSan: p.bestSan, bestLine: p.bestLine, replyLine: ev.pv || [],
  };
  const why = explainMove(rec);
  s.attempt.replyUci = (ev.pv || [])[0] || null;
  s.state = 'wrong';
  render();
  const parts = [
    el('div', 'bad', `ยังไม่ใช่: ${move.san} ทำให้โอกาสชนะลดจาก ${Math.round(p.winBefore)}% เหลือ ` +
      `${Math.round(winAfter)}% (${LABEL_TEXT[rec.label] || rec.label})`),
    ...why.notes.map((n) => el('div', 'why', n)),
  ];
  if (why.outcome) parts.push(el('div', 'outcome', why.outcome));
  if (why.replySan) parts.push(el('div', '', `อีกฝ่ายจะตอบด้วย ${why.replySan} (ลูกศรสีส้ม)`));
  renderFeedback(parts);
}

/**
 * Mark the current puzzle solved and explain the original mistake.
 * @param {{winAfter: number} | null} alt Set when an alternative to the engine's move was accepted.
 */
function solved(alt) {
  const p = s.puzzle;
  markSolved(p.id);
  s.state = 'solved';
  render();
  const parts = [el('div', 'ok', alt
    ? `ถูกต้อง ตานี้ใช้ได้ (โอกาสชนะ ${Math.round(alt.winAfter)}%) ตาที่ engine เลือกคือ ${p.bestSan}`
    : `ถูกต้อง ${p.bestSan} คือตาที่ engine เลือก`)];
  parts.push(el('div', '', `ในเกมจริงคุณเดิน ${p.playedSan} (${LABEL_TEXT[p.playedLabel]}) เพราะ:`));
  for (const n of p.notes) parts.push(el('div', 'why', n));
  if (p.outcome) parts.push(el('div', 'outcome', p.outcome));
  renderFeedback(parts);
}

// ---------- drawing ----------

/** Draw the board and the task text for the current state. */
function render() {
  const p = s.puzzle;
  const side = p.colour === 'w' ? 'ขาว' : 'ดำ';
  const solvedSet = loadSolved();
  const solvedHere = s.list.filter((x) => solvedSet.has(x.id)).length;
  $('practiceStatus').textContent =
    `โจทย์ที่ ${s.index + 1} จาก ${s.list.length} ในกลุ่มนี้ (แก้แล้ว ${solvedHere}) จากความผิดพลาดทั้งหมด ${s.all.length} ตา`;
  $('practiceTask').textContent =
    `ตา${side}เดิน ในเกมจริงคุณเดิน ${p.playedSan} ซึ่งเป็น ${LABEL_TEXT[p.playedLabel]} ลองหาตาที่ดีกว่า`;
  $('practiceMeta').textContent = `จากเกมพบ ${p.opponent} วันที่ ${p.date} ตาที่ ${p.moveNumber}` +
    (solvedSet.has(p.id) && s.state === 'idle' ? ' (เคยแก้แล้ว)' : '');

  const showingTry = s.attempt && (s.state === 'checking' || s.state === 'wrong' || s.state === 'solved');
  const fen = showingTry ? s.attempt.fen : p.fen;
  const rings = threatsOn()
    ? [...hangingSquares(fen, p.colour).map((square) => ({ square, cls: 'ring-mine' })),
      ...hangingSquares(fen, p.colour === 'w' ? 'b' : 'w').map((square) => ({ square, cls: 'ring-theirs' }))]
    : [];
  if (s.hint >= 1 && s.state === 'idle') rings.push({ square: p.bestUci.slice(0, 2), cls: 'ring-hint' });

  const arrows = [];
  if (s.state === 'revealed' || s.state === 'solved') {
    if (!showingTry) arrows.push({ from: p.bestUci.slice(0, 2), to: p.bestUci.slice(2, 4), colour: ARROW.best });
  }
  if (s.state === 'wrong' && s.attempt.replyUci) {
    arrows.push({ from: s.attempt.replyUci.slice(0, 2), to: s.attempt.replyUci.slice(2, 4), colour: ARROW.reply });
  }
  const dots = s.selected
    ? new Chess(p.fen).moves({ square: s.selected, verbose: true }).map((m) => m.to)
    : [];
  board.render(fen, showingTry ? { from: s.attempt.move.from, to: s.attempt.move.to } : null, {
    arrows, rings, dots, selected: s.selected,
    animate: showingTry && s.state === 'checking' ? { from: s.attempt.move.from, to: s.attempt.move.to } : null,
  });
  $('practiceBoard').classList.toggle('interactive', s.state === 'idle');

  if (s.state === 'idle') renderFeedback(s.hint >= 2 && p.notes.length
    ? [el('div', '', 'คำใบ้: ในเกมจริง ตาที่คุณเดินพลาดเพราะ'), el('div', 'why', p.notes[0])]
    : [el('div', '', s.hint >= 1
      ? 'คำใบ้: ลองเดินหมากตัวที่มีวงสีฟ้า'
      : 'คลิกหมากของคุณ แล้วคลิกช่องที่จะเดินไป')]);
  if (s.state === 'checking') renderFeedback([el('div', '', 'กำลังตรวจตานี้ด้วย engine...')]);
  if (s.state === 'revealed') {
    const parts = [el('div', '', `เฉลย: ${p.bestSan} (ลูกศรสีเขียว) ในเกมจริงคุณเดิน ${p.playedSan} เพราะ:`)];
    for (const n of p.notes) parts.push(el('div', 'why', n));
    if (p.outcome) parts.push(el('div', 'outcome', p.outcome));
    renderFeedback(parts);
  }
  renderTools();
}

/**
 * Replace the feedback area.
 * @param {HTMLElement[]} parts
 */
function renderFeedback(parts) {
  $('practiceFeedback').replaceChildren(...parts);
}

/** Buttons that fit the current state. */
function renderTools() {
  const box = $('practiceTools');
  box.replaceChildren();
  const add = (text, onClick, primary = false) => {
    const btn = el('button', primary ? '' : 'ghost', text);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    box.appendChild(btn);
  };
  if (s.state === 'idle') {
    // The second hint quotes why the game move was bad, so it exists only when there is a reason.
    const maxHint = s.puzzle.notes.length ? 2 : 1;
    if (s.hint < maxHint) add(s.hint === 0 ? 'คำใบ้' : 'คำใบ้เพิ่ม', () => { s.hint += 1; render(); });
    add('เฉลย', () => { s.state = 'revealed'; s.selected = null; render(); });
  }
  if (s.state === 'wrong') add('ลองใหม่', () => { s.state = 'idle'; s.attempt = null; render(); }, true);
  if (s.state === 'wrong') add('เฉลย', () => { s.state = 'revealed'; s.attempt = null; render(); });
  add(threatsOn() ? 'ซ่อนหมากที่ถูกโจมตี' : 'แสดงหมากที่ถูกโจมตี', () => {
    try { localStorage.setItem(THREATS_KEY, threatsOn() ? '0' : '1'); } catch { /* storage unavailable */ }
    render(); // feedback text is kept for the 'wrong' and 'solved' states
  });
  add('โจทย์ถัดไป', () => loadPuzzle(s.index + 1), s.state === 'solved' || s.state === 'revealed');
  add('เปิดเกมนี้ตรงตานี้', () => s.deps.openGame(s.puzzle.gameId, s.puzzle.ply));
}
