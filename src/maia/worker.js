// Runs Maia off the main thread. Request: { id, fens } → reply: { id, moves } or { id, error }.
import { loadNet, evaluate } from './net.js';

const ready = fetch('maia-1900.bin')
  .then((r) => {
    if (!r.ok) throw new Error(`couldn't load Maia (${r.status})`);
    return r.arrayBuffer();
  })
  .then(loadNet);

self.onmessage = async (e) => {
  const { id, fens } = e.data;
  try {
    const net = await ready;
    self.postMessage({ id, moves: evaluate(net, fens) });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
