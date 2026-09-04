/**
 * M0a — shared measurement helpers for the CodeMirror harness (A2 and A6).
 *
 * THROWAWAY SPIKE CODE.
 */

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export async function settle(frames = 6) {
  for (let i = 0; i < frames; i++) await nextFrame();
}

export function gc() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return true;
  }
  return false;
}

export function rssMB() {
  return process.memoryUsage().rss / 1024 / 1024;
}

export function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    min: +s[0].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
}

/**
 * 100 single-character insertions at a fractional position within the
 * document currently loaded in `view` (whole file in A2, one window in A6).
 * Scrolls to the position first — typing off-viewport measures nothing,
 * since CodeMirror only renders what is visible.
 */
export async function keystrokeLatency(view, EditorView, frac, count = 100) {
  const docLen = view.state.doc.length;
  let pos = Math.max(0, Math.min(docLen - 1, Math.floor(docLen * frac)));

  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  await settle(10);

  const times = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    view.dispatch({ changes: { from: pos, insert: 'x' }, selection: { anchor: pos + 1 } });
    await nextFrame();
    times.push(performance.now() - t0);
    pos += 1;
  }
  return stats(times);
}

export async function scrollTest(view, viewports = 200, stepPx = null) {
  const el = view.scrollDOM;
  el.scrollTop = 0;
  await settle(10);

  const step = stepPx ?? (el.clientHeight || 800);
  const intervals = [];
  let last = performance.now();

  for (let i = 0; i < viewports; i++) {
    if (el.scrollTop + step * 2 >= el.scrollHeight) el.scrollTop = 0;
    else el.scrollTop += step;
    await nextFrame();
    const now = performance.now();
    intervals.push(now - last);
    last = now;
  }

  const over32 = intervals.filter((t) => t > 32).length;
  const over16 = intervals.filter((t) => t > 16.7).length;
  const s = stats(intervals);
  return {
    ...s,
    pctOver32ms: +((100 * over32) / intervals.length).toFixed(1),
    pctOver16ms: +((100 * over16) / intervals.length).toFixed(1),
  };
}

// ---------------------------------------------------------------------------
// A6-specific: byte-level window slicing over a Uint8Array/Buffer, never a
// full-document JS string (invariant 2 applies even in the spike).
// ---------------------------------------------------------------------------

function isContinuationByte(b) {
  return (b & 0xc0) === 0x80;
}

/** Advances `offset` forward past any UTF-8 continuation bytes. */
export function snapForward(buf, offset) {
  let o = offset;
  while (o < buf.length && isContinuationByte(buf[o])) o++;
  return o;
}

/**
 * One-time byte scan building row-start offsets, exactly the shape of the
 * row index CONCEPT.md §3.1 describes for the real product — reused here
 * only to make displayed line numbers match the whole file. Uses
 * Buffer.indexOf (native memchr), never decodes anything.
 */
export function buildLineIndex(buf) {
  const starts = [0];
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    starts.push(nl + 1);
    pos = nl + 1;
  }
  return Int32Array.from(starts);
}

/** 0-based line index containing byte offset `offset`, via binary search. */
export function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Clamps a window of `windowBytes` centred on `centerAbs` to the file. */
export function computeOrigin(centerAbs, windowBytes, fileLen) {
  const maxOrigin = Math.max(0, fileLen - windowBytes);
  return Math.max(0, Math.min(Math.floor(centerAbs - windowBytes / 2), maxOrigin));
}

export const decoder = new TextDecoder('utf-8');

/**
 * Computes the actual (post-snap) [start, end) of a window without decoding
 * anything — used by A6b's incremental re-slice, which only needs to decode
 * the small leading/trailing edge diffs, not the whole window.
 */
export function computeWindowBounds(buf, origin, windowBytes) {
  // A fractional index here defeats snapForward silently rather than
  // throwing: `buf[nonInteger]` is `undefined`, `undefined & 0xc0` is `0`,
  // so the continuation-byte check never advances and the fractional offset
  // survives to become a fractional CodeMirror position several calls later
  // — which is where it actually throws, far from the real bug. Floor here
  // once so no caller has to remember to.
  origin = Math.floor(origin);
  const rawEnd = Math.min(buf.length, origin + windowBytes);
  const start = snapForward(buf, origin);
  const end = snapForward(buf, rawEnd);
  return { start, end };
}

/**
 * Slices [origin, origin+windowBytes) from `buf`, snapping both ends forward
 * to a UTF-8 lead byte, and decodes only that slice. Returns the *actual*
 * (post-snap) start/end alongside the text, since callers must use the real
 * boundaries for origin+localOffset arithmetic to be exact.
 */
export function sliceWindow(buf, origin, windowBytes) {
  const { start, end } = computeWindowBounds(buf, origin, windowBytes);
  const text = decoder.decode(buf.subarray(start, end));
  return { start, end, text };
}
