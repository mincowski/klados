/**
 * M0a / A6b — Windowing confirmation, renderer side.
 *
 * THROWAWAY SPIKE CODE.
 *
 * A6's mechanical "stop and report" rested on two things it inferred rather
 * than measured: that a full-document-replace re-slice is the ceiling on
 * crossing cost, and that soft wrap would give a minified document a
 * scrollable window. This confirms both.
 *
 * Part 1 — incremental re-windowing at 1 MB on cars-500mb.xml: replace A6's
 * full-document dispatch with the two edge changes a re-centred window
 * actually represents (drop the leading edge, append the trailing edge,
 * leave the shared middle alone), and see whether CodeMirror's own
 * change-mapping preserves scroll position and caret without any manual
 * repositioning — including whether the scrollTop=0 reset A6's bug 2 needed
 * is still required.
 *
 * Part 2 — soft wrap at 1 MB on cars-100mb.min.json: confirm wrap gives a
 * single-line document a vertical scroll surface at all (A6 could not test
 * boundary crossing on this fixture for exactly this reason), then measure
 * keystroke/scroll/crossing cost under wrap. Also runs the same four figures
 * on cars-500mb.xml as a sanity check that wrap is not free everywhere.
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
  computeWindowBounds,
  sliceWindow,
  decoder,
} from './harness-lib.js';

const params = new URLSearchParams(location.search);
const fixture500Path = params.get('fixture500');
const fixtureMinPath = params.get('fixtureMin');
const WINDOW_BYTES = 1024 * 1024; // 1 MB — the deciding configuration for both parts

const statusEl = document.getElementById('status');
const editorHost = document.getElementById('editor');
let lastStatus = 'starting';
const setStatus = (s) => {
  lastStatus = s;
  statusEl.textContent = s;
};

const keystrokeLatency = (view, frac, count) => keystrokeLatencyLib(view, EditorView, frac, count);

// Same diagnostic scaffolding A6 needed to pin down a CodeMirror error that
// throws off an internal async pass rather than synchronously — see
// renderer-windowed.js for the incident this was built for.
const crumbs = [];
function crumb(label, data) {
  crumbs.push({ label, data, t: +performance.now().toFixed(1) });
  if (crumbs.length > 15) crumbs.shift();
}
let errorReported = false;
window.addEventListener('error', (e) => {
  if (errorReported) return;
  errorReported = true;
  ipcRenderer.send('result', {
    ok: false,
    error: `window.onerror during "${lastStatus}": ${e.message}`,
    stack: e.error && e.error.stack,
    crumbs,
  });
});

// ---------------------------------------------------------------------------
// cold editor open — same shape as A6's openWindow
// ---------------------------------------------------------------------------

function makeFormatNumber(lineBaseRef) {
  return (n) => String(n + lineBaseRef.value);
}

function openWindow(buf, origin, windowBytes, lineStarts, prevView, extraExtensions = []) {
  if (prevView) prevView.destroy();
  editorHost.replaceChildren();

  const { start, end } = computeWindowBounds(buf, origin, windowBytes);
  const text = decoder.decode(buf.subarray(start, end));
  const lineBaseRef = { value: lineAt(lineStarts, start) };

  const t0 = performance.now();
  const state = EditorState.create({
    doc: text,
    extensions: [lineNumbers({ formatNumber: makeFormatNumber(lineBaseRef) }), ...extraExtensions],
  });
  const view = new EditorView({ state, parent: editorHost });
  return { view, start, end, lineBaseRef, openMs: () => performance.now() - t0 };
}

function absTopOffset(handle) {
  // See renderer-windowed.js (A6) for why lineBlockAtHeight is preferred over
  // viewportLineBlocks[0] (precision) but needs a fallback (it throws on a
  // handful of edge geometries).
  try {
    const height = Math.round(Math.max(0, Math.min(handle.view.scrollDOM.scrollTop, handle.view.contentHeight)));
    return handle.start + handle.view.lineBlockAtHeight(height).from;
  } catch {
    const blocks = handle.view.viewportLineBlocks;
    return handle.start + (blocks.length ? blocks[0].from : 0);
  }
}

function absCaretOffset(handle) {
  return handle.start + handle.view.state.selection.main.head;
}

// ---------------------------------------------------------------------------
// Part 1 — incremental re-slice: two edge changes instead of a full replace.
//
// General formula, both directions:
//   sharedStart = max(oldStart, newStart), sharedEnd = min(oldEnd, newEnd)
//   front change: [0, sharedStart-oldStart) -> decode(buf, newStart, sharedStart)
//   back  change: [sharedEnd-oldStart, oldLen) -> decode(buf, sharedEnd, newEnd)
// A pure forward pan (the boundary-crossing case) makes the front insert
// empty (drop only) and the back "change" a pure append; a pure backward pan
// is the mirror image. If the windows don't overlap at all this degenerates
// to a full replace, which is correct but not what this test exercises.
// ---------------------------------------------------------------------------

function incrementalReslice(handle, buf, newOriginRaw, windowBytes) {
  const { start: newStart, end: newEnd } = computeWindowBounds(buf, newOriginRaw, windowBytes);
  const oldStart = handle.start;
  const oldLen = handle.view.state.doc.length;

  const sharedStart = Math.max(oldStart, newStart);
  const sharedEnd = Math.min(handle.end, newEnd);

  if (sharedStart >= sharedEnd) {
    // No overlap — not the scenario this test measures, but must not corrupt
    // the document if it happens.
    const text = decoder.decode(buf.subarray(newStart, newEnd));
    handle.view.dispatch({ changes: { from: 0, to: oldLen, insert: text } });
    handle.start = newStart;
    handle.end = newEnd;
    return { incremental: false };
  }

  const leadingText = decoder.decode(buf.subarray(newStart, sharedStart));
  const trailingText = decoder.decode(buf.subarray(sharedEnd, newEnd));
  handle.view.dispatch({
    changes: [
      { from: 0, to: sharedStart - oldStart, insert: leadingText },
      { from: sharedEnd - oldStart, to: oldLen, insert: trailingText },
    ],
  });
  handle.start = newStart;
  handle.end = newEnd;
  return { incremental: true, droppedBytes: sharedStart - oldStart, appendedBytes: trailingText.length };
}

/**
 * 20 boundary crossings via incremental re-slice, deliberately WITHOUT the
 * scrollTop=0 reset or the manual scrollIntoView/selection repositioning A6
 * needed after its full-document replace. If CodeMirror's own change-mapping
 * (selection is mapped through a ChangeSet by default; CM6's scroll-anchor
 * logic is meant to preserve visual position when content above the
 * viewport changes) actually does the job, position should survive
 * untouched. If it doesn't, that shows up directly as drift or a crash —
 * this is the measurement, not an assumption.
 */
