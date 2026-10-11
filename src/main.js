import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import { parsePgn, chapterName, sharedPrefix, guessColor, extractLines, lineLabel, START } from './pgn.js';
import { createSync, POLGAR_SYNC_KEY } from './sync.js';

const STORE_KEY = 'opening-drills-v1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HOUR = 3600e3;
const DAY = 24 * HOUR;
// box → wait before the next review. A miss drops the line back to box 1.
const INTERVAL = [0, 4 * HOUR, DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY, 80 * DAY, 180 * DAY];
const MAX_BOX = INTERVAL.length - 1;
const KNOWN_BOX = 3;
const ARROW_DELAY = 2000; // ms before a new line's arrow appears

// ---------- persistence ----------
// studies: id -> { name, pgn, chapters: [{ name, color, off }], t, del? }
// entries: lineKey -> { b: box, d: due ms, t: ms }
let db = { studies: {}, entries: {}, resetAt: 0, settings: { newPer: 5, depth: 0 } };
try {
  const s = JSON.parse(localStorage.getItem(STORE_KEY));
  if (s) db = { ...db, ...s, settings: { ...db.settings, ...(s.settings || {}) } };
} catch {}
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
    return true;
  } catch {
    alert("Couldn't save — this device's storage is full. Try removing a large study.");
    return false;
  }
}

// ---------- library (parsed studies, cached) ----------
const parsed = new Map(); // id -> { sig, chapters }
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function studyView(id) {
  const st = db.studies[id];
  const sig = `${st.t}|${db.settings.depth}`;
  const hit = parsed.get(id);
  if (hit && hit.sig === sig) return hit.view;
  const games = parsePgn(st.pgn);
  const seen = new Set();
  const chapters = games.map((g, i) => {
    const cfg = st.chapters[i] || {};
    const color = cfg.color || guessColor(g.root, chapterName(g.tags, i), g.tags);
    const fenTag = g.root.fen === START ? '' : hash(g.root.fen) + '/';
    const lines = extractLines(g.root, color, +db.settings.depth)
      .map((l) => ({ ...l, key: `${id}:${color[0]}:${fenTag}${l.path}`, label: lineLabel(l.nodes) }))
      .filter((l) => !seen.has(l.key) && seen.add(l.key));
    return { idx: i, name: cfg.name || chapterName(g.tags, i), color, off: !!cfg.off, root: g.root, lines };
  });
  const view = { id, name: st.name, chapters };
  parsed.set(id, { sig, view });
  return view;
}
const liveStudies = () =>
  Object.entries(db.studies)
    .filter(([, s]) => !s.del)
    .sort((a, b) => (a[1].created || a[1].t) - (b[1].created || b[1].t))
    .map(([id]) => studyView(id));

