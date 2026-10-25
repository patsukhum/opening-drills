import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import { parsePgn, chapterName, sharedPrefix, guessColor, extractLines, lineLabel, START } from './pgn.js';
import { createSync, cleanCode } from './sync.js';
import { maiaMoves, pickHuman, analyse, judge, scoreText } from './engines.js';

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
let db = { studies: {}, entries: {}, resetAt: 0, settings: { newPer: 5, depth: 0, surprise: 0.1 } };
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
    return { idx: i, name: cfg.name || chapterName(g.tags, i), color, off: !!cfg.off, root: g.root, lines, video: YT(g.tags.Site) || YT(g.tags.Annotator) };
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
      </div>
      <div class="row"><button class="btn grow" data-go="random" ${t.total ? '' : 'disabled'}>🎲 Random lines${+db.settings.surprise ? ` · ${Math.round(db.settings.surprise * 100)}% surprises` : ''}</button></div>`;
  }
  $('#studies').innerHTML = studies.map(studyHtml).join('');
  $('#set-new').value = String(db.settings.newPer);
  $('#set-depth').value = String(db.settings.depth);
  $('#set-surprise').value = String(db.settings.surprise);
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
          <button data-act="random">Random lines</button>
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
  if (b) startSession({ kind: b.dataset.go, title: { due: 'Review', new: 'Learn new lines', random: 'Random lines' }[b.dataset.go] });
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
  else if (act === 'random') startSession({ kind: 'random', study: id, title: st.name });
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
$('#set-surprise').onchange = (e) => {
  db.settings.surprise = +e.target.value;
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

function batchFor(opts, now = Date.now()) {
  const refs = refsFor(opts);
  if (opts.kind === 'line') return refs;
  if (opts.kind === 'practice') return shuffle(refs.slice());
  const due = refs.filter((r) => lineState(r.line.key, now) === 'due').sort((a, b) => db.entries[a.line.key].d - db.entries[b.line.key].d);
  const fresh = opts.kind === 'due' ? [] : refs.filter((r) => lineState(r.line.key, now) === 'new').slice(0, +db.settings.newPer);
  return opts.kind === 'new' ? fresh : due.concat(fresh);
}

function startSession(opts) {
  if (opts.kind === 'random') {
    if (!refsFor(opts).length) return;
    session = { ...opts, queue: [], i: -1, done: [] };
    showDrill();
    return nextLine();
  }
  const queue = batchFor(opts);
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

const userColor = () => cur.ref.ch.color;
const userTurn = () => (userColor() === 'white' ? 'w' : 'b');
const isUserMove = (pos) => cur.ref.line.nodes[pos].parent.fen.split(' ')[1] === userTurn();
const nodes = () => cur.ref.line.nodes;
const fens = () => [cur.root.fen, ...cur.played.map((p) => p.fen)];

// a random line in scope; in random mode the opponent's choices come from this pick
function randomRef() {
  const refs = refsFor(session);
  return { ...refs[Math.floor(Math.random() * refs.length)], random: true };
}

// phases: 'line' (following the study) · 'offbook' (answer Maia's surprise) · 'judging' · 'done' · 'play' (vs Maia)
function loadLine(again = false) {
  gen++;
  const ref = session.queue[session.i];
  const e = db.entries[ref.line.key];
  const root = ref.line.nodes[0].parent;
  cur = {
    ref,
    root,
    chess: new Chess(root.fen),
    played: [], // { san, uci, fen, node?, you, offbook? }
    pos: 0,
    phase: 'line',
    mistakes: 0,
    tries: 0,
    learn: !e && !ref.practice && !ref.retry && !ref.random && !again,
    again,
    shown: false,
    view: null,
  };
  if (ref.random && Math.random() < +db.settings.surprise) {
    // pick one of the opponent's moves (not the very first if possible) for Maia to replace
    const opp = ref.line.nodes.map((_, k) => k).filter((k) => !isUserMove(k));
    const later2 = opp.filter((k) => k >= 2);
    const pool = later2.length ? later2 : opp;
    if (pool.length) cur.surpriseAt = pool[Math.floor(Math.random() * pool.length)];
  }
  cg.set({ orientation: ref.ch.color, lastMove: undefined });
  cg.setShapes([]);
  cg.setAutoShapes([]);
  syncBoard(false);
  $('#d-title').textContent = ref.ch.name;
  $('#d-sub').textContent = ref.s.name + ' · you play ' + ref.ch.color;
  const kind = ref.random ? ['practice', 'Random line'] : ref.practice || again ? ['practice', 'Practice'] : ref.retry ? ['practice', 'Second try'] : cur.learn ? ['new', 'New line'] : ['review', 'Review'];
  $('#d-kind').textContent = kind[1];
  $('#d-kind').className = 'pill ' + kind[0];
  renderCount();
  showRow('play');
  $('#btn-hint').disabled = $('#btn-show').disabled = false;
  setMsg(
    ref.random ? `Random line — your opponent may surprise you. Play as ${ref.ch.color}.` : cur.learn ? 'New line — think first, then an arrow shows the move.' : `Play your moves as ${ref.ch.color}.`,
    cur.learn ? 'info' : '',
  );
  renderMoves();
  renderNotes();
  later(advance, 350);
}

function renderCount() {
  if (session.kind === 'random') {
    const ok = session.done.filter((d) => d.ok).length;
    $('#d-count').textContent = `Round ${session.i + 1}${session.done.length ? ` · ${ok}/${session.done.length} passed` : ''}`;
    $('#d-progress').parentElement.hidden = true;
    return;
  }
  $('#d-progress').parentElement.hidden = false;
  $('#d-count').textContent = session.queue.length > 1 ? `Line ${session.i + 1} of ${session.queue.length}` : '';
  const doneHere = cur && cur.phase !== 'line' && cur.phase !== 'offbook' ? 1 : 0;
  $('#d-progress').style.width = ((session.i + doneHere) / session.queue.length) * 100 + '%';
}

function showRow(which) {
  $('#d-play').hidden = which !== 'play';
  $('#d-done').hidden = which !== 'done';
  $('#d-vs').hidden = which !== 'vs';
}

function syncBoard(userCanMove) {
  const turn = cur.chess.turn() === 'w' ? 'white' : 'black';
  cg.set({
    fen: cur.chess.fen(),
    turnColor: turn,
    check: cur.chess.inCheck() ? turn : false,
    movable: { color: userCanMove ? userColor() : undefined, dests: userCanMove ? dests(cur.chess) : new Map() },
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

function playMove(uci, extra = {}) {
  const mv = cur.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  cur.played.push({ san: mv.san, uci, fen: cur.chess.fen(), you: mv.color === userTurn(), ...extra });
  cg.set({ lastMove: [mv.from, mv.to] });
  return mv;
}

// play opponent moves until it's your turn or the line ends
function advance() {
  if (cur.phase !== 'line') return;
  const line = nodes();
  if (cur.pos >= line.length) return finishLine();
  if (!isUserMove(cur.pos)) {
    if (cur.surpriseAt === cur.pos) return surprise();
    playMove(line[cur.pos].uci, { node: line[cur.pos] });
    cur.pos++;
    syncBoard(false);
    renderMoves();
    renderNotes();
    return later(advance, cur.pos >= line.length ? 200 : 420);
  }
  cur.tries = 0;
  cur.shown = false;
  syncBoard(true);
  if (cur.learn) {
    // give a moment to think before the answer shows
    const pos = cur.pos;
    setMsg('Your move — have a think. The arrow shows in 2 seconds.', 'info');
    later(() => {
      if (cur.pos !== pos || cur.phase !== 'line' || cur.shown) return;
      cg.setAutoShapes([...studyShapes(pos), { orig: sq(line[pos].uci)[0], dest: sq(line[pos].uci)[1], brush: 'blue' }]);
      setMsg(`Play <b>${moveText(line[pos])}</b> (the blue arrow).`, 'info');
      cur.noteAhead = pos;
      renderNotes();
    }, ARROW_DELAY);
  } else if (cur.pos > 0) {
    setMsg(`Your move — after <b>${moveText(line[cur.pos - 1])}</b>.`, '');
  }
  cg.setAutoShapes(cur.learn ? studyShapes(cur.pos) : []);
}

// Maia plays a move the study doesn't cover; any reply that isn't a blunder passes
async function surprise() {
  const g = gen;
  cur.surpriseAt = null;
  setMsg('…', '');
  let moves;
  try {
    moves = await maiaMoves(fens());
  } catch {
    moves = null;
  }
  if (g !== gen) return;
  const book = new Set(nodes()[cur.pos].parent.children.map((c) => c.uci));
  const off = (moves || []).filter((m) => !book.has(m.uci) && m.p >= 0.03);
  if (!off.length) return advance(); // nothing human-like off the book — carry on as normal
  const pick = pickHuman(off, 0);
  const mv = playMove(pick.uci, { offbook: true });
  cur.phase = 'offbook';
  cur.surprised = true;
  cur.before = analyse(cur.chess.fen());
  syncBoard(true);
  renderMoves();
  renderNotes();
  setMsg(`<b>Surprise!</b> Maia left the study with <b>${mv.san}</b> (${Math.round(pick.p * 100)}% of 1900s play it). Find a good reply — anything but a blunder passes.`, 'info');
  cg.setAutoShapes([]);
}

// arrows the study drew for the move before `pos`
function studyShapes(pos) {
  const n = pos > 0 ? nodes()[pos - 1] : cur.root;
  return (n.shapes || []).map((s) => ({ ...s }));
}

function moveText(n) {
  const ply = n.ply - 1;
  return `${Math.floor(ply / 2) + 1}${ply % 2 ? '…' : '.'}${n.san}`;
}
// move number prefix for cur.played[k]; black moves get "12…" only when `always` or first
function moveNo(k, always = true) {
  const [, turn, , , , full] = cur.root.fen.split(' ');
  const ply = k + (turn === 'b' ? 1 : 0);
  const n = (+full || 1) + Math.floor(ply / 2);
  return ply % 2 === 0 ? `${n}.` : always || k === 0 ? `${n}…` : '';
}
const plyText = (k) => moveNo(k) + cur.played[k].san;

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
  if (!cur || !['line', 'offbook', 'play'].includes(cur.phase)) return;
  const g = gen;
  let promotion;
  if (needsPromotion(from, to)) promotion = await askPromotion();
  if (g !== gen) return;
  const u = from + to + (promotion || '');
  if (cur.phase === 'offbook') return answerSurprise(u);
  if (cur.phase === 'play') return playVsMaia(u);

  const node = nodes()[cur.pos];
  let target = node.uci === u ? node : null;
  // random mode: any of your repertoire moves is fine — follow a line through it
  if (!target && cur.ref.random) {
    const alt = node.parent.children.find((c) => c.uci === u);
    const lines = alt && cur.ref.ch.lines.filter((l) => l.nodes[cur.pos] === alt);
    if (lines && lines.length) {
      cur.ref = { ...cur.ref, line: lines[Math.floor(Math.random() * lines.length)] };
      target = alt;
    }
  }
  if (target) {
    const mv = playMove(u, { node: target });
    cur.pos++;
    syncBoard(false);
    renderMoves();
    renderNotes();
    if (!cur.learn) setMsg(`✓ <b>${mv.san}</b>`, 'good');
    cg.setAutoShapes([]);
    return later(advance, 260);
  }
  let san = u;
  try {
    san = new Chess(cur.chess.fen()).move({ from, to, promotion }).san;
  } catch {}
  if (node.parent.children.some((c) => c.uci === u)) {
    setMsg(`<b>${san}</b> is also in your repertoire — but this line goes another way. Try again.`, 'info');
  } else {
    cur.mistakes++;
    cur.tries++;
    setMsg(`✗ <b>${san}</b> isn't the move here.${cur.tries >= 2 ? ' The arrow shows it.' : ' Try again.'}`, 'bad');
    if (cur.tries >= 2) showMove(false);
  }
  const last = cur.played[cur.played.length - 1];
  later(() => {
    cg.set({ lastMove: last ? sq(last.uci) : undefined });
    syncBoard(true);
  }, 0);
}

