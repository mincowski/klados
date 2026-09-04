# R124 — the go-to hint says which unit *this* document takes

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Reported as a question — *"when I click the line number in the
status bar I can go to a line number or byte offset. Entering a line number is easy. But how do I
enter a byte offset?"* The answer is that there is no way to choose, and nothing in the UI says so.
Sibling: `docs/plans/R120-find-bar-keyboard.md`, reported in the same message but a separate topic.

**Every question in this document is settled.** The wording below was rendered in both themes before
being written down, not picked in the abstract.

---

## 1. The answer to the question

**It is automatic, and the document decides — not the user.** `parseGoToPosition`
(`src/renderer/navigation/goToPosition.ts`) accepts a bare non-negative integer and nothing else,
then branches once:

```ts
if (hasMeaningfulLines(line, byteLength)) {
  return { offset: offsetOfLine(bytes, rowIndex, line, n), kind: 'line' }
}
return { offset: Math.max(0, Math.min(byteLength, n)), kind: 'byte' }
```

`hasMeaningfulLines` (`detailModel.ts`) is `lineCount > 1 && byteLength / lineCount <
MEANINGFUL_LINE_MEAN_BYTES`. So a normal file takes a **1-based line number** and there is no syntax
that gets you a byte offset; a minified file — one long line — takes a **0-based byte offset** and
there is no syntax that gets you a line.

**So the user's own guess is right, and no new syntax is needed.** The app is already self-consistent
on this: a document with meaningful lines never shows a byte offset anywhere to paste back in. The
status bar shows `Ln 42, Col 7` for it and `Byte 1,048,576` for a minified one (`caretPositionLabel`),
and the Detail pane's node header says `line 42` versus `bytes 1024–2048` (`sourceRangeLabel`) off
the same predicate. There is no byte offset on screen in a lines document, so there is nothing you
could want to type.

**The defect is the copy, and it is in three places** — each of which promises a choice that does not
exist:

| Where | Says today |
|---|---|
| `Palette.tsx`, the `:` mode hint | `Type a line number or byte offset` |
| `StatusBar.tsx`, the caret button's `title` | `Go to Line/Byte` |
| `Shortcuts.tsx`, `IN_PANE_KEYS` → Command Palette | `:line or :offset` → `Go to a line number or byte offset` |

Read together they say "type one or the other." What is true is "type the one this document uses,
and here is which."

---

## 2. The wording — rendered, then chosen

Six candidates were rendered inside a real `.palette` against `tokens.css`, in both themes, at the
palette's real `min(560px, …)` width. What the rendering settled: the range fits on one line for the
lines form and wraps to two for every byte form, so the byte form's *second* clause has to be worth
a second line rather than an afterthought hanging off an em dash.

**Chosen:**

| Document | Hint |
|---|---|
| has meaningful lines | `Type a line number (1–41,038)` |
| does not | `Type a byte offset (0–10,485,760). This document has no lines to number.` |

Numbers via `toLocaleString()`, matching `caretPositionLabel`'s own formatting in the strip the
button lives in. `lineCount` is already on `LineIndex`; `byteLength` is `sourceBuffer.byteLength`.

**Rejected:** `No line structure in this document — type a byte offset (0–…)` — it leads with the
negative, so the reader meets a fact about the document before the instruction they came for.
`Type a byte offset, 0 to 10,485,760 — this document has no lines` — the em-dash clause wrapped
into the second line as a fragment; two sentences read better at that width.

The second clause is the whole point of the round. Without it, the byte-mode hint just swaps one
unexplained unit for another; with it, the palette answers "why can't I type a line number?" at the
moment the question arises.

**Unchanged:** the confirmation line (`Enter to go to line 42` / `Enter to go to byte 1024`) already
names the unit correctly once something has been typed. This round fixes the state *before* that —
which is the only state the user was ever in when they wondered.

---

## 3. The other two strings

**Status bar button `title`** — the same fact, so the same split:
`Go to Line` / `Go to Byte Offset`. `ReadyStatus` already has the document; the predicate is one
call it makes nowhere yet but `caretPositionLabel`, three lines above, already makes.

**Shortcuts panel row** — one string, since it describes the palette in general rather than an open
document:

```
{ keys: ':42', does: 'Go to line 42 — or byte offset 42 in a document with no lines' }
```

`:line or :offset` as a key column was also part of the problem: it reads as two accepted syntaxes.
`:42` is the whole grammar.

---

## 4. What this deliberately does not add

**A byte-offset syntax for documents that have lines** (`:b1024`, `:0x400`, `:@1024`). Rejected, and
not only on scope: nothing in the app ever puts a byte offset in front of you for such a document
(§1), so the feature would exist to consume a number the UI never produces. If `sourceRangeLabel` or
the status bar ever start showing byte offsets for lines documents, this becomes a real request and
should be reopened then — recorded here so the reasoning is visible rather than re-derived.

**Any change to `hasMeaningfulLines`' threshold.** The heuristic is D9's and is used by four callers;
this round only reports what it decided.

---

## 5. Acceptance criteria

1. With a multi-line document open, the palette's `:` mode with an empty query shows
   `Type a line number (1–N)` with `N` the real `lineCount`, and **no** mention of bytes.
2. With a minified document open (one long line, so `hasMeaningfulLines` is false), it shows the
   byte form including the second sentence.
3. Both of 1 and 2 assert the rendered string, not the predicate — the defect was copy, so the test
   has to read the copy.
4. The status bar caret button's `title` is `Go to Line` in case 1 and `Go to Byte Offset` in case 2.
5. `test/goToPosition.test.ts` is untouched and still passes: no parsing behaviour changes in this
   round.

---

## 6. Results

All three strings changed exactly as chosen in §2–3, copy only:

- `Palette.tsx`'s `:` mode empty-query hint now branches on `hasMeaningfulLines(readyDocument.lineIndex,
  readyDocument.sourceBuffer.byteLength)`: `Type a line number (1–N)` (N = `lineIndex.lineCount`) or
  `Type a byte offset (0–N). This document has no lines to number.` (N = `sourceBuffer.byteLength`),
  both via `toLocaleString()`.
- `StatusBar.tsx`'s caret button `title` now branches on the same predicate (already imported for
  `caretPositionLabel`, three lines above): `Go to Line` / `Go to Byte Offset`.
- `Shortcuts.tsx`'s `IN_PANE_KEYS` Command Palette row is now
  `{ keys: ':42', does: 'Go to line 42 — or byte offset 42 in a document with no lines' }`.

`parseGoToPosition` and `hasMeaningfulLines` themselves are untouched; `test/goToPosition.test.ts`
passes unmodified.

New coverage: `test/goToPositionHint.test.tsx` (real Chromium, real document opened through the
fake-parse transport, `test/palettePathQuery.test.tsx`'s own harness) — one multi-line document and
one single-line (no-newline) document, asserting the exact rendered palette hint string and the
exact status-bar button `title` for both, per acceptance criteria 1–4.

**Review pass:** read `git diff` before committing, as `CLAUDE.md` requires. Nothing found — the
change is copy plus one predicate call already imported in `StatusBar.tsx` and newly imported in
`Palette.tsx`; no invariant, no new O(n) work, no test asserting shape instead of the literal string.