async function boundaryCrossingIncremental(handle, buf, fileLen, windowBytes, crossings = 20) {
  const el = handle.view.scrollDOM;
  el.scrollTop = 0;
  await settle(5);

  const stepPx = () => Math.max(20, Math.round((el.scrollHeight || 1) / 60));
  const crossingFrameMs = [];
  const topDriftBytes = [];
  const caretDriftBytes = [];
  const incrementalCount = { yes: 0, no: 0 };
  let crossed = 0;
  let iterations = 0;
  const maxIterations = crossings * 400;

  while (crossed < crossings && iterations++ < maxIterations) {
    const ratio = el.scrollHeight > 0 ? el.scrollTop / (el.scrollHeight - el.clientHeight || 1) : 0;

    if (ratio >= 0.8) {
      crumb('crossing:start', { ratio, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight });
      const topAbsBefore = absTopOffset(handle);

      // Caret anchored near the tracked top-of-viewport point, guaranteed to
      // be inside the *shared* region that survives the incremental edit —
      // see A6's writeup for why a caret that can fall outside the window
      // entirely makes this measurement meaningless rather than strict.
      const caretLocalBefore = Math.max(
        0,
        Math.min(handle.view.state.doc.length, topAbsBefore - handle.start + 500),
      );
      handle.view.dispatch({ selection: { anchor: caretLocalBefore } });
      const caretAbsBefore = absCaretOffset(handle);
      crumb('crossing:before', { topAbsBefore, caretAbsBefore, start: handle.start, end: handle.end });

      const wantedOrigin = Math.floor(
        Math.max(0, Math.min(topAbsBefore - windowBytes * 0.2, Math.max(0, fileLen - windowBytes))),
      );

      const t0 = performance.now();
      const r = incrementalReslice(handle, buf, wantedOrigin, windowBytes);
      incrementalCount[r.incremental ? 'yes' : 'no']++;
      crumb('crossing:resliced', { incremental: r.incremental, start: handle.start, end: handle.end });

      // Deliberately no scrollTop reset and no scrollIntoView/selection
      // effect here — that omission is the entire point of Part 1.
      await nextFrame();
      const ms = performance.now() - t0;
      crossingFrameMs.push(+ms.toFixed(2));
      crumb('crossing:afterFrame', { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight });

      // Extra settle frames before reading back, as in A6: CodeMirror's
      // viewport plugin refines over a few frames and reading immediately
      // conflates that refinement with genuine positional error.
      await settle(3);
      const topAbsAfter = absTopOffset(handle);
      const caretAbsAfter = absCaretOffset(handle);
      crumb('crossing:after', { topAbsAfter, caretAbsAfter });

      topDriftBytes.push(topAbsAfter - topAbsBefore);
      caretDriftBytes.push(caretAbsAfter - caretAbsBefore);

      crossed++;
      continue;
    }

    el.scrollTop += stepPx();
    await nextFrame();
  }

  return {
    crossings: crossed,
    iterations,
    incrementalCount,
    frameMs: crossingFrameMs,
    frameStats: crossingFrameMs.length ? stats(crossingFrameMs) : null,
    topDriftBytes,
    caretDriftBytes,
    maxAbsTopDrift: topDriftBytes.length ? Math.max(...topDriftBytes.map(Math.abs)) : null,
    maxAbsCaretDrift: caretDriftBytes.length ? Math.max(...caretDriftBytes.map(Math.abs)) : null,
  };
}

