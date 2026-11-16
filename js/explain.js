// Rule-based explanations for why a move was bad.
//
// Every sentence produced here is backed by a concrete check on the board (a legal capture
// sequence or an engine-reported mate). When no rule matches, no reason is given: the UI then
// only reports which move the engine preferred. Nothing here guesses.

import { Chess } from '../vendor/chess.js/chess.js';

export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const PIECE_TH = { p: 'เบี้ย', n: 'ม้า', b: 'บิชอป', r: 'เรือ', q: 'ควีน', k: 'คิง' };

/** Mates longer than this are not reported: they are not something a beginner can act on. */
const MAX_MATE_DISTANCE = 3;

/**
 * Convert a UCI move such as "e7e8q" to SAN in a given position.
 * @param {string} fen Position the move is played from.
 * @param {string | null} uci
 * @returns {string | null} SAN, or null if the move is missing or illegal.
 */
export function uciToSan(fen, uci) {
  if (!uci) return null;
  try {
    const move = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

/**
 * Best material the side to move can win by starting a capture sequence on one square,
 * always capturing with its least valuable piece and stopping whenever continuing would lose.
 * Uses legal moves only, so pins and discovered attackers are handled.
 * @param {Chess} chess Position (restored before returning).
 * @param {string} square Target square.
 * @returns {number} Net gain in pawns, never negative (the side may simply not capture).
 */
function exchangeGain(chess, square) {
  // Try the attackers of the square from least to most valuable and play the first legal capture.
  // (Asking chess.js for full verbose move lists here was the slowest part of a review.)
  const attackers = chess.attackers(square)
    .map((from) => ({ from, type: chess.get(from).type }))
    .sort((a, b) => PIECE_VALUE[a.type] - PIECE_VALUE[b.type]);

  for (const attacker of attackers) {
    const promotes = attacker.type === 'p' && (square[1] === '8' || square[1] === '1');
    let move;
    try {
      move = chess.move({ from: attacker.from, to: square, promotion: promotes ? 'q' : undefined });
    } catch {
      continue; // illegal: the piece is pinned, or the king would step into check
    }
    if (!move.captured) { chess.undo(); continue; }
    const promo = move.promotion ? PIECE_VALUE[move.promotion] - 1 : 0;
    const gain = PIECE_VALUE[move.captured] + promo - exchangeGain(chess, square);
    chess.undo();
    return Math.max(0, gain);
  }
  return 0;
}

/**
 * Material outcome of playing one move, counting the exchange that follows on its target square.
 * @param {string} fen Position before the move.
 * @param {string | null} uci Move to play.
 * @returns {null | {san: string, piece: string, from: string, to: string, captured: string | undefined,
 *                   gain: number, free: boolean}} null if the move is missing or illegal.
 *   `gain` is the mover's net material; `free` means the opponent has no profitable recapture.
 */
export function evaluateCapture(fen, uci) {
  if (!uci) return null;
  try {
    const chess = new Chess(fen);
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    const taken = move.captured ? PIECE_VALUE[move.captured] : 0;
    const promo = move.promotion ? PIECE_VALUE[move.promotion] - 1 : 0;
    const lostBack = exchangeGain(chess, move.to);
    // En passant takes a pawn that is not on the destination square.
    const square = move.flags.includes('e') ? move.to[0] + move.from[1] : move.to;
    return {
      san: move.san, piece: move.piece, from: move.from, to: move.to, square, captured: move.captured,
      gain: taken + promo - lostBack, free: lostBack === 0,
    };
  } catch {
    return null;
  }
}

/**
 * Play a short sequence of UCI moves.
 * @param {string} fen Starting position.
 * @param {string[]} ucis Moves to play in order.
 * @returns {null | {fen: string, moves: object[]}} Final position and the moves made; null if any is illegal.
 */
function playLine(fen, ucis) {
  try {
    const chess = new Chess(fen);
    const moves = ucis.map((u) => chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }));
    return { fen: chess.fen(), moves };
  } catch {
    return null;
  }
}

/**
 * Material a single move takes off the board, ignoring what happens next.
 * @param {object} move chess.js move.
 * @returns {number}
 */
