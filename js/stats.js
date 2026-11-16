// Cross-game statistics: which kinds of mistakes the player makes most often.
// Pure functions only; rendering lives in app.js.

/** Mistake categories in display order, with Thai names and one practical habit for each. */
export const CATEGORIES = [
  {
    tag: 'hung_piece',
    name: 'ทิ้งหมากให้กินฟรี',
    advice: 'ก่อนปล่อยมือทุกตา ถามตัวเองสองข้อ: ตัวที่เพิ่งเดินไปถูกกินได้ไหม และตัวที่มันเคยคุ้มกันอยู่ยังปลอดภัยไหม',
  },
  {
    tag: 'missed_capture',
    name: 'มองไม่เห็นว่ากินฟรีได้',
    advice: 'ทุกครั้งที่อีกฝ่ายเดินเสร็จ ให้กวาดตาดูก่อนว่าตานั้นทิ้งหมากตัวไหนไว้ให้กินฟรี',
  },
  {
    tag: 'allowed_mate',
    name: 'เปิดให้โดน mate',
    advice: 'ก่อนเดิน ให้ดูว่าอีกฝ่ายมีตารุกคิงของเราตาไหนบ้าง และคิงมีช่องหนีหรือไม่',
  },
  {
    tag: 'missed_mate',
    name: 'พลาด mate ที่มีอยู่',
    advice: 'เมื่อหมากของเราอยู่ใกล้คิงอีกฝ่าย ให้ไล่ดูตารุกทุกตาก่อนเสมอ และฝึกโจทย์ mate ใน 1 ทุกวัน',
  },
  {
    tag: 'allowed_tactic',
    name: 'โดน tactic สองตา',
    advice: 'ระวังตารุกและตาที่โจมตีหมากสองตัวพร้อมกัน ถ้าอีกฝ่ายรุกได้ ให้คิดต่อว่าหลังรุกแล้วเขากินอะไรได้',
  },
  {
    tag: 'missed_tactic',
    name: 'พลาด tactic สองตา',
    advice: 'มองหาตารุกของตัวเองก่อนเสมอ แล้วดูว่าหลังรุก หมากตัวไหนของอีกฝ่ายไม่มีตัวคุ้มกัน',
  },
  {
    tag: 'hung_pawn',
    name: 'ทิ้งเบี้ยให้กินฟรี',
    advice: 'เบี้ยหนึ่งตัวยังไม่ตัดสินเกมในระดับนี้ แก้เรื่องทิ้งหมากตัวใหญ่ก่อน',
  },
];

/** Game phases by move number. A deliberately simple definition, shown as such in the UI. */
export const PHASES = [
  { key: 'opening', name: 'ช่วงเปิดเกม (ตาที่ 1-10)', from: 1, to: 10 },
  { key: 'middle', name: 'ช่วงกลางเกม (ตาที่ 11-30)', from: 11, to: 30 },
  { key: 'end', name: 'ช่วงท้ายเกม (ตาที่ 31 ขึ้นไป)', from: 31, to: Infinity },
];

/**
 * Convert a PGN clock such as "0:09:55.6" to seconds.
 * @param {string} clk
 * @returns {number}
 */
