# R168 — a Raw edit on a CRLF document lands at the wrong byte

<!-- status: built -->

**Built.** The one item this round owed — §11's question of whether a mouse *click* past the end of
a CRLF line can place the caret inside the pair — **was answered by R179, and the answer was yes**;
see §12. Register: `docs/TASKS.md`.
Results in §10. **The reported data corruption is fixed** — it was a real invariant-6 violation.
Found by a user running R164–R167's owed manual pass against a real build; the pass was looking for
something else entirely.

---

## 1. The symptom, as reported and then reproduced

A file with CRLF line endings, opened in Raw. The user placed the caret after `Jante` on **line 2**
and typed `t`, intending `Jantet`. The buffer received `Jantte` — the character landed **one byte
early**. Reported twice, from two independent attempts, before anyone knew why.

Reproduced in the real editor harness (`test/rawEditCaretSurvival.test.tsx`'s fixture shape, real
Chromium, real CodeMirror):

```
[CRLF] CodeMirror doc has CR: false   length: 25      (the buffer is 27 bytes)
[CRLF] buffer after edit: "{\r\n  \"name\": \"Jantte Doe\"\r\n}"

AssertionError: expected '…"Jantte Doe"…' to be '…"Jantet Doe"…'
```

**The drift equals the number of line breaks before the edit point.** Line 2 is one break, so one
byte. An edit on line 10 lands nine bytes early. On an LF-only document there is no drift at all,
which is why nothing has ever caught this.

## 2. The mechanism

Three facts, each read from the current tree at the line cited.

1. **CodeMirror discards the `\r`.** `Raw.tsx:346` builds the editor with
   `EditorState.create({ doc: text })` and nothing sets the `lineSeparator` facet, so CodeMirror
   uses its default split, `/\r\n?|\n/`. A CRLF becomes a single line break and **the carriage
   return is not in the document at all** — the probe above confirms it directly: 25 units against
   27 bytes.

2. **The byte map is built from that document.** `rawEdit.ts:163` takes
   `priorText = update.startState.doc.toString()` — CodeMirror's text, CR-free — and
   `applyChangesToSession` (`rawEdit.ts:99`) does `buildOffsetMap(priorText, encoding)`.

3. **The resulting offsets are applied to the buffer, which still has the `\r`.**
   `rawEdit.ts:101-106` converts `change.fromA`/`toA` through that map and hands
   `origin + fromBytes + shift` to `session.applyEdit`, which splices the real byte buffer.

So the map undercounts by one byte per preceding CRLF. Every arithmetic step is individually
correct; the two sides simply disagree about what text they are measuring.

## 3. Why this is severe

- **It is silent data corruption.** The user sees the character where they typed it, because
  CodeMirror renders its own document. The buffer is what gets written on save, and it holds
  something else. The visible "jump" they reported is the reparse rebuilding the window from the
  wrongly-patched bytes.
- **CRLF is the Windows default.** This is not an exotic input.
- **It breaks invariant 6**, which is the decision the rest of the design hangs on: *"Editing
  happens only in the Raw view; Save writes the byte buffer … this is what makes byte-identical
  saves possible."* A byte-identical save of the wrong bytes is not the promise.

## 4. Blast radius — verified, and expected-but-unverified

Stated separately on purpose, per `PLANNING.md` §2.

**Verified:** a single-character insertion on line 2 of a CRLF document lands one byte early.

**Expected, from the same conversion, not yet demonstrated:**

- **Deletion and replacement** — `toA` goes through the identical `map.toBytes` call, so a
  selection deleted on line N should be off by the same amount at both ends.
- **The caret offset the session records.** `rawEdit.ts:189` builds a *second* map the same way
  (`buildOffsetMap(postText, encoding)`) to compute `caretOffset`, so node resolution, "Locate in
  Source" and undo-restore positions should all drift on CRLF files too.
- **`rawCaretSync`** resolves a clicked caret through `window.map.toBytes` — a different map, built
  in `Raw.tsx` from the *decoded window text*, which **does** contain the `\r`. If that is right
  and `rawEdit`'s is wrong, the two disagree with each other, which is worth confirming before
  changing either.

