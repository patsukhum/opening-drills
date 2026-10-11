# Opening Drills

Offline trainer that turns a chess study into spaced-repetition drills.

- Paste a PGN (Lichess study export, ChessBase, any game with variations). Every variation becomes a line; you play your side, the app plays the other.
- New lines are taught with arrows; reviews are blind. Perfect lines move up a box (4 h → 1 d → 3 d → 7 d → 16 d → 35 d → 80 d → 180 d); a mistake drops the line back to box 1 and repeats it at the end of the session.
- Studies and progress live in localStorage; optional GitHub-gist sync keeps devices in step.
- `npm install && node build.mjs` bundles everything into `docs/index.html` (served by GitHub Pages; installable as an offline PWA).
