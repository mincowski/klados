# R41 — typing in the Raw view loses the caret

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Decision: `docs/DECISIONS.md` D-069.

Reported as: *"the raw pane jumps somewhere, then back to where I edited, and the cursor is lost, so
I don't get to continue typing."* Correctly flagged as the largest of the batch — but the cause is
already known, already written down, and already deferred once.

---

## 1. What was measured

Real Electron, `cars-small.xml`, caret placed in the Raw view, two characters typed. The `.cm-content`
element was tagged before typing so a remount is detectable rather than inferred:

| t | editor element survived | CodeMirror focused | selection in editor | `.cm-scroller` scrollTop |
|---|---|---|---|---|
| 0 ms (before typing) | yes | yes | yes | 0 |
| +75 ms | yes | yes | yes | **96** |
| +358 ms | **no** | **no** | **no** | 0 |

Two distinct symptoms, ~280 ms apart, and they need separating because fixing one does not fix the
other.

---

## 2. Symptom A — the editor is destroyed and rebuilt (~+358 ms)

`Raw.tsx`'s mount effect is keyed on `[store]`. Typing schedules a debounced reparse
(`REPARSE_DEBOUNCE_MS = 200`, `session/reparse.ts`), the reparse produces a **new `NodeStore`**,
and the new store identity tears down the `EditorView` and builds a fresh one. Focus, selection,
scroll position and CodeMirror's own internal state all go with it. The effect's own comment says so
in as many words — *"a reparse recreates the whole EditorView, per this effect's own `[store]`
dependency"*.

**This is `M5g-PLAN.md`'s O4, Raw half — deferred, not attempted, with the fix shape already fully
specified.** From `M5g-RESULTS.md`:

> Not remounting the `EditorView` on every reparse needs
> `rawDecorationsExtension`/`rawCaretSyncExtension`/`rawLineNumbersExtension`/`rawEditExtension`
> converted from closed-over `store`/`sourceBuffer`/`rowIndex`/`lineIndex` values to live getters —
> the same pattern `getWindow: () => RawWindowSnapshot` already uses […] plus a second effect in
> `Raw.tsx` (mount effect re-keyed on document identity, a new one on
> `[store, sourceBuffer, rowIndex, lineIndex]` that re-slices the window and forces a decoration
> rebuild without destroying the view).

It was deferred for an honest reason — "real surgery on the most heavily-hardened, most bug-fixed
part of this codebase (D10, J1–J3, R8), with no live GUI in this session to drive the result." **That
second half no longer holds.** Real-Electron driving is routine now (this document's own table came
from it), which removes the specific blocker M5g named.

**It now has three independent motivations rather than one**, which is the argument for finally
doing it:

1. reparse-on-edit destroys the caret — this report;
2. tab-switching a minified document costs ~2.5 s because the rebuild re-lays-out a wrapped 1 MB
   line (`docs/FINDINGS.md`);
3. M5g's original one — the rebuild is simply wasted work on every reparse.

### Scope: same-document reparse only

