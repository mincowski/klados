# R19–R20 — how the document reaches the views

<!-- status: built -->

**R19: built.** **R20: closed as not worth doing** (§5a's measurement — the extra renders are
cheap). Register: `docs/TASKS.md`. Decisions: `docs/DECISIONS.md` D-061, D-063.

First document under the per-topic naming convention (`CLAUDE.md` § "Plan documents"): one file
per topic, named for the lowest `R` id it covers, results appended rather than split off.

Both tasks concern the same thing — the shape of `OpenDocument` and how it is handed to the
panes. They are **not** two halves of one fix. §4 is the finding that separates them, and it is
the single most important paragraph here.

---

## 1. What happened

Pressing pretty-print on `cars-10mb.min.xml` under `npm run dev` made the renderer stop
responding within a second, produce no formatted output, and grow past **12.6 GB** working set
with 578 s of CPU burned before the process was killed.

None of it was the formatter. Measured first, precisely because the formatter was the obvious
suspect:

| | |
|---|---|
| `format()` on `cars-10mb.min.xml`, node harness | **385 ms**, correct 10,485,791-byte output |
| Same file + Format in the **packaged** app | **~1 s**, RSS flat at ~450 MB, formatted output on screen |
| Same file + Format under `npm run dev` | wedged in <1 s, >12 GB, never recovers |

The production build was never affected. This is a `npm run dev` defect only — which also means
`npm start` and the packaged executable cannot reproduce it, and a fix cannot be verified there.

---

## 2. Root cause

In a DEV build, `react-dom`'s `logComponentRender` runs on every commit. When a component
re-renders with a props object that is not referentially identical to the previous one — which is
*every* re-render, since JSX allocates a fresh props object each time — it calls
`addObjectDiffToProperties(alternate.memoizedProps, props)` to build a readable prop diff for
Chrome's "Components ⚛" track.

That walk recurses three levels deep, and at the bottom level enumerates objects with `for...in`.
**`for...in` over an `Int32Array` yields one key per element**, each pushing a freshly allocated
`[label, value]` string pair.

`Tree`, `Detail`, `Raw`, `StatusBar` and `Scrubber` all receive `document` as a prop, so the walk
reaches `document.store`'s parallel typed arrays and `document.rowIndex` / `lineIndex` /
`nameIndex` at exactly the depth where it enumerates — for both the old and the new props, once
per re-rendered pane.

Two properties of the trigger explain why this went unnoticed for so long:

- **It cannot fire on a first open.** A mount has no `alternate` to diff against. It needs an
  *in-place* store replacement, which is why every one of Format, Minify, an edit's reparse,
  undo/redo and reload wedges, while opening a second document is fine.
- **It is stripped from production builds**, so no packaged app or `npm start` session could ever
  show it.

### How it was found, since none of the usual instruments worked

Worth recording, because the renderer wedges so hard that nothing can be evaluated inside it and
every ordinary approach returns nothing:

- `npm run dev -- --remote-debugging-port=9222` plus Playwright's `chromium.connectOverCDP` gives
  a real driven app. In dev the renderer is served as real ES modules, so
  `await import('/session/activeSession.ts')` from the page reaches the singleton directly — open
  a file, trigger a Transform, read state, with no UI automation at all.
- **`Debugger.pause` interrupts a wedged main thread** and returns a stack. This is the only
  instrument that produced an answer. `Debugger.evaluateOnCallFrame` then runs arbitrary
  expressions *while* the thread is parked, which is how counters and snapshot-stability checks
  were read out of a renderer that could not answer a normal `evaluate`.
- Non-pausing breakpoints (`Debugger.setBreakpointByUrl` with a condition that increments a global
  and returns `false`) count call sites without stopping — that is what proved **no** component
  was re-rendering in a loop and **no** session `setState` was repeating, which is what redirected
  the search away from application code entirely.
- Console capture produced nothing: a wedged thread never flushes. Do not trust its silence.

