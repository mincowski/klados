# R201 — the path query grammar cannot name a non-ASCII node

<!-- status: built -->

**Built.** The `FINDINGS.md` "known-wrong" entry, closed. § 4 records what an audit of the rest of
the codebase found, because the question that prompted this was *"is that the only place?"*
Results in § 9.

## 1. The defect

`src/core/path/parse.ts:185`:

```ts
const NAME_CHAR = /[A-Za-z0-9_.:-]/
```

A query like `//größe` fails to **tokenize** — the cursor stops at `ö` and the parse fails with a
syntax error, one layer before name resolution is ever reached. The Palette cannot reach a
non-ASCII-named node by typing its name, in any document, in any format.

**This is not R53.** R53 fixed `Interner.lookup`'s encoding round-trip so that a non-ASCII name
*resolves* correctly once it arrives, and added `'unrepresentable'` as a distinct answer. That fix is
real and tested. This is the layer above it, and it means R53's fix is currently unreachable from
the UI.

## 2. Widening the character class is not sufficient

`/[\p{L}\p{N}_.:\-]/u` is the obvious change and it is **half a fix**, which is worth stating before
someone makes it and closes the entry.

`Cursor.peek()` is `this.source[this.pos]` (`parse.ts:197`) — **a UTF-16 code unit, not a code
point.** For any character outside the BMP it yields half a surrogate pair, and a lone surrogate
matches no `\p{L}` class however the regex is written. So astral names still fail: CJK Extension B
(U+20000+) is the realistic case in this project's own domain, and Gothic, Osage and the
mathematical alphanumerics are the easy test cases.

**The cursor must advance by code point**, which is a change to `Cursor`, not to a regex.

## 3. Prefer exclusion to whitelisting

XML's tokenizer already learned this, and says so at `src/formats/xml/index.ts:35`:

> Permissive on purpose: a byte-scanning tokenizer, not a strict XML NCName validator. Excludes
> markup delimiters and whitespace, nothing else.

That is why `<größe>` parses today while `//größe` does not: the parser **excludes delimiters**, the
path grammar **whitelists letters**. A whitelist is wrong here for the same reason it was wrong
there — the set of characters a name may contain is open, and the set the grammar needs to reserve
is small and closed (`/`, `[`, `]`, `@`, `=`, quotes, parens, whitespace, the operator characters).

**Define `NAME_CHAR` by what the path grammar reserves**, so the next script added to Unicode needs
no change here. The round should state the reserved set explicitly and test that each member still
terminates a name.

## 4. What the rest of the audit found

Prompted by *"is that the only place?"* — searched for ASCII character classes, case folding,
collation, and code-unit assumptions.

**Correctly ASCII, not defects:**

| Site | Why it is right |
|---|---|
| `renderer/commands/context.ts:140` `IDENT_CHAR` | the `when`-clause DSL. Its identifiers are ours, declared in code, never user data |
| `formats/toml/index.ts:77` `isBareKeyByte` | the TOML spec defines bare keys as `A-Za-z0-9_-`; non-ASCII keys must be quoted |
| `formats/json/index.ts:33` `isDigit` | the JSON grammar's numbers are ASCII digits |
| `formats/csv/header.ts` `NUMERIC_PATTERN` | a header-detection heuristic over CSV numerics |

**Already Unicode-correct:** XML names (§ 3), `rawOffsetMap.ts` surrogate handling
(`codePointAt`, `units += codePoint > 0xffff ? 2 : 1`), `gridSort.ts` via `Intl.Collator`,
`textEncode.ts` (UTF-8, UTF-16LE/BE and single-byte legacy, with a representability check rather
than silent loss).

**Two genuine gaps, neither belonging to R201**, recorded here so the audit is not re-run:

1. **Nothing anywhere calls `String.prototype.normalize`.** A name or needle in NFC never matches
   the same text in NFD — `é` as U+00E9 against `e` + U+0301 — in search, in the grid's quick
   filter, and in path-name resolution, which compares interned **bytes**. macOS filesystems and
   several common exporters emit NFD, so this is reachable with ordinary files. **Undocumented
   anywhere before this audit.**
2. **The byte path's case-insensitive compare is ASCII-only folding** while the decoded path uses
   full `toLowerCase()`. This one *is* documented — D-082, with 154 measured disagreeing pairs
   across U+0020–U+2FFF and zero for any ASCII needle — and was **accepted** on the judgement that
   this project's documents are unlikely to search non-ASCII text. That premise is exactly what a
   "Unicode all the way through" position revises, so D-082 is **reopenable, not wrong**.

Both are deferred out of R201 deliberately: they are comparison-semantics decisions with a shared
hard problem (§ 5), and R201 is a tokenizer fix that is correct regardless of how they land.

## 5. Why normalization is not a small follow-up

Recorded now so the next round does not start by assuming it is.

Invariant 1 forbids decoding the document to a JS string, and invariant 6 requires Save to write the
original bytes — so **normalization can never be applied to the document**, only to a comparison.
And a normalizing comparison changes lengths: NFD `e` + U+0301 is two code points where NFC `é` is
one, so **a match offset found in a normalized window does not map back to a byte offset in the
document**.

