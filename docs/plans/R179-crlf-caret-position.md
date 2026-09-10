# R179–R181 — the caret can rest between the CR and the LF

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. R168 made CodeMirror's document byte-faithful by keeping the
`\r` as an ordinary character. That was right, and it created a document position **inside** the
CRLF pair that ordinary arrow keys and ordinary clicks reached. Typing there spliced bytes between
the CR and the LF, producing a line ending the app never intended and no other editor read back the
same way. §13 records what landed; R181's rule is `DECISIONS.md` D-093.

Found by a user editing `spike/fixtures/small.json` by hand, in the manual pass that has now produced
R168–R171 and R175–R178.

---

## 1. What was observed, and the bytes that prove it

Reported verbatim:

> In Raw view, I clicked somewhere in the text and the caret appeared there. That also works when I
> click at the exact end of the line. If I click behind the text in a line, the caret does not show
> up. But if I then start typing "ds", the typed text appears right at the end of the line. Then I
> opened the file in VSCode and there the "ds" is displayed on a new line.

The file on disk settles it without any reproduction. `spike/fixtures/small.json` now reads:

```
"  \"address\": {\r\n    \"city\": \"Frankfurt\",\rds\n    \"country\": \"Germany\"\r"
```

Ten CRLF pairs and **one bare LF** — the line the user typed on. The insertion landed at
`…"Frankfurt",` `\r` **`ds`** `\n`, so the CR now terminates a line by itself and the LF starts the
next one. VS Code renders a lone CR as a break, which is why `ds` appeared on its own line there and
on paste.

The file is untracked and gitignored, so nothing in the repository was damaged, but that local copy
now holds the broken bytes and should be regenerated before it is used to judge anything else.

## 2. Why the position exists

R168 set `EditorState.lineSeparator.of('\n')` so that `state.doc` is byte-faithful to the window.
CodeMirror's default split (`/\r\n?|\n/`) discards the `\r` entirely, which is what made every
offset conversion undercount and what R168 correctly fixed.

The consequence R168 did not follow through on: with `\n` as the only separator, a CRLF line's
content **ends with the `\r`**, so `line.to` is the position *after* the CR and *before* the LF. That
is a legal document position, one unit wide, and it sits in the middle of what the file means as a
single line terminator.

R168's own comment states the neighbouring consequence — that a lone `\r` is no longer a line break
— and stops there. This is the other half of the same change.

## 3. Measured: which input paths actually reach it

Against a real `EditorView` with `EditorState.lineSeparator.of('\n')`, document
`alpha\r\nbeta\r\ngamma\r\n`, in real Chromium via the browser project (Playwright), with genuine
CDP-driven key events rather than synthetic ones. Line 1 is `alpha\r`, `line.to` is 6, and position
6 is the gap.

