// Studies + progress sync by a short code, stored in Supabase (see supabase/sync.sql).
// State shape: { entries: { [lineKey]: { b, d, t } }, studies: { [id]: { ..., t, del? } }, resetAt: ms }
// Merge is last-write-wins per line and per study; a reset wipes progress older than it.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const SYNC_KEY = 'opening-drills-code';
// no 0/O, 1/I/L — easy to read off one screen and type on another
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function lww(a = {}, b = {}, floor = 0) {
  const out = {};
  for (const src of [a, b]) {
    for (const [k, e] of Object.entries(src)) {
      if (e.t <= floor) continue;
      if (!out[k] || e.t > out[k].t) out[k] = e;
    }
  }
  return out;
}

export function mergeStates(a, b) {
  const resetAt = Math.max(a.resetAt || 0, b.resetAt || 0);
  return { entries: lww(a.entries, b.entries, resetAt), studies: lww(a.studies, b.studies), resetAt };
}

const EMPTY = { entries: {}, studies: {}, resetAt: 0 };
const stable = (v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
    : JSON.stringify(v);
const same = (a, b) => stable(mergeStates(a, EMPTY)) === stable(mergeStates(b, EMPTY));

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`server error ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const readRemote = (code) => rpc('drill_get', { p_code: code });
const writeRemote = (code, state) => rpc('drill_put', { p_code: code, p_state: state });

export function createSync({ getState, applyState, onStatus }) {
  let cfg = {};
  try {
    cfg = JSON.parse(localStorage.getItem(SYNC_KEY)) || {};
  } catch {}
  const saveCfg = () => {
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
    } catch {}
  };

  let running = null;
  let again = false;

  async function run() {
    if (!cfg.code) return onStatus({ state: 'off' });
    if (!navigator.onLine) return onStatus({ state: 'offline', at: cfg.lastSync, code: cfg.code });
    onStatus({ state: 'syncing', at: cfg.lastSync, code: cfg.code });
    try {
      const remote = (await readRemote(cfg.code)) || EMPTY;
      const local = getState();
      const merged = mergeStates(local, remote);
      if (!same(merged, remote)) await writeRemote(cfg.code, merged);
      if (!same(merged, local)) applyState(merged);
      cfg.lastSync = Date.now();
      saveCfg();
      onStatus({ state: 'ok', at: cfg.lastSync, code: cfg.code });
    } catch (e) {
      onStatus({ state: 'error', message: navigator.onLine ? e.message || String(e) : "you're offline", at: cfg.lastSync, code: cfg.code });
    }
  }

  function sync() {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
      if (again) {
        again = false;
        sync();
      }
    });
    return running;
  }

  let timer;
  const syncSoon = (ms = 1500) => {
    clearTimeout(timer);
    timer = setTimeout(sync, ms);
  };

  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());

  return {
    get connected() {
      return !!cfg.code;
    },
    get code() {
      return cfg.code || '';
    },
    // join an existing code; resolves false if nobody has used that code yet
    async join(raw) {
      const code = cleanCode(raw);
      if (code.length !== 5) throw new Error('Codes are 5 letters.');
      onStatus({ state: 'syncing', code });
      const remote = await readRemote(code);
      if (!remote) {
        onStatus({ state: 'off' });
        return false;
      }
      cfg = { code };
      saveCfg();
      await sync();
      return true;
    },
    // start a new code from this device's studies and progress
    async create() {
      for (let tries = 0; tries < 5; tries++) {
        const code = Array.from(crypto.getRandomValues(new Uint32Array(5)), (n) => ALPHABET[n % ALPHABET.length]).join('');
        if (await readRemote(code)) continue; // taken — try another
        await writeRemote(code, getState());
        cfg = { code };
        saveCfg();
        await sync();
        return code;
      }
      throw new Error("Couldn't find a free code — try again.");
    },
    disconnect() {
      cfg = {};
      saveCfg();
      onStatus({ state: 'off' });
    },
    sync,
    syncSoon,
  };
}
