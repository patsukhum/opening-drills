// Maia 1900 (human-like moves) and Stockfish (blunder checks), each in its own worker,
// started on first use so the library screen stays light.

let maia = null;
let maiaSeq = 0;
const maiaWaiting = new Map();

function maiaWorker() {
  if (!maia) {
    maia = new Worker('maia-worker.js');
    maia.onmessage = (e) => {
      const p = maiaWaiting.get(e.data.id);
      maiaWaiting.delete(e.data.id);
      if (p) e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.moves);
    };
  }
  return maia;
}

// fens: every position from the start of the game to now. Resolves to [{ uci, san, p }], best first.
export function maiaMoves(fens) {
  return new Promise((resolve, reject) => {
    const id = ++maiaSeq;
    maiaWaiting.set(id, { resolve, reject });
    maiaWorker().postMessage({ id, fens });
  });
}

// Pick like a 1900 player: usually the favourite, sometimes another move people often play.
export function pickHuman(moves, minP = 0.05) {
  const pool = moves.filter((m) => m.p >= minP);
  if (!pool.length) return moves[0];
  let r = Math.random() * pool.reduce((s, m) => s + m.p, 0);
  for (const m of pool) if ((r -= m.p) <= 0) return m;
  return pool[0];
}

// ---------- Stockfish ----------
let sf = null;
let sfReady = null;
let sfQueue = Promise.resolve();
let onLine = null;

function stockfish() {
  if (!sf) {
    sf = new Worker('engine/stockfish-18-lite-single.js');
    sf.onmessage = (e) => onLine && onLine(String(e.data));
    sfReady = send('uci', (l) => l === 'uciok')
      .then(() => sf.postMessage('setoption name Hash value 16'))
      .then(() => send('isready', (l) => l === 'readyok'));
  }
  return sfReady;
}
function send(cmd, done, collect) {
  return new Promise((resolve) => {
    onLine = (l) => {
      if (collect) collect(l);
      if (done(l)) {
        onLine = null;
        resolve(l);
      }
    };
    sf.postMessage(cmd);
  });
}

// Score for the side to move: { cp } or { mate }, plus Stockfish's best move.
export function analyse(fen, ms = 1000) {
  const job = sfQueue.then(async () => {
    await stockfish();
    sf.postMessage('position fen ' + fen);
    let score = { cp: 0 };
    const last = await send(`go depth 18 movetime ${ms}`, (l) => l.startsWith('bestmove'), (l) => {
      const m = l.match(/ score (cp|mate) (-?\d+)/);
      if (m && !l.includes('lowerbound') && !l.includes('upperbound')) score = m[1] === 'cp' ? { cp: +m[2] } : { mate: +m[2] };
    });
    const best = last.split(' ')[1];
    return { ...score, best: best && best !== '(none)' ? best : null };
  });
  sfQueue = job.catch(() => {});
  return job;
}

// Lichess's winning-chances curve, -1 (lost) … 1 (won), for the side to move.
export function chances(s) {
  if (s.mate !== undefined) return s.mate > 0 ? 1 : -1; // mate 0 = already mated
  return 2 / (1 + Math.exp(-0.00368208 * s.cp)) - 1;
}

// How much a move threw away, judged like lichess: ≥0.3 blunder, ≥0.2 mistake, ≥0.1 inaccuracy.
export async function judge(before, fenAfter) {
  const b = await before;
  const a = await analyse(fenAfter);
  const loss = chances(b) - -chances(a);
  const label = loss >= 0.3 ? 'blunder' : loss >= 0.2 ? 'mistake' : loss >= 0.1 ? 'inaccuracy' : 'good';
  return { loss, label, best: b.best, after: a };
}

export function scoreText(s, flip = false) {
  if (s.mate !== undefined) return s.mate === 0 ? 'mate' : `mate in ${Math.abs(s.mate)}${(s.mate > 0) !== flip ? '' : ' (against)'}`;
  const v = (flip ? -s.cp : s.cp) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}
