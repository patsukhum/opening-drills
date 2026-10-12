import { build } from 'esbuild';
import fs from 'node:fs';
const cg = 'node_modules/@lichess-org/chessground/assets/';
const css = ['chessground.base.css', 'chessground.brown.css', 'chessground.cburnett.css']
  .map((f) => fs.readFileSync(cg + f, 'utf8')).join('\n');
const bundle = async (entry) =>
  (await build({ entryPoints: [entry], bundle: true, minify: true, format: 'iife', write: false, target: 'es2019' })).outputFiles[0].text;
const js = await bundle('src/main.js');
let html = fs.readFileSync('src/index.html', 'utf8');
html = html.replace('/*CG_CSS*/', () => css).replace('/*APP_JS*/', () => js.replace(/<\/script/gi, '<\\/script'));
fs.mkdirSync('docs/engine', { recursive: true });
fs.writeFileSync('docs/index.html', html);
// engines load on demand: Maia (human-like moves) and Stockfish (blunder checks)
fs.writeFileSync('docs/maia-worker.js', await bundle('src/maia/worker.js'));
fs.copyFileSync('src/maia/maia-1900.bin', 'docs/maia-1900.bin');
for (const f of ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm', 'STOCKFISH-COPYING.txt']) fs.copyFileSync('src/engine/' + f, 'docs/engine/' + f);
for (const f of ['sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png']) if (fs.existsSync('src/' + f)) fs.copyFileSync('src/' + f, 'docs/' + f);
console.log('docs/index.html', (html.length / 1024).toFixed(0) + ' KB');