// ---------------------------------------------------------------------------
// offset round-trip — identical check to A6's item 7, re-run here because
// incremental patching changes how `origin`/`start` bookkeeping works and a
// regression there would invalidate the drift numbers above.
// ---------------------------------------------------------------------------

function offsetRoundTrip(buf, fileLen, windowBytes, lineStarts) {
  const checks = [];
  for (const [label, frac] of [['1%', 0.01], ['50%', 0.5], ['99%', 0.99]]) {
    const targetAbs = Math.min(fileLen - 1, Math.max(0, Math.floor(fileLen * frac)));
    const origin = computeOrigin(targetAbs, windowBytes, fileLen);
    const handle = openWindow(buf, origin, windowBytes, lineStarts, null);

    const localOffset = targetAbs - handle.start;
    const inRange = localOffset >= 0 && localOffset < handle.view.state.doc.length;
    let reconstructed = null;
    let charOk = null;
    if (inRange) {
      handle.view.dispatch({ changes: { from: localOffset, insert: 'X' } });
      reconstructed = handle.start + localOffset;
      charOk = handle.view.state.sliceDoc(localOffset, localOffset + 1) === 'X';
    }
    handle.view.destroy();

    checks.push({
      label,
      targetAbs,
      origin: handle.start,
      windowEnd: handle.end,
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
// Part 2 — soft wrap
// ---------------------------------------------------------------------------

async function measureWrapConfig(buf, fileLen, windowBytes, lineStarts, label) {
  const out = { label };
  setStatus(`[${label}] opening wrapped window…`);

  gc();
  await settle(3);
  const baselineRss = rssMB();

  const handle = openWindow(buf, 0, windowBytes, lineStarts, null, [EditorView.lineWrapping]);
  await nextFrame();
  out.openMs = +handle.openMs().toFixed(1);

  await settle(5);
  gc();
  await settle(5);
  out.rssDeltaMB = +(rssMB() - baselineRss).toFixed(1);

  const el = handle.view.scrollDOM;
  out.scrollHeight = el.scrollHeight;
  out.clientHeight = el.clientHeight;
  out.hasScrollRange = el.scrollHeight > el.clientHeight;
  // CM6 exposes defaultLineHeight; visual line count is an estimate from it,
  // fine for a spike where the point is "many" vs "one", not an exact count.
  out.estimatedVisualLines = Math.round(el.scrollHeight / handle.view.defaultLineHeight);

  for (const [flabel, frac] of [['1%', 0.01], ['50%', 0.5], ['99%', 0.99]]) {
    setStatus(`[${label}] typing at ${flabel}…`);
    out[`keystroke_${flabel}`] = await keystrokeLatency(handle.view, frac);
  }

  setStatus(`[${label}] scrolling…`);
  out.scrollWheel = await scrollTest(handle.view, 200, 100);

  setStatus(`[${label}] boundary crossing…`);
  out.boundaryCrossing = out.hasScrollRange
    ? await boundaryCrossingIncremental(handle, buf, fileLen, windowBytes)
    : { skipped: true, reason: 'no vertical scroll range even with wrap on' };

  handle.view.destroy();
  out.ok = true;
  return out;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

async function run() {
  const result = { ok: false };

  try {
    // ---------------- Part 1: cars-500mb.xml, 1 MB window ----------------
    setStatus('Part 1: reading cars-500mb.xml…');
    const buf500 = fs.readFileSync(fixture500Path);
    const fileLen500 = buf500.length;
    const lineStarts500 = buildLineIndex(buf500);

    setStatus('Part 1: opening window…');
    const handle1 = openWindow(buf500, 0, WINDOW_BYTES, lineStarts500, null);
    await nextFrame();
    await settle(5);

    setStatus('Part 1: incremental boundary crossing…');
    result.part1 = {
      fixture: 'cars-500mb.xml',
      windowBytes: WINDOW_BYTES,
      boundaryCrossing: await boundaryCrossingIncremental(handle1, buf500, fileLen500, WINDOW_BYTES),
    };
    handle1.view.destroy();

    setStatus('Part 1: offset round-trip…');
    result.part1.offsetRoundTrip = offsetRoundTrip(buf500, fileLen500, WINDOW_BYTES, lineStarts500);

    // ------------- Part 2: cars-100mb.min.json, 1 MB window, wrap ON -------------
    setStatus('Part 2: reading cars-100mb.min.json…');
    const bufMin = fs.readFileSync(fixtureMinPath);
    const fileLenMin = bufMin.length;
    const lineStartsMin = buildLineIndex(bufMin); // trivially [0] — single line

    result.part2Min = await measureWrapConfig(bufMin, fileLenMin, WINDOW_BYTES, lineStartsMin, 'min.json+wrap');

    // ---------- Part 2 sanity: cars-500mb.xml, 1 MB window, wrap ON ----------
    result.part2Sanity500 = await measureWrapConfig(buf500, fileLen500, WINDOW_BYTES, lineStarts500, '500mb+wrap');

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