function lineState(key, now = Date.now()) {
  const e = db.entries[key];
  if (!e) return 'new';
  if (e.d <= now) return 'due';
  return e.b >= KNOWN_BOX ? 'known' : 'learning';
}
function refsFor({ study, chapter, key } = {}) {
  const out = [];
  for (const s of liveStudies()) {
    if (study && s.id !== study) continue;
    for (const ch of s.chapters) {
      if (chapter !== undefined && ch.idx !== chapter) continue;
      if (ch.off && chapter === undefined && !key) continue;
      for (const line of ch.lines) if (!key || line.key === key) out.push({ s, ch, line });
    }
  }
  return out;
}
function tally(refs, now = Date.now()) {
  const t = { total: refs.length, new: 0, due: 0, learning: 0, known: 0, next: Infinity };
  for (const r of refs) {
    const st = lineState(r.line.key, now);
    t[st]++;
    const e = db.entries[r.line.key];
    if (e && e.d > now) t.next = Math.min(t.next, e.d);
  }
  return t;
}
function until(ms) {
  const m = Math.max(1, Math.round((ms - Date.now()) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}

// ---------- home ----------
const openStudies = new Set();
let openMenu = null;

function renderHome() {
  const studies = liveStudies();
  const all = refsFor();
  const t = tally(all);
  const newCount = Math.min(t.new, +db.settings.newPer);
  if (!studies.length) {
    $('#hero').innerHTML = `<div class="empty"><b>No studies yet</b>Paste a study's PGN below to turn its variations into drills.</div>`;
  } else {
    $('#hero').innerHTML = `
      <div class="stats">
        <div><b>${t.due}</b><span>due now</span></div>
        <div><b>${t.new}</b><span>new lines</span></div>
        <div><b>${t.known}<span class="muted" style="font-size:14px"> / ${t.total}</span></b><span>known</span></div>
      </div>
      ${barHtml(t)}
      <div class="row">
        <button class="btn primary grow" data-go="due" ${t.due ? '' : 'disabled'}>${t.due ? `Review ${t.due} due` : t.next < Infinity ? `Next review in ${until(t.next)}` : 'Nothing to review'}</button>
        <button class="btn grow" data-go="new" ${newCount ? '' : 'disabled'}>${newCount ? `Learn ${newCount} new` : 'No new lines'}</button>
      </div>`;
  }
  $('#studies').innerHTML = studies.map(studyHtml).join('');
  $('#set-new').value = String(db.settings.newPer);
  $('#set-depth').value = String(db.settings.depth);
}

function barHtml(t) {
  const pct = (n) => (t.total ? (n / t.total) * 100 : 0) + '%';
  return `<div class="bar"><div class="known" style="width:${pct(t.known)}"></div><div class="learning" style="width:${pct(t.learning)}"></div><div class="due" style="width:${pct(t.due)}"></div></div>`;
}

function studyHtml(s) {
  const refs = refsFor({ study: s.id });
  const t = tally(refs);
  const on = s.chapters.filter((c) => !c.off).length;
  const parts = [t.due && `<span style="color:var(--due)">${t.due} due</span>`, t.new && `${t.new} new`, t.learning && `${t.learning} learning`, t.known && `${t.known} known`].filter(Boolean);
  return `<section class="card study" data-study="${s.id}">
    <div class="st-head"><h3 title="${esc(s.name)}">${esc(s.name)}</h3>
      <div class="menu"><button class="btn sm" data-menu="${s.id}" aria-label="Study options">⋯</button>
        ${openMenu === s.id ? `<div class="menu-pop">
          <button data-act="rename">Rename</button>
          <button data-act="replace">Replace PGN…</button>
          <button data-act="practice">Practice all lines</button>
          <button data-act="delete" class="danger">Delete study</button></div>` : ''}
      </div></div>
    <div class="st-meta">${on}${on !== s.chapters.length ? ` of ${s.chapters.length}` : ''} chapter${s.chapters.length === 1 ? '' : 's'} · ${t.total} line${t.total === 1 ? '' : 's'}${parts.length ? ' · ' + parts.join(' · ') : ''}</div>
    ${barHtml(t)}
    <div class="row"><button class="btn primary grow" data-act="drill" ${t.due || t.new ? '' : 'disabled'}>${t.due || t.new ? 'Drill' : t.next < Infinity ? `All caught up · next in ${until(t.next)}` : 'No lines'}</button></div>
    <details class="chapters" ${openStudies.has(s.id) ? 'open' : ''}><summary>Chapters &amp; lines</summary>
      ${s.chapters.map((ch) => chapterHtml(s, ch)).join('')}
    </details>
  </section>`;
}

function chapterHtml(s, ch) {
  const t = tally(ch.lines.map((line) => ({ line })));
  let prev = null;
  const items = ch.lines.map((l) => {
    let from = 0;
    if (prev) while (from < l.nodes.length && prev.nodes[from] === l.nodes[from]) from++;
    prev = l;
    const st = lineState(l.key);
    const e = db.entries[l.key];
    const when = st === 'new' ? 'new' : st === 'due' ? 'due' : until(e.d);
    return `<li data-line="${esc(l.key)}" title="${esc(l.label)}"><span class="dotk k-${st}"></span><span class="lbl">${from ? '… ' : ''}${esc(lineLabel(l.nodes, from))}</span><span class="when">${when}</span></li>`;
  });
  return `<div class="ch${ch.off ? ' off' : ''}" data-ch="${ch.idx}">
    <div class="ch-head">
      <button class="side-pill ${ch.color}" data-act="color" title="Switch side">${ch.color === 'white' ? '<i></i>White' : '<i></i>Black'}</button>
      <div class="ch-name">${esc(ch.name)}<small>${t.total} line${t.total === 1 ? '' : 's'}${t.due ? ` · ${t.due} due` : ''}${t.new ? ` · ${t.new} new` : ''}${ch.off ? ' · skipped' : ''}</small></div>
      <button class="btn sm" data-act="toggle">${ch.off ? 'Include' : 'Skip'}</button>
      <button class="btn sm" data-act="drill-ch" ${ch.lines.length ? '' : 'disabled'}>Drill</button>
    </div>
    <ul class="lines">${items.join('')}</ul>
  </div>`;
}

$('#hero').onclick = (e) => {
  const b = e.target.closest('[data-go]');
  if (b) startSession({ kind: b.dataset.go, title: b.dataset.go === 'due' ? 'Review' : 'Learn new lines' });
};

$('#studies').addEventListener('toggle', (e) => {
  const card = e.target.closest('[data-study]');
  if (!card || !e.target.matches('details')) return;
  e.target.open ? openStudies.add(card.dataset.study) : openStudies.delete(card.dataset.study);
}, true);

$('#studies').onclick = (e) => {
  const card = e.target.closest('[data-study]');
  if (!card) return;
  const id = card.dataset.study;
  const st = db.studies[id];
  const m = e.target.closest('[data-menu]');
  if (m) {
    openMenu = openMenu === id ? null : id;
    return renderHome();
  }
  const li = e.target.closest('[data-line]');
  if (li) {
    const ref = refsFor({ key: li.dataset.line })[0];
    return startSession({ kind: 'line', key: li.dataset.line, title: ref ? ref.ch.name : 'Line' });
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const chEl = e.target.closest('[data-ch]');
  const ci = chEl ? +chEl.dataset.ch : undefined;
  openMenu = null;
  if (act === 'drill') startSession({ kind: 'both', study: id, title: st.name });
  else if (act === 'practice') startSession({ kind: 'practice', study: id, title: st.name });
  else if (act === 'drill-ch') {
    const ch = studyView(id).chapters[ci];
    const t = tally(refsFor({ study: id, chapter: ci }));
    startSession({ kind: t.due || t.new ? 'both' : 'practice', study: id, chapter: ci, title: ch.name });
  } else if (act === 'color' || act === 'toggle') {
    const view = studyView(id);
    st.chapters = view.chapters.map((c) => ({ name: c.name, color: c.color, off: c.off }));
    if (act === 'color') st.chapters[ci].color = st.chapters[ci].color === 'white' ? 'black' : 'white';
    else st.chapters[ci].off = !st.chapters[ci].off;
    touchStudy(id);
  } else if (act === 'rename') {
    const name = prompt('Study name', st.name);
    if (name && name.trim()) {
      st.name = name.trim();
      touchStudy(id);
    } else renderHome();
  } else if (act === 'replace') {
    renderHome();
    beginImport(id);
  } else if (act === 'delete') {
    if (confirm(`Delete "${st.name}"? Its progress is kept if you add the same study back with Replace… — but not if you add it as a new study.`)) {
      db.studies[id] = { del: true, t: Date.now() };
      parsed.delete(id);
      persist();
      sync.syncSoon();
    }
    renderHome();
  } else renderHome();
};
document.addEventListener('click', (e) => {
  if (openMenu && !e.target.closest('.menu')) {
    openMenu = null;
    renderHome();
  }
});

function touchStudy(id) {
  db.studies[id].t = Date.now();
  persist();
  renderHome();
  sync.syncSoon();
}

// ---------- import ----------
let pending = null; // { id?, pgn, chapters: [{ name, color, off, lines }] }

function beginImport(id) {
  pending = null;
  $('#add-title').textContent = id ? `Replace PGN · ${db.studies[id].name}` : 'Add a study';
  $('#add').dataset.target = id || '';
  $('#add-cancel').hidden = !id;
  $('#preview').hidden = true;
  $('#pgn-err').hidden = true;
  $('#pgn-in').value = '';
  $('#add').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('#pgn-in').focus(), 300);
}
function endImport() {
  pending = null;
  $('#add').dataset.target = '';
  $('#add-title').textContent = 'Add a study';
  $('#add-cancel').hidden = true;
  $('#preview').hidden = true;
  $('#pgn-err').hidden = true;
  $('#pgn-in').value = '';
}

function readPgn(text) {
  $('#pgn-err').hidden = true;
  const games = parsePgn(text);
  const target = $('#add').dataset.target;
  const old = target ? db.studies[target] : null;
  const prefix = sharedPrefix(games);
  const chapters = games.map((g, i) => {
    const name = !g.tags.ChapterName && prefix ? g.tags.Event.slice(prefix.length + 2) : chapterName(g.tags, i);
    const prev = old && old.chapters.find((c) => c.name === name);
    const color = prev ? prev.color : guessColor(g.root, name + ' ' + (g.tags.StudyName || ''), g.tags);
    return { name, color, off: prev ? prev.off : false, root: g.root, errors: g.errors };
  });
  const total = chapters.reduce((n, c) => n + extractLines(c.root, c.color, +db.settings.depth).length, 0);
  if (!total) {
    $('#pgn-err').textContent = games.length ? "Found the PGN but no moves to drill. Check it has moves after the headers." : "Couldn't find any games in that text. Paste a PGN that starts with [Event …] headers or 1. e4 …";
    $('#pgn-err').hidden = false;
    return;
  }
  const g0 = games[0].tags;
  pending = { pgn: text, chapters };
  $('#study-name').value = old ? old.name : g0.StudyName || prefix || (games.length === 1 ? chapterName(g0, 0) : (g0.Event || '').split(':')[0]) || 'New study';
  renderPreview();
  $('#preview').hidden = false;
}

function renderPreview() {
  const errs = pending.chapters.reduce((n, c) => n + c.errors, 0);
  $('#preview-chs').innerHTML =
    pending.chapters
      .map((c, i) => {
        const n = extractLines(c.root, c.color, +db.settings.depth).length;
        return `<div class="ch-head${c.off ? ' off' : ''}" data-i="${i}" style="${c.off ? 'opacity:.5' : ''}">
          <input type="checkbox" ${c.off ? '' : 'checked'} aria-label="Include chapter">
          <button class="side-pill ${c.color}" data-act="color"><i></i>${c.color === 'white' ? 'White' : 'Black'}</button>
          <div class="ch-name">${esc(c.name)}<small>${n} line${n === 1 ? '' : 's'}</small></div></div>`;
      })
      .join('') + (errs ? `<div class="err">${errs} move${errs === 1 ? '' : 's'} couldn't be read and ${errs === 1 ? 'was' : 'were'} skipped.</div>` : '');
}
$('#preview-chs').onclick = (e) => {
  const row = e.target.closest('[data-i]');
  if (!row) return;
  const c = pending.chapters[+row.dataset.i];
  if (e.target.closest('[data-act=color]')) c.color = c.color === 'white' ? 'black' : 'white';
  else if (e.target.matches('input[type=checkbox]')) c.off = !e.target.checked;
  else return;
  renderPreview();
};
$('#pgn-read').onclick = () => {
  const text = $('#pgn-in').value.trim();
  if (!text) return $('#pgn-in').focus();
  readPgn(text);
};
$('#pgn-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const text = await f.text();
  $('#pgn-in').value = text.length > 200000 ? text.slice(0, 2000) + '\n…' : text;
  e.target.value = '';
  readPgn(text);
};
$('#add-cancel').onclick = endImport;
$('#study-save').onclick = () => {
  if (!pending) return;
  const target = $('#add').dataset.target;
  const id = target || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = Date.now();
  const prevStudy = db.studies[id];
  db.studies[id] = {
    name: $('#study-name').value.trim() || 'Untitled study',
    pgn: pending.pgn,
    chapters: pending.chapters.map((c) => ({ name: c.name, color: c.color, off: c.off })),
    created: (prevStudy && prevStudy.created) || now,
    t: now,
  };
  parsed.delete(id);
  if (!persist()) {
    if (prevStudy) db.studies[id] = prevStudy;
    else delete db.studies[id];
    return;
  }
  openStudies.add(id);
  endImport();
  renderHome();
  sync.syncSoon();
  document.querySelector(`[data-study="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ---------- settings / backup ----------
$('#set-new').onchange = (e) => {
  db.settings.newPer = +e.target.value;
  persist();
  renderHome();
};
$('#set-depth').onchange = (e) => {
  db.settings.depth = +e.target.value;
  persist();
  renderHome();
};
$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'opening-drills', studies: db.studies, entries: db.entries, resetAt: db.resetAt })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `opening-drills-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#import').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'opening-drills') throw new Error();
    const merged = mergeLocal(data);
    applyState(merged);
    sync.syncSoon();
    alert('Imported.');
  } catch {
    alert("That file isn't an Opening Drills backup.");
  }
};
function mergeLocal(other) {
  const lww = (a = {}, b = {}, floor = 0) => {
    const out = {};
    for (const src of [a, b]) for (const [k, v] of Object.entries(src)) if (v.t > floor && (!out[k] || v.t > out[k].t)) out[k] = v;
    return out;
  };
  const resetAt = Math.max(db.resetAt || 0, other.resetAt || 0);
  return { studies: lww(db.studies, other.studies), entries: lww(db.entries, other.entries, resetAt), resetAt };
}
$('#reset').onclick = () => {
  if (confirm('Clear progress on every line? Your studies stay. This cannot be undone.')) {
    db.entries = {};
    db.resetAt = Date.now();
    persist();
    renderHome();
    sync.syncSoon(0);
  }
};

// ---------- drill ----------
let cg = null;
let session = null; // { title, kind, queue: [ref], i, done: [{ ok }] }
let cur = null; // { ref, chess, pos, mistakes, tries, mode, finished, retry }
let gen = 0;
const later = (fn, ms) => {
  const g = gen;
  setTimeout(() => g === gen && fn(), ms);
};

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startSession(opts) {
  const now = Date.now();
  const refs = refsFor(opts);
  let queue;
  if (opts.kind === 'line') queue = refs;
  else if (opts.kind === 'practice') queue = shuffle(refs.slice());
  else {
    const due = refs.filter((r) => lineState(r.line.key, now) === 'due').sort((a, b) => db.entries[a.line.key].d - db.entries[b.line.key].d);
    const fresh = refs.filter((r) => lineState(r.line.key, now) === 'new').slice(0, +db.settings.newPer);
    queue = opts.kind === 'due' ? due : opts.kind === 'new' ? fresh : due.concat(fresh);
  }
  if (!queue.length) return;
  session = { ...opts, queue: queue.map((r) => ({ ...r, practice: opts.kind === 'practice' })), i: 0, done: [] };
  showDrill();
  loadLine();
}

function showDrill() {
  $('#home').hidden = true;
  $('footer').hidden = true;
  $('#drill').hidden = false;
  window.scrollTo(0, 0);
  if (!cg) {
    cg = Chessground($('#board'), {
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, events: { after: onUserMove } },
      premovable: { enabled: false },
      draggable: { showGhost: true },
    });
  }
}
function showHome() {
  gen++;
  session = null;
  cur = null;
  $('#drill').hidden = true;
  $('#home').hidden = false;
  $('footer').hidden = false;
  renderHome();
  window.scrollTo(0, 0);
}

const userTurn = () => (cur.ref.ch.color === 'white' ? 'w' : 'b');
const isUserMove = (pos) => cur.ref.line.nodes[pos].parent.fen.split(' ')[1] === userTurn();

function loadLine(again = false) {
  gen++;
  const ref = session.queue[session.i];
  const e = db.entries[ref.line.key];
  cur = {
    ref,
    chess: new Chess(ref.line.nodes[0].parent.fen),
    pos: 0,
    mistakes: 0,
    tries: 0,
    learn: !e && !ref.practice && !ref.retry && !again,
    finished: false,
    shown: false,
  };
  cg.set({ orientation: ref.ch.color, lastMove: undefined });
  cg.setShapes([]);
  cg.setAutoShapes([]);
  syncBoard(false);
  $('#d-title').textContent = ref.ch.name;
  $('#d-sub').textContent = ref.s.name + ' · you play ' + ref.ch.color;
  const kind = ref.practice || again ? ['practice', 'Practice'] : ref.retry ? ['practice', 'Second try'] : cur.learn ? ['new', 'New line'] : ['review', 'Review'];
  $('#d-kind').textContent = kind[1];
  $('#d-kind').className = 'pill ' + kind[0];
  $('#d-count').textContent = session.queue.length > 1 ? `Line ${session.i + 1} of ${session.queue.length}` : '';
  $('#d-progress').style.width = (session.i / session.queue.length) * 100 + '%';
  $('#d-play').hidden = false;
  $('#d-done').hidden = true;
  $('#btn-hint').disabled = $('#btn-show').disabled = false;
  setMsg(cur.learn ? "New line — think first, then an arrow shows the move." : `Play your moves as ${ref.ch.color}.`, cur.learn ? 'info' : '');
  renderMoves();
  renderNotes();
  later(advance, 350);
}

function syncBoard(userCanMove) {
  const turn = cur.chess.turn() === 'w' ? 'white' : 'black';
  cg.set({
    fen: cur.chess.fen(),
    turnColor: turn,
    check: cur.chess.inCheck() ? turn : false,
    movable: { color: userCanMove ? cur.ref.ch.color : undefined, dests: userCanMove ? dests(cur.chess) : new Map() },
  });
}
function dests(chess) {
  const m = new Map();
  for (const mv of chess.moves({ verbose: true })) {
    if (!m.has(mv.from)) m.set(mv.from, []);
    m.get(mv.from).push(mv.to);
  }
  return m;
}
const sq = (u) => [u.slice(0, 2), u.slice(2, 4)];

// play opponent moves until it's your turn or the line ends
function advance() {
  const nodes = cur.ref.line.nodes;
  if (cur.pos >= nodes.length) return finishLine();
  if (!isUserMove(cur.pos)) {
    const n = nodes[cur.pos];
    const [from, to] = sq(n.uci);
    cur.chess.move({ from, to, promotion: n.uci[4] });
    cur.pos++;
    cg.set({ lastMove: [from, to] });
    syncBoard(false);
    renderMoves();
    renderNotes();
    return later(advance, cur.pos >= nodes.length ? 200 : 420);
  }
  cur.tries = 0;
  cur.shown = false;
  syncBoard(true);
  const shapes = studyShapes();
  if (cur.learn) {
    // give a moment to think before the answer shows
    const pos = cur.pos;
    setMsg('Your move — have a think. The arrow shows in 2 seconds.', 'info');
    later(() => {
      if (cur.pos !== pos || cur.finished || cur.shown) return;
      cg.setAutoShapes([...studyShapes(), { orig: sq(nodes[pos].uci)[0], dest: sq(nodes[pos].uci)[1], brush: 'blue' }]);
      setMsg(`Play <b>${moveText(pos)}</b> (the blue arrow).`, 'info');
    }, ARROW_DELAY);
  } else if (cur.pos > 0 && !cur.finished) {
    setMsg(`Your move${nodes[cur.pos - 1] ? ` — after <b>${moveText(cur.pos - 1)}</b>` : ''}.`, '');
  }
  cg.setAutoShapes(shapes);
}

// arrows the study drew for the move just played — only while learning, so reviews stay blind
function studyShapes() {
  if (!cur.learn && !cur.finished) return [];
  const n = cur.pos > 0 ? cur.ref.line.nodes[cur.pos - 1] : cur.ref.line.nodes[0].parent;
  return (n.shapes || []).map((s) => ({ ...s }));
}

function moveText(pos) {
  const n = cur.ref.line.nodes[pos];
  const ply = n.ply - 1;
  return `${Math.floor(ply / 2) + 1}${ply % 2 ? '…' : '.'}${n.san}`;
}

function needsPromotion(from, to) {
  return cur.chess.moves({ verbose: true }).some((m) => m.from === from && m.to === to && m.promotion);
}
function askPromotion() {
  return new Promise((resolve) => {
    const dlg = $('#promo');
    dlg.hidden = false;
    const handler = (e) => {
      const b = e.target.closest('button[data-p]');
      if (!b) return;
      dlg.removeEventListener('click', handler);
      dlg.hidden = true;
      resolve(b.dataset.p);
    };
    dlg.addEventListener('click', handler);
  });
}

async function onUserMove(from, to) {
  if (!cur || cur.finished) return;
  const g = gen;
  let promotion;
  if (needsPromotion(from, to)) promotion = await askPromotion();
  if (g !== gen) return;
  let mv;
  try {
    mv = cur.chess.move({ from, to, promotion });
  } catch {
    return syncBoard(true);
  }
  const u = mv.from + mv.to + (mv.promotion || '');
  const node = cur.ref.line.nodes[cur.pos];
  if (u === node.uci) {
    cur.pos++;
    cg.set({ lastMove: [from, to] });
    syncBoard(false);
    renderMoves();
    renderNotes();
    if (!cur.learn) setMsg(`✓ <b>${mv.san}</b>`, 'good');
    cg.setAutoShapes([]);
    return later(advance, 260);
  }
  cur.chess.undo();
  const sibling = node.parent.children.some((c) => c.uci === u);
  if (sibling) {
    setMsg(`<b>${mv.san}</b> is also in your repertoire — but this line goes another way. Try again.`, 'info');
  } else {
    cur.mistakes++;
    cur.tries++;
    setMsg(`✗ <b>${mv.san}</b> isn't the move here.${cur.tries >= 2 ? ' The arrow shows it.' : ' Try again.'}`, 'bad');
    if (cur.tries >= 2) showMove(false);
  }
  const prev = cur.pos > 0 ? sq(cur.ref.line.nodes[cur.pos - 1].uci) : undefined;
  later(() => {
    cg.set({ lastMove: prev });
    syncBoard(true);
  }, 0);
}

function showMove(counts = true) {
  if (!cur || cur.finished || !isUserMove(cur.pos)) return;
  if (counts && !cur.learn && !cur.shown) cur.mistakes++;
  cur.shown = true;
  const [a, b] = sq(cur.ref.line.nodes[cur.pos].uci);
  cg.setAutoShapes([{ orig: a, dest: b, brush: 'blue' }]);
}

function finishLine() {
  cur.finished = true;
  syncBoard(false);
  const ref = cur.ref;
  const key = ref.line.key;
  const e = db.entries[key];
  const now = Date.now();
  const ok = cur.mistakes === 0;
  const graded = !ref.practice && !ref.retry && !cur.again;
  let note = '';
  if (graded) {
    const b = cur.learn ? 1 : ok ? Math.min((e ? e.b : 0) + 1, MAX_BOX) : 1;
    db.entries[key] = { b, d: now + INTERVAL[b], t: now };
    persist();
    sync.syncSoon();
    note = ` Next review in ${until(now + INTERVAL[b])}.`;
    if (!ok && session.kind !== 'line') session.queue.push({ ...ref, retry: true });
  }
  session.done.push({ ok });
  cg.setAutoShapes(studyShapes());
  if (cur.learn) setMsg(`Line learned.${note}`, 'good');
  else if (ok) setMsg(`✓ Perfect.${note}`, 'good');
  else setMsg(`Done with ${cur.mistakes} mistake${cur.mistakes === 1 ? '' : 's'}.${note}${graded && session.kind !== 'line' ? " You'll see it again at the end of this session." : ''}`, 'bad');
  $('#d-play').hidden = true;
  $('#d-done').hidden = false;
  $('#d-count').textContent = session.queue.length > 1 ? `Line ${session.i + 1} of ${session.queue.length}` : '';
  const last = session.i >= session.queue.length - 1;
  $('#btn-next').textContent = last ? 'Finish' : 'Next line →';
  $('#d-progress').style.width = ((session.i + 1) / session.queue.length) * 100 + '%';
  renderMoves(true);
}

function nextLine() {
  if (!session) return;
  if (session.i < session.queue.length - 1) {
    session.i++;
    return loadLine();
  }
  endSession();
}
function endSession() {
  gen++;
  const n = session.done.length;
  const perfect = session.done.filter((d) => d.ok).length;
  const opts = { kind: session.kind, study: session.study, chapter: session.chapter, key: session.key, title: session.title };
  $('#d-play').hidden = true;
  $('#d-done').hidden = true;
  $('#d-count').textContent = '';
  $('#d-progress').style.width = '100%';
  const t = tally(refsFor(opts.kind === 'line' ? { key: opts.key } : opts));
  const moreNew = opts.kind !== 'line' && opts.kind !== 'practice' && opts.kind !== 'due' && t.new > 0;
  setMsg(
    `<b>Session complete.</b> ${n} line${n === 1 ? '' : 's'}, ${perfect} perfect.` +
      `<div class="row" style="margin-top:10px">` +
      (moreNew ? `<button class="btn primary grow" id="more">Learn ${Math.min(t.new, +db.settings.newPer)} more</button>` : '') +
      `<button class="btn grow" id="practice">Practice these again</button></div>`,
    'good',
  );
  const done = session.queue.filter((r) => !r.retry);
  $('#more') && ($('#more').onclick = () => startSession({ ...opts, kind: opts.kind === 'new' ? 'new' : 'both' }));
  $('#practice').onclick = () => {
    session = { ...opts, kind: 'practice', queue: shuffle(done.map((r) => ({ ...r, practice: true, retry: false }))), i: 0, done: [] };
    loadLine();
  };
}

function renderMoves(all = false) {
  const nodes = cur.ref.line.nodes;
  const ut = userTurn();
  const upto = all ? nodes.length : cur.pos;
  const parts = [];
  for (let k = 0; k < upto; k++) {
    const n = nodes[k];
    const ply = n.ply - 1;
    const num = ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}.` : k === 0 ? `${Math.floor(ply / 2) + 1}…` : '';
    const you = n.parent.fen.split(' ')[1] === ut;
    parts.push(`<span class="${you ? 'you' : ''}">${num}${esc(n.san)}${n.ann ? esc(n.ann) : ''}</span>`);
  }
  if (!all && cur.pos < nodes.length && isUserMove(cur.pos)) parts.push('<span class="cur">?</span>');
  const intro = nodes[0].ply > 1 || nodes[0].parent.fen !== START ? '<span class="muted">(from position) </span>' : '';
  $('#moves').innerHTML = intro + (parts.join(' ') || '<span class="muted">…</span>');
}

function renderNotes() {
  const nodes = cur.ref.line.nodes;
  const shown = [];
  const root = nodes[0].parent;
  if (root.comment && cur.pos === 0) shown.push(`<p>${esc(root.comment)}</p>`);
  // most recent notes first, only for moves already on the board
  for (let k = cur.finished ? nodes.length - 1 : cur.pos - 1; k >= 0 && shown.length < 3; k--) {
    if (nodes[k].comment) shown.push(`<p><span class="at">${esc(moveText(k))}</span>${esc(nodes[k].comment)}</p>`);
  }
  $('#notes').innerHTML = shown.join('');
  $('#notes-card').hidden = !shown.length;
}

function setMsg(html, kind) {
  const el = $('#msg');
  el.innerHTML = html;
  el.className = 'msg ' + (kind || '');
}

$('#btn-next').onclick = nextLine;
$('#btn-again').onclick = () => {
  loadLine(true);
  cur.again = true;
};
$('#btn-skip').onclick = nextLine;
$('#btn-show').onclick = () => showMove(true);
$('#btn-hint').onclick = () => {
  if (!cur || cur.finished || !isUserMove(cur.pos)) return;
  if (!cur.learn && !cur.shown) cur.mistakes++;
  cur.shown = true;
  cg.setAutoShapes([{ orig: sq(cur.ref.line.nodes[cur.pos].uci)[0], brush: 'blue' }]);
  setMsg('Hint: the circled piece moves.', 'info');
};
$('#btn-home').onclick = showHome;
$('#home-link').onclick = () => session && showHome();
document.addEventListener('keydown', (e) => {
  if ($('#drill').hidden || e.target.matches('input, select, textarea')) return;
  if ((e.key === 'Enter' || e.key === 'n') && cur && cur.finished) nextLine();
  else if (e.key === 'h') $('#btn-hint').click();
  else if (e.key === 'Escape') showHome();
});

// ---------- sync ----------
function applyState(st) {
  for (const id of Object.keys(st.studies)) if (!db.studies[id] || db.studies[id].t !== st.studies[id].t) parsed.delete(id);
  db.studies = st.studies;
  db.entries = st.entries;
  db.resetAt = st.resetAt;
  persist();
  if (!$('#home').hidden) renderHome();
}
const sync = createSync({
  getState: () => ({ entries: db.entries, studies: db.studies, resetAt: db.resetAt }),
  applyState,
  onStatus: renderSync,
});
function ago(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function renderSync(st) {
  const on = st.state !== 'off';
  $('#sync-setup').hidden = on;
  $('#sync-on').hidden = !on;
  let polgar = null;
  try {
    polgar = JSON.parse(localStorage.getItem(POLGAR_SYNC_KEY));
  } catch {}
  $('#sync-reuse').hidden = on || !(polgar && polgar.token);
  $('#sync-status').textContent = {
    off: '',
    syncing: 'Syncing…',
    ok: `Synced ${ago(st.at)}`,
    offline: `Offline — will sync when you're back online${st.at ? ` (last synced ${ago(st.at)})` : ''}`,
    error: `Sync failed: ${st.message}`,
  }[st.state];
  $('#sync-status').className = 'sync-status ' + st.state;
  $('#sync-dot').className = 'dot ' + st.state;
}
$('#sync-connect').onclick = async () => {
  const token = $('#sync-token').value.trim();
  if (!token) return $('#sync-token').focus();
  $('#sync-token').value = '';
  await sync.connect(token);
};
$('#sync-reuse-btn').onclick = async () => {
  try {
    await sync.connect(JSON.parse(localStorage.getItem(POLGAR_SYNC_KEY)).token);
  } catch {}
};
$('#sync-now').onclick = () => sync.sync();
$('#sync-off').onclick = () => {
  if (confirm('Stop syncing on this device? Your studies and progress stay here and in the gist.')) sync.disconnect();
};

renderHome();
renderSync({ state: sync.connected ? 'syncing' : 'off' });
if (sync.connected) sync.sync();
// refresh due counts when coming back to the app
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && !$('#home').hidden && renderHome());

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// test hook for local development only
if (location.hostname === 'localhost') window.__drill = { expected: () => cur && !cur.finished && cur.ref.line.nodes[cur.pos] && isUserMove(cur.pos) ? cur.ref.line.nodes[cur.pos].uci : null, db: () => db };