async function answerSurprise(u) {
  const g = gen;
  const fenBefore = cur.chess.fen();
  const mv = playMove(u, { offbook: true });
  cur.phase = 'judging';
  syncBoard(false);
  renderMoves();
  setMsg(`<b>${mv.san}</b> — checking with Stockfish…`, '');
  let verdict;
  try {
    verdict = await judge(cur.before, cur.chess.fen());
  } catch (err) {
    verdict = null;
  }
  if (g !== gen) return;
  if (!verdict) {
    setMsg(`Couldn't run Stockfish on this device, so this one counts as a pass.`, '');
    return finishLine(true);
  }
  const bestSan = verdict.best ? new Chess(fenBefore).move({ from: verdict.best.slice(0, 2), to: verdict.best.slice(2, 4), promotion: verdict.best[4] }).san : null;
  const isBest = verdict.best === u;
  const bestNote = bestSan && !isBest ? ` Stockfish's choice was <b>${bestSan}</b>.` : '';
  if (verdict.best && !isBest) cg.setAutoShapes([{ orig: sq(verdict.best)[0], dest: sq(verdict.best)[1], brush: 'green' }]);
  if (verdict.label === 'blunder') {
    cur.mistakes++;
    cur.blunder = { fenBefore };
    setMsg(`✗ <b>${mv.san}</b> is a blunder (${scoreText(verdict.after, cur.chess.fen())} after it).${bestNote}`, 'bad');
    return finishLine(true);
  }
  const how = isBest ? 'the best move' : { good: 'a good move', inaccuracy: 'OK — a slight inaccuracy', mistake: 'not a blunder, but a mistake' }[verdict.label];
  setMsg(`✓ <b>${mv.san}</b> is ${how}.${bestNote}`, verdict.label === 'mistake' ? 'info' : 'good');
  finishLine(true);
}

