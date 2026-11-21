# Vendored third-party files

Downloaded 2026-11-16 (board and maestro pieces 2026-11-19). Do not edit these files by hand.

| Folder | What | Version | Source | Licence |
|---|---|---|---|---|
| `stockfish/` | Stockfish chess engine, lite single-threaded WASM build | 19.0.1 | https://unpkg.com/stockfish@19.0.1/bin/ | GPL-3.0 (`stockfish/Copying.txt`) |
| `chess.js/` | Chess rules and PGN parsing | 1.4.0 | https://unpkg.com/chess.js@1.4.0/dist/esm/chess.js | BSD-2-Clause (`chess.js/LICENSE`) |
| `pieces/cburnett/` | Piece images by Colin M.L. Burnett | lila `master` | https://github.com/lichess-org/lila/tree/master/public/piece/cburnett | GPLv2+ (per lila `COPYING.md`) |
| `pieces/maestro/` | Piece images "maestro" by sadsnake1 (in use) | lila `master` | https://github.com/lichess-org/lila/tree/master/public/piece/maestro | CC BY-NC-SA 4.0 (per lila `COPYING.md`) |
| `board/wood4.jpg` | Wooden board image, by the lila authors | lila `master` | https://github.com/lichess-org/lila/blob/master/public/images/board/wood4.jpg | AGPLv3+ (per lila `COPYING.md`) |

`pieces/cburnett/` is the earlier piece set, kept but no longer used.

The computer page (`pc.html`) also uses `stockfish/stockfish-19.js` and `stockfish/stockfish-19.wasm`
(full network, multi-threaded, 99 MB, from https://unpkg.com/stockfish@19.0.1/bin/, downloaded 2026-11-21,
GPL-3.0). It needs cross-origin isolation, which `coi-sw.js` provides.