**R41 fixes (1) and (3), not (2).** Keying the mount effect on document identity instead of store
identity stops the rebuild when the *same* document reparses. Keeping a live `EditorView` per *tab*
so switching back is free is a different and larger change — it multiplies CodeMirror's ~1 MB UTF-16
window (invariant 1's bounded exception) by the tab count, straight into R28's cross-tab budget.
Deliberately out of scope; recorded here so the two are not confused when the diff is reviewed.

---

## 3. Symptom B — the pane scrolls away *before* the rebuild (~+75 ms)

At +75 ms the editor was still the original element, still focused, still holding the selection —
and `scrollTop` had moved from 0 to 96. So "the pane jumps somewhere" is **not** the remount; it
happens ~280 ms earlier, while everything is still alive.

The likely source is the selection/caret sync (`rawCaretSync.ts`, R8f made selection move the caret
to the node's span start) reacting to the edit changing which node is selected, and scrolling the
new selection into view. **Confirm this before changing it** — it is inferred from timing and the
module's purpose, not measured directly, unlike everything in §1.

Whatever it turns out to be, the rule it should follow is clear: **a selection change that the user
caused by typing must not scroll the pane they are typing in.** Scrolling to a selection is correct
when the selection changed from the Tree or the breadcrumb, and wrong when it changed because the
caret is already there.

---

## 4. Symptom C — a transient `>` in the other views (not reproduced)

Reported as *"an intermediate `>` in front of some elements that is rendered and that makes the UI
feel jumping."* **I could not reproduce it**, and it is recorded as unconfirmed rather than
explained away.

What was tried: typing inside an element's text content on `cars-10mb.xml` with the Tree visible,
sampling every 40 ms for 2.5 s after the keystroke. The Tree's disclosure glyphs did not change at
all across the window.

Two candidates, distinguishable by one observation:

- **A real data change, not a transient.** Typing at a position that creates a new node — e.g. after
  `</name>`, which makes a new `Text` sibling — legitimately adds a Tree row and can turn a leaf
  into a parent, giving it a `▸`. The first probe's Detail pane did show a new `Text` child after
  exactly that edit. If this is it, nothing is wrong except that the rebuild in §2 makes a
  legitimate change feel like a glitch.
- **A genuine transient**, where a view renders against a half-updated store between the edit and the
  reparse landing.

**To settle it: sample the Tree rows across the debounce window while typing at the *end* of an
element's content**, which is the edit shape that changes the tree's structure. If the glyphs only
ever change once and stay changed, it is the first case. Ask which pane the `>` appeared in if it
recurs — Tree's disclosure (`▸`) and the grid's drill affordance (`▸`, `.grid-cell-drill`) are
different mechanisms that look identical.

---

## 5. The "edit mode" idea — recommend against (D-069)

The report suggests a Raw-view edit mode that handles updates differently while typing.

**The debounce already is that mode**, and the problem is not that it is missing — it is that its
end is destructive. A longer or manually-ended edit mode makes the caret survive *longer* while
leaving every other view stale for as long as the user keeps typing, and it still destroys the caret
when it ends. It adds a state to a module whose state machine is already the most bug-fixed in the
project, and it does nothing for the tab-switch cost or for M5g's wasted work.

Fixing the rebuild fixes all three, adds no mode, and is already specified.

### The interim option, and why it is second choice

Capturing selection + scroll before teardown and restoring after would take an afternoon. It is a
band-aid, and it should only be reached for if §2 turns out to be genuinely blocked:

- it restores a *position*, not the editor — an in-progress IME composition, a selection drag, or a
  CodeMirror-internal undo entry are all still lost;
- there is a visible flash at every debounce boundary, which is most of what "feels jumping" is;
- it leaves symptom B untouched, and B fires first.

---

## 6. Verify

Browser project, real Chromium — this is entirely about live DOM state:

- **After typing and waiting past the debounce, the `.cm-content` element is the same node** — tag
  it and assert identity, the exact check §1's table used. This is the regression guard.
- Focus and selection offset are unchanged after the reparse lands, and typing a third character
  appends where the first two went.
- `scrollTop` is unchanged across the whole sequence (§3).
- The existing Raw suites (D10, J1–J3, R8) all still pass **unmodified** — with four extension
  modules converted to live getters, a test that needed changing is evidence the conversion changed
  behaviour rather than plumbing.

---

## Results — built

**§2 (Symptom A)** landed as specified, plus one thing the plan didn't call out. `Raw.tsx`'s mount
effect now keys on `getActiveTabId() ?? document.filePath` (`documentIdentity`) instead of `store`
— switching tabs still remounts; a same-document reparse no longer does. A second effect, keyed on
`[store, sourceBuffer, rowIndex, lineIndex]`, is what M5g-PLAN.md's own O4 note called "re-slices
the window and forces a decoration rebuild without destroying the view": it refreshes
`handle.text`/`handle.map` from the new `sourceBuffer` over the byte range `handle.start`/`.end`
already correctly track (via the existing per-edit `onApplied` callback), then dispatches a new
`bumpDecorationsEffect` (`rawDecorations.ts`) to force `rawDecorationsExtension`'s `ViewPlugin` to
rebuild — needed because re-dispatching the *same* `selectedNode` value doesn't register as a
state change on its own, so `selectionChanged`'s existing check would otherwise silently skip the
rebuild every time.

`rawDecorationsExtension`, `rawCaretSyncExtension`, `rawLineNumbersExtension` and
`rawEditExtension` all took live getters in place of their closed-over `store`/`sourceBuffer`/
`rowIndex`/`lineIndex`/`encoding` parameters, per the plan. **Not in the plan, found while making
the conversion**: several closures declared *inside* the mount effect itself — `handleScrollFrame`
(the scroll-triggered re-centre path), `scrubTo` (the scrubber's jump target), and the
component-level `publishViewport` — closed over the plain `sourceBuffer`/`rowIndex` bindings too.
Since the effect that creates them no longer reruns per reparse, those closures would have gone
stale the same way the extensions themselves would have, just one level down (a scroll-triggered
re-slice computing against a `sourceBuffer.byteLength` that hadn't been true since the last actual
remount). Fixed the same way: routed through the same `sourceBufferRef`/`rowIndexRef` the
extensions themselves read.

The live refs are kept current by a `useLayoutEffect` with no dependency array, not a plain
render-body assignment — this project's own `react-hooks/refs` lint rule forbids mutating a ref
during render, and `useLayoutEffect` runs synchronously after every commit and *before* any
`useEffect` in the same commit, so nothing downstream can observe last-render's values.

**§3 (Symptom B)** was confirmed exactly as inferred: `Raw.tsx`'s own `caretOffset` effect, not
`rawCaretSync.ts`. `rawEditExtension` calls `session.setCaretOffset` after every edit; the effect
had no way to tell that apart from an external "Locate in source" jump, so it called `jumpTo`
(selection + `scrollIntoView`) on every keystroke. Fixed with a new `onCaretMoved` callback on
`rawEditExtension`, invoked with the edit's resulting offset *before* `session.setCaretOffset` —
`Raw.tsx` uses it to mark that offset "already positioned" ahead of the re-render the state change
triggers, so the effect's existing guard skips the jump for it.

**§4 (Symptom C)** stayed unreproduced, as flagged; no code change.

**§5** — the "edit mode" idea stayed rejected, per D-069; nothing here needed one.

Verified in real Chromium against a real, tab-backed `DocumentSession` (the same fake-parse
infrastructure `test/tabStrip.test.tsx`/`test/documentSession.test.ts` use, with a near-zero
`reparseDelayMs`), dispatching `changes` transactions on the `EditorView` recovered via
`EditorView.findFromDOM(contentDOM)` — the same internal mechanism a real keystroke drives.
`test/rawEditCaretSurvival.test.tsx` (new) asserts: `.cm-content` is the same DOM node after the
debounced reparse lands; focus stays on `contentDOM` and the selection offset is exactly where
typing left it, with a third keystroke appending correctly after the reparse; and `scrollTop` is
unchanged across the whole sequence. All three pass. Every pre-existing Raw suite (D10, J1–J3, R8)
passed **unmodified**.

`npm run typecheck`, `npm run lint` (CRLF warnings only), and the full `vitest` suite (101 files,
1196 tests, node + browser projects) are clean.
