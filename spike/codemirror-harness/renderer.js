/**
 * M0a / A2 — CodeMirror 6 measurement, renderer side.
 *
 * THROWAWAY SPIKE CODE.
 *
 * Measures, for one fixture:
 *   1. load time      — readFile complete -> first paint of the editor
 *   2. memory         — renderer RSS delta across the load, after forced GC
 *   3. keystroke p50/p95 at 1% / 50% / 99% of the document, 100 samples each
 *   4. scroll         — 200 viewports, % of frames over 32 ms
 *   5. full replace   — one transaction replacing the whole document
 *
 * Editor is configured per M0-PLAN A2: no syntax highlighting, no history
 * extension, line numbers on, line wrapping off.
 */

import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import fs from 'fs';
import { ipcRenderer } from 'electron';
import { nextFrame, settle, gc, rssMB, keystrokeLatency as keystrokeLatencyLib, scrollTest } from './harness-lib.js';

const params = new URLSearchParams(location.search);
const fixturePath = params.get('fixture');
const fixtureName = params.get('name') || fixturePath;

const statusEl = document.getElementById('status');
const setStatus = (s) => {
  statusEl.textContent = `${fixtureName}: ${s}`;
};

const keystrokeLatency = (view, frac, count) => keystrokeLatencyLib(view, EditorView, frac, count);

async function run() {
  const result = { fixture: fixtureName, gcExposed: gc() };

  try {
    // ---------- baseline ----------
    gc();
    await settle(3);
    const baselineRss = rssMB();
    result.baselineRssMB = +baselineRss.toFixed(1);

    // ---------- read ----------
    setStatus('reading…');
    const tRead0 = performance.now();
    let text = fs.readFileSync(fixturePath, 'utf8');
    result.readMs = +(performance.now() - tRead0).toFixed(0);
    result.docChars = text.length;
    result.fileMB = +(fs.statSync(fixturePath).size / 1024 / 1024).toFixed(1);

    // ---------- load: readFile complete -> first paint ----------
    setStatus('building editor…');
    const tLoad0 = performance.now();
    const state = EditorState.create({
      doc: text,
      extensions: [lineNumbers()], // no highlighting, no history, no wrapping
    });
    const view = new EditorView({ state, parent: document.getElementById('editor') });
    await nextFrame(); // first paint
    result.loadMs = +(performance.now() - tLoad0).toFixed(0);
    result.lines = view.state.doc.lines;

    // Drop our own reference so the measurement reflects CodeMirror's copy,
    // not CodeMirror's copy plus the source string.
    text = null;
    await settle(5);
    gc();
    await settle(5);

    result.afterLoadRssMB = +rssMB().toFixed(1);
    result.memoryDeltaMB = +(result.afterLoadRssMB - baselineRss).toFixed(1);

    // ---------- keystroke latency ----------
    for (const [label, frac] of [['1%', 0.01], ['50%', 0.5], ['99%', 0.99]]) {
      setStatus(`typing at ${label}…`);
      result[`keystroke_${label}`] = await keystrokeLatency(view, frac);
    }

    // ---------- scroll ----------
    // Two modes, because they answer different questions:
    //  - viewport jumps: worst case, page-down style, forces a full re-render
    //  - 100 px steps:   realistic mouse-wheel scrolling
    setStatus('scrolling (viewport jumps)…');
    result.scroll = await scrollTest(view);

    setStatus('scrolling (wheel-sized steps)…');
    result.scrollWheel = await scrollTest(view, 200, 100);

    // ---------- full document replacement ----------
    setStatus('replacing document…');
    const replacement = fs.readFileSync(fixturePath, 'utf8');
    await settle(3);
    const tRep0 = performance.now();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: replacement },
    });
    await nextFrame();
    result.fullReplaceMs = +(performance.now() - tRep0).toFixed(0);

    gc();
    await settle(3);
    result.finalRssMB = +rssMB().toFixed(1);
    result.ok = true;
    setStatus('done');
  } catch (err) {
    result.ok = false;
    result.error = String((err && err.stack) || err);
    setStatus('ERROR: ' + result.error);
  }

  ipcRenderer.send('result', result);
}

run();