That is the same obstacle D-082 already declined for length-changing case mappings (`textFind.ts`'s
limit 3, `'İ'.toLowerCase()` going 1 code unit to 2), for the same reason. Any round that takes this
on has to answer the offset-mapping question first, and that answer is the round — not the
`.normalize()` call.

## 6. Rejected

**Widening `NAME_CHAR` and closing the entry.** § 2 — it leaves astral names broken, and the
`FINDINGS.md` entry would read as fixed.

**Validating names against XML's NCName production.** The path grammar resolves against whatever the
document interned, across four formats with different name rules. A validator would reject names
that legitimately exist in the store.

**Normalizing the query before resolution, as a quick win.** § 5 — it would make some NFD documents
findable and silently change which node a query resolves to, without the offset question being
answered. A half-answer here is worse than the current honest failure.

## 7. Acceptance

1. `//größe` parses and resolves against a document containing that element.
2. **An astral name resolves** — a CJK Extension B element (U+20000+), which pins § 2's code-point
   fix rather than only the character class.
3. Each reserved character still terminates a name, asserted per character rather than by sampling.
4. A name containing a character the document's encoding cannot represent still returns R53's
   `'unrepresentable'`, not a parse error — the two failure modes stay distinct.
5. `FINDINGS.md`'s `NAME_CHAR` entry is removed, and its two surviving neighbours (§ 4) are recorded
   in its place rather than being lost with it.
6. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 8. Version

Candidate was patch — a defect fix in the query grammar. **Deferred to the end of the branch**: R202–R205
land with this one, and § 12 of `docs/plans/R202-unicode-comparison.md` proposes the bump for the
round as a whole.

## 9. Results

**Built.** All six acceptance criteria met, with one deviation on 5 explained below.

### 9a. What landed

`NAME_CHAR` is gone. In its place, `RESERVED_NAME_CHARS` — `/ [ ] @ * ( ) = ! < > " '` — and an
`isNameChar` that admits **any** code point the grammar does not reserve, excluding whitespace and
C0/C1 controls. The inversion § 3 asked for: the set a name may contain is open, the set the grammar
reserves is closed, so the next script Unicode adds needs no change here.

`Cursor.nextCodePoint()` returns the full code point, and `Cursor.consumeName()` advances by it.
The three grammar positions that read a name — a step, a predicate subject, an attribute name — all
go through `consumeName` now, so they cannot drift apart; before, each ran its own copy of the same
`while` loop.

`matchesWord` (the `and`/`or` boundary check) still reads a **code unit**, deliberately, and says
so. It only asks whether something name-like follows, and a high surrogate is not reserved, so an
astral character after `and` correctly denies the word boundary.

### 9b. What the tests pin

`test/pathUnicodeNames.test.ts`, 21 assertions. `//größe` and an astral `//x𠀀y` both resolve
**end to end** — parse, resolve through the document's own `Interner`, evaluate — rather than only
tokenizing, since tokenizing was never the goal. Each of the thirteen reserved characters gets its
own test that it terminates a name, per acceptance 3 rather than by sampling. And nine characters
the grammar does *not* reserve (`+ # $ % ~ | , ; ?`) are asserted to belong to names now; every one
of them was a tokenizer error before.

Fixtures are authored from escapes with a codepoint guard, per `FINDINGS.md` — including
`ASTRAL.length === 2`, which is the property the old cursor broke on.

### 9c. Acceptance 5, and why it was not followed literally

It asked that `FINDINGS.md`'s `NAME_CHAR` entry be removed and § 4's two surviving gaps be
**recorded in its place**. The entry is removed. The two neighbours were *not* recorded as
known-wrong, because **R202–R205 land on this same branch and fix both** — writing an entry here to
delete three commits later would be churn, and the intent (do not lose them) is better served by
their being fixed than by their being listed. R201 was planned as a standalone round; it is not
landing as one.

### 9d. A stale entry found and corrected

`FINDINGS.md`'s first known-wrong entry still said `CONCEPT.md` §11.1 claims parsing stops at the
first failure and that *"nothing caps the list (`src/core/nodeStore.ts:449` is an unbounded
`push`)"*. **R200 made both false last round and did not update the entry.** Corrected here: the
parser behaviour it describes is unchanged and still surprises people, so the entry stays, but it
now points at the cap and at `store.diagnosticIndex` rather than describing a defect that was
fixed. `FINDINGS.md`'s own rule is that an entry leaves when it stops being true; half of this one
had.

### 9e. Review

Reviewed against `git diff` before the commit. It found one real defect: the whitespace guard had
been written as `/s/u` rather than `/\s/u` — a regex matching the **letter s**, which would have
excluded `s` from every name in every query. Caught by reading the diff, not by a test; every
fixture in the new file happened to contain no `s` in a position that mattered. Fixed before
committing, and the more general lesson is `FINDINGS.md`'s existing one about escapes surviving the
tools that carry them.