| Path | Lands at | Inside the CRLF? |
|---|---|---|
| `End` | 5 (before the CR) | no |
| `Shift`+`End` | 5, selects `pha` | no |
| `ArrowRight` from position 5 | **6** | **yes** |
| `ArrowUp` from the line below | **12** (that line's `line.to`) | **yes** |
| Click at the end of the rendered text | **6** | **yes** |
| Click past the end of the line | **6** | **yes** |

And the symptom the user could see, measured directly:

```
coordsAtPos(line.to)    -> NULL
coordsAtPos(line.to - 1) -> 42
```

**CodeMirror cannot produce screen coordinates for the gap position at all**, which is exactly "the
caret does not show up". The caret is not missing; it is at a position that has no box.

Typing one character there reproduces the user's file exactly:

```
before: "alpha\r\nbeta\r\ngamma\r\n"
after:  "alpha\rds\nbeta\r\ngamma\r\n"
```

The same probe against the default line split produces `alphads\n` — correct placement, but that
configuration is the R168 defect and is not an option.

## 4. Why R168 concluded this was unreachable, and what was wrong with it

R168 considered exactly this failure, built a module to prevent it, then deleted the module after
establishing that the three CodeMirror APIs it relied on were **on no input path**: this editor
loads no `@codemirror/commands` keymap, so cursor motion is the browser's own contentEditable
behaviour. `rawKeymap.ts` binds `Escape`, `Tab`, `Shift-Tab` and `Enter`, and nothing else —
re-confirmed, so that half of the reasoning still holds.

The inference drawn from it does not. "Motion is native, and native motion resolves against rendered
geometry" was taken to mean the caret could not land on a character that renders as nothing. §3 shows
native `ArrowRight` and native `ArrowUp` both land there, because the `\r` occupies a document
position whether or not it paints. **The evidence gathered was about the keyboard API surface; the
conclusion drawn was about the browser's behaviour, which was never measured.**

It is worth naming because the fix R168 deleted was a `Prec.highest` keymap and an `atomicRanges`
extension, and one of those two — the atomic ranges — was independently found to be wrong there (it
biases by direction of travel, so a click jumped to the following line). The module deserved to be
deleted. The conclusion that no protection was needed did not follow from that.

## 5. What else the gap breaks

Beyond the insertion the user hit:

- **Backspace at the start of a line** deletes the `\n` and leaves the `\r` stranded inside the
  joined line — `alpha\rbeta`. A lone CR in the middle of a line, silently.
- **Delete at the end of a line** (caret before the CR) removes the `\r` alone and converts that one
  line ending from CRLF to LF, silently.
- Both survive a save, because invariant 6 means the buffer is written verbatim. The corruption is
  durable and invisible in Klados' own rendering — the same property that made R168 silent.

## 6. R179 — the selection never rests inside a CRLF pair

A transaction filter that inspects every selection range's endpoints and moves any endpoint `p`
where `doc[p-1] === '\r'` and `doc[p] === '\n'` back to `p - 1`.

A filter is the right seam because **every** way the selection changes is a transaction: native
arrow motion, mouse clicks, drag selection, programmatic jumps from Locate in Source, and the
selection CodeMirror derives after native typing. Fixing it once there covers the paths in §3's
table and the ones nobody has enumerated, which is R164's argument and R171's.

Requirements:

- **Both endpoints of every range**, not just the head — a drag can leave `anchor` in the gap.
- **Multiple ranges**, since `changeByRange` and future multi-cursor work produce them.
- **Position 0 and the end of the document** must be safe to test without reading out of bounds.
- **A line ending in LF alone is untouched**, and a mixed-ending file is handled per position rather
  than per document.
- **The clamp must not fight the user**: moving to `p - 1` is the position they visibly aimed at in
  every case in §3, since `p - 1` is where the rendered text ends.

Also to be settled by measurement during the round, not assumed: whether a transaction that
*inserts* at the gap position can arrive without a preceding selection transaction to clamp — drag
and drop and IME composition are the candidates. If one can, the filter clamps insertion positions
too; if none can, the plan says so rather than adding speculative code.

**Acceptance is the user's own sequence:** click past the end of a line in a CRLF document, type,
save, and read the bytes back — the CRLF pair is intact and the typed text precedes it.

## 7. R180 — a deletion crosses the whole line ending, never half of it

With R179 in place the caret cannot sit inside the pair, which removes the insertion defect but not
§5's two deletion defects: those start from positions either side of a *complete* CRLF and delete
one unit.

Backspace at a line's start must remove `\r\n` together when the preceding line ends in CRLF, and
Delete at the position before a `\r` must do the same. Neither is currently bound at all, so this is
a new binding rather than a change to one, and it must fall through to native behaviour everywhere
else rather than reimplementing deletion.

**The test is on the bytes, not the document**: delete across a CRLF boundary, save, and assert the
buffer contains no lone `\r` and no lone `\n` that was not there before.

## 8. R181 — Enter inserts the document's own line ending

Verified, not assumed: `rawKeymap.ts`'s `insertNewlineAndIndentCommand` builds
`const insert = '\n' + leadingWhitespace(line.text)`, a literal LF. **Every line a user adds to a
CRLF file gets an LF ending**, so editing a CRLF document steadily converts it to a mixed-ending
one — a smaller, slower version of the same silent corruption.

The line ending to insert must come from the document, not from `EditorState.lineBreak`, which
follows `lineSeparator` and is deliberately pinned to `\n` by R168 so that splitting stays exact on
mixed files. So the command reads the ending of the line it is splitting (or the document's dominant
ending) and inserts that.

### 8a. What a mixed document gets — settled, with the measurement behind it

Three candidates were weighed. **"Always insert `\n`" is rejected outright, because it is what the
code does today and it is the defect**: it is the mechanism by which a CRLF file drifts to mixed.
Its simplicity is real but it is simplicity purchased by corrupting the file.

**"Document majority" is affordable, and the cost was measured rather than guessed.** Counting CRLF
against LF across a whole buffer runs at **~820 MB/s** — 1.2 ms at 1 MB, 60 ms at 50 MB, **244 ms at
the 200 MB ceiling**. Cheap enough to do once, far too slow to do on every Enter, so it would have
to be computed once and cached. That cache is the real cost: it has to be invalidated when the
buffer changes, and every edit changes the buffer.

**Decided: the ending of the line being split; failing that, the ending of the line before it;
failing that, `\n`.** Majority is not needed at all — and that is the point of the rule rather than
a detail of it. The measurement above becomes the record of an option **not** taken, and the 244 ms
scan and the cache it would have required leave the design entirely.

```
endingOf(n)  = undefined                              if n is the last line (it has no ending)
             = '\r\n'  if line n's text ends with \r
             = '\n'    otherwise

insert       = endingOf(current) ?? endingOf(current - 1) ?? '\n'
```

Every case is `O(1)`: one line lookup, or two. No scan, no cache, no invalidation, and no question
about whether the window or the whole file is the right population to measure — the last of which
was the weakest part of the majority design and it is now moot.

Each clause earns its place:

- **The line being split** is the answer whenever the caret is anywhere but the final line, which is
  nearly always. Splitting a CRLF line yields two CRLF lines.
- **The line before** covers the last line, which by definition has no ending of its own. This is not
  a rare case: a document ending in a trailing newline has an empty final line, so *pressing Enter at
  the end of a file* lands here every time. Reading the previous line's ending gets it right, and a
  majority would have had to be computed to answer the single most common Enter in the editor.
- **`\n`** covers a document with no line break at all, where there is nothing to imitate and no
  majority to consult either. Any choice is arbitrary; `\n` is the one that matches
  `EditorState.lineBreak` and every other default in the codebase.

The rule preserves a mixed file's local structure rather than healing it toward the dominant ending
— the more conservative of the two behaviours, and the one consistent with invariant 6's posture of
writing back what was there. `DECISIONS.md` records the rule, the majority measurement it displaced,
and that "always `\n`" was the defect rather than an option.

Verified while settling this: `leadingWhitespace` is `/^[ \t]*/`, so a trailing `\r` can never be
captured into the indent the command copies. That was worth checking rather than assuming, since an
indent containing a CR would have been a second corruption hiding inside the fix for the first.

R181 is separable. If it is dropped, R179 and R180 still stand on their own and the plan loses
nothing but the slow drift.

## 9. What must not be done

- **Not `atomicRanges`.** Already tried and already found wrong for this in R168: it biases by
  direction of travel, so a range spanning a line break resolves to the wrong side and a click jumps
  to the next line.
- **Not reverting `lineSeparator`.** The default split discards the `\r`, which is the R168 defect
  and a byte-corruption bug an order of magnitude worse than this one. R168 §2's reasoning for
  preferring one facet over teaching four conversions about dropped CRs is unchanged.
- **Not hiding the `\r` with a replacing decoration alone.** It changes what paints, not which
  positions exist, so §3's arrow-key paths still reach the gap.
- **Not a fix in `rawEdit.ts`'s offset mapping.** The mapping is correct — R168 made it so. The
  defect is the position the user is allowed to occupy, which is upstream of every conversion.

## 10. Acceptance

1. No sequence of native arrow keys, clicks or drags leaves a selection endpoint between a `\r` and
   its `\n`, asserted against a real browser rather than a synthetic event.
2. The user's reported sequence, driven end to end on a CRLF document, leaves the bytes correct.
3. A deletion across a line ending removes both bytes or neither, asserted on the saved buffer.
4. If R181 lands: a line added to a CRLF document ends with CRLF, and the choice for mixed documents
   is recorded in `DECISIONS.md`.
5. The caret is visible wherever it can now be placed — §3's `coordsAtPos` returning `NULL` was the
   visible half of this defect, and no reachable position may keep that property.
6. An LF-only document behaves exactly as it does today, asserted rather than assumed.

## 10a. The fixture, added with this plan

`test/fixtures/crlf/small.json` — 206 bytes, eleven CRLF pairs, no bare LF, no bare CR. It is the
repaired copy of the file the defect was found in, so the tests R179–R181 need have a real CRLF
document to run against rather than one assembled in a string literal.

**It needed a `.gitattributes` exemption to survive being committed.** R47 set `* text=auto eol=lf`
across the repository, which rewrites every tracked text file to LF on commit and on every checkout.
Without an exemption this fixture would be stored as LF, checked out as LF, and still be named
`crlf/` — the tests built on it would pass while asserting nothing. `test/fixtures/crlf/** -text`
disables the conversion in both directions.

Verified rather than assumed, since a silent normalization is exactly what this guards against:
`git check-attr` reports `text: unset` for the path, and the blob git actually stored is 206 bytes
with all eleven pairs intact — checked by reading it back with `git cat-file`, not by looking at the
working tree.

`test/crlfFixture.test.ts` then asserts the endings as checked out on the machine running it, on all
three CI platforms. Mutation-verified: rewriting the fixture to LF turns it red.

## 11. Out of scope

Lone-CR documents as a line-ending convention (R168 settled that they are ordinary text). Any change
to how the buffer is saved. Normalising a file's endings on open or on save — this plan is about not
corrupting what is there, not about tidying it.

## 12. Version

No bump implied — defect fixes against unreleased `1.0.0`, consistent with R168–R178.

## 13. Results

All three tasks landed. **The reproduction is exact**: with the fix removed, the browser test
produces the user's own bytes.

```
without R179:  alpha\rds\nbeta\r\ngamma\r\n     the CR ending a line by itself
with R179:     alphads\r\nbeta\r\ngamma\r\n
```

| | |
|---|---|
| **R179** | `crlfCaret.ts` — two transaction filters, wired into `Raw.tsx` beside the facet that creates the position |
| **R180** | `Backspace`/`Delete` bindings in `rawKeymap.ts`, falling through to native everywhere else |
| **R181** | Enter reads the line's own ending; `DECISIONS.md` D-093 |
| Tests | 15 + 12 node (rules), 12 node (keymap), 16 browser (paths and bytes) |

### §6's open question had an answer, and it was not the expected one

The plan asked whether an insertion can reach the gap **without** a preceding selection transaction
to clamp, and said to settle it by measurement rather than to add speculative code. Measured: **a
drop can.** CodeMirror's drop handling takes its position from `posAtCoords` and dispatches the
insertion directly, so it never passes through a selection this module has already moved. With only
the selection clamp installed, dropping text past the end of a CRLF line produced
`alpha\rds\nbeta…` in a real browser — the same corruption by a second route.

So the filter covers insertions too, and the round has **two filters rather than one**. CodeMirror
runs them in sequence, each seeing what the previous produced; the insertion correction has to run
first, because relocating a `\r` moves the positions the selection clamp then judges.

**Expressed as an appended follow-up rather than by rewriting the transaction**, which is the part
worth keeping. A rebuilt spec silently drops annotations, and two of them are load-bearing here:
`programmaticChange` and `programmaticSelection` are what stop `rawEdit` and `rawCaretSync` treating
the app's own replays as user edits. The insertion is allowed to land and the `\r` is moved to the
far side of it, combined into one transaction before anything is applied — so no observer ever sees
the split.

### Measured against real input, because that is where R168 went wrong

Every path is driven through `userEvent`, which issues genuine CDP key and mouse events — not
CodeMirror's geometry helpers (on no input path in this app, and they answer `line.to`, which is
exactly what made this look fine) and not synthetic `KeyboardEvent`s, which contentEditable ignores.

