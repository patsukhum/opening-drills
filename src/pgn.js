// PGN → move trees → drillable lines. Handles multi-chapter study exports,
// nested variations, comments (incl. Lichess [%cal]/[%csl] arrows) and NAGs.
import { Chess } from 'chess.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BRUSH = { G: 'green', R: 'red', B: 'blue', Y: 'yellow' };

function tokenize(text) {
  const toks = [];
  const re = /\[\s*(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]|\{([^}]*)\}|;([^\n]*)|(\()|(\))|\$(\d+)|(1-0|0-1|1\/2-1\/2|\*)|([^\s(){};[\]]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) toks.push({ t: 'tag', k: m[1], v: m[2].replace(/\\(.)/g, '$1') });
    else if (m[3] !== undefined) toks.push({ t: 'cmt', v: m[3] });
    else if (m[4] !== undefined) toks.push({ t: 'cmt', v: m[4] });
    else if (m[5]) toks.push({ t: '(' });
    else if (m[6]) toks.push({ t: ')' });
    else if (m[7]) toks.push({ t: 'nag', v: +m[7] });
    else if (m[8]) toks.push({ t: 'end' });
    else toks.push({ t: 'word', v: m[9] });
  }
  return toks;
}

// Pull [%cal ...] / [%csl ...] out of a comment; return clean text + chessground shapes.
export function parseComment(raw) {
  const shapes = [];
  const text = raw
    .replace(/\[%(cal|csl)\s+([^\]]*)\]/g, (_, kind, body) => {
      for (const s of body.split(',')) {
        const v = s.trim();
        const brush = BRUSH[v[0]] || 'green';
        if (kind === 'cal' && /^[GRBY][a-h][1-8][a-h][1-8]$/.test(v)) shapes.push({ orig: v.slice(1, 3), dest: v.slice(3, 5), brush });
        if (kind === 'csl' && /^[GRBY][a-h][1-8]$/.test(v)) shapes.push({ orig: v.slice(1, 3), brush });
      }
      return '';
    })
    .replace(/\[%[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, shapes };
}

function addComment(node, raw) {
  const { text, shapes } = parseComment(raw);
  if (text) node.comment = node.comment ? node.comment + ' ' + text : text;
  if (shapes.length) node.shapes = (node.shapes || []).concat(shapes);
}

function newGame() {
  return { tags: {}, root: null, cur: null, stack: [], errors: 0, started: false };
}

function startTree(g) {
  if (g.root) return;
  const fen = g.tags.FEN || START;
  let ok = true;
  try {
    new Chess(fen);
  } catch {
    ok = false;
  }
  g.root = { fen: ok ? fen : START, children: [], parent: null, ply: 0 };
  g.cur = g.root;
}

export function parsePgn(text) {
  const games = [];
  let g = newGame();
  const flush = () => {
    if (g.started || Object.keys(g.tags).length) {
      startTree(g);
      games.push(g);
    }
    g = newGame();
  };
  for (const tok of tokenize(text.replace(/\r/g, ''))) {
    if (tok.t === 'tag') {
      if (g.started) flush();
      g.tags[tok.k] = tok.v;
      continue;
    }
    if (tok.t === 'end') {
      if (g.stack.length === 0) {
        g.started = true;
        flush();
      }
      continue;
    }
    startTree(g);
    g.started = true;
    if (tok.t === 'cmt') addComment(g.cur, tok.v);
    else if (tok.t === 'nag') (g.cur.nags = g.cur.nags || []).push(tok.v);
    else if (tok.t === '(') {
      g.stack.push(g.cur);
      g.cur = g.cur.parent || g.cur; // a variation replaces the move just played
    } else if (tok.t === ')') {
      if (g.stack.length) g.cur = g.stack.pop();
    } else if (tok.t === 'word') {
      let w = tok.v.replace(/^\d+\.(\.\.)?/, '').replace(/^\.+/, '');
      if (!w || /^\d+\.*$/.test(w)) continue;
      const ann = w.match(/[!?]+$/);
      w = w.replace(/[!?]+$/, '').replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O');
      if (w === '--' || w === 'Z0') {
        g.errors++;
        continue;
      }
      const c = new Chess(g.cur.fen);
      let mv;
      try {
        mv = c.move(w, { strict: false });
      } catch {
        mv = null;
      }
      if (!mv) {
        g.errors++;
        continue;
      }
      const u = mv.from + mv.to + (mv.promotion || '');
      let child = g.cur.children.find((n) => n.uci === u);
      if (!child) {
        child = { uci: u, san: mv.san, fen: c.fen(), children: [], parent: g.cur, ply: g.cur.ply + 1 };
        g.cur.children.push(child);
      }
      if (ann) child.ann = ann[0];
      g.cur = child;
    }
  }
  flush();
  return games
    .filter((x) => !x.tags.Variant || /standard|from position/i.test(x.tags.Variant))
    .map((x) => ({ tags: x.tags, root: x.root, errors: x.errors }));
}

// "Repertoire: 4.e3", "Repertoire: 4.Qc2" → the shared "Repertoire" prefix, or ''
export function sharedPrefix(games) {
  const evs = games.map((g) => g.tags.Event || '');
  const m = evs[0].match(/^(.+?): /);
  return games.length > 1 && m && evs.every((e) => e.startsWith(m[0])) ? m[1] : '';
}

export function chapterName(tags, i) {
  if (tags.ChapterName) return tags.ChapterName;
  const ev = tags.Event && tags.Event !== '?' ? tags.Event : '';
  if (ev.includes(': ') && tags.StudyName && ev.startsWith(tags.StudyName + ': ')) return ev.slice(tags.StudyName.length + 2);
  if (tags.White && tags.Black && tags.White !== '?') return `${tags.White} – ${tags.Black}`;
  return ev || `Chapter ${i + 1}`;
}

// The side you play rarely branches; the opponent's side does.
export function guessColor(root, name = '', tags = {}) {
  if (/^(white|black)$/i.test(tags.Orientation || '')) return tags.Orientation.toLowerCase();
  let w = 0;
  let b = 0;
  const walk = (n) => {
    if (n.children.length > 1) (n.fen.split(' ')[1] === 'w' ? w++ : b++);
    n.children.forEach(walk);
  };
  walk(root);
  if (w > b) return 'black';
  if (b > w) return 'white';
  return /black|caro|sicil|french|pirc|scand|kid\b|king'?s indian|gr[uü]nfeld|nimzo|slav|dutch|benoni|vs\.? ?(d4|e4|c4)|defen[cs]e/i.test(name) ? 'black' : 'white';
}

// Every root-to-leaf path is a line. maxMove > 0 cuts lines after that move number.
export function extractLines(root, color, maxMove = 0) {
  const lines = [];
  const cap = maxMove > 0 ? maxMove * 2 : Infinity;
  const path = [];
  const walk = (n) => {
    const kids = n.ply >= cap ? [] : n.children;
    if (!kids.length) {
      if (path.length) lines.push(path.slice());
      return;
    }
    for (const k of kids) {
      path.push(k);
      walk(k);
      path.pop();
    }
  };
  walk(root);
  const userTurn = color === 'white' ? 'w' : 'b';
  const out = [];
  const seen = new Set();
  for (const nodes of lines) {
    // drop trailing opponent moves — the line ends on your last move
    let end = nodes.length;
    while (end > 0 && nodes[end - 1].parent.fen.split(' ')[1] !== userTurn) end--;
    const kept = nodes.slice(0, end);
    if (!kept.length) continue;
    const key = kept.map((n) => n.uci).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ nodes: kept, path: key });
  }
  // a line that is just the start of a longer line adds nothing
  const keys = out.map((l) => l.path).sort();
  const prefix = new Set(keys.filter((k, i) => keys.slice(i + 1).some((o) => o.startsWith(k + ' '))));
  return out.filter((l) => !prefix.has(l.path));
}

export function lineLabel(nodes, from = 0) {
  return nodes
    .map((n, i) => {
      if (i < from) return null;
      const ply = n.ply - 1;
      const num = Math.floor(ply / 2) + 1;
      if (ply % 2 === 0) return `${num}.${n.san}`;
      return i === from ? `${num}…${n.san}` : n.san;
    })
    .filter(Boolean)
    .join(' ');
}

export { START };