function showMove(counts = true) {
  if (!cur || cur.phase !== 'line' || !isUserMove(cur.pos)) return;
  if (counts && !cur.learn && !cur.shown) cur.mistakes++;
  cur.shown = true;
  const [a, b] = sq(nodes()[cur.pos].uci);
  cg.setAutoShapes([{ orig: a, dest: b, brush: 'blue' }]);
}

// keepMsg: the surprise verdict is already on screen
function finishLine(keepMsg = false) {
  cur.phase = 'done';
  syncBoard(false);
  const ref = cur.ref;
  const key = ref.line.key;
  const e = db.entries[key];
  const now = Date.now();
  const ok = cur.mistakes === 0;
  const graded = !ref.practice && !ref.retry && !ref.random && !cur.again;
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
  if (!keepMsg) {
    cg.setAutoShapes(studyShapes(cur.pos));
    if (cur.learn) setMsg(`Line learned.${note}`, 'good');
    else if (ok) setMsg(`✓ Perfect.${note}`, 'good');
    else setMsg(`Done with ${cur.mistakes} mistake${cur.mistakes === 1 ? '' : 's'}.${note}${graded && session.kind !== 'line' ? " You'll see it again at the end of this session." : ''}`, 'bad');
  }
  showRow('done');
  $('#btn-again').textContent = cur.blunder ? 'Try another move' : 'Retry line';
  $('#btn-next').textContent = hasNext() ? 'Next line →' : 'Done ✓';
  renderCount();
  cur.view = cur.played.length;
  renderMoves();
  renderNotes();
}

