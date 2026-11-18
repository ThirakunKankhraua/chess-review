// Turning engine evaluations into win chances, move labels and accuracy.
//
// Formulas follow the published Lichess source (read 2026-11-16):
//   win chance   - lichess-org/scalachess, core/src/main/scala/eval.scala
//   accuracy     - lichess-org/lila, modules/analyse/src/main/AccuracyPercent.scala
//   move labels  - lichess-org/lila, modules/tree/src/main/Advice.scala
//   mean helpers - lichess-org/scalalib, lila/src/main/scala/Maths.scala
// chess.com does not publish its formulas, so numbers here will not match chess.com exactly.

import { explainMove, uciToSan } from './explain.js';
import { openingTips } from './opening.js';

/** Evaluations beyond +/-10 pawns, and all forced mates, count as this many centipawns. */
export const CP_CEILING = 1000;

/**
 * Drop in the mover's win chance (percentage points) at which each label starts.
 * Bands follow chess.com's published expected-points table (support.chess.com article 8572705,
 * dated 2026-02-09): Excellent up to 0.02, Good 0.02-0.05, Inaccuracy 0.05-0.10, Mistake 0.10-0.20,
 * Blunder 0.20 and over. Approximation: chess.com's curve depends on rating; this one is Lichess's.
 */
export const LABEL_THRESHOLDS = { excellent: 2, inaccuracy: 5, mistake: 10, blunder: 20 };

export const LABELS = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];

/**
 * Collapse an evaluation to capped centipawns from White's point of view.
 * @param {{cp?: number, mate?: number, winner?: 'w' | 'b'}} ev White-POV evaluation.
 * @returns {number} Value in [-CP_CEILING, CP_CEILING].
 */
export function evalToCp(ev) {
  if (typeof ev.mate === 'number') {
    const whiteWins = ev.mate > 0 || (ev.mate === 0 && ev.winner === 'w');
    return whiteWins ? CP_CEILING : -CP_CEILING;
  }
  return Math.max(-CP_CEILING, Math.min(CP_CEILING, ev.cp));
}

/**
 * White's chance of winning, in percent, for a centipawn evaluation.
 * @param {number} cp Capped centipawns, White's point of view.
 * @returns {number} Value in [0, 100].
 */
export function winPercent(cp) {
  const chances = 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
  return 50 + 50 * Math.max(-1, Math.min(1, chances));
}

/**
 * Accuracy of a single move from the mover's win chance before and after it.
 * @param {number} before Mover's win percent before the move.
 * @param {number} after Mover's win percent after the move.
 * @returns {number} Value in [0, 100].
 */
export function moveAccuracy(before, after) {
  if (after >= before) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (before - after)) - 3.166924740191411;
  return Math.max(0, Math.min(100, raw + 1));
}

/**
 * Label a move by how much win chance it gave away.
 * @param {number} drop Win-percent points lost by the mover (>= 0).
 * @param {boolean} isBest True when the move is the engine's first choice.
 * @returns {string} One of LABELS.
 */