function clockSeconds(clk) {
  const [h, m, s] = clk.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/**
 * Seconds the player spent on each of their own moves, from the clock readings in the PGN.
 * @param {object} game Parsed game (moves, clocks, headers).
 * @param {'w' | 'b'} colour The player.
 * @returns {Map<number, number>} ply -> seconds spent; empty if the game has no clock data.
 */
function timeSpentByPly(game, colour) {
  const spent = new Map();
  if (!game.clocks) return spent;
  const [base, inc] = String(game.headers.TimeControl || '').split('+').map(Number);
  if (!Number.isFinite(base)) return spent;
  let previous = base;
  game.moves.forEach((move, i) => {
    if (move.color !== colour) return;
    const now = clockSeconds(game.clocks[i]);
    spent.set(i + 1, Math.max(0, previous - now + (Number.isFinite(inc) ? inc : 0)));
    previous = now;
  });
  return spent;
}

/**
 * Median of a list.
 * @param {number[]} xs
 * @returns {number | null} null for an empty list.
 */
function median(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Aggregate the player's own moves across analysed games.
 * @param {{game: object, analysis: object, colour: 'w' | 'b'}[]} entries One per analysed game the player took part in.
 * @returns {object} Totals, per-category counts with examples, per-phase counts and move-time comparison.
 */
export function computeStats(entries) {
  const stats = {
    games: entries.length,
    results: { win: 0, loss: 0, draw: 0 },
    moves: 0,
    accuracy: [],                 // one value per game
    labels: { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
    // count = tagged moves; incidents = the same, with a piece left hanging over several
    // consecutive moves counted once.
    categories: new Map(CATEGORIES.map((c) => [c.tag, { count: 0, incidents: 0, games: new Set(), examples: [] }])),
    // serious = Mistake/Blunder labels plus the '#' and 'x' marks; decided = moves played when the
    // game was already all but won or lost, where labels go quiet.
    phases: new Map(PHASES.map((p) => [p.key, { moves: 0, serious: 0, decided: 0 }])),
    blunderSeconds: [],           // time spent on moves labelled mistake/blunder
    otherSeconds: [],             // time spent on all other moves
  };

  for (const { game, analysis, colour } of entries) {
    const result = game.headers.Result;
    if (result === '1/2-1/2') stats.results.draw += 1;
    else if ((result === '1-0') === (colour === 'w')) stats.results.win += 1;
    else stats.results.loss += 1;

    const acc = analysis.accuracy[colour];
    if (acc !== null && acc !== undefined) stats.accuracy.push(acc);
    const spent = timeSpentByPly(game, colour);
    const opponent = colour === 'w' ? game.headers.Black : game.headers.White;

    // Square last flagged per mistake family in this game, to recognise the same piece being
    // left hanging (or the same capture being missed) move after move.
    const lastSquare = new Map();

    for (const rec of analysis.records) {
      if (rec.color !== colour) continue;
      stats.moves += 1;
      stats.labels[rec.label] += 1;
      const labelled = rec.label === 'mistake' || rec.label === 'blunder';
      // Same rule as the review screen's "next mistake" button.
      const serious = labelled
        || rec.tags.some((t) => t === 'missed_mate' || t === 'allowed_mate' || t === 'hung_piece');

      const moveNumber = Math.ceil(rec.ply / 2);
      const phase = PHASES.find((p) => moveNumber >= p.from && moveNumber <= p.to);
      const bucket = stats.phases.get(phase.key);
      bucket.moves += 1;
      if (serious) bucket.serious += 1;
      if (rec.winBefore >= 90 || rec.winBefore <= 10) bucket.decided += 1;

      if (spent.has(rec.ply)) (labelled ? stats.blunderSeconds : stats.otherSeconds).push(spent.get(rec.ply));

      const familiesNow = new Set();
      rec.tags.forEach((tag, t) => {
        const cat = stats.categories.get(tag);
        if (!cat) return;
        cat.count += 1;
        const family = tag.startsWith('hung') ? 'hung' : tag;
        const square = rec.targets ? rec.targets[t] : null;
        familiesNow.add(family);
        if (square === null || lastSquare.get(family) !== square) cat.incidents += 1;
        if (square !== null) lastSquare.set(family, square);
        cat.games.add(game.id);
        cat.examples.push({
          gameId: game.id, ply: rec.ply, moveNumber, san: rec.san, note: rec.notes[t] || '',
          opponent: opponent || '', date: game.headers.Date || '', drop: rec.drop,
        });
      });
      // A move without the tag ends the run: the piece was saved, traded or taken.
      for (const family of [...lastSquare.keys()]) {
        if (!familiesNow.has(family)) lastSquare.delete(family);
      }
    }
  }

  stats.meanAccuracy = stats.accuracy.length
    ? stats.accuracy.reduce((a, b) => a + b, 0) / stats.accuracy.length
    : null;
  stats.medianBlunderSeconds = median(stats.blunderSeconds);
  stats.medianOtherSeconds = median(stats.otherSeconds);
  // Most costly examples first, so the list opens on the clearest cases.
  for (const cat of stats.categories.values()) cat.examples.sort((a, b) => b.drop - a.drop);
  return stats;
}
