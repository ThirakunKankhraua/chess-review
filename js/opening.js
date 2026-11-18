// Opening principles for beginners, checked move by move.
//
// These are general rules of thumb, not engine findings: the review screen shows them under a
// separate heading so they are never mistaken for the reason a move was bad. Each kind of tip
// appears at most once per player per game, on the first move that breaks the rule.

import { Chess } from '../vendor/chess.js/chess.js';
import { PIECE_TH } from './motifs.js';

const MINOR_HOME = {
  w: { b1: 'n', g1: 'n', c1: 'b', f1: 'b' },
  b: { b8: 'n', g8: 'n', c8: 'b', f8: 'b' },
};

/**
 * Knights and bishops still on their starting squares.
 * @param {Chess} chess
 * @param {'w' | 'b'} colour
 * @returns {number}
 */
function undevelopedMinors(chess, colour) {
  let count = 0;
  for (const [square, type] of Object.entries(MINOR_HOME[colour])) {
    const p = chess.get(square);
    if (p && p.color === colour && p.type === type) count += 1;
  }
  return count;
}

/**
 * Find opening-principle tips for both players.
 * @param {{moves: object[]}} game Parsed game; moves are chess.js verbose moves with `before` FEN.
 * @returns {Map<number, {kind: string, text: string}[]>} ply -> tips for that move.
 */
export function openingTips(game) {
  const tips = new Map();
  const given = { w: new Set(), b: new Set() };
  const moved = { w: new Set(), b: new Set() };   // current squares of pieces that have moved
  const flankPawnMoves = { w: 0, b: 0 };

  const add = (ply, colour, kind, text) => {
    if (given[colour].has(kind)) return;
    given[colour].add(kind);
    if (!tips.has(ply)) tips.set(ply, []);
    tips.get(ply).push({ kind, text });
  };

  game.moves.forEach((move, i) => {
    const ply = i + 1;
    const colour = move.color;
    const them = colour === 'w' ? 'b' : 'w';
    const n = Math.ceil(ply / 2); // full-move number (games here always start from move 1)
    if (n > 15) return;
    const before = new Chess(move.before);
    const capture = Boolean(move.captured);
    const castled = move.flags.includes('k') || move.flags.includes('q');
    const castleRights = move.before.split(' ')[2];
    const hadRights = colour === 'w' ? /[KQ]/.test(castleRights) : /[kq]/.test(castleRights);

    if (move.piece === 'q' && n <= 5 && !capture) {
      add(ply, colour, 'early_queen',
        `ออกควีนตั้งแต่ตาที่ ${n}: ช่วงต้นเกมควีนมักถูกม้าและบิชอปของอีกฝ่ายไล่ ทำให้เสียจังหวะ ` +
        'ควรออกม้าและบิชอปก่อน');
    }

    if (move.piece === 'k' && !castled && hadRights && !before.inCheck()) {
      add(ply, colour, 'king_walk',
        'เดินคิงเองโดยไม่ได้ castle ทำให้เสียสิทธิ์ castle ถาวร และคิงค้างอยู่กลางกระดานที่โดนโจมตีง่าย');
    }

    const minors = undevelopedMinors(before, colour);
    if (move.piece !== 'p' && move.piece !== 'k' && !capture && n <= 8 && moved[colour].has(move.from)
        && minors >= 2 && !before.isAttacked(move.from, them)) {
      add(ply, colour, 'repeat_piece',
        `เดิน${PIECE_TH[move.piece]}ตัวเดิมซ้ำ ทั้งที่ยังมีม้าหรือบิชอปที่ยังไม่ได้ออกอีก ${minors} ตัว ` +
        'ช่วงเปิดเกมควรออกหมากตัวใหม่ทีละตัว');
    }

    if (move.piece === 'p' && !capture && n <= 8 && move.from === (colour === 'w' ? 'f2' : 'f7')) {
      add(ply, colour, 'f_pawn',
        `เดินเบี้ย f ช่วงต้นเกมเปิดแนวทแยงเข้าหาคิง (${colour === 'w' ? 'e1-h4' : 'e8-h5'}) ` +
        'ทำให้เสี่ยงโดนรุกด้วยควีนหรือบิชอป');
    }

    if (move.piece === 'p' && !capture && n <= 6 && 'abgh'.includes(move.from[0])) {
      flankPawnMoves[colour] += 1;
      if (flankPawnMoves[colour] >= 2) {
        add(ply, colour, 'flank_pawns',
          'เดินเบี้ยริมกระดานหลายตาตั้งแต่ต้นเกม ควรใช้ตาเดินช่วงแรกคุมกลางกระดาน (เบี้ย e และ d) ' +
          'และออกม้ากับบิชอป');
      }
    }

    const homeKing = colour === 'w' ? 'e1' : 'e8';
    const king = before.get(homeKing);
    const queensOn = before.board().flat().some((c) => c && c.type === 'q' && c.color === them);
    if (n >= 12 && king && king.type === 'k' && king.color === colour && queensOn && !castled) {
      add(ply, colour, 'no_castle',
        `ผ่านมา ${n} ตาแล้วคิงยังอยู่ที่ ${homeKing} ควร castle เพื่อให้คิงปลอดภัยและให้เรือออกมาทำงาน`);
    }

    // Track which pieces have already moved, by their current square.
    moved[colour].delete(move.from);
    if (move.piece !== 'p') moved[colour].add(move.to);
    if (castled) moved[colour].add(move.flags.includes('k') ? (colour === 'w' ? 'f1' : 'f8') : (colour === 'w' ? 'd1' : 'd8'));
    if (capture) moved[them].delete(move.to);
  });

  return tips;
}

/**
 * Opening name from chess.com's PGN headers (ECOUrl), e.g. "Kings Pawn Opening Kings Knight".
 * @param {object} headers PGN headers.
 * @returns {string | null}
 */
export function openingName(headers) {
  const url = headers.ECOUrl || '';
  const slug = url.split('/openings/')[1];
  if (!slug) return headers.Opening || null;
  // The slug ends with the moves that reached it (e.g. "...-3.Nc3"); keep only the name part.
  return decodeURIComponent(slug).replace(/-\d+\..*$/, '').replace(/-/g, ' ');
}