**Believed unaffected:** Find/Replace, which computes byte offsets from the buffer itself rather
than from CodeMirror's text.

R168 should establish each of these rather than assume them — the shape of the fix depends on how
many maps are wrong.

## 5. Why the suite missed it, which is a finding in its own right

**Every Raw edit fixture in the suite is LF-only.** `rawEditCaretSurvival.test.tsx`,
`rawExternalRewrite.test.tsx`, `documentEdits.test.ts` — all of them build documents with `\n`, so
the units and the bytes have always agreed and the conversion has never been exercised against the
line ending most of the target platform uses.

That is the same class as R151's finding about CI: a whole dimension of the input space that no
test ever varied. **R168's acceptance therefore includes CRLF fixtures for the existing edit tests**,
not only a new test for the new fix — otherwise the next thing to touch this path re-introduces it
against a green suite.

## 6. Candidate fixes

Not settled here; the round should verify before choosing.

**(a) `EditorState.lineSeparator.of('\n')`.** Splitting only on `\n` leaves the `\r` in the line's
own text, so CodeMirror's document becomes byte-faithful and every existing conversion aligns with
no other change. Cheapest and most likely correct. **Must be checked for:** whether the `\r` renders
as a visible placeholder (`highlightSpecialChars` is not currently among Raw's extensions, so
probably not — verify rather than assume), whether it lands at line *ends* where the caret can be
placed after it, and what a **mixed-ending** file does, since CodeMirror would then no longer treat
a lone `\r` as a break at all.

**(b) Give `rawEdit` a map built from the window's bytes** rather than from CodeMirror's text, and
translate CM units → byte offsets across the dropped CRs. Keeps the editor's document as it is.
More code, and it must stay correct as the window re-slices.

**(c) Normalise the buffer to LF on open. Rejected outright** — it breaks invariants 6 and 7, and
turns "open and save an untouched file" into a rewrite of every line ending in it.

## 7. Non-functional expectation (`PLANNING.md` §3)

**The conversion is on the keystroke path.** `applyChangesToSession` builds a fresh offset map per
transaction — deliberately, per J1 — so whatever the fix is, it must not turn that into a scan of
the whole document per keypress. The map is already built from the *window* (~1 MB bounded by
D-031), and the fix must not widen that to the file.

`PLANNING.md` §1 does not apply: nothing here is a visual decision. §2 is the whole of §2 above.

## 8. Acceptance criteria

1. A test that **fails before the fix** with the exact reported symptom — a CRLF document, an
   insertion on line 2, asserting the resulting bytes. The reproduction in §1 is that test, already
   written and confirmed failing.
2. Insertion, deletion and replacement all land at the correct byte on a CRLF document, on **more
   than one line**, so a fix that happens to work for a drift of one is not mistaken for correct.
3. The caret offset the session records is correct on a CRLF document (§4).
4. **Existing Raw edit tests gain CRLF variants** (§5).
5. A CRLF file opened and saved without editing is still byte-identical — invariant 6 and 7 hold,
   and whatever the fix does must not touch the untouched case.
6. Mixed line endings in one document behave sanely, or the round states plainly what it does with
   them.

## 9. Not in scope

R164–R167's security work, which is unrelated and touches no edit-path file — verified by diffing
that branch against `main` by filename before this document was written. The two rounds are
independent; this one was merely *found* during the other's manual pass.

---

## 10. Results

**Built, with one item owed** (§11). The reported corruption is fixed and the fix is one line.

### 10a. What landed

`Raw.tsx`'s `EditorState.create` gained **`EditorState.lineSeparator.of('\n')`** — candidate (a),
and nothing else in the edit path changed. Splitting on `\n` alone leaves the `\r` in its line's own
text, so CodeMirror's document becomes byte-faithful to the window and **every existing conversion
becomes correct at once**: `rawEdit`'s splice map, `rawEdit`'s separate caret map, `rawCaretSync`'s,
and the decorations'. §2's three facts were all confirmed exactly as written.

Candidate (b) — teaching each conversion about dropped CRs — was not needed, and would have been
worse for the reason §6 anticipated: it leaves four places that each have to stay right, where (a)
removes the disagreement they were all compensating for.