Ruled out with evidence before the real cause was found: a formatter loop, a re-render loop, an
unstable `useSyncExternalStore` snapshot (all seven stores checked for referential stability, both
before and during the wedge — all stable), the Raw view (it wedges with the Raw pane closed), and
anything Transform-specific (a plain `reloadAndDiscard` wedges identically).

---

## 3. R19 — disable React's dev performance tracks · **built**

`src/renderer/devPerformanceTracks.ts`, imported **first** in `main.tsx`.

React computes `supportsUserTiming` once, when `react-dom` first evaluates, from
`typeof console.timeStamp === 'function' && typeof performance.measure === 'function'`. Deleting
`console.timeStamp` before that module is evaluated makes the entire logging path — the prop diff
included — inert. Deleted rather than stubbed: the gate tests `typeof === 'function'`, so a no-op
stub would still pass it. Nothing in this codebase calls `console.timeStamp`.

`performance.measure` is deliberately left alone. It is the standard API and this project's own
measurement harnesses use it.

**Verified in the real app, in dev, on every path that previously wedged:**

| Scenario | Before | After |
|---|---|---|
| `cars-10mb.min.xml` + Format | wedged, >12.6 GB | **~1 s, heap 93–176 MB** |
| Format with the Raw pane closed | wedged | survived |
| Minify | wedged | survived |
| Edit (one keystroke) | wedged | survived |
| Reload (`reloadAndDiscard`) | wedged | survived |

`npm test` 1039 passed, `npm run test:browser` 21 passed, typecheck clean, lint unchanged (the
same four pre-existing errors). **The production bundle is byte-identical** before and after —
Vite eliminates the module entirely once `import.meta.env.DEV` folds away, so there is no
production behaviour to re-verify.

### What it costs, and the fragility to know about

The React "Components ⚛" and "Scheduler ⚛" tracks no longer appear in Chrome DevTools performance
profiles. They were never usable here — recording one *is* the hang. StrictMode's double-invoke,
Fast Refresh and the React DevTools extension are all untouched, since none of them go through
this gate.

**The shim depends on a React internal.** If React changes how the tracks are gated, the hang
returns silently on a version bump. There is no way to assert the gate from inside the
application. The mitigations are that the symptom is unmistakable and that
`devPerformanceTracks.ts` explains the whole mechanism at the point someone would look. Named
here rather than left to be rediscovered.

### The guard

`test/devPerformanceTracks.test.ts` asserts the import is first in `main.tsx` and ahead of
`react-dom/client`, and that the module deletes rather than stubs. Confirmed failing when the
import is moved and passing when restored — not merely asserted.

A source-text assertion on purpose: what breaks is module *evaluation order*, which a test that
imports the modules itself cannot observe, because Vitest has already loaded React by then. The
realistic regression is an import sort — which would silently restore a renderer that hangs on the
first Format, with nothing failing until someone runs the app by hand.

---

## 4. The finding that separates R19 from R20

**Narrowing the props does not help, and the codebase had already tried it.**

`TreeContent`'s prop type is a structural three-field type, not `OpenDocument`:

```ts
readonly document: {
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  readonly filePath: string
}
```

But `Tree` renders `<TreeContent document={state.document} …>`. TypeScript's structural typing
narrows the *compile-time view*; at runtime the whole 26-field object flows through, and that is
what React walks. **A narrow type is not a narrow value.**

Narrowing the value would not have helped either. Passing `store` as its own prop puts the typed
arrays *one level shallower* in a walk that recurses three levels — strictly worse. The only prop
shape that avoids this is **primitives only**.

Three consequences, and they are the whole reason these are two tasks:

1. This is not a "too many fields" problem, so the natural architectural fix does not fix it.
2. **R20 does not make R19 revertable.** Splitting `OpenDocument` leaves `store` reachable from
   some pane's props, which is all the walk needs. Anyone who reads R20 and reaches for the
   revert should stop here.
