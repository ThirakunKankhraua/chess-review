# Chess Review

A personal game-review tool for chess.com games, built for a beginner working towards 1000 Elo.
It runs entirely in the browser: no server, no account, no upload of your games.

## What it does

- Loads your games from the public chess.com API by username, or from pasted PGN.
- Analyses every position with Stockfish (WebAssembly) and labels each move
  Best / Good / Inaccuracy / Mistake / Blunder by how much win chance it gave away.
- Explains mistakes in Thai with rule-based checks: hung pieces, missed free captures,
  missed and allowed mates, and two-move tactics. When no rule applies it says so instead of guessing.
- Shows an eval bar, an eval graph, per-game accuracy, and the engine's better move on the board.
- Aggregates mistake categories across games to show which habit to fix first.
- Practice mode turns your own Mistakes and Blunders into puzzles: click a move, and a fresh engine
  check accepts it if it loses less than 5 points of win chance. Wrong tries are explained.
- Optional rings show pieces that can be won right now (red: yours, green: the opponent's).

## Two pages, two engines

| Page | Engine | Used for |
|---|---|---|
| `index.html` | Stockfish 19 Lite, single thread (1.8 MB) | phones, and any browser |
| `pc.html` | Stockfish 19 full network, multi-threaded (99 MB) | computers |

Both pages are the same app. `pc.html` is generated from `index.html` by
`python tools/make_pc_page.py`; run it after changing `index.html`. Multi-threading needs a
cross-origin isolated page, which GitHub Pages cannot provide with headers, so `coi-sw.js` (a small
service worker) adds them for `pc.html` and the engine files only. If isolation fails, `pc.html` falls
back to the Lite engine and says so.

Measured 2026-11-21 on one 132-ply game (8-core PC): against a reference of the full engine at depth 18,
the Lite engine at depth 14 disagreed on 10 Mistake/Blunder labels; the full engine at depth 14
(0.3 s cap per position) disagreed on 1, taking 13 s instead of 7 s. Multi-threaded search is not
repeatable: two runs of the full-engine setting on that same game differed on 5 Mistake/Blunder labels
(the Lite engine gives identical results every run). One game only, so treat these as signs, not a benchmark.

Each move also has an "analyse this move in depth" button: three candidate moves at a deeper search,
what each one does on the board, what the opponent was threatening before the move, and a link to the
player's own weakness counts from the statistics page.

## Running it locally

ES modules and Web Workers do not load from `file://`, so serve the folder over HTTP:

```bash
python -m http.server 4620
```

Then open `http://localhost:4620`.

## Method and limits

- Engine: Stockfish 19 Lite, single-threaded WASM, fixed depth 14 on desktop and 12 on touch devices.
- Win chance and accuracy follow the formulas in
  the published Lichess source. chess.com does not publish its formulas, so accuracy here differs
  from chess.com's; on 5 reference games the mean absolute gap was about 11 points.
- Move labels use the expected-points bands chess.com publishes (support article 8572705, dated
  2026-02-09): Excellent under 2, Inaccuracy 5, Mistake 10, Blunder 20 percentage points of win chance
  lost. Miss marks a move that failed to punish the opponent's mistake. Brilliant and Great are not used.
- Tactic names (fork, pin, skewer, discovered attack, back-rank mate) are given only when the board
  shows that pattern aimed at the piece the engine line then wins. Opening tips are general rules of thumb.
- Material claims use 1/3/3/5/9 piece values and must be confirmed twice: by the exchange on the
  square and by the engine's own continuation. Positional mistakes are not explained.
- Analyses are stored in the browser's IndexedDB. Each browser and device keeps its own copy.

## Third-party components

See [vendor/README.md](vendor/README.md). Stockfish is GPL-3.0 and chess.js is BSD-2-Clause.
The "maestro" pieces (by sadsnake1) are CC BY-NC-SA 4.0 and the wood board image (lila authors)
is AGPLv3+, both from the Lichess repository. This project is non-commercial.