### 10b. Acceptance, criterion by criterion

1. **A test that fails first** — `test/rawCrlfEdit.test.tsx`, nine cases. Before the fix **seven of
   the eight** original cases failed; the one that passed was the untouched-save case, which is
   correct, since a document nobody edited never reaches the conversion. The headline failure was
   the reported symptom exactly: `expected 25 to be 27` on the document length, then `Jantte` for
   `Jantet`.
2. **Insertion, deletion and replacement on more than one line** — all four covered. The line-4
   insertion is the one that matters: before the fix it produced `"c": z"xy"`, three bytes early, so
   a fix correct only for a drift of one could not have passed it.
3. **The caret offset the session records** — asserted against an expectation derived from the
   *source* rather than from the edited buffer, so it cannot agree with an incorrect splice.
4. **Existing Raw edit tests gained CRLF variants** — four in `rawExternalRewrite.test.tsx`
   (Replace All, Undo, Redo, Reload) and one in `rawEditCaretSurvival.test.tsx`. All five were
   **verified to fail with the fix disabled**, so none is vacuous: the external-rewrite cases fail
   on `expectViewMatchesBuffer` (the view drops every `\r`, the buffer keeps them), and the
   keystroke-sequence case produced `"012xy"` — the drift accumulating across three keystrokes,
   which a single-keystroke case cannot show.
5. **A CRLF file opened and saved untouched is byte-identical** — asserted on the bytes handed to
   `api.document.write`, and passing both before and after.
6. **Mixed line endings** — covered by a case that edits a CRLF line and an LF line in the same
   document and asserts both. §10d states what the fix does with a lone `\r`.

`documentEdits.test.ts` deliberately gained nothing. It works in bytes and byte offsets given to
it; it never converts units to bytes, so it was never affected, and a CRLF fixture there would
assert nothing new. Recorded rather than silently skipped.

Full suite **1874 passed**, lint at its 3-warning ratchet, typecheck clean.

### 10c. What §6a's check actually found — and one wrong turn worth recording

§6a asked whether the retained `\r` renders, and whether the caret can be placed *after* it. Both
were measured rather than assumed, and the second went wrong before it went right.

**Rendering: no.** The `.cm-specialChar` count is zero — `highlightSpecialChars` is not among Raw's
extensions, as §6a guessed — and line 1 of `{\r\n…` renders as `<span>{</span>`. The `\r` is in the
DOM text node and occupies no width.

**The caret: the position exists, but real input does not land on it.** The offset *after* the `\r`
is `line.to`, and three CodeMirror APIs answer it: `moveToLineBoundary`, `posAtCoords` past the end
of the line, and `moveByChar` forward. On that evidence this looked like a genuine regression —
typing there splits the CRLF into `\r`, the typed text, and a bare `\n`, which over an editing
session would drift a CRLF file towards mixed endings. That is not acceptable for a project whose
promise is byte fidelity, so a second fix was written: `EditorView.atomicRanges`, marking each
`[\r, next line)` pair atomic.

**Both halves of that were wrong, and the diagnosis was wrong first.**

- **`atomicRanges` is the wrong tool here.** Its skip logic biases by direction of travel, which
  suits an inline widget; a range spanning a *line break* makes a click past the end of line 1 land
  at the start of line 2 — a caret that jumps lines, worse than what it was fixing.
- **The premise was wrong too.** Those three APIs are on no input path in this application. There is
  no `@codemirror/commands` dependency and therefore no standard keymap: Home, End and the arrow
  keys are the **browser's** own contentEditable motion, resolved against *rendered* geometry. The
  `\r` renders as nothing, so `Selection.modify(…, 'lineboundary')` — the primitive the End key
  actually uses — answers the position **before** the `\r`, and typing there produces `{X\r\n`,
  which is correct. Measured, not reasoned about.

The `atomicRanges` module was deleted. `test/rawCrlfEdit.test.tsx` keeps the measurement as an
assertion rather than leaving the conclusion recorded only here: it drives `Selection.modify` and
asserts the resulting position is `line.to - 1`.

