# Opening Drills

Offline trainer that turns a chess study into spaced-repetition drills.

- Paste a PGN (Lichess study export, ChessBase, any game with variations). Every variation becomes a line; you play your side, the app plays the other. `[Orientation "black"]` sets your side.
- New lines are taught with arrows (after a 2-second pause to think); reviews are blind. Perfect lines move up a box (4 h → 1 d → 3 d → 7 d → 16 d → 35 d → 80 d → 180 d); a mistake drops the line back to box 1 and repeats it at the end of the session.
- **Random lines:** the opponent picks random branches from your study. In a set share of rounds (10% by default) Maia 1900 plays a move the study doesn't cover; any reply Stockfish doesn't rate as a blunder passes.
- **Play on vs Maia 1900** from the end of any line, with take-back and a Stockfish evaluation.
- After a line, step back through it to read each move's study notes. Timestamps like `5:00` link to that moment in the chapter's YouTube video (`[Site "https://www.youtube.com/watch?v=…"]`).
- Studies and progress live in localStorage; a 5-letter sync code keeps devices in step (see Sync).
- `npm install && node build.mjs` bundles everything into `docs/` (served by GitHub Pages; installable as an offline PWA).

## Engines

Both run on-device in web workers and are cached for offline use.

- **Maia 1900** ([CSSLab/maia-chess](https://github.com/CSSLab/maia-chess), GPL-3.0) — the policy head runs in plain JS (`src/maia/net.js`), checked against lc0 to within 0.1% on test positions. `tools/convert_maia.py` turns `maia-1900.pb.gz` plus lc0's `policy_map.h` and lczero-training's `policy_index.py` into `src/maia/maia-1900.bin` and `src/maia/tables.js` (lc0 tables, GPL-3.0).
- **Stockfish 18 lite, single-threaded** ([nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js), GPL-3.0) in `src/engine/`.

## Sync

Devices sync through a 5-letter code. State lives in one row of a Supabase table (`supabase/sync.sql`, run once in the project's SQL editor); the app only reaches it through `drill_get` / `drill_put`, so codes can't be listed. Each device stores its code after the first connect.