function takenBy(move) {
  return (move.captured ? PIECE_VALUE[move.captured] : 0) + (move.promotion ? PIECE_VALUE[move.promotion] - 1 : 0);
}

/**
 * Material balance along an engine line, for the side that makes the first move.
 * Walks `basePlies`, then keeps going while the last move was a capture, so the count never stops
 * in the middle of an exchange (up to `maxPlies`). This is what confirms a material claim: a piece
 * that looks free on its own square may be won back elsewhere a move later.
 * @param {string} fen Starting position.
 * @param {string[]} ucis Engine line.
 * @param {number} basePlies Plies always walked when available.
 * @param {number} maxPlies Hard upper bound.
 * @returns {null | {net: number, plies: number, moves: object[]}} null if fewer than 2 plies could be played.
 */
export function lineBalance(fen, ucis, basePlies = 8, maxPlies = 12) {
  const moves = [];
  try {
    const chess = new Chess(fen);
    for (let i = 0; i < Math.min(maxPlies, ucis.length); i++) {
      if (i >= basePlies && !moves[i - 1].captured) break;
      const u = ucis[i];
      moves.push(chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }));
    }
  } catch {
    /* an illegal move ends the walk; keep what was played */
  }
  if (moves.length < 2) return null;
  const net = moves.reduce((sum, m, i) => sum + (i % 2 === 0 ? 1 : -1) * takenBy(m), 0);
  return { net, plies: moves.length, moves };
}

/**
 * Check whether an engine line wins material with a capture on its third ply.
 * @param {string} fen Position the line starts from.
 * @param {string[]} ucis Engine line: attacker, defender, attacker, ...
 * @returns {null | {net: number, target: string}} null unless the third ply is a capture worth at
 *   least 2 on its square AND the line continues past it. `net` is the attacker's material balance
 *   over the walked line, so a counter-capture elsewhere lowers it; `target` is Thai text for the piece.
 */
function twoMoveTactic(fen, ucis) {
  if (ucis.length < 4) return null; // the line must continue past the capture to confirm it
  const lead = playLine(fen, ucis.slice(0, 2));
  const capture = lead ? evaluateCapture(lead.fen, ucis[2]) : null;
  if (!capture || !capture.captured || capture.gain < 2) return null;
  const balance = lineBalance(fen, ucis);
  if (!balance || balance.plies < 4) return null;
  // If the piece only arrives on that square during the line (e.g. it blocks a check there),
  // naming the square would point at an empty square on the board, so leave it out.
  const arrives = lead.moves[1].to === capture.square;
  const target = arrives ? PIECE_TH[capture.captured] : `${PIECE_TH[capture.captured]}ที่ ${capture.square}`;
  return { net: balance.net, target };
}

/**
 * Read a forced mate from one player's point of view.
 * @param {{mate?: number, winner?: 'w' | 'b'}} ev White-POV evaluation.
 * @param {'w' | 'b'} colour The player asking.
 * @returns {null | {forMe: boolean, n: number}} null when the evaluation is not a forced mate.
 */
function mateFor(ev, colour) {
  if (typeof ev.mate !== 'number') return null;
  if (ev.mate === 0) return { forMe: ev.winner === colour, n: 0 };
  return { forMe: (ev.mate > 0) === (colour === 'w'), n: Math.abs(ev.mate) };
}

/**
 * Uncapped score for one player, used only to confirm a position really got worse.
 * @param {{cp?: number, mate?: number, winner?: 'w' | 'b'}} ev White-POV evaluation.
 * @param {'w' | 'b'} colour
 * @returns {number} Centipawns; forced mates count as +/-10000.
 */
function rawScore(ev, colour) {
  const mate = mateFor(ev, colour);
  if (mate) return mate.forMe ? 10000 : -10000;
  return colour === 'w' ? ev.cp : -ev.cp;
}

/**
 * Same position with the other side to move, to ask "was this already possible before the move?".
 * @param {string} fen
 * @returns {string}
 */
function flipTurn(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return parts.join(' ');
}

/**
 * Explain one move.
 * @param {object} rec Move record from buildAnalysis (before tags are filled).
 * @returns {{tags: string[], notes: string[], targets: (string | null)[], replySan: string | null}}
 *   tags: machine-readable mistake categories, for cross-game statistics.
 *   notes: Thai sentences to show the player.
 */