// is there something after this line — the rest of the queue, or a fresh batch for the same scope?
function hasNext() {
  if (session.kind === 'random') return true;
  if (session.i < session.queue.length - 1) return true;
  return ['due', 'new', 'both'].includes(session.kind) && nextBatch().length > 0;
}
function nextBatch() {
  const seen = new Set(session.queue.map((r) => r.line.key));
  return batchFor(session).filter((r) => !seen.has(r.line.key) || lineState(r.line.key) === 'due');
}

function nextLine() {
  if (!session) return;
  if (session.kind === 'random') {
    session.queue.push(randomRef());
    session.i++;
    return loadLine();
  }
  if (session.i >= session.queue.length - 1 && ['due', 'new', 'both'].includes(session.kind)) {
    session.queue.push(...nextBatch());
  }
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
  showRow(null);
  $('#d-count').textContent = '';
  $('#d-progress').style.width = '100%';
  const t = tally(refsFor(opts.kind === 'line' ? { key: opts.key } : opts));
  setMsg(
    `<b>All done.</b> ${n} line${n === 1 ? '' : 's'}, ${perfect} perfect.${t.next < Infinity ? ` Next review in ${until(t.next)}.` : ''}` +
      `<div class="row" style="margin-top:10px">` +
      `<button class="btn primary grow" id="end-home">Back to library</button>` +
      `<button class="btn grow" id="end-practice">Practice these again</button>` +
      `<button class="btn grow" id="end-random">Random lines</button></div>`,
    'good',
  );
  const done = session.queue.filter((r) => !r.retry);
  $('#end-home').onclick = showHome;
  $('#end-random').onclick = () => startSession({ ...opts, kind: 'random', title: 'Random lines' });
  $('#end-practice').onclick = () => {
    session = { ...opts, kind: 'practice', queue: shuffle(done.map((r) => ({ ...r, practice: true, retry: false }))), i: 0, done: [] };
    loadLine();
  };
}

