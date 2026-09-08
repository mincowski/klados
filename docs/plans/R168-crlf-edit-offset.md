# R168 — a Raw edit on a CRLF document lands at the wrong byte

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. **Data corruption, reproduced, and it breaks invariant 6.**
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