export function explainMove(rec) {
  const tags = [];
  const targets = []; // parallel to tags: square of the piece concerned, or null
  const notes = [];
  const me = rec.color;
  const flagged = rec.label === 'inaccuracy' || rec.label === 'mistake' || rec.label === 'blunder';
  const before = mateFor(rec.evalBefore, me);
  const after = mateFor(rec.evalAfter, me);
  const replyUci = rec.replyLine[0] || null;
  const replySan = uciToSan(rec.fenAfter, replyUci);
  const them = me === 'w' ? 'ดำ' : 'ขาว'; // name the other side by colour: both players' moves get notes
  // Material this move itself won: a capture, a promotion, or both.
  const iGained = (rec.captured ? PIECE_VALUE[rec.captured] : 0)
    + (rec.promotion ? PIECE_VALUE[rec.promotion] - 1 : 0);
  const decided = rec.winBefore >= 90 || rec.winBefore <= 10;

  // Most moves need no explanation. No rule below can fire for the engine's own first choice,
  // and a "good" move in a live game can only matter if a forced mate is involved, so stop early
  // and skip the board work.
  const mateInvolved = Boolean(before || after);
  if (rec.label === 'best' || (rec.label === 'good' && !decided && !mateInvolved)) {
    return { tags, notes, targets, replySan };
  }

  // 1. Missed a forced mate that was available.
  if (before && before.forMe && before.n >= 1 && before.n <= MAX_MATE_DISTANCE
      && !(after && after.forMe) && rec.bestSan && rec.uci !== rec.bestUci) {
    tags.push('missed_mate');
    targets.push(null);
    notes.push(before.n === 1
      ? `มี mate ในตาเดียวด้วย ${rec.bestSan} แต่ไม่ได้เดิน`
      : `มี mate ใน ${before.n} ตา เริ่มด้วย ${rec.bestSan} แต่ไม่ได้เดิน`);
  }

  // 2. Allowed a forced mate that was not there before.
  if (after && !after.forMe && after.n >= 1 && after.n <= MAX_MATE_DISTANCE
      && !(before && !before.forMe) && replySan && rec.label !== 'best') {
    tags.push('allowed_mate');
    targets.push(null);
    notes.push(after.n === 1
      ? `ตานี้เปิดให้${them} mate ได้ในตาเดียวด้วย ${replySan}`
      : `ตานี้เปิดให้${them} mate ได้ใน ${after.n} ตา เริ่มด้วย ${replySan}`);
  }

  // 3. Left material to be taken: the engine's reply is a capture that wins material.
  if (!tags.includes('allowed_mate')) {
    const reply = evaluateCapture(rec.fenAfter, replyUci);
    // Two independent checks must agree: the exchange on that square wins material, and so does
    // the engine's own continuation. Either alone produced false claims on real games.
    // A capture that can be recaptured is a weaker claim, so it needs a bigger margin.
    const margin = reply && reply.free ? 1 : 2;
    const line = reply && reply.captured && reply.gain - iGained >= margin
      ? lineBalance(rec.fenAfter, rec.replyLine)
      : null;
    if (line && line.net - iGained >= margin) {
      const net = reply.gain - iGained;
      // Also catch pieces hung in already-decided games, where the win chance barely moves.
      const gotWorse = rawScore(rec.evalAfter, me) <= rawScore(rec.evalBefore, me) - 150;
      if ((flagged && net >= 1) || (rec.label !== 'best' && decided && net >= 3 && gotWorse)) {
        tags.push(PIECE_VALUE[reply.captured] >= 3 ? 'hung_piece' : 'hung_pawn');
        targets.push(reply.square);
        notes.push(hungSentence(rec, reply, replyUci));
      }
    }
  }

  // 4. Missed a capture that wins material.
  if (flagged && !tags.includes('missed_mate') && rec.bestUci && rec.bestUci !== rec.uci && rec.bestSan) {
    const best = evaluateCapture(rec.fenBefore, rec.bestUci);
    const played = evaluateCapture(rec.fenBefore, rec.uci);
    const playedGain = played && played.captured ? played.gain : 0;
    const line = lineBalance(rec.fenBefore, rec.bestLine);
    const margin = best && best.free ? 1 : 2;
    if (best && best.captured && best.gain >= margin && best.gain > playedGain && line && line.net >= margin) {
      tags.push('missed_capture');
      targets.push(best.square);
      const target = `${PIECE_TH[best.captured]}ที่ ${best.square}`;
      notes.push(best.free
        ? `กิน${target} ได้ฟรีด้วย ${rec.bestSan} แต่ไม่ได้กิน`
        : `ได้เปรียบหมากด้วย ${rec.bestSan} ซึ่งกิน${target} แต่ไม่ได้เดิน`);
    }
  }

  // 5. Allowed a two-move tactic: the engine's line wins material one move later
  //    (typically a check, fork, pin or skewer first, then the capture).
  //    The line is walked past the capture, so a counter-capture elsewhere cancels the claim.
  if (flagged && !tags.some((t) => t === 'allowed_mate' || t.startsWith('hung')) && replySan) {
    const tactic = twoMoveTactic(rec.fenAfter, rec.replyLine);
    if (tactic && tactic.net - iGained >= 2) {
      tags.push('allowed_tactic');
      targets.push(null);
      const lead = replySan.includes('+') ? `${them}รุกด้วย ${replySan}` : `${them}เดิน ${replySan}`;
      notes.push(`${lead} แล้วกิน${tactic.target} ได้ในตาถัดไป (ตามแนวที่ engine คำนวณ)`);
    }
  }

  // 6. Missed a two-move tactic of your own.
  if (flagged && !tags.some((t) => t === 'missed_mate' || t === 'missed_capture')
      && rec.bestUci !== rec.uci && rec.bestSan) {
    const tactic = twoMoveTactic(rec.fenBefore, rec.bestLine);
    if (tactic && tactic.net >= 2) {
      tags.push('missed_tactic');
      targets.push(null);
      notes.push(`ถ้าเดิน ${rec.bestSan} จะกิน${tactic.target} ได้ในตาถัดไป (ตามแนวที่ engine คำนวณ)`);
    }
  }

  return { tags, notes, targets, replySan };
}

