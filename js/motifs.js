// Names for common tactics (fork, pin, skewer, discovered attack, back-rank mate).
//
// Each detector checks a concrete fact on the board after one move: which pieces the moved piece
// attacks, or what stands on a straight line from it. A name is only returned when that fact is
// true, and callers only use it when the engine's line also wins material or mates, so the name
// describes something that actually happens rather than a guess.

import { Chess } from '../vendor/chess.js/chess.js';

export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const PIECE_TH = { p: 'เบี้ย', n: 'ม้า', b: 'บิชอป', r: 'เรือ', q: 'ควีน', k: 'คิง' };

const FILES = 'abcdefgh';
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Directions a sliding piece moves in.
 * @param {string} type Piece type letter.
 * @returns {number[][]} [fileStep, rankStep] pairs; empty for non-sliders.
 */
function slideDirs(type) {
  if (type === 'r') return ROOK_DIRS;
  if (type === 'b') return BISHOP_DIRS;
  if (type === 'q') return [...ROOK_DIRS, ...BISHOP_DIRS];
  return [];
}

/**
 * Pieces met along one ray from a square, nearest first.
 * @param {Chess} chess
 * @param {string} from Starting square (not included).
 * @param {number[]} dir [fileStep, rankStep]
 * @returns {{square: string, color: string, type: string}[]}
 */
function piecesOnRay(chess, from, [df, dr]) {
  const found = [];
  let f = FILES.indexOf(from[0]) + df;
  let r = Number(from[1]) + dr;
  while (f >= 0 && f < 8 && r >= 1 && r <= 8) {
    const square = FILES[f] + r;
    const piece = chess.get(square);
    if (piece) found.push({ square, ...piece });
    f += df;
    r += dr;
  }
  return found;
}

/**
 * Thai name of a piece with its square, e.g. "ม้าที่ c7".
 * @param {string} type
 * @param {string} square
 * @returns {string}
 */
function named(type, square) {
  return type === 'k' ? 'คิง' : `${PIECE_TH[type]}ที่ ${square}`;
}

/**
 * Join Thai names with "และ".
 * @param {string[]} parts
 * @returns {string}
 */
function joinTh(parts) {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(' ')} และ${parts.at(-1)}`;
}

/**
 * Name the tactic that a move sets up, if any.
 * @param {string} fen Position before the move.
 * @param {string | null} uci The move.
 * @param {string} target Square of the piece the engine line goes on to win. The tactic must be
 *   aimed at that piece; a fork or pin of some other piece would describe the wrong thing.
 * @returns {null | {kind: 'fork' | 'pin' | 'skewer' | 'discovered', text: string}}
 *   `text` is a Thai sentence that starts with the English name of the tactic.
 */
export function detectMotif(fen, uci, target) {
  if (!uci) return null;
  let chess;
  let move;
  const before = new Chess(fen);
  try {
    chess = new Chess(fen);
    move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return null;
  }
  const us = move.color;
  const them = us === 'w' ? 'b' : 'w';
  const moverType = move.promotion || move.piece;
  const moverValue = PIECE_VALUE[moverType];

  // Every enemy piece, for the attack checks below.
  const enemies = [];
  for (const row of chess.board()) {
    for (const cell of row) if (cell && cell.color === them) enemies.push(cell);
  }

  // Fork: the moved piece attacks two worthwhile targets at once. A target is worthwhile if it is
  // the king, is worth more than the attacker, or has no defender.
  const forked = enemies.filter((e) => {
    if (!chess.attackers(e.square, us).includes(move.to)) return false;
    if (e.type === 'k') return true;
    if (e.type === 'p') return false;
    return PIECE_VALUE[e.type] > moverValue || chess.attackers(e.square, them).length === 0;
  });
  if (forked.length >= 2 && forked.some((e) => e.square === target)) {
    const list = forked.sort((a, b) => PIECE_VALUE[b.type] - PIECE_VALUE[a.type]).map((e) => named(e.type, e.square));
    return {
      kind: 'fork',
      text: `fork: ${named(moverType, move.to)} โจมตี${joinTh(list)} พร้อมกัน อีกฝ่ายหนีได้แค่ตัวเดียว`,
    };
  }

  // Pin and skewer: look along each line the moved piece controls.
  for (const dir of slideDirs(moverType)) {
    const [first, second] = piecesOnRay(chess, move.to, dir);
    if (!first || !second || first.color !== them || second.color !== them) continue;
    if (second.type === 'k' && first.type !== 'p' && first.square === target) {
      // Absolute pin: moving the front piece off this line would expose the king, which is illegal.
      return {
        kind: 'pin',
        text: `pin: ${named(moverType, move.to)} ตรึง${named(first.type, first.square)} ไว้กับคิง ` +
          `${PIECE_TH[first.type]}ตัวนั้นจึงออกจากแนวนี้ไม่ได้`,
      };
    }
    const frontValue = PIECE_VALUE[first.type];
    if ((first.type === 'k' || frontValue >= 9) && second.type !== 'p' && PIECE_VALUE[second.type] < frontValue
        && second.square === target) {
      return {
        kind: 'skewer',
        text: `skewer: ${named(moverType, move.to)} โจมตี${named(first.type, first.square)} ซึ่งต้องหลบ ` +
          `แล้ว${named(second.type, second.square)} ที่อยู่ด้านหลังจะถูกกิน`,
      };
    }
  }

  // Discovered attack: moving this piece opens a line for another piece of ours. Either the
  // opened line hits the target itself, or it gives check while the moved piece hits the target.
  const moverHitsTarget = chess.attackers(target, us).includes(move.to);
  for (const e of enemies) {
    if (e.square !== target && !(e.type === 'k' && moverHitsTarget)) continue;
    const was = new Set(before.attackers(e.square, us));
    for (const sq of chess.attackers(e.square, us)) {
      if (sq === move.to || was.has(sq)) continue;
      const opener = chess.get(sq);
      if (!slideDirs(opener.type).length) continue;
      const what = e.type === 'k'
        ? `รุกคิง (discovered check) ขณะที่${PIECE_TH[move.piece]}ตัวที่เดินโจมตี${named(chess.get(target).type, target)} อยู่`
        : `โจมตี${named(e.type, e.square)}`;
      return {
        kind: 'discovered',
        text: `discovered attack: พอ${PIECE_TH[move.piece]}หลีกทาง ${named(opener.type, sq)} ก็${what} ทันที`,
      };
    }
  }
  return null;
}

/**
 * Describe a forced mate when it is a back-rank mate.
 * @param {string} fen Position the mating line starts from.
 * @param {string[]} ucis The mating line.
 * @returns {null | string} Thai sentence, or null when the line is not a back-rank mate.
 */
export function backRankMate(fen, ucis) {
  try {
    const chess = new Chess(fen);
    let last = null;
    for (const u of ucis) {
      last = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (chess.isCheckmate()) break;
    }
    if (!last || !chess.isCheckmate()) return null;
    const loser = chess.turn();
    const backRank = loser === 'w' ? '1' : '8';
    const king = chess.board().flat().find((c) => c && c.type === 'k' && c.color === loser);
    const mater = last.promotion || last.piece;
    if (!king || king.square[1] !== backRank || last.to[1] !== backRank || !'rq'.includes(mater)) return null;
    return `back-rank mate: คิงติดอยู่แถวหลังสุด หนีขึ้นมาไม่ได้เพราะหมากของตัวเองบังอยู่ แล้วโดน${PIECE_TH[mater]}รุกตามแถว`;
  } catch {
    return null;
  }
}
