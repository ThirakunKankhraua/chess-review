// "Analyse this move in depth": a longer engine search on one move, on request.
//
// The whole-game pass looks at one line per position. This looks at the three best candidate
// moves, re-checks the move played, and asks what the opponent was threatening before it, then
// describes each candidate with board facts (what it captures, attacks, defends or sets up).

import { Chess } from '../vendor/chess.js/chess.js';
import { classify, evalToCp, winPercent, formatEval } from './analysis.js';
import { evaluateCapture, hangingSquares, lineBalance, uciToSan } from './explain.js';
import { PIECE_TH, PIECE_VALUE, detectMotif } from './motifs.js';

/** Candidate moves shown. */
const CANDIDATES = 3;

/**
 * Convert a UCI score (side to move) to the app's White-POV evaluation.
 * @param {{type: 'cp' | 'mate', value: number, pv?: string[]}} line
 * @param {'w' | 'b'} turn Side to move in the searched position.
 * @returns {{cp?: number, mate?: number, pv: string[]}}
 */
function toWhitePov(line, turn) {
  const sign = turn === 'w' ? 1 : -1;
  return line.type === 'mate'
    ? { mate: sign * line.value, pv: line.pv || [] }
    : { cp: sign * line.value, pv: line.pv || [] };
}

/**
 * Same position with the other side to move ("what if they could move again?").
 * @param {string} fen
 * @returns {string}
 */
function passTurn(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return parts.join(' ');
}

/**
 * Run the engine work for one move. Results are plain data so they can be saved and reused.
 * @param {object} engine Engine instance (analyse / analyseMulti).
 * @param {object} rec Move record from the whole-game analysis.
 * @param {{depth: number, maxMs: number}} budget Search limits.
 * @param {(text: string) => void} onProgress Progress messages.
 * @returns {Promise<object>} { depth, cands, played, threat }
 */
export async function runDeep(engine, rec, budget, onProgress) {
  const turn = rec.fenBefore.split(' ')[1];
  onProgress(`กำลังหา ${CANDIDATES} ตาที่ดีที่สุด...`);
  const multi = await engine.analyseMulti(rec.fenBefore, budget.depth, CANDIDATES,
    (d) => onProgress(`กำลังหา ${CANDIDATES} ตาที่ดีที่สุด (depth ${d}/${budget.depth})...`), budget.maxMs);
  const cands = multi.lines.map((l) => ({ uci: l.pv[0], ...toWhitePov(l, turn) }));

  // The move played: reuse its candidate line if it is one, otherwise search the position after it.
  let played = cands.find((c) => c.uci === rec.uci) || null;
  if (!played && !new Chess(rec.fenAfter).isGameOver()) {
    onProgress('กำลังตรวจตาที่เดินจริง...');
    const r = await engine.analyse(rec.fenAfter, Math.max(10, budget.depth - 2), budget.maxMs);
    played = { uci: rec.uci, ...toWhitePov(r, rec.fenAfter.split(' ')[1]) };
  } else if (!played) {
    played = { uci: rec.uci, ...rec.evalAfter };
  }

  // What was the opponent threatening before this move? Only possible when not in check.
  let threat = null;
  if (!new Chess(rec.fenBefore).inCheck()) {
    onProgress('กำลังดูว่าอีกฝ่ายขู่อะไรอยู่...');
    try {
      const flipped = passTurn(rec.fenBefore);
      const r = await engine.analyse(flipped, Math.max(10, budget.depth - 6), Math.round(budget.maxMs / 2));
      if (r.best) threat = { fen: flipped, uci: r.best, pv: r.pv, type: r.type, value: r.value };
    } catch {
      threat = null;
    }
  }
  return { depth: multi.depth, cands, played, threat };
}

/**
 * Win chance for one side from a White-POV evaluation.
 * @param {object} ev
 * @param {'w' | 'b'} colour
 * @returns {number}
 */