Acceptance 5 is asserted as a property rather than a spot check: **every position the caret can now
reach has screen coordinates**. §3's `coordsAtPos(line.to) -> NULL` was the visible half of the
defect, and the test walks the whole document.

### Mutation-verified, fourteen mutations

R179: removing the extension, making the clamp a no-op, clamping only the head, dropping the
insertion correction, moving forward instead of back. R180/R181: removing either binding, Enter
reverting to a literal LF, `lineBreakAt` losing its previous-line clause, `lineEndingOf` ignoring the
retained CR, either deletion range never matching, and the deletion commands consuming the key
instead of falling through. All red.

**One mutation stayed green, and it is equivalent rather than uncovered.** Removing
`isInsideCrlfPair`'s explicit bounds check changes nothing: CodeMirror's rope clamps an out-of-range
`sliceString` to `''`, which is already not a `\r`. The check is kept as `DocumentSlice`'s stated
precondition and as two fewer rope reads at the boundaries, and both the module and the test now say
so rather than claiming a correctness role the measurement disproved.

### The suite

`npm test`: **1941 → 1993 tests**, 1988 passed and 5 skipped across 165 files, exit 0.
`typecheck` clean; `lint` unchanged at its ratcheted 3 warnings, 0 errors.

### CI found a platform assumption in one test

