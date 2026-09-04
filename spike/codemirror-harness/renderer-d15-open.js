/**
 * M1 D15 — end-to-end open time + main-thread responsiveness during parse.
 *
 * THROWAWAY MEASUREMENT HARNESS. Not part of the product, not tested.
 *
 * Unlike A2/A6 (which measured CodeMirror against synthetic data), this
 * drives the *real* production worker protocol: the actual built
 * `parse.worker.ts` output (passed in as `workerUrl`, produced by
 * `electron-vite build` — not a copy, the shipped artifact) and the real
 * `Interner`/`NodeStore`/`SourceBuffer` rehydration path
 * (`core/parseClient.ts`'s `rehydrateParseResult`, reimplemented inline
 * below rather than imported — importing `parseClient.ts` itself would
 * pull its `new Worker(new URL(...))` construction into this bundle too,
 * which Vite's worker plugin would try to bundle a second time for no
 * reason).
 *
 * A `requestAnimationFrame` loop runs continuously from just before the
 * worker is sent the job until just after it resolves, recording every
 * frame gap — this is the real test of B11's deferred claim: parsing
 * off-thread means the render thread's own frame cadence should barely
 * notice, no matter how long the parse takes.
 */
import { ipcRenderer } from 'electron';
import fs from 'fs';
import { Interner } from '../../src/core/interner';
import { NodeStore } from '../../src/core/nodeStore';
import { SourceBuffer } from '../../src/core/buffer';
import { nextFrame, gc, rssMB, stats } from './harness-lib.js';

const params = new URLSearchParams(location.search);
const fixturePath = params.get('fixture');
const fixtureName = params.get('name');
const workerUrl = params.get('workerUrl');

const statusEl = document.getElementById('status');
const setStatus = (s) => {
  statusEl.textContent = s;
};

let errorReported = false;
window.addEventListener('error', (e) => {
  if (errorReported) return;
  errorReported = true;
  ipcRenderer.send('result', {
    ok: false,
    fixture: fixtureName,
    error: `window.onerror: ${e.message}`,
    stack: e.error && e.error.stack,
  });
});

/** The exact reconstruction `parseClient.ts`'s `rehydrateParseResult` does
 * — copied rather than imported, see the module comment. */
function rehydrate(response) {
  const interner = Interner.fromBuffers(
    response.internerBuffers.nameBytes,
    response.internerBuffers.starts,
    response.internerBuffers.ends,
  );
  const bytes = new Uint8Array(response.bytes);
  const store = NodeStore.fromBuffers(bytes, interner, response.storeBuffers);
  const sourceBuffer = new SourceBuffer(bytes, response.encoding, response.bomLength);
  return { store, sourceBuffer, rowIndex: response.rowIndex, lineIndex: response.lineIndex };
}

async function run() {
  setStatus('reading fixture from disk...');
  const buf = fs.readFileSync(fixturePath);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  // Captured now, not read back after the fact — `bytes` is the buffer
  // *transferred* to the worker below (`postMessage(request, [bytes])`),
  // which detaches it on this side; `bytes.byteLength` would read 0 by the
  // time the result is reported.
  const sizeBytes = bytes.byteLength;

  gc();
  await new Promise((r) => setTimeout(r, 100));
  const baselineRssMB = rssMB();

  // Runs continuously through the whole parse, not sampled — every frame
  // gap is recorded so a single stall is visible in the max/p95, not
  // averaged away.
  const frameGaps = [];
  let rafRunning = true;
  let last = performance.now();
  function rafLoop() {
    if (!rafRunning) return;
    const now = performance.now();
    frameGaps.push(now - last);
    last = now;
    requestAnimationFrame(rafLoop);
  }
  requestAnimationFrame(rafLoop);
  await nextFrame(); // let the loop actually start before t0

  setStatus(`parsing ${fixtureName} via the real built worker...`);
  const t0 = performance.now();

  const response = await new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    const requestId = 1;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.requestId !== requestId) return;
      if (msg.type === 'progress') return;
      if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
        return;
      }
      worker.terminate();
      resolve(msg);
    };
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage({ type: 'parse', requestId, bytes, filename: fixtureName }, [bytes]);
  });

  const parseWorkerMs = performance.now() - t0;
  await nextFrame(); // one more frame, standing in for "first paint"
  const totalMs = performance.now() - t0;
  rafRunning = false;

  setStatus('rehydrating...');
  const rehydrateT0 = performance.now();
  const rehydrated = rehydrate(response);
  const rehydrateMs = performance.now() - rehydrateT0;

  gc();
  await new Promise((r) => setTimeout(r, 100));
  const afterRssMB = rssMB();

  const frameStats = frameGaps.length ? stats(frameGaps) : null;
  const over32 = frameGaps.filter((g) => g > 32).length;
  const meanGap = frameGaps.length
    ? frameGaps.reduce((a, b) => a + b, 0) / frameGaps.length
    : null;

  ipcRenderer.send('result', {
    ok: true,
    fixture: fixtureName,
    sizeBytes,
    complete: response.complete,
    nodeCount: rehydrated.store.nodeCount,
    rowCount: rehydrated.rowIndex.length,
    lineCount: rehydrated.lineIndex.lineCount,
    parseWorkerMs: +parseWorkerMs.toFixed(1),
    rehydrateMs: +rehydrateMs.toFixed(2),
    totalMs: +totalMs.toFixed(1),
    frameCount: frameGaps.length,
    frameStats,
    framesOver32ms: over32,
    approxFpsDuringParse: meanGap ? +(1000 / meanGap).toFixed(1) : null,
    baselineRssMB: +baselineRssMB.toFixed(1),
    afterRssMB: +afterRssMB.toFixed(1),
  });
  setStatus('done');
}

run().catch((err) => {
  ipcRenderer.send('result', {
    ok: false,
    fixture: fixtureName,
    error: String((err && err.stack) || err),
  });
});