export function classify(drop, isBest) {
  if (isBest) return 'best';
  if (drop >= LABEL_THRESHOLDS.blunder) return 'blunder';
  if (drop >= LABEL_THRESHOLDS.mistake) return 'mistake';
  if (drop >= LABEL_THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (drop >= LABEL_THRESHOLDS.excellent) return 'good';
  return 'excellent';
}

/**
 * Population standard deviation, matching lichess-org/scalalib Maths.standardDeviation.
 * @param {number[]} xs
 * @returns {number}
 */
function standardDeviation(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
}

/**
 * Whole-game accuracy per colour: the mean of a volatility-weighted mean and a harmonic mean
 * of the per-move accuracies, as Lichess computes it.
 * @param {number[]} whiteWin White's win percent for every position (moves + 1 entries).
 * @param {'w' | 'b'} firstToMove Side that made the first move.
 * @returns {{w: number | null, b: number | null}}
 */
export function gameAccuracy(whiteWin, firstToMove) {
  const n = whiteWin.length;
  if (n < 2) return { w: null, b: null };
  const windowSize = Math.max(2, Math.min(8, Math.floor((n - 1) / 10)));

  const windows = [];
  for (let k = 0; k < Math.min(windowSize, n) - 2; k++) windows.push(whiteWin.slice(0, windowSize));
  for (let s = 0; s + windowSize <= n; s++) windows.push(whiteWin.slice(s, s + windowSize));
  const weights = windows.map((w) => Math.max(0.5, Math.min(12, standardDeviation(w))));

  const perColour = { w: [], b: [] };
  for (let i = 0; i < n - 1; i++) {
    const colour = (i % 2 === 0) === (firstToMove === 'w') ? 'w' : 'b';
    const before = colour === 'w' ? whiteWin[i] : 100 - whiteWin[i];
    const after = colour === 'w' ? whiteWin[i + 1] : 100 - whiteWin[i + 1];
    perColour[colour].push({ acc: moveAccuracy(before, after), weight: weights[i] });
  }

  const combine = (items) => {
    if (items.length === 0) return null;
    const weightSum = items.reduce((a, x) => a + x.weight, 0);
    const weighted = items.reduce((a, x) => a + x.acc * x.weight, 0) / weightSum;
    // Lichess floors each accuracy at 1 here so one zero-accuracy move cannot zero the mean.
    const harmonic = items.length / items.reduce((a, x) => a + 1 / Math.max(1, x.acc), 0);
    return (weighted + harmonic) / 2;
  };
  return { w: combine(perColour.w), b: combine(perColour.b) };
}

/**
 * Build the per-move review records and game summary from raw position evaluations.
 * @param {object} game Parsed game (moves, positions, firstToMove, clocks).
 * @param {object[]} evals One White-POV evaluation per position: {cp | mate, winner?, best, pv}.
 * @returns {{evals: object[], whiteWin: number[], records: object[], accuracy: object, counts: object}}
 */
export function buildAnalysis(game, evals) {
  const whiteWin = evals.map((ev) => winPercent(evalToCp(ev)));
  const counts = { w: {}, b: {} };
  for (const label of LABELS) { counts.w[label] = 0; counts.b[label] = 0; }

  const records = game.moves.map((move, i) => {
    const white = move.color === 'w';
    const winBefore = white ? whiteWin[i] : 100 - whiteWin[i];
    const winAfter = white ? whiteWin[i + 1] : 100 - whiteWin[i + 1];
    const drop = Math.max(0, winBefore - winAfter);
    const uci = move.from + move.to + (move.promotion || '');
    const bestUci = evals[i].best || null;
    const label = classify(drop, bestUci !== null && uci === bestUci);
    counts[move.color][label] += 1;

    const rec = {
      ply: i + 1,
      color: move.color,
      san: move.san,
      uci,
      piece: move.piece,
      captured: move.captured || null,
      promotion: move.promotion || null,
      from: move.from,
      to: move.to,
      fenBefore: game.positions[i],
      fenAfter: game.positions[i + 1],
      evalBefore: evals[i],
      evalAfter: evals[i + 1],
      winBefore,
      winAfter,
      drop,
      label,
      accuracy: moveAccuracy(winBefore, winAfter),
      bestUci,
      bestSan: uciToSan(game.positions[i], bestUci),
      bestLine: evals[i].pv || [],        // engine's preferred line from the position before the move
      replyLine: evals[i + 1].pv || [],   // engine's best continuation after the move actually played
      clock: game.clocks ? game.clocks[i] : null,
    };
    // tags: mistake categories for statistics; notes: Thai sentences shown to the player.
    return Object.assign(rec, explainMove(rec));
  });

  // Miss: the opponent's previous move was a mistake or blunder, and this move gave most of that
  // chance back, leaving the position roughly level or worse (chess.com's description of Miss).
  // Kept apart from `label`, which stays purely a measure of win chance lost.
  records.forEach((rec, i) => {
    const prev = records[i - 1];
    rec.miss = Boolean(prev && (prev.label === 'mistake' || prev.label === 'blunder')
      && rec.drop >= LABEL_THRESHOLDS.mistake && rec.winAfter <= 60);
  });
  const tips = openingTips(game);
  for (const rec of records) rec.tips = tips.get(rec.ply) || [];

  return { evals, whiteWin, records, accuracy: gameAccuracy(whiteWin, game.firstToMove), counts };
}

/**
 * Human-readable evaluation, White's point of view.
 * @param {{cp?: number, mate?: number, winner?: 'w' | 'b'}} ev
 * @returns {string} e.g. "+1.3", "-0.4", "+M3", "-M2", "1-0".
 */
export function formatEval(ev) {
  if (typeof ev.mate === 'number') {
    if (ev.mate === 0) return ev.winner === 'w' ? '1-0' : '0-1';
    return (ev.mate > 0 ? '+M' : '-M') + Math.abs(ev.mate);
  }
  const pawns = ev.cp / 100;
  return (pawns > 0 ? '+' : '') + pawns.toFixed(1);
}