3. The core architecture is not what is wrong. Passing a large object *by reference* through props
   is ordinary React and costs nothing at runtime — React never deep-compares props in production.
   `for...in` over a typed array to build a DevTools tooltip is a defect in React's
   instrumentation, and any application holding typed arrays in state meets it.

---

## 5. R20 — split `OpenDocument` into slices · **closed, not worth doing**

Optional hygiene, on its own merits, gated on measurement. Not a fix for anything currently
broken, and explicitly not a prerequisite for anything.

> **Where this lands, decided when tabs were planned (D-061's amendment).** §5a's measurement
> still runs first and still stands alone. **§5b's implementation folds into `docs/plans/R24-tabs.md`
> R24** — the twelve-singleton refactor reshapes the session anyway, and doing that surgery twice
> is waste. R20 keeps its id and its home here; only where the work lands changed. If §5a's figure
> says the extra renders are cheap, R24 inherits a recorded number and no obligation.

### The smell

`OpenDocument` has 26 fields mixing three lifetimes:

| Slice | Fields | Changes |
|---|---|---|
| **model** | `store`, `sourceBuffer`, `rowIndex`, `lineIndex`, `nameIndex`, `diagnostics`, `complete`, `errorNode`, `errorOffset` | when a parse commits |
| **file** | `filePath`, `fileName`, `formatId`, `encoding`, `readOnly` | on open, Save As, external change |
| **status** | `dirty`, `reparsePending`, `transformInProgress`, `externalChangeDetected`, `pendingTransform`, `pendingParseError`, `minifiedBannerDismissed`, `lastTransformWasNoOp`, `undoBytes`, `undoEntryCount` | constantly |

Every update replaces the whole object (`{...state.document, dirty: true}`), and **there is no
`React.memo` anywhere in the renderer**. So `syncUndoContext` updating `undoBytes` re-renders
Tree, Detail, Raw, Scrubber and the status bar.

Today this does not hurt: the expensive derivations are `useMemo`'d on `store`, so the extra
renders are shallow. It is the kind of coupling that gets expensive quietly, which is the only
reason it is written down.

### 5a. Measure before refactoring — and this task may stop here

The first deliverable is a number, not a change. Count renders per pane, using R10's browser
tooling or the counting-breakpoint technique in §2, across:

- a typing burst in the Raw view (the `syncUndoContext` path),
- a Format on a mid-size document,
- an undo/redo cycle.

**If the extra renders are cheap, record the figure and close R20 as not worth doing.** That is a
legitimate outcome and should not be treated as a failure to deliver. `CLAUDE.md` already flags
this project's recurring pattern of measuring a component cleanly while leaving the pipeline
around it unmeasured — refactoring a render path on the strength of an argument rather than a
measurement would be the same mistake wearing different clothes.

### 5b. If the figure justifies it

Reshaping the data alone changes nothing: the panes' wrappers re-render on any session change, and
each child gets a fresh props object regardless. The split only pays off with **slice-scoped
subscriptions**:

- The session keeps `model`, `file` and `status` as independently replaced objects, and rebuilds
  only the one that changed. `OpenDocument` stays assembled from them so existing `document.store`
  call sites keep working — a flag-day rename of 26 fields across the renderer is not in scope.
- Panes subscribe to a slice: `useDocumentModel()`, `useDocumentFile()`, `useDocumentStatus()`,
  each a `useSyncExternalStore` over its own snapshot. A pane that only reads the model then does
  not re-render when `undoBytes` moves.
- **Keep the outer/inner component split.** It is what `test/statusBar.test.tsx` and
  `test/treeExpansion.test.tsx` drive, and those tests caught real defects in R12 and R13's O4.
  Slice hooks belong in the outer component, exactly where `useDocumentSession()` sits now.

### Acceptance

- The before/after render counts from 5a, in the same table.
- Every existing test passes unmodified. This is a re-render-timing change to working code; the
  suite is the safety net, the same role it played for R18's control-flow rewrite.
- `computeMemoryBudget`'s O(1) property survives (D-060/§3a's constraint).
- R19's shim and its guard test are untouched — see §4.

