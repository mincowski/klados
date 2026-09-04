/**
 * M1 D15 — viewport decoration cost (§13: "every A2/A6 latency figure was
 * measured with syntax highlighting off").
 *
 * THROWAWAY MEASUREMENT HARNESS. Not part of the product, not tested.
 *
 * Same-process A/B on the same parsed document: one `EditorView` with the
 * real `viewportDecorations` (`components/Raw/decorations.ts`, imported
 * directly — this is the actual shipped decoration logic, not a copy)
 * wired in via a `ViewPlugin`, one without, scrolled and boundary-crossed
 * identically. A same-run comparison is more reliable than diffing against
 * A6b's own numbers from a different day and machine state; A6b's
 * 16.8 ms / 20.8 ms (1 MB window, cars-500mb.xml) is quoted alongside as a
 * sanity check, not the primary comparison.
 *
 * The window mechanism itself — `computeWindowBounds`, `planReslice`,
 * `shouldRecenter` — is imported from the real `components/Raw/
 * rawWindow.ts`, not reimplemented, for the same reason.
 */
import { ipcRenderer } from 'electron';
import fs from 'fs';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import { Interner } from '../../src/core/interner';
import { NodeStore } from '../../src/core/nodeStore';
import { SourceBuffer } from '../../src/core/buffer';
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../../src/core/rowIndex';
import { xmlFormatModule } from '../../src/formats/xml/index';
import {
  computeWindowBounds,
  planReslice,
  shouldRecenter,
  WINDOW_BYTES,
} from '../../src/renderer/components/Raw/rawWindow';
import { viewportDecorations } from '../../src/renderer/components/Raw/decorations';
import { nextFrame, settle, gc, stats, scrollTest } from './harness-lib.js';

const params = new URLSearchParams(location.search);
const fixturePath = params.get('fixture');
const fixtureName = params.get('name');
// Overridable for D15's window-size question — defaults to the production
// value so the common case tests exactly what ships.
const windowBytesOverride = params.has('windowBytes') ? Number(params.get('windowBytes')) : WINDOW_BYTES;

const statusEl = document.getElementById('status');
const editorHost = document.getElementById('editor');
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

const SYNTAX_CLASS_NAMES = {
  tagName: 'cm-np-tagName',
  string: 'cm-np-string',
  number: 'cm-np-number',
  keyword: 'cm-np-keyword',
  comment: 'cm-np-comment',
};

/** The same decoration-set builder as the real `rawDecorations.ts`'s, minus
 * the selection highlight (no selected node in this test — the syntax
 * decorations are what §13 asks about). */
function buildDecorationSet(view, store, source, windowStart) {
  const docLength = view.state.doc.length;
  const from = windowStart + view.viewport.from;
  const to = windowStart + view.viewport.to;

  const builder = new RangeSetBuilder();
  for (const span of viewportDecorations(store, source, from, to)) {
    const localFrom = Math.max(0, span.start - windowStart);
    const localTo = Math.min(docLength, span.end - windowStart);
    if (localFrom < localTo) {
      builder.add(localFrom, localTo, Decoration.mark({ class: SYNTAX_CLASS_NAMES[span.className] }));
    }
  }
  return builder.finish();
}

function decorationsExtension(store, source, getWindowStart) {
  return ViewPlugin.define(
    (view) => ({
      decorations: buildDecorationSet(view, store, source, getWindowStart()),
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorationSet(update.view, store, source, getWindowStart());
        }
      },
    }),
    { decorations: (v) => v.decorations },
  );
}

function openWindow(store, sourceBuffer, rowIndex, origin, withDecorations) {
  const { start, end } = computeWindowBounds(rowIndex, sourceBuffer.byteLength, origin, windowBytesOverride);
  const text = sourceBuffer.slice(start, end);
  const handle = { start, end };
  const extensions = [EditorState.readOnly.of(true)];
  if (withDecorations) {
    extensions.push(decorationsExtension(store, sourceBuffer, () => handle.start));
  }
  const state = EditorState.create({ doc: text, extensions });
  handle.view = new EditorView({ state, parent: editorHost });
  return handle;
}

