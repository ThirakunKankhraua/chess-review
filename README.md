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

## Running it locally

ES modules and Web Workers do not load from `file://`, so serve the folder over HTTP:

```bash
python -m http.server 4620
```

Then open `http://localhost:4620`.

## Method and limits

- Engine: Stockfish 19 Lite, single-threaded WASM, fixed depth 14 on desktop and 12 on touch devices.
- Win chance, move labels (5 / 10 / 15 percentage-point drops) and accuracy follow the formulas in
  the published Lichess source. chess.com does not publish its formulas, so accuracy here differs
  from chess.com's; on 5 reference games the mean absolute gap was about 11 points.
- Material claims use 1/3/3/5/9 piece values and must be confirmed twice: by the exchange on the
  square and by the engine's own continuation. Positional mistakes are not explained.
- Analyses are stored in the browser's IndexedDB. Each browser and device keeps its own copy.

## Third-party components

See [vendor/README.md](vendor/README.md). Stockfish is GPL-3.0 and chess.js is BSD-2-Clause.
The "maestro" pieces (by sadsnake1) are CC BY-NC-SA 4.0 and the wood board image (lila authors)
is AGPLv3+, both from the Lichess repository. This project is non-commercial.
