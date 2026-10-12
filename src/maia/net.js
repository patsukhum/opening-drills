// Maia (lc0 SE-resnet, classical 112-plane input) policy head in plain JS.
// Weights come from tools/convert_maia.py: float16, batch norm already folded in.
import { Chess } from 'chess.js';
import { SHAPE, MOVES, CONV_MAP } from './tables.js';

const POLICY_USED = 73; // lc0 kPolicyUsedPlanes
const PIECES = ['p', 'n', 'b', 'r', 'q', 'k'];
const START_BOARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

function halfToFloat(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i];
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    out[i] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return out;
}

export function loadNet(buffer) {
  const w = halfToFloat(new Uint16Array(buffer));
  const { filters: F, blocks, se, policyPlanes } = SHAPE;
  let o = 0;
  const take = (n) => w.subarray(o, (o += n));
  const net = { input: { w: take(F * 112 * 9), b: take(F) }, res: [] };
  for (let i = 0; i < blocks; i++) {
    net.res.push({
      c1: { w: take(F * F * 9), b: take(F) },
      c2: { w: take(F * F * 9), b: take(F) },
      w1: take(se * F), b1: take(se), w2: take(2 * F * se), b2: take(2 * F),
    });
  }
  net.p1 = { w: take(F * F * 9), b: take(F) };
  net.p = { w: take(policyPlanes * F * 9), b: take(policyPlanes) };
  if (o !== w.length) throw new Error(`Maia weights: expected ${o} values, got ${w.length}`);
  return net;
}

// 3x3 same-padding convolution over 8x8 planes
function conv(input, cin, { w, b }, cout, relu) {
  const pad = new Float32Array(cin * 100);
  for (let c = 0; c < cin; c++)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pad[c * 100 + (y + 1) * 10 + x + 1] = input[c * 64 + y * 8 + x];
  const out = new Float32Array(cout * 64);
  const acc = new Float32Array(64);
  for (let oc = 0; oc < cout; oc++) {
    acc.fill(b[oc]);
    for (let c = 0; c < cin; c++) {
      const wb = (oc * cin + c) * 9;
      const pb = c * 100;
      for (let k = 0; k < 9; k++) {
        const wk = w[wb + k];
        if (wk === 0) continue;
        const off = pb + ((k / 3) | 0) * 10 + (k % 3);
        for (let y = 0; y < 8; y++) {
          const r = off + y * 10;
          const a = y * 8;
          for (let x = 0; x < 8; x++) acc[a + x] += wk * pad[r + x];
        }
      }
    }
    if (relu) for (let i = 0; i < 64; i++) out[oc * 64 + i] = acc[i] > 0 ? acc[i] : 0;
    else out.set(acc, oc * 64);
  }
  return out;
}

function residual(x, blk, F, SE) {
  const h = conv(x, F, blk.c1, F, true);
  const y = conv(h, F, blk.c2, F, false);
  const pool = new Float32Array(F);
  for (let c = 0; c < F; c++) {
    let s = 0;
    for (let i = 0; i < 64; i++) s += y[c * 64 + i];
    pool[c] = s / 64;
  }
  const fc1 = new Float32Array(SE);
  for (let j = 0; j < SE; j++) {
    let s = blk.b1[j];
    for (let c = 0; c < F; c++) s += blk.w1[j * F + c] * pool[c];
    fc1[j] = s > 0 ? s : 0;
  }
  const out = new Float32Array(F * 64);
  for (let c = 0; c < F; c++) {
    let g = blk.b2[c];
    let be = blk.b2[F + c];
    for (let j = 0; j < SE; j++) {
      g += blk.w2[c * SE + j] * fc1[j];
      be += blk.w2[(F + c) * SE + j] * fc1[j];
    }
    const sg = 1 / (1 + Math.exp(-g));
    for (let i = 0; i < 64; i++) {
      const v = sg * y[c * 64 + i] + be + x[c * 64 + i];
      out[c * 64 + i] = v > 0 ? v : 0;
    }
  }
  return out;
}