function winFor(ev, colour) {
  const w = winPercent(evalToCp(ev));
  return colour === 'w' ? w : 100 - w;
}

/**
 * Short Thai phrases saying what a move does, each backed by a board check.
 * @param {string} fen Position before the move.
 * @param {string} uci
 * @returns {string[]}
 */
export function moveIdeas(fen, uci) {
  const ideas = [];
  let move;
  const after = new Chess(fen);
  try {
    move = after.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return ideas;
  }
  const me = move.color;
  const them = me === 'w' ? 'b' : 'w';

  if (after.isCheckmate()) return ['mate ทันที'];
  if (move.flags.includes('k') || move.flags.includes('q')) ideas.push('castle ให้คิงปลอดภัย');
  if (move.captured) {
    const cap = evaluateCapture(fen, uci);
    const what = `${PIECE_TH[move.captured]}ที่ ${cap ? cap.square : move.to}`;
    ideas.push(cap && cap.free ? `กิน${what} ได้ฟรี` : `กิน${what}`);
  }
  if (move.promotion) ideas.push(`โปรโมตเบี้ยเป็น${PIECE_TH[move.promotion]}`);
  if (after.inCheck()) ideas.push('รุกคิง');

  const hungBefore = new Set(hangingSquares(fen, me));
  const hungAfter = new Set(hangingSquares(after.fen(), me));
  if (hungBefore.has(move.from) && !hungAfter.has(move.to)) {
    ideas.push(`พา${PIECE_TH[move.piece]}หนีจากการถูกกิน`);
  }
  for (const sq of hungBefore) {
    if (sq === move.from || hungAfter.has(sq) || sq === move.to) continue;
    const p = after.get(sq);
    if (p && p.color === me) ideas.push(`ป้องกัน${PIECE_TH[p.type]}ที่ ${sq}`);
  }

  const threatsBefore = new Set(hangingSquares(passTurn(fen), them));
  const newThreats = hangingSquares(after.fen(), them).filter((sq) => !threatsBefore.has(sq));
  if (newThreats.length) {
    const best = newThreats
      .map((sq) => ({ sq, type: after.get(sq).type }))
      .sort((a, b) => PIECE_VALUE[b.type] - PIECE_VALUE[a.type])[0];
    ideas.push(`ขู่กิน${PIECE_TH[best.type]}ที่ ${best.sq}`);
    const motif = detectMotif(fen, uci, best.sq);
    if (motif) ideas.push(motif.text);
  }

  const n = Number(fen.split(' ')[5]);
  const home = me === 'w' ? '1' : '8';
  if (!move.captured && 'nb'.includes(move.piece) && move.from[1] === home && n <= 12) {
    ideas.push(`ออก${PIECE_TH[move.piece]}มาทำงาน`);
  }
  if (!ideas.length) ideas.push('ตาเงียบ ปรับตำแหน่งหมากหรือเตรียมแผน');
  return ideas;
}

/**
 * Describe a threat the opponent had before the move, if it is a real one.
 * @param {object} raw Result of runDeep().
 * @param {object} rec Move record.
 * @returns {null | {text: string, stillThere: boolean}}
 */
function describeThreat(raw, rec) {
  const t = raw.threat;
  if (!t) return null;
  const them = rec.color === 'w' ? 'ดำ' : 'ขาว';
  const san = uciToSan(t.fen, t.uci);
  if (!san) return null;
  let what = null;
  if (t.type === 'mate' && t.value > 0) {
    what = t.value === 1 ? 'mate ในตาเดียว' : `mate ใน ${t.value} ตา`;
  } else {
    const cap = evaluateCapture(t.fen, t.uci);
    const line = lineBalance(t.fen, t.pv || [t.uci]);
    if (cap && cap.captured && cap.gain >= 2 && line && line.net >= 2) {
      what = `กิน${PIECE_TH[cap.captured]}ที่ ${cap.square}${cap.free ? ' ได้ฟรี' : ''}`;
    }
  }
  if (!what) return null;
  // Does the threat still work after the move that was played?
  let stillThere = false;
  try {
    const after = new Chess(rec.fenAfter);
    const m = after.move({ from: t.uci.slice(0, 2), to: t.uci.slice(2, 4), promotion: t.uci[4] });
    if (t.type === 'mate') stillThere = after.isCheckmate() || (m && after.inCheck());
    else {
      const cap = evaluateCapture(rec.fenAfter, t.uci);
      stillThere = Boolean(cap && cap.captured && cap.gain >= 2);
    }
  } catch {
    stillThere = false;
  }
  return { text: `ก่อนตานี้ ${them}ขู่ ${san} (${what})`, stillThere };
}