function applyReslice(handle, sourceBuffer, newStart, newEnd) {
  const plan = planReslice(handle.start, handle.end, newStart, newEnd);
  if (plan.kind === 'replace') {
    const text = sourceBuffer.slice(plan.newStart, plan.newEnd);
    handle.view.dispatch({ changes: { from: 0, to: handle.view.state.doc.length, insert: text } });
    handle.start = plan.newStart;
    handle.end = plan.newEnd;
    return;
  }
  const oldStart = handle.start;
  const oldLength = handle.view.state.doc.length;
  const leadingText =
    plan.leading.end > plan.leading.start ? sourceBuffer.slice(plan.leading.start, plan.leading.end) : '';
  const trailingText =
    plan.trailing.end > plan.trailing.start ? sourceBuffer.slice(plan.trailing.start, plan.trailing.end) : '';
  handle.view.dispatch({
    changes: [
      { from: 0, to: plan.sharedStart - oldStart, insert: leadingText },
      { from: plan.sharedEnd - oldStart, to: oldLength, insert: trailingText },
    ],
  });
  handle.start = plan.newStart;
  handle.end = plan.newEnd;
}

async function boundaryCrossings(handle, sourceBuffer, rowIndex, crossings = 20) {
  const el = handle.view.scrollDOM;
  el.scrollTop = 0;
  await settle(5);

  const stepPx = () => Math.max(20, Math.round((el.scrollHeight || 1) / 60));
  const frameMs = [];
  let crossed = 0;
  let iterations = 0;
  const maxIterations = crossings * 400;

  while (crossed < crossings && iterations++ < maxIterations) {
    const topAbs = handle.start + el.scrollTop;
    if (shouldRecenter(topAbs, handle.start, handle.end)) {
      const wanted = Math.floor(
        Math.max(
          0,
          Math.min(
            topAbs - windowBytesOverride * 0.2,
            Math.max(0, sourceBuffer.byteLength - windowBytesOverride),
          ),
        ),
      );
      const { start, end } = computeWindowBounds(rowIndex, sourceBuffer.byteLength, wanted, windowBytesOverride);
      const t0 = performance.now();
      applyReslice(handle, sourceBuffer, start, end);
      await nextFrame();
      frameMs.push(+(performance.now() - t0).toFixed(2));
      crossed++;
      continue;
    }
    el.scrollTop += stepPx();
    await nextFrame();
  }

  return { crossings: crossed, frameStats: frameMs.length ? stats(frameMs) : null };
}

async function measureConfig(store, sourceBuffer, rowIndex, label, withDecorations) {
  setStatus(`[${label}] opening window...`);
  const handle = openWindow(store, sourceBuffer, rowIndex, Math.floor(sourceBuffer.byteLength / 2), withDecorations);
  await nextFrame();
  await settle(5);

  setStatus(`[${label}] scroll test...`);
  const scroll = await scrollTest(handle.view, 200, 100);

  setStatus(`[${label}] boundary crossings...`);
  const crossing = await boundaryCrossings(handle, sourceBuffer, rowIndex, 20);

  handle.view.destroy();
  editorHost.replaceChildren();
  return { label, scroll, crossing };
}

async function run() {
  setStatus('reading + parsing fixture (real xmlFormatModule)...');
  const buf = fs.readFileSync(fixturePath);
  const source = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const interner = new Interner();
  const store = new NodeStore(source, interner);
  const parseT0 = performance.now();
  xmlFormatModule.parse(source, store, { maxDepth: 10000, encoding: 'utf-8' });
  const parseMs = performance.now() - parseT0;

  const sourceBuffer = new SourceBuffer(source, 'utf-8', 0);
  const rowIndex = buildRowIndex(source, DEFAULT_MAX_ROW_BYTES, xmlFormatModule.capabilities.rowBreakBytes);

  gc();
  await new Promise((r) => setTimeout(r, 100));

  const withDecorations = await measureConfig(store, sourceBuffer, rowIndex, 'decorations-on', true);
  const withoutDecorations = await measureConfig(store, sourceBuffer, rowIndex, 'decorations-off', false);

  ipcRenderer.send('result', {
    ok: true,
    fixture: fixtureName,
    sizeBytes: source.byteLength,
    nodeCount: store.nodeCount,
    rowCount: rowIndex.length,
    windowBytes: windowBytesOverride,
    parseMs: +parseMs.toFixed(1),
    withDecorations,
    withoutDecorations,
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
