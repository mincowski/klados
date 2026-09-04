/**
 * M0a / A6 — Windowed CodeMirror measurement, renderer side.
 *
 * THROWAWAY SPIKE CODE.
 *
 * CodeMirror never receives the whole document. It gets a window of bytes
 * around the current position, sliced at UTF-8 character boundaries, with
 * absolute offsets reconstructed as `origin + localOffset`. This measures
 * whether that holds up, for three window sizes, against the fixtures A5
 * flagged as scroll-limited.
 *
 * The file is read once as a Buffer (raw bytes, never decoded in full) and
 * reused across all three window sizes, so a 500 MB fixture is only read
 * from disk once per process.
 *
 * Per window size:
 *   0. Offset round-trip (correctness gate — run first; a failure here
 *      invalidates everything that follows for this window size)
 *   1. Open cost — cold editor, slice+decode+first paint
 *   2. Renderer RSS delta after open
 *   3. Keystroke p50/p95 at 1% / 50% / 99% of the *window*
 *   4. Scroll smoothness within the window (wheel-sized steps)
 *   5. Re-slice cost — 100 full-document replacements at random origins
 *   6. Re-slice under continuous scrolling — 20 boundary crossings with
 *      20% hysteresis, recording frame time and positional drift
 */

import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import fs from 'fs';
import { ipcRenderer } from 'electron';
import {
  nextFrame,
  settle,
  gc,
  rssMB,
  keystrokeLatency as keystrokeLatencyLib,
  scrollTest,
  stats,
  buildLineIndex,
  lineAt,
  computeOrigin,
  sliceWindow,
} from './harness-lib.js';

const params = new URLSearchParams(location.search);
const fixturePath = params.get('fixture');
const fixtureName = params.get('name') || fixturePath;
const WINDOW_SIZES = [
  ['256KB', 256 * 1024],
  ['1MB', 1024 * 1024],
  ['4MB', 4 * 1024 * 1024],
];

const statusEl = document.getElementById('status');
const editorHost = document.getElementById('editor');
let lastStatus = 'starting';
const setStatus = (s) => {
  lastStatus = s;
  statusEl.textContent = `${fixtureName}: ${s}`;
};

// Ring buffer of recent actions, for diagnosing errors CodeMirror throws
// asynchronously off its own internal rAF-scheduled work — outside any
// promise our own await chain is watching, so they never reach our
// try/catch and would otherwise just hang until the harness's timeout.
const crumbs = [];
function crumb(label, data) {
  crumbs.push({ label, data, t: +performance.now().toFixed(1) });
  if (crumbs.length > 15) crumbs.shift();
}

let errorReported = false;
window.addEventListener('error', (e) => {
  if (errorReported) return; // one report is enough; more just delay exit
  errorReported = true;
  ipcRenderer.send('result', {
    fixture: fixtureName,
    ok: false,
    error: `window.onerror during "${lastStatus}": ${e.message}`,
    stack: e.error && e.error.stack,
    crumbs,
  });
});

const keystrokeLatency = (view, frac, count) => keystrokeLatencyLib(view, EditorView, frac, count);

// ---------------------------------------------------------------------------
// A cold editor for a given window: destroys any previous view, builds a
// fresh EditorState over the decoded slice, and reports open cost.
// `lineBase` is a mutable ref so formatNumber stays correct after a reslice
// without reconfiguring the extension — cheaper than a Compartment, and this
// is throwaway code.
// ---------------------------------------------------------------------------

function makeFormatNumber(lineBaseRef) {
  return (n) => String(n + lineBaseRef.value);
}

function openWindow(buf, origin, windowBytes, lineStarts, prevView) {
  if (prevView) prevView.destroy();
  editorHost.replaceChildren();

  const { start, end, text } = sliceWindow(buf, origin, windowBytes);
  const lineBaseRef = { value: lineAt(lineStarts, start) }; // 0-based

  const t0 = performance.now();
  const state = EditorState.create({
    doc: text,
    extensions: [lineNumbers({ formatNumber: makeFormatNumber(lineBaseRef) })],
  });
  const view = new EditorView({ state, parent: editorHost });
  return { view, start, end, lineBaseRef, openMs: () => performance.now() - t0 };
}

/** Replaces the whole window document at a new origin. Returns elapsed ms. */
function resliceTo(handle, buf, origin, windowBytes, lineStarts) {
  const { start, end, text } = sliceWindow(buf, origin, windowBytes);
  handle.lineBaseRef.value = lineAt(lineStarts, start);
  const t0 = performance.now();
  handle.view.dispatch({
    changes: { from: 0, to: handle.view.state.doc.length, insert: text },
  });
  handle.start = start;
  handle.end = end;
  return { ms: performance.now() - t0, start, end };
}