// ---------- play on vs Maia ----------
function startVsMaia() {
  if (!cur || cur.phase !== 'done') return;
  gen++;
  // continue from the real end of the game, not a replay position
  cur.phase = 'play';
  cur.view = null;
  cur.blunder = null;
  cur.feedback = null;
  cur.vsStatus = '';
  syncBoard(false);
  cg.setAutoShapes([]);
  showRow('vs');
  renderMoves();
  renderNotes();
  vsTurn();
}
// the message while playing Maia: feedback on your last move, then whose turn it is
function vsMsg(status) {
  if (status !== undefined) cur.vsStatus = status;
  const f = cur.feedback;
  setMsg((f ? `<div>${f.html}</div>` : '') + (cur.vsStatus ? `<div class="small">${cur.vsStatus}</div>` : ''), f ? f.kind : '');
}
function vsTurn() {
  const c = cur.chess;
  if (c.isGameOver()) {
    const why = c.isCheckmate() ? (c.turn() === userTurn() ? 'Checkmate — Maia wins.' : 'Checkmate — you win!') : c.isStalemate() ? 'Stalemate.' : 'Draw.';
    vsMsg(`${why} Take back to try again, or move on.`);
    return syncBoard(false);
  }
  if (c.turn() === userTurn()) {
    // start Stockfish on your position now, so the verdict on your move comes back fast
    const fen = c.fen();
    if (!cur.vsBefore || cur.vsBefore.fen !== fen) cur.vsBefore = { fen, p: analyse(fen) };
    syncBoard(true);
    return;
  }
  syncBoard(false);
  vsMsg('Maia is thinking…');
  const g = gen;
  maiaMoves(fens())
    .then((moves) => {
      if (g !== gen || cur.phase !== 'play') return;
      const pick = pickHuman(moves);
      const mv = playMove(pick.uci, { offbook: true });
      vsMsg(`Maia played <b>${mv.san}</b>. Your move.`);
      renderMoves();
      vsTurn();
    })
    .catch(() => g === gen && setMsg("Couldn't start Maia on this device.", 'bad'));
}
const MARK = { inaccuracy: '?!', mistake: '?', blunder: '??' };
function playVsMaia(u) {
  const fenBefore = cur.chess.fen();
  const before = cur.vsBefore && cur.vsBefore.fen === fenBefore ? cur.vsBefore.p : analyse(fenBefore);
  const mv = playMove(u, { offbook: true });
  const entry = cur.played[cur.played.length - 1];
  const fenAfter = cur.chess.fen();
  cur.feedback = { html: `<b>${mv.san}</b> — checking…`, kind: '' };
  judge(before, fenAfter)
    .then((v) => {
      if (!cur || !cur.played.includes(entry)) return; // taken back meanwhile
      const best = v.best && v.best !== u ? new Chess(fenBefore).move({ from: v.best.slice(0, 2), to: v.best.slice(2, 4), promotion: v.best[4] }).san : null;
      const label = v.best === u ? 'best' : v.label;
      const text = { best: 'best move', good: 'good move', inaccuracy: 'inaccuracy', mistake: 'mistake', blunder: 'blunder' }[label];
      const icon = { best: '✓', good: '✓', inaccuracy: '?!', mistake: '?', blunder: '??' }[label];
      entry.mark = MARK[label];
      entry.markKind = label;
      cur.feedback = {
        html: `${icon} <b>${mv.san}</b> — ${text} (${scoreText(v.after, fenAfter)})${best && label !== 'good' ? `. Better was <b>${best}</b>.` : '.'}`,
        kind: { best: 'good', good: 'good', inaccuracy: 'info', mistake: 'bad', blunder: 'bad' }[label],
      };
      if (cur.phase === 'play') vsMsg();
      renderMoves();
    })
    .catch(() => {
      if (cur && cur.played.includes(entry)) cur.feedback = null;
    });
  cg.setAutoShapes([]);
  renderMoves();
  vsTurn();
}
function takeBack() {
  if (!cur || cur.phase !== 'play') return;
  const min = cur.vsStart ?? 0;
  // undo back to your last move (Maia's reply plus yours)
  do {
    if (cur.played.length <= min) break;
    cur.chess.undo();
    cur.played.pop();
  } while (cur.chess.turn() !== userTurn());
  gen++;
  const last = cur.played[cur.played.length - 1];
  cg.set({ lastMove: last ? sq(last.uci) : undefined });
  cg.setAutoShapes([]);
  cur.feedback = null;
  renderMoves();
  vsMsg('Taken back. Your move.');
  vsTurn();
}
// the game so far as PGN: the study line, then the Maia game with your move marks
function gamePgn() {
  const c = cur.chess;
  const result = c.isCheckmate() ? (c.turn() === 'w' ? '0-1' : '1-0') : c.isDraw() || c.isStalemate() ? '1/2-1/2' : '*';
  const you = userColor() === 'white';
  const d = new Date();
  const tags = {
    Event: `Opening Drills: ${cur.ref.s.name} – ${cur.ref.ch.name}`,
    Site: location.origin + location.pathname,
    Date: `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`,
    White: you ? 'You' : 'Maia 1900',
    Black: you ? 'Maia 1900' : 'You',
    Result: result,
  };
  if (cur.root.fen !== START) Object.assign(tags, { SetUp: '1', FEN: cur.root.fen });
  const head = Object.entries(tags).map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join('\n');
  const parts = [];
  cur.played.forEach((p, k) => {
    if (k === (cur.vsStart ?? -1)) parts.push('{ Maia 1900 takes over }');
    const num = moveNo(k, k === cur.vsStart).replace('…', '...'); // PGN wants ASCII dots
    parts.push((num ? num + ' ' : '') + p.san + (p.mark || ''));
  });
  parts.push(result);
  return `${head}\n\n${parts.join(' ').replace(/(.{1,79})(\s|$)/g, '$1\n').trim()}\n`;
}
async function copyPgn() {
  const text = gamePgn();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // older browsers / no clipboard permission: copy through a hidden textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
  }
  const b = $('#btn-pgn');
  b.textContent = ok ? 'Copied ✓' : 'Copy failed';
  setTimeout(() => (b.textContent = 'Copy PGN'), 1600);
}
async function evaluateNow() {
  if (!cur) return;
  const fen = cur.chess.fen();
  setMsg('Stockfish is looking…', '');
  try {
    const s = await analyse(fen, 1500);
    if (!cur || cur.chess.fen() !== fen) return;
    const best = s.best ? new Chess(fen).move({ from: s.best.slice(0, 2), to: s.best.slice(2, 4), promotion: s.best[4] }).san : null;
    setMsg(`Stockfish: <b>${scoreText(s, fen)}</b>${best ? ` · best here is <b>${best}</b>` : ''}.`, '');
    if (s.best) cg.setAutoShapes([{ orig: sq(s.best)[0], dest: sq(s.best)[1], brush: 'green' }]);
  } catch {
    setMsg("Couldn't run Stockfish on this device.", 'bad');
  }
}