`End and Shift+End still land where they always did` asserted position 5 and got **20** on
`macos-latest`. §3 measured those keys on Windows, where End is line-boundary motion; **macOS means
something else by it** — End scrolls to the end of the *document*, and line-end is Cmd+Right. The
test had encoded a native convention as though it were a fact about this code.

Split in two rather than platform-gated. The claim that matters — *a selection already outside a pair
is never moved*, which is the failure mode of an over-eager clamp — is a property of the filter, so
it is asserted directly against a set of positions with no key involved and no platform in it. The
native-key test keeps only the portable half: wherever this platform's End goes, it is not between a
CR and its LF, and the anchor of an extended selection does not move. Pinning the landing position
would be testing the operating system.

Same class as R171's finding in a new place: **a test driving a real OS facility inherits its
platform differences**, and CI is what establishes them.

### One failure in the same run was not from this branch

`ubuntu-latest` also failed `TabStrip overflow (R35–R37) > clicking the right chevron scrolls the
strip without changing the active tab`. It passes 3/3 locally and touches nothing this round
changes. **`main` itself has been intermittently red in this class**: two recent `main` runs failed
on `R170 — a deeply nested tree can scroll horizontally`. Reported rather than folded in here,
because a pre-existing flake in the browser project's geometry tests is its own problem and fixing
it inside an unrelated round is how it would stop being visible.