// ---------------------------------------------------------------------------
// Step 0 — offset round-trip. Correctness gate, not a benchmark.
// ---------------------------------------------------------------------------

function offsetRoundTrip(buf, fileLen, windowBytes, lineStarts) {
  const checks = [];
  for (const [label, frac] of [['1%', 0.01], ['50%', 0.5], ['99%', 0.99]]) {
    const targetAbs = Math.min(fileLen - 1, Math.max(0, Math.floor(fileLen * frac)));
    const origin = computeOrigin(targetAbs, windowBytes, fileLen);
    const { view, start, end } = openWindow(buf, origin, windowBytes, lineStarts, null);

    const localOffset = targetAbs - start;
    const inRange = localOffset >= 0 && localOffset < view.state.doc.length;
    let reconstructed = null;
    let charOk = null;
    if (inRange) {
      view.dispatch({ changes: { from: localOffset, insert: 'X' } });
      reconstructed = start + localOffset;
      charOk = view.state.sliceDoc(localOffset, localOffset + 1) === 'X';
    }
    view.destroy();

    checks.push({
      label,
      targetAbs,
      origin,
      windowStart: start,
      windowEnd: end,
      localOffset,
      inRange,
      reconstructedAbs: reconstructed,
      arithmeticOk: inRange ? reconstructed === targetAbs : null,
      charOk,
    });
  }
  const ok = checks.every((c) => c.inRange && c.arithmeticOk && c.charOk);
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// Step 5 — re-slice cost at random origins (mulberry32, seeded for repeatability)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function resliceCostTest(handle, buf, fileLen, windowBytes, lineStarts, count = 100) {
  const rnd = mulberry32(0xa6);
  const el = handle.view.scrollDOM;
  const times = [];
  for (let i = 0; i < count; i++) {
    const origin = Math.floor(rnd() * Math.max(1, fileLen - windowBytes));
    if (i % 20 === 0) crumb('reslice:iter', { i, origin });
    const t0 = performance.now();
    resliceTo(handle, buf, origin, windowBytes, lineStarts);
    // See boundaryCrossingTest for why this reset can't be skipped: a stale
    // scrollTop against the new document's height is what hangs the renderer.
    el.scrollTop = 0;
    await nextFrame();
    times.push(performance.now() - t0);
  }
  return stats(times);
}

// ---------------------------------------------------------------------------
// Step 6 — re-slice under continuous scrolling.
//
// Scrolls in wheel-sized steps. When the viewport passes 80% depth into the
// window (20% hysteresis from the far edge), re-centres: the byte currently
// at the top of the viewport is placed 20% into the *new* window, so there
// is 80% of fresh window left to scroll through before the next crossing.
// Drift is the gap between the pre- and post-reslice absolute offset of that
// same byte (and, separately, of the caret) — it must be 0.
// ---------------------------------------------------------------------------

function absTopOffset(handle) {
  // lineBlockAtHeight(scrollTop) gives the exact line at a pixel height, but
  // an earlier bug fed it a fractional offset and it threw ("No tile at
  // position …") off CodeMirror's own async measure pass rather than
  // synchronously — see harness-lib's sliceWindow for the actual root cause,
  // which is now fixed. Preferred when it works: viewportLineBlocks[0] is
  // biased ~800 B early in practice, consistent with CodeMirror overscan-
  // rendering a margin above the requested scroll target and reporting that
  // as the first block. Falls back only if something still throws.
  try {
    const height = Math.round(Math.max(0, Math.min(handle.view.scrollDOM.scrollTop, handle.view.contentHeight)));
    return handle.start + handle.view.lineBlockAtHeight(height).from;
  } catch {
    const blocks = handle.view.viewportLineBlocks;
    const top = blocks.length ? blocks[0].from : 0;
    return handle.start + top;
  }
}

function absCaretOffset(handle) {
  return handle.start + handle.view.state.selection.main.head;
}