/**
 * Sentence describing how material was left to be captured.
 * @param {object} rec Move record.
 * @param {object} reply Result of evaluateCapture() for the opponent's capture.
 * @param {string} replyUci The opponent's capture in UCI form.
 * @returns {string}
 */
function hungSentence(rec, reply, replyUci) {
  const lost = PIECE_TH[reply.captured];
  const attacker = `${PIECE_TH[reply.piece]}ที่ ${reply.from}`;

  if (reply.square === rec.to) {
    // The piece that just moved is the one being taken.
    if (rec.promotion) return `โปรโมตเบี้ยที่ ${rec.to} แต่ถูก${attacker} กินได้ทันที`;
    if (rec.captured) {
      return `ใช้${lost}กิน${PIECE_TH[rec.captured]}ที่ ${rec.to} แต่ถูก${attacker} กินกลับ ` +
        `จึงเสีย${lost}แลกกับ${PIECE_TH[rec.captured]}`;
    }
    return reply.free
      ? `เดิน${lost}ไปที่ ${rec.to} ซึ่งถูก${attacker} กินได้ฟรี`
      : `เดิน${lost}ไปที่ ${rec.to} ซึ่งถูก${attacker} กินได้ และแลกกลับแล้วยังเสียหมากมากกว่า`;
  }

  // A different piece is taken: was it already capturable before this move?
  let alreadyHanging = false;
  try {
    const earlier = evaluateCapture(flipTurn(rec.fenBefore), replyUci);
    alreadyHanging = Boolean(earlier && earlier.captured === reply.captured && earlier.gain >= 1);
  } catch {
    alreadyHanging = false;
  }
  const tail = reply.free ? 'กินได้ฟรี' : 'กินได้และได้เปรียบหมาก';
  return alreadyHanging
    ? `${lost}ที่ ${reply.square} ถูกโจมตีอยู่ก่อนแล้ว ตานี้ไม่ได้ย้ายหนีหรือคุ้มกัน ${attacker} จึง${tail}`
    : `หลังตานี้ ${lost}ที่ ${reply.square} ถูก${attacker} ${tail}`;
}