### 5a results — measured, and R20 is closed as not worth doing

`test/documentPropsRenderCost.test.tsx`, real Chromium via `React.Profiler` (D-063). Doesn't drive
the real `activeSession` singleton end to end (no Electron preload IPC in this environment, the
same gap J9/M5d/M5e/M5g/M6/R21 have all flagged) — instead it replays the exact shallow-copy
`document` object each of the three scenarios actually produces, at the outer/inner seam
`test/statusBar.test.tsx`/`test/treeExpansion.test.tsx` already use, and mounts all five panes'
props-driven inner components (`TreeContent`, `DetailContent`, `RawContent`, `ScrubberContent`,
`ReadyStatus` — `Detail`/`Raw`/`Scrubber` gained the export this round, following the same pattern
`Tree`/`StatusBar` already had) side by side, each wrapped in its own `Profiler`.

| Scenario | tree | detail | raw | scrubber | statusBar | total |
|---|---|---|---|---|---|---|
| Typing burst, 10 replacements | 10 renders, ~9ms | 10 renders, ~16ms | 10 renders, ~2ms | 10 renders, ~2ms | 10 renders, ~4ms | **~33ms / 10 keystrokes ≈ 3.3ms/keystroke, all five panes combined** |
| One Format replacement | 1 render, ~0.5ms | 1-2 renders, ~1-1.3ms | 1-2 renders, ~0.1-0.2ms | 1 render, ~0.1ms | 1 render, ~0.2-0.4ms | **~2-2.5ms total** |
| Undo/redo, 2 replacements | 2 renders, ~1ms | 2 renders, ~2ms | 2-3 renders, ~0.2-1.5ms | 2 renders, ~0-0.3ms | 2 renders, ~0.5-0.6ms | **~4-5ms total** |

Stable across repeated runs (checked 3× locally). Every pane re-renders on every unrelated
`document` replacement, confirming §5's own diagnosis — but the cost of that is small enough to be
irrelevant against a 16ms frame budget even *summed across all five panes at once*: a ten-keystroke
burst costs ~3.3ms of render time total, not per keystroke per pane. `Detail` is consistently the
most expensive single pane (its children table + virtualizer), and even it never exceeds ~1.6ms for
one unrelated re-render.

**One incidental finding, not part of §5a's own question**: `raw` and `detail` occasionally commit
one extra time beyond the prop-driven render on a single-replacement scenario (Format, undo/redo) —
an effect (Raw's caret positioning, Detail's grid-detection pass) scheduling a follow-up commit on
some transitions and not others. Harmless at these costs, and not investigated further — recorded
here so a future reader doesn't re-derive it as a mystery.

**Verdict, per 5a's own acceptance rule**: the extra renders are cheap. **R20 is closed as not
worth doing** — 5b's slice-scoped-subscription split is not built. `docs/plans/R24-tabs.md` R24 no longer
inherits an obligation to fold it in; it inherits this recorded figure instead, exactly as §5's own
redirect paragraph above anticipated.

---

## 6. Rejected, with reasons

- **Move the panes to reading the session via hooks instead of props** (the only *complete* fix for
  §2). It costs the props test seam R10 was built around, it is a large change to the most-hardened
  part of the UI, and it closes only this one path — React DevTools' own inspector still serializes
  hook values when a component is selected, so it buys no guarantee. Not worth it for a dev-tooling
  defect that a five-line shim removes entirely.
- **Underscore-prefixing the heavy fields** (`_store`, `_rowIndex`): React's walk skips keys
  starting with `_`. It works, and it is unreadable, and it touches every call site in the
  renderer.
- **Making the typed arrays non-enumerable**: object spread copies only enumerable own properties,
  and `{...state.document}` is the update idiom everywhere. It would silently drop fields.
- **A `Symbol.toStringTag` on `NodeStore`**: does not help. React's recursion decision at that
  depth is unconditional for objects; the type name is only used as a label.