async function boundaryCrossingTest(handle, buf, fileLen, windowBytes, lineStarts, crossings = 20) {
  const el = handle.view.scrollDOM;
  el.scrollTop = 0;
  await settle(5);

  // A single-line document (the minified JSON fixture) has almost no
  // vertical scroll range within any window — the whole window is one huge
  // line — so scrollTop can never advance and the loop below would just
  // spin against its safety valve for minutes. Same situation A2 already
  // flagged for min.json's scroll test ("0% over 32ms is meaningless" —
  // there is nothing to scroll). Reported explicitly rather than silently
  // producing a misleadingly clean 0-crossings result.
  if (el.scrollHeight <= el.clientHeight) {
    return {
      skipped: true,
      reason: 'no vertical scroll range within this window (content fits in one viewport)',
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }

  // A fixed 100 px step (the realistic mouse-wheel size used elsewhere in
  // this harness) is fine for a whole-file scrollHeight, but a window is
  // small on purpose — even the 256 KB window still holds ~8,000 lines
  // (~160,000 px), and climbing that 100 px at a time means over 1,000
  // awaited frames just to reach the first crossing, and again after every
  // one of the 20. That is a self-inflicted hang, not a measurement. The
  // step is scaled to the window's own height instead, so ~60 steps span it
  // regardless of window size — still genuinely incremental scrolling
  // (nothing here jumps straight to the trigger point), just not wheel-sized.
  const stepPx = () => Math.max(20, Math.round((el.scrollHeight || 1) / 60));
  const crossingFrameMs = [];
  const topDriftBytes = [];
  const caretDriftBytes = [];
  const allIntervals = [];
  let last = performance.now();
  let crossed = 0;
  let iterations = 0;
  const maxIterations = crossings * 400; // safety valve

  while (crossed < crossings && iterations++ < maxIterations) {
    const ratio = el.scrollHeight > 0 ? el.scrollTop / (el.scrollHeight - el.clientHeight || 1) : 0;

    if (ratio >= 0.8) {
      crumb('crossing:start', { ratio, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      const topAbsBefore = absTopOffset(handle);
      // Caret is re-anchored just past the tracked top-of-viewport byte on
      // every crossing, not carried forward from wherever it landed last
      // time. A caret carried across many crossings while the window pans
      // forward eventually falls outside the *next* window's byte range
      // entirely — CodeMirror then silently clamps the out-of-range
      // selection into range, and that clamp is indistinguishable from real
      // drift in this measurement. Anchoring near the tracked point keeps
      // the caret guaranteed in-window on both sides of the reslice, so a
      // nonzero result here means CodeMirror actually failed to preserve
      // position, not that the test walked off the edge of its own window.
      const caretLocalBefore = Math.min(handle.view.state.doc.length, topAbsBefore - handle.start + 500);
      handle.view.dispatch({ selection: { anchor: caretLocalBefore } });
      const caretAbsBefore = absCaretOffset(handle);
      crumb('crossing:before', { topAbsBefore, caretAbsBefore, start: handle.start, end: handle.end });

      // computeOrigin() centres a window; here the tracked byte needs to land
      // at ~20% depth from the top (hysteresis), not the middle, so solve
      // for that directly instead. Must be an integer byte offset — a
      // fractional one (windowBytes * 0.2 is 52428.8 for a 256KB window)
      // silently defeats snapForward's continuation-byte check ((undefined &
      // 0xc0) is falsy, so the loop never advances) and the fractional
      // offset propagates all the way into scrollIntoView, where CodeMirror
      // throws trying to resolve a "tile" at a non-integer position.
      const wantedOrigin = Math.floor(
        Math.max(0, Math.min(topAbsBefore - windowBytes * 0.2, Math.max(0, fileLen - windowBytes))),
      );

      const t0 = performance.now();
      const { start } = resliceTo(handle, buf, wantedOrigin, windowBytes, lineStarts);
      crumb('crossing:resliced', { wantedOrigin, start, docLen: handle.view.state.doc.length });

      // The document just got a new (possibly much shorter) height. Leaving
      // scrollTop at its pre-swap value makes CodeMirror query its height map
      // at a now-invalid position on its next internal measure pass — thrown
      // asynchronously off a rAF callback we never see, which just hangs the
      // rest of the run. Reset before anything else touches geometry.
      el.scrollTop = 0;
      await nextFrame();
      crumb('crossing:scrollReset', { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight });

      const newTopLocal = Math.max(0, Math.min(handle.view.state.doc.length - 1, topAbsBefore - start));
      const newCaretLocal = Math.max(0, Math.min(handle.view.state.doc.length, caretAbsBefore - start));
      crumb('crossing:beforeScrollIntoView', { newTopLocal, newCaretLocal, docLen: handle.view.state.doc.length });
      handle.view.dispatch({
        selection: { anchor: newCaretLocal },
        effects: EditorView.scrollIntoView(newTopLocal, { y: 'start' }),
      });
      crumb('crossing:dispatched', {});
      await nextFrame();
      crumb('crossing:afterFrame', { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight });
      const ms = performance.now() - t0;
      crossingFrameMs.push(+ms.toFixed(2));

      // The frame-time measurement above stops at one rAF, matching what a
      // user actually waits for. Drift is read after a few more frames —
      // CodeMirror's viewport plugin does an initial coarse pass and refines
      // over subsequent frames, so reading back immediately can report the
      // coarse pass's imprecision as if it were true positional drift.
      await settle(3);
      const topAbsAfter = absTopOffset(handle);
      const caretAbsAfter = absCaretOffset(handle);
      crumb('crossing:after', { topAbsAfter, caretAbsAfter });
      // topAbsAfter is read back from viewportLineBlocks after scrollIntoView,
      // which snaps to a rendered block's start, so compare against what we
      // *asked* for (start + newTopLocal), the position we meant to preserve.
      topDriftBytes.push(topAbsAfter - (start + newTopLocal));
      caretDriftBytes.push(caretAbsAfter - caretAbsBefore);

      crossed++;
      last = performance.now();
      continue;
    }

    el.scrollTop += stepPx();
    if (iterations % 25 === 0) crumb('scroll:step', { iterations, scrollTop: el.scrollTop, ratio });
    await nextFrame();
    const now = performance.now();
    allIntervals.push(now - last);
    last = now;
  }

  return {
    crossings: crossed,
    iterations,
    frameMs: crossingFrameMs,
    frameStats: crossingFrameMs.length ? stats(crossingFrameMs) : null,
    topDriftBytes,
    caretDriftBytes,
    maxAbsTopDrift: topDriftBytes.length ? Math.max(...topDriftBytes.map(Math.abs)) : null,
    maxAbsCaretDrift: caretDriftBytes.length ? Math.max(...caretDriftBytes.map(Math.abs)) : null,
    normalScrollStats: allIntervals.length ? stats(allIntervals) : null,
  };
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

async function measureOneWindowSize(buf, fileLen, windowBytes, lineStarts) {
  const out = {};

  // ---- 0. offset round-trip (gate) ----
  setStatus(`round-trip check…`);
  out.offsetRoundTrip = offsetRoundTrip(buf, fileLen, windowBytes, lineStarts);
  if (!out.offsetRoundTrip.ok) {
    out.ok = false;
    out.error = 'offset round-trip failed — see offsetRoundTrip.checks';
    return out;
  }

  // ---- 1/2. open cost + memory, cold editor at origin 0 ----
  setStatus('opening window…');
  gc();
  await settle(3);
  const baselineRss = rssMB();

  const handle = openWindow(buf, 0, windowBytes, lineStarts, null);
  await nextFrame(); // first paint
  out.openMs = +handle.openMs().toFixed(1);
  out.windowStart = handle.start;
  out.windowEnd = handle.end;
  out.windowChars = handle.view.state.doc.length;

  await settle(5);
  gc();
  await settle(5);
  out.afterOpenRssMB = +rssMB().toFixed(1);
  out.rssDeltaMB = +(out.afterOpenRssMB - baselineRss).toFixed(1);

  // ---- 3. keystroke latency within the window ----
  for (const [label, frac] of [['1%', 0.01], ['50%', 0.5], ['99%', 0.99]]) {
    setStatus(`typing at ${label} of window…`);
    out[`keystroke_${label}`] = await keystrokeLatency(handle.view, frac);
  }

  // ---- 4. scroll within the window ----
  setStatus('scrolling within window…');
  out.scrollWheel = await scrollTest(handle.view, 200, 100);

  // ---- 5. re-slice cost ----
  setStatus('re-slicing at random origins…');
  out.reslice = await resliceCostTest(handle, buf, fileLen, windowBytes, lineStarts);

  // ---- 6. re-slice under continuous scrolling ----
  setStatus('scrolling across window boundaries…');
  out.boundaryCrossing = await boundaryCrossingTest(handle, buf, fileLen, windowBytes, lineStarts);

  handle.view.destroy();
  out.ok = true;
  return out;
}

async function run() {
  const result = { fixture: fixtureName, gcExposed: gc(), windows: {} };

  try {
    setStatus('reading file (bytes, not decoded)…');
    const tRead0 = performance.now();
    const buf = fs.readFileSync(fixturePath); // Buffer, i.e. Uint8Array — never .toString()
    result.readMs = +(performance.now() - tRead0).toFixed(0);
    result.fileMB = +(buf.length / 1024 / 1024).toFixed(1);
    const fileLen = buf.length;

    setStatus('building line index (byte scan, no decode)…');
    const tIdx0 = performance.now();
    const lineStarts = buildLineIndex(buf);
    result.lineIndexMs = +(performance.now() - tIdx0).toFixed(0);
    result.totalLines = lineStarts.length;

    for (const [label, windowBytes] of WINDOW_SIZES) {
      setStatus(`window ${label}…`);
      result.windows[label] = await measureOneWindowSize(buf, fileLen, windowBytes, lineStarts);
    }

    result.ok = Object.values(result.windows).every((w) => w.ok);
    setStatus('done');
  } catch (err) {
    result.ok = false;
    result.error = String((err && err.stack) || err);
    setStatus('ERROR: ' + result.error);
  }

  ipcRenderer.send('result', result);
}

run();
