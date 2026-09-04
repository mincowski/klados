# R100–R101 — the Raw view does not follow a buffer rewritten outside it

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Reported against R90: Replace runs, but the Raw pane keeps
showing the old text. **Investigated, and it is not an R90 defect** — Replace is the fourth feature
to hit a five-day-old regression in R41, which Format, Minify, Undo, Redo and Reload all hit too. Related:
`docs/plans/R41-raw-editing.md` (which introduced the effect at fault, for good reasons),
`docs/plans/R86-find-as-query-surface.md` §6 (R90, Replace). Results at the end of this file.

**Every question in this document is settled — nothing here is waiting on a decision.**

---

## 1. What was measured

Real Chromium, real `DocumentSession`, real `Raw`, comparing `sourceBuffer` against the live
`EditorView`'s own document after each operation:

| Operation | Buffer after | `.cm-content` after | Agree? |
|---|---|---|---|
| **Replace All** (`{"a":"xy","b":"xy"}` → `ZZZZ`) | `{"a":"ZZZZ","b":"ZZZZ"}` | `{"a":"xy","b":"xy"}` | **no** |
| **Format** (`{"a":1,"b":2}`) | `{\n  "a": 1,\n  "b": 2\n}\n` | `{"a":1,"b":2}` | **no** |
| **Undo** of a typed edit | `{"a":"xy"}` | `{"a":"xyQQ"}` | **no** |
| A subsequent caret move | — | still stale | **no** — it does not self-repair |

**Confirmed in the built app, not only in the harness.** Launched via Playwright, opened a JSON file,
ran `Format Document` from the palette: the title bar shows the dirty dot, the Detail pane shows the
reparsed tree, and the Raw pane still reads the unformatted original. Screenshotted, and asserted on
the pane's own text rather than by eye — `.cm-content`'s `innerText` is **byte-identical** before and
after the command:

```
BEFORE : {"a":1,"b":"xy","c":"xy"}
AFTER  : {"a":1,"b":"xy","c":"xy"}
CHANGED: false
```

The buffer, the model, the dirty flag and every other pane are correct throughout; only the editor's
own document is stale. That is why it survived: nothing about it looks like data loss, and the Tree
and Detail always agreed with what you asked for.

### The regression point is R41, and it is five days old

Format shipped in M5 and Undo in M3, both long before this — so the obvious conclusion is that they
have been broken for months. **Checked instead of assumed, and they have not.**

Before `a50ceff` (R41, 2026-08-16) the mount effect was keyed `}, [store])`. Every reparse therefore
tore the `EditorView` down and rebuilt it from the current `sourceBuffer` — so Format, Minify, Undo,
Redo and Reload all displayed correctly, not by design but as a side effect of the rebuild.