**The lesson, which is R159's own in a different guise:** a measurement is worth only what the path
it measured is worth. Three CodeMirror APIs agreed with each other, and all three were irrelevant,
because none of them is what this application's keyboard actually calls.

### 10d. What this does with a lone `\r`

A lone carriage return is **no longer a line break** — it is ordinary text inside its line. This is
a deliberate consequence of splitting on `\n` alone, and it is what keeps the document
byte-faithful. No format this application parses emits lone-`\r` line endings (a pre-1999 Mac
convention), and a *mixed* CRLF/LF file — which is common, and which the previous behaviour also
handled, by discarding the CRs — is now handled exactly, asserted by its own test.

### 10e. Non-functional (§7)

The fix adds no work to the keystroke path. It changes how one string is split at mount, not what
happens per transaction: `applyChangesToSession` still builds one offset map per transaction from
the window text, unchanged. Suite duration is unmoved — 41.7 s against 41.6 s before, with fourteen
more tests.

### 10f. Review pass

Reviewed as a separate pass over `git diff`, per `CLAUDE.md`. Two findings, both fixed before the
commit:

- A comment in `rawExternalRewrite.test.tsx` cited "the plan's §9" for why Format and Minify are
  absent from the CRLF cases. §9 is about R164–R167 and says nothing of the sort. Repointed at
  §10g, where the question is actually recorded.
- The first version of the caret-offset test computed its expectation from the *edited buffer*,
  which is the thing under test — it would have agreed with any splice, correct or not. Now derived
  from the source string.

### 10g. One question this round did not answer

**What Format and Minify do to a CRLF document's line endings.** Both regenerate the text through
the format module, which emits its own endings, so formatting a CRLF file may well convert it to LF
throughout. That is a question about the *formatter*, not about the Raw view's offsets, and it
predates R168 entirely — which is why the CRLF variants added to `rawExternalRewrite.test.tsx`
deliberately exclude both. Recorded here rather than left for someone to trip over.

## 11. Owed

**Whether a mouse click past the end of a CRLF line can place the caret between the `\r` and the
`\n`.** The keyboard path is measured and correct (§10c). The pointer path is not: CodeMirror's
`posAtCoords` answers the position *after* the `\r`, and whether a real click resolves through that
or through the browser's own native caret placement could not be settled in the test harness —
`caretPositionFromPoint` and `caretRangeFromPoint` are both unavailable there, so any answer would
have been a guess dressed as a measurement.

If it is reachable, the consequence is narrow and cosmetic: text typed at that one position lands
between the `\r` and the `\n`, turning that line's ending into a bare LF. Nothing is lost or
misplaced from the user's point of view — both orderings render identically — but it is a fidelity
leak, and fidelity is this project's whole argument.

**It needs one manual check on a real build**, which is why it is disclosed rather than guessed at:
open a CRLF file, click well past the end of a line, type a character, save, and look at the bytes.

## 12. The owed question, answered by R179

§11 left one item owed: **whether a mouse *click* past the end of a CRLF line can put the caret
between the `\r` and the `\n`.** The keyboard path had been measured; the pointer path had not,
because `caretPositionFromPoint` and `caretRangeFromPoint` were both unavailable in the harness of
the day, so any answer from it would have been a guess dressed as a measurement.

**R179 (`docs/plans/R179-crlf-caret-position.md`) measured it, and the answer is yes.** Driven
through `userEvent` in real Chromium — genuine CDP mouse events rather than the geometry helpers
this round had reached for — a click at the end of the rendered text and a click *past* the end of
the line both landed on `line.to`, inside the pair. So did `ArrowRight` and `ArrowUp`, which this
round's §6a had concluded could not.

Typing there produced exactly the corruption feared: `alpha\rds\nbeta…`, the CR terminating a line
by itself. **A user hit it by hand before any test did.**

R179 fixed it with a transaction filter and `test/crlfCaretPosition.test.tsx` now holds the
behaviour. The owed entry is closed and removed from `docs/TASKS.md`.

**Worth keeping, because the shape recurs**: this round gathered real evidence about the *keyboard
API surface* and drew a conclusion about the *browser's behaviour*, which was never measured. R179's
§4 says the same thing at more length, and R171 is a third instance of it.