/**
 * Turn the saved engine results into what the screen shows.
 * @param {object} raw Result of runDeep().
 * @param {object} rec Move record.
 * @param {object | null} profile The player's saved weakness counts, or null.
 * @param {boolean} isPlayer Whether this move was made by the player.
 * @returns {object} Display data.
 */
export function describeDeep(raw, rec, profile, isPlayer) {
  const me = rec.color;
  const cands = raw.cands.map((c, i) => ({
    rank: i + 1,
    uci: c.uci,
    san: uciToSan(rec.fenBefore, c.uci) || c.uci,
    win: winFor(c, me),
    evalText: formatEval(c),
    pv: c.pv,
    ideas: moveIdeas(rec.fenBefore, c.uci),
  }));
  const playedWin = winFor(raw.played, me);
  const rank = cands.findIndex((c) => c.uci === rec.uci);
  const bestWin = cands.length ? cands[0].win : playedWin;
  const drop = Math.max(0, bestWin - playedWin);
  const deepLabel = classify(drop, rank === 0);

  const notes = [];
  if (cands.length >= 2) {
    const gap = cands[0].win - cands[1].win;
    if (gap >= 15) notes.push(`ตำแหน่งนี้มีตาดีอยู่ตาเดียวคือ ${cands[0].san} ตาอื่นเสียโอกาสชนะอย่างน้อย ${Math.round(gap)} จุด ต้องคิดให้ดีก่อนเดิน`);
    else if (cands.length >= 3 && cands[0].win - cands[2].win < 4) notes.push('มีหลายตาที่ดีพอ ๆ กัน ตำแหน่งนี้ไม่ต้องหาตาเดียวที่ถูก');
  }
  const threat = describeThreat(raw, rec);
  if (threat) {
    notes.push(threat.stillThere
      ? `${threat.text} และตาที่เดินจริงไม่ได้แก้ภัยนี้`
      : `${threat.text} ตาที่เดินจริงแก้ภัยนี้แล้ว`);
  }

  // Personal note: connect this mistake to the player's own record.
  if (isPlayer && profile && profile.tags) {
    const ranked = Object.entries(profile.tags).sort((a, b) => b[1].count - a[1].count);
    for (const tag of rec.tags) {
      const at = ranked.findIndex(([t]) => t === tag);
      if (at < 0) continue;
      const [, info] = ranked[at];
      notes.push(`ความผิดพลาดแบบนี้ (${info.name}) เป็นจุดอ่อนอันดับ ${at + 1} ของคุณ ` +
        `เกิด ${info.count} ครั้งใน ${profile.games} เกมที่วิเคราะห์ไว้`);
      break;
    }
    if (threat && threat.stillThere && rec.label !== 'best') {
      notes.push('นิสัยที่ช่วยได้: ก่อนเดินทุกตา ให้ถามว่า "ตาที่แล้วอีกฝ่ายขู่อะไร" ก่อนคิดแผนของตัวเอง');
    }
  }

  return {
    depth: raw.depth,
    cands,
    played: { san: rec.san, win: playedWin, rank: rank >= 0 ? rank + 1 : null, evalText: formatEval(raw.played) },
    deepLabel,
    notes,
  };
}