// ---------- input planes ----------
function parseFen(fen) {
  const [board, turn, castling, , half] = fen.split(' ');
  const sq = new Array(64).fill(null); // sq = rank * 8 + file, rank 0 = rank 1
  let r = 7;
  let f = 0;
  for (const ch of board) {
    if (ch === '/') {
      r--;
      f = 0;
    } else if (/\d/.test(ch)) f += +ch;
    else sq[r * 8 + f++] = ch;
  }
  return { board, sq, turn, castling, half: +half || 0, key: fen.split(' ').slice(0, 4).join(' ') };
}

// history: FENs from the start of the game up to and including the position to move in
export function encode(history) {
  const pos = history.map(parseFen);
  const cur = pos[pos.length - 1];
  const us = cur.turn;
  const planes = new Float32Array(112 * 64);
  const reps = pos.map((p, i) => pos.slice(0, i).some((q) => q.key === p.key));
  const startFill = pos[0].board === START_BOARD;
  for (let i = 0, idx = pos.length - 1; i < 8; i++, idx--) {
    // before the first position, lc0 repeats it — unless the game began at the start position
    if (idx < 0 && startFill) break;
    const p = pos[Math.max(idx, 0)];
    const view = us; // every board is drawn from the side to move now
    const base = i * 13;
    for (let s = 0; s < 64; s++) {
      const pc = p.sq[s];
      if (!pc) continue;
      const white = pc === pc.toUpperCase();
      const mine = (white ? 'w' : 'b') === view;
      const t = PIECES.indexOf(pc.toLowerCase());
      const r = s >> 3;
      const vs = (view === 'b' ? 7 - r : r) * 8 + (s & 7);
      planes[(base + (mine ? 0 : 6) + t) * 64 + vs] = 1;
    }
    if (idx >= 0 && reps[idx]) planes.fill(1, (base + 12) * 64, (base + 13) * 64);
  }
  const set = (k) => planes.fill(1, k * 64, (k + 1) * 64);
  const c = cur.castling;
  const [oo, ooo, theirOO, theirOOO] = us === 'w' ? ['K', 'Q', 'k', 'q'] : ['k', 'q', 'K', 'Q'];
  if (c.includes(ooo)) set(104);
  if (c.includes(oo)) set(105);
  if (c.includes(theirOOO)) set(106);
  if (c.includes(theirOO)) set(107);
  if (us === 'b') set(108);
  planes.fill(cur.half, 109 * 64, 110 * 64);
  set(111);
  return planes;
}

// ---------- move index ----------
const MOVE_INDEX = new Map(MOVES.map((m, i) => [m, i]));
const mirror = (u) => u[0] + (9 - +u[1]) + u[2] + (9 - +u[3]) + u.slice(4);

function policyIndex(m, us) {
  let u = m.from + m.to;
  // lc0 encodes castling as king-takes-rook
  if (m.flags.includes('k')) u = m.from + 'h' + m.from[1];
  else if (m.flags.includes('q')) u = m.from + 'a' + m.from[1];
  if (us === 'b') u = mirror(u);
  if (m.promotion && m.promotion !== 'n') u += m.promotion;
  return MOVE_INDEX.get(u);
}

// Returns legal moves sorted by Maia's probability: [{ uci, san, p }]
export function evaluate(net, history, temperature = 1) {
  const { filters: F, se: SE, policyPlanes } = SHAPE;
  let x = conv(encode(history), 112, net.input, F, true);
  for (const blk of net.res) x = residual(x, blk, F, SE);
  const p1 = conv(x, F, net.p1, F, true);
  const raw = conv(p1, F, net.p, policyPlanes, false);
  const logits = new Float32Array(MOVES.length).fill(-Infinity);
  for (let i = 0; i < POLICY_USED * 64; i++) if (CONV_MAP[i] >= 0) logits[CONV_MAP[i]] = raw[i];
  const fen = history[history.length - 1];
  const chess = new Chess(fen);
  const us = chess.turn();
  const moves = chess.moves({ verbose: true }).map((m) => {
    const k = policyIndex(m, us);
    return { uci: m.from + m.to + (m.promotion || ''), san: m.san, logit: k === undefined ? -Infinity : logits[k] };
  });
  const max = Math.max(...moves.map((m) => m.logit));
  let sum = 0;
  for (const m of moves) sum += m.e = Math.exp((m.logit - max) / temperature);
  return moves.map((m) => ({ uci: m.uci, san: m.san, p: m.e / sum })).sort((a, b) => b.p - a.p);
}