R41 removed that rebuild, for good and well-argued reasons: it was destroying the caret on every
keystroke's debounced reparse, which is the bug R41 existed to fix. What went unnoticed is that the
rebuild was also **the only mechanism by which an externally rewritten buffer ever reached the
view**. The replacement (§2's live-update effect) covers the typing case it was written for and no
other.

So this is one regression, five days old, in a change that was right about what it set out to do —
not four features independently broken. R90 is where it became visible because Replace is the first
feature added since.

## 2. The cause, and the sentence that names it

`Raw.tsx`'s live-update effect (`Raw.tsx:530`, deps `[store, sourceBuffer, rowIndex, lineIndex]`)
re-derives `handle.text` and `handle.map` from the new buffer and then says, in its own comment:

> Nothing here dispatches a *content* change — the view's own document is already the live, correct
> text (CodeMirror is what the user has been typing into all along).

**That assumption is true for exactly one caller and false for every other.** When the buffer changed
because someone typed, CodeMirror *is* the origin and the view already holds the text. When the
buffer changed because of Replace, Format, Minify, Undo, Redo or Reload, the origin is
`documentSession` and CodeMirror has never been told.

R41 was right to stop tearing the `EditorView` down on every reparse — that was the caret-loss bug it
existed to fix, and the mount effect is correctly keyed on `documentIdentity` (the tab), not `store`.
What it left behind is that **a same-document reparse is now the only path by which an externally
rewritten buffer could reach the view, and that path deliberately refuses to touch the content.**

Two consequences, the second worse than the first:

- **The view is stale.** Visible, and what was reported.
- **`handle.text` and `view.state.doc` disagree.** `handle.map` is rebuilt from the new bytes while
  the view still shows the old ones, so every byte↔UTF-16 conversion through that map now describes
  text that is not on screen. Nothing has been observed to corrupt from this, but a subsequent edit
  is computed against a window whose text is not the window's text.

**There is no self-repair.** `applyReslice` does dispatch content (with `programmaticChange`), but it
runs only from the scroll handler and from `jumpTo` — and `jumpTo` reslices only when the target
falls *outside* the current window. In a document smaller than one window, that is never. Measured:
moving the caret afterwards left the view stale.

## 3. R100 — the session says when it rewrote the buffer

**Decided: an explicit signal, not a text comparison.**

The self-correcting alternative — compare `view.state.doc` against the freshly-derived `handle.text`
and dispatch when they differ — cannot miss a caller, which is genuinely attractive given that
missing callers is the whole bug. It is rejected on cost: the comparison would run on **every
debounced reparse while typing**, and the window is up to ~1 MB (D-031), so it allocates a
megabyte-scale string every ~200ms during ordinary editing to answer a question that is almost always
"no". A length pre-check does not save it, since a same-length replace (`xy` → `ab`) is exactly the
case that must not be missed.

So `OpenDocument` gains a counter:

```ts
/** Incremented whenever `sourceBuffer` is replaced by something *other than*
 *  an edit originating in the Raw editor. R100: `Raw.tsx`'s live-update
 *  effect cannot otherwise distinguish "the user typed this" (the view
 *  already has it) from "Replace/Format/Undo/Reload rewrote it" (the view
 *  has never seen it). */
readonly externalRewrites: number
```

**Four call sites, enumerated rather than approximated** — every place `sourceBuffer` is replaced
by something that is not an edit from the editor:

| Site | Covers |
|---|---|
| `applyReplaceAll` | Replace, Replace All |
| `applyTransform` | Format, Minify |
| `applyUndoEntry` | **both** undo and redo — one shared path, so one increment, not two |
| `reloadFromDisk` | F8 reload, and `reloadAndDiscard`, which delegates to it |

**Not** `applyEdit`, which is the Raw editor's own path and the one case where the view is
already correct.

`Raw.tsx`'s live-update effect then branches:

- `externalRewrites` unchanged → today's behaviour exactly, the in-place `handle.text`/`handle.map`
  refresh plus `bumpDecorationsEffect`. Typing is untouched, which matters: R41 exists because this
  path is performance- and caret-sensitive.
- `externalRewrites` changed → **a full reslice** around the current `caretOffset`:
  `computeWindowBounds(rowIndex, sourceBuffer.byteLength, caretOffset)` then `applyReslice(...)`.
  Not a hand-written content dispatch — `applyReslice` already rebuilds bounds, text and map together
  and annotates with `programmaticChange` so `rawEditExtension` does not record it as a user edit.
  Reusing it is what keeps this from becoming a second, subtly different content path.

**A reslice, not a patch, because the window bounds themselves move.** After a Format the document's
length changes by a large factor; clamping `handle.end` to the new length (what the effect does
today) keeps a window that no longer describes anything meaningful. Recomputing from the caret is
the same thing an open does.

**The caret after an external rewrite.** `applyReslice` maps the selection through its own change
set, which is right for Replace (the caret keeps its place in text that mostly did not move) and
meaningless for Format (every offset moved). The reparse has already re-resolved the *selection* by
structural path (`reresolveSelection`), and `caretOffset` is what this effect reslices around, so the
view lands where the model says the selection is. That is the correct anchor and it needs no new
policy.

## 4. R101 — the guard that stops it coming back

Per-path regression tests are necessary but not sufficient: this bug is *a caller that was never
told about a rule*, and a test per known caller cannot fail for a caller added later.

- **Per-path tests** (R100's own commit): Replace, Replace All, Format, Minify, Undo, Redo and
  Reload each assert `.cm-content`'s text equals the decoded `sourceBuffer` afterwards. The harness
  exists — `test/rawEditCaretSurvival.test.tsx` already mounts a real `Raw` over a real tab-backed
  session in real Chromium, and these are the same shape.
- **R101, the enumeration guard.** A test that asserts every `DocumentSession` method which replaces
  `document.sourceBuffer` either increments `externalRewrites` or is the one documented exception
  (`applyEdit`). Written so that adding a sixth rewriting method without touching the counter fails,
  rather than shipping stale-until-you-scroll behaviour in a feature nobody thought to check.
  The precedent is invariant 10's own test — "enforced by test, not discipline."

R101 is separate because it is the durable half and should not be squeezed into the fix commit's
review; R100 without R101 is a fix, R101 without R100 is nothing.

## 5. Definition of done

- [x] R100 — after Replace, Replace All, Format, Minify, Undo, Redo and Reload, `.cm-content`'s text
      equals the decoded `sourceBuffer`. Asserted per path, in real Chromium.
- [x] R100 — **typing is unchanged**: no reslice fires on an ordinary edit's debounced reparse, and
      `test/rawEditCaretSurvival.test.tsx` still passes unmodified. That file is the record of what
      R41 cost to get right; if it needs changing, something in this fix is wrong.
- [x] R100 — after an external rewrite the caret is somewhere sensible and the view is scrolled to
      it, rather than left at a stale offset in re-flowed text.
- [x] R101 — a test fails if a `DocumentSession` method replaces `sourceBuffer` without marking it.
- [x] `Raw.tsx:530`'s comment is rewritten. It states the false assumption plainly and confidently,
      which is why four features inherited it.
- [x] `docs/FINDINGS.md` gains the general form: **a buffer rewritten outside CodeMirror does not
      reach the Raw view on its own**, and the Tree/Detail agreeing is not evidence that it did.
- [x] `docs/LOG.md` records that R41 is the regression point and that Format/Minify/Undo/Redo/Reload
      displayed correctly before it — the date matters, because "broken since M3" and "broken five
      days ago by the round that fixed caret loss" are different stories about the same symptom.

## 6. Results

Built as specified in §3/§4, with one addition §3 did not anticipate: **the reslice itself was
wrong on the first pass.** `applyReslice`'s incremental path (`planReslice`'s two-edge dispatch)
assumes the old and new windows describe the *same underlying buffer*, just scrolled — it keeps
whatever `handle.text` already holds for the byte range the two windows share, which is exactly
right for a scroll-triggered recentre and exactly wrong here: an external rewrite can leave the
byte range at the same *offsets* while the *content* at those offsets is now completely different
(a Format changes every offset; a Replace can too). Measured directly: formatting `{"a":1,"b":2}`
first rendered as `{"a":1,"b":2} "b": 2\n}\n` — old text and new text spliced together at whatever
offset the two windows happened to overlap. Fixed with `applyReslice`'s new `forceReplace`
parameter, which skips `planReslice` entirely and takes the `'replace'` branch unconditionally —
the external-rewrite call site (`Raw.tsx`'s live-update effect) always passes `true`. This is the
kind of defect the working agreement's review pass exists to catch — found writing the per-path
regression test (`test/rawExternalRewrite.test.tsx`), not by inspection.

Five tests in `test/rawExternalRewrite.test.tsx` (Replace All, Format, Minify, Undo, Redo) plus
Reload — all real Chromium, a real tab-backed `DocumentSession`, asserting `.cm-content`'s text
against the decoded `sourceBuffer`. `test/rawEditCaretSurvival.test.tsx` (R41's own regression
test) passes unmodified, confirming typing's own path is untouched. `test/
externalRewritesEnumeration.test.ts` is R101's enumeration guard — a static scan of
`documentSession.ts`'s own source for every function that constructs a new `SourceBuffer` or
assigns `sourceBuffer: result.sourceBuffer`, asserting each either references `externalRewrites`
in its own body or is the one documented exception (`applyEdit`); verified to actually fail by
temporarily removing one call site's increment and confirming the guard catches it.