// ---------- moves, replay, notes ----------
// move list as numbered rows (1. d4 | Nf6), scrolling inside its own box
function renderMoves() {
  const played = cur.played;
  const replay = cur.phase === 'done' && cur.view !== null;
  const cells = played.map((p, k) => {
    const cls = [p.you ? 'you' : '', p.offbook ? 'off' : '', replay && cur.view === k + 1 ? 'on' : ''].filter(Boolean).join(' ');
    const ann = p.node && p.node.ann ? esc(p.node.ann) : p.mark ? `<span class="mk ${p.markKind}">${p.mark}</span>` : '';
    return `<button class="mv ${cls}" data-k="${k + 1}" ${replay ? '' : 'tabindex="-1"'}>${esc(p.san)}${ann}</button>`;
  });
  if ((cur.phase === 'line' && cur.pos < nodes().length && isUserMove(cur.pos)) || cur.phase === 'offbook') cells.push('<span class="mv cur">?</span>');
  const [, turn, , , , full] = cur.root.fen.split(' ');
  if (turn === 'b') cells.unshift('<span class="mv empty">…</span>');
  let html = cur.root.fen !== START ? '<div class="from">from position</div>' : '';
  for (let i = 0; i < cells.length; i += 2) {
    html += `<span class="no">${(+full || 1) + i / 2}.</span>${cells[i]}${cells[i + 1] || '<span></span>'}`;
  }
  const box = $('#moves');
  box.innerHTML = html || '<span class="muted">…</span>';
  box.classList.toggle('replay', replay);
  $('#replay').hidden = !replay;
  // keep the current move (or the newest) in view without scrolling the page
  const target = box.querySelector('.mv.on') || box.querySelector('.mv.cur') || box.lastElementChild;
  if (target) {
    const top = target.offsetTop; // #moves is position: relative, so this is already box-relative
    if (top < box.scrollTop) box.scrollTop = top - 4;
    else if (top + target.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + target.offsetHeight - box.clientHeight + 4;
  }
}

// replay: view = how many plies are on the board
function setView(k) {
  if (!cur || cur.phase !== 'done') return;
  cur.view = Math.max(0, Math.min(cur.played.length, k));
  const p = cur.played[cur.view - 1];
  const fen = p ? p.fen : cur.root.fen;
  const c = new Chess(fen);
  const turn = c.turn() === 'w' ? 'white' : 'black';
  cg.set({ fen, lastMove: p ? sq(p.uci) : undefined, turnColor: turn, check: c.inCheck() ? turn : false, movable: { color: undefined, dests: new Map() } });
  const node = p ? p.node : cur.root;
  cg.setAutoShapes(node && node.shapes ? node.shapes.map((s) => ({ ...s })) : []);
  renderMoves();
  renderNotes();
}

function YT(url) {
  const m = (url || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
// "(idea 5, 5:00)" → a link to that moment in the chapter's video
function linkify(text) {
  const vid = cur.ref.ch.video;
  const safe = esc(text).replace(/\s*\[([^\]]+)\]/g, (_, inner) => {
    const pct = inner.match(/plays this in (\d+)% of games/);
    return ` <span class="tag">${pct ? `played in ${pct[1]}% of games` : inner}</span>`;
  });
  if (!vid) return safe;
  return safe.replace(/\b(\d{1,2}):([0-5]\d)\b/g, (t, m, s) => `<a href="https://www.youtube.com/watch?v=${vid}&amp;t=${+m * 60 + +s}s" target="_blank" rel="noopener">▶ ${t}</a>`);
}
// first timestamp in this line's notes, for the "watch" link
function lineVideoTime() {
  if (!cur.ref.ch.video) return null;
  for (const n of [cur.root, ...nodes()]) {
    const m = (n.comment || '').match(/\b(\d{1,2}):([0-5]\d)\b/);
    if (m) return +m[1] * 60 + +m[2];
  }
  return null;
}

function noteHtml(label, text, { cls = '', you = false, kicker = '' } = {}) {
  const chip = label ? `<span class="mvchip${you ? ' you' : ''}">${esc(label)}</span>` : '';
  return `<div class="note ${cls}">${chip}<div class="body">${kicker ? `<span class="kicker">${kicker}</span>` : ''}${linkify(text)}</div></div>`;
}

function renderNotes() {
  if (cur.phase === 'play') {
    $('#notes-card').hidden = true;
    return;
  }
  const out = [];
  if (cur.phase === 'done' && cur.view !== null) {
    // replay: the note for the move on the board
    const p = cur.played[cur.view - 1];
    const node = p ? p.node : cur.root;
    if (node && node.comment) out.push(noteHtml(p ? plyText(cur.view - 1) : '', node.comment, { you: p && p.you }));
    else out.push(`<div class="note-empty">${p && p.offbook ? 'Off the study — no notes for this move.' : 'No note on this move.'} Step through with ◀ ▶.</div>`);
  } else {
    // teach mode: why the move you're about to play, revealed together with its arrow
    const next = cur.phase === 'line' && cur.learn && cur.noteAhead === cur.pos ? nodes()[cur.pos] : null;
    if (next && next.comment) out.push(noteHtml(moveText(next), next.comment, { cls: 'next', you: true, kicker: 'Your move' }));
    if (cur.root.comment && cur.played.length === 0) out.push(noteHtml('', cur.root.comment));
    // then the latest notes for moves already on the board, newest first
    let shown = 0;
    for (let k = cur.played.length - 1; k >= 0 && out.length < 2; k--) {
      const node = cur.played[k].node;
      if (!node || !node.comment) continue;
      out.push(noteHtml(plyText(k), node.comment, { cls: shown++ ? 'old' : '', you: cur.played[k].you }));
    }
  }
  const done = cur.phase === 'done' || cur.phase === 'play';
  const t = done && !cur.surprised ? lineVideoTime() : null;
  if (t !== null) out.push(`<div class="note-watch"><a href="https://www.youtube.com/watch?v=${cur.ref.ch.video}&amp;t=${t}s" target="_blank" rel="noopener">▶ Watch this idea in the video (${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')})</a></div>`);
  $('#notes').innerHTML = out.join('');
  $('#notes-card').hidden = !out.length;
}

function setMsg(html, kind) {
  const el = $('#msg');
  el.innerHTML = html;
  el.className = 'msg ' + (kind || '');
}

$('#btn-next').onclick = nextLine;
$('#btn-again').onclick = () => {
  if (cur && cur.blunder) {
    // undo your reply and try another answer to Maia's surprise
    gen++;
    cur.chess.undo();
    cur.played.pop();
    cur.blunder = null;
    cur.phase = 'offbook';
    session.done.pop();
    const last = cur.played[cur.played.length - 1];
    cg.set({ lastMove: last ? sq(last.uci) : undefined });
    cg.setAutoShapes([]);
    showRow('play');
    syncBoard(true);
    cur.view = null;
    renderMoves();
    renderNotes();
    setMsg(`Try another reply to <b>${last.san}</b>.`, 'info');
    return;
  }
  loadLine(true);
};
$('#btn-skip').onclick = () => {
  if (session && session.kind === 'random' && cur && cur.phase !== 'done') session.done.push({ ok: false });
  nextLine();
};
$('#btn-show').onclick = () => showMove(true);
$('#btn-hint').onclick = () => {
  if (!cur || cur.phase !== 'line' || !isUserMove(cur.pos)) return;
  if (!cur.learn && !cur.shown) cur.mistakes++;
  cur.shown = true;
  cg.setAutoShapes([{ orig: sq(nodes()[cur.pos].uci)[0], brush: 'blue' }]);
  setMsg('Hint: the circled piece moves.', 'info');
};
$('#btn-vs').onclick = () => {
  if (cur) cur.vsStart = cur.played.length;
  startVsMaia();
};
$('#btn-takeback').onclick = takeBack;
$('#btn-eval').onclick = evaluateNow;
$('#btn-pgn').onclick = copyPgn;
$('#btn-stopvs').onclick = () => {
  if (!cur) return;
  gen++;
  cur.phase = 'done';
  showRow('done');
  setView(cur.played.length);
  setMsg('Back to the line. Step through it with ◀ ▶, or move on.', '');
};
$('#moves').onclick = (e) => {
  const b = e.target.closest('button[data-k]');
  if (b && cur && cur.phase === 'done') setView(+b.dataset.k);
};
$('#replay').onclick = (e) => {
  const b = e.target.closest('button[data-step]');
  if (!b || !cur) return;
  const s = b.dataset.step;
  setView(s === 'start' ? 0 : s === 'end' ? cur.played.length : cur.view + +s);
};
$('#btn-home').onclick = showHome;
$('#home-link').onclick = () => session && showHome();
document.addEventListener('keydown', (e) => {
  if ($('#drill').hidden || e.target.matches('input, select, textarea')) return;
  if (cur && cur.phase === 'done' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    setView(cur.view + (e.key === 'ArrowLeft' ? -1 : 1));
  } else if ((e.key === 'Enter' || e.key === 'n') && cur && cur.phase === 'done') nextLine();
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
  $('#sync-code-label').textContent = st.code || sync.code;
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
function syncNote(text, error = false) {
  $('#sync-msg').hidden = !text;
  $('#sync-msg').textContent = text || '';
  $('#sync-msg').className = 'sync-status' + (error ? ' error' : '');
}
// don't rewrite the box while typing: phone keyboards compose text, and resetting the value cancels it.
// The code is shown in capitals by CSS and cleaned up on Connect.
$('#sync-join').onclick = async () => {
  const code = cleanCode($('#sync-code').value);
  if (code.length !== 5) {
    syncNote('Codes are 5 letters.', true);
    return $('#sync-code').focus();
  }
  syncNote('Connecting…');
  try {
    const ok = await sync.join(code);
    if (ok) {
      syncNote('');
      $('#sync-code').value = '';
    } else syncNote(`No sync found for ${code}. Check the letters — or create a new code on your first device.`, true);
  } catch (e) {
    syncNote(navigator.onLine ? `Couldn't connect: ${e.message}` : "You're offline — connect to the internet to set up sync.", true);
  }
};
$('#sync-code').onkeydown = (e) => e.key === 'Enter' && $('#sync-join').click();
// for the home-screen app: copy the code from a message, then tap Paste
$('#sync-paste').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    const code = cleanCode(text).slice(0, 5);
    if (code.length !== 5) return syncNote("The clipboard doesn't hold a 5-letter code. Copy the code first, then tap Paste.", true);
    $('#sync-code').value = code;
    $('#sync-join').click();
  } catch {
    syncNote("This browser didn't allow pasting — long-press the box and choose Paste instead.", true);
  }
};
// opening …/#sync=ABCDE connects this device without typing
async function joinFromLink() {
  const m = location.hash.match(/sync=([A-Za-z0-9]{5})/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (sync.connected && sync.code === cleanCode(m[1])) return;
  $('#sync-code').value = cleanCode(m[1]);
  $('#sync').scrollIntoView({ block: 'center' });
  $('#sync-join').click();
}
$('#sync-create').onclick = async () => {
  if (!confirm("Create a new sync code from this device's studies and progress? Use it on your other devices.")) return;
  syncNote('Creating…');
  try {
    await sync.create();
    syncNote('');
  } catch (e) {
    syncNote(navigator.onLine ? `Couldn't create a code: ${e.message}` : "You're offline — connect to the internet to set up sync.", true);
  }
};
$('#sync-now').onclick = () => sync.sync();
$('#sync-off').onclick = () => {
  if (confirm(`Stop syncing on this device? Your studies and progress stay here, and under code ${sync.code}.`)) sync.disconnect();
};

joinFromLink();
window.addEventListener('hashchange', joinFromLink); // link opened while the app is already open
renderHome();
renderSync({ state: sync.connected ? 'syncing' : 'off' });
if (sync.connected) sync.sync();
// refresh due counts when coming back to the app
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && !$('#home').hidden && renderHome());

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// test hook for local development only
if (location.hostname === 'localhost') window.__drill = { expected: () => (cur && cur.phase === 'line' && cur.ref.line.nodes[cur.pos] && isUserMove(cur.pos) ? cur.ref.line.nodes[cur.pos].uci : null), cur: () => cur, db: () => db, pgn: () => gamePgn() };