### Review, per `R` id

- **R179** — the first draft's test comment asserted that the bounds check prevented a *wrong
  answer*. It does not, and the mutation run is what established that. Corrected in place rather than
  left as a plausible-sounding claim.
- **R180** — the deletion commands handle only a single empty selection and fall through otherwise.
  Recorded in the code as a deliberate limit: handling partial matches across multiple ranges is
  reimplementing deletion by another name, which §7 rules out.
- **R181** — no finding. The rule went in as §8a specified it, and the one thing worth checking
  (`leadingWhitespace` never capturing a trailing CR) was already verified while the plan was
  written and is now asserted by test.
- **A block comment cannot contain `*/`.** Writing `leadingWhitespace`'s own regex into a doc
  comment closed the comment early and turned the rest of the file into a parse error. Caught by
  `prettier`, fixed by rephrasing, and the applying script now refuses to write a block comment
  containing the sequence.
- **R180 and R181 share one commit**, which the per-`R`-id rule would rather they did not. They are
  not separable in the tree: R181 changes the Enter command three lines from R180's new bindings,
  both sets of rules live in `crlfCaret.ts`, and their tests interleave in the same two files. Named
  rather than quietly ignored.

### Not done, and deliberately

§11's exclusions hold: lone-CR documents stay ordinary text, nothing about saving changed, and no
file's endings are normalised on open or on save. **No version bump**, per §12.
