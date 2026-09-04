# R53 — `Interner.lookup` assumes UTF-8, and answers "not in this document" when it is wrong

<!-- status: built-caveat -->

**Built — with one adjacent gap found and reported, not fixed here (see Results).** Register:
`docs/TASKS.md`.

From `docs/FINDINGS.md`'s known-wrong list, where it carries a qualifier no other entry does:

> **`Interner.lookup` encodes query names as UTF-8**, so a non-ASCII element name in a windows-1252
> document resolves as "absent from the document" and the query returns an empty result **with no
> diagnostic**. The only silently-wrong one on this list.

Promoted to a task for publication because "returns the wrong answer and says nothing" is the one
category of defect a user cannot work around, route around, or even notice.

---

## 1. The mechanism

```ts
const lookupEncoder = new TextEncoder()          // interner.ts — always UTF-8

lookup(text: string): number | null {
  const bytes = lookupEncoder.encode(text)
  const hash = fnv1a32(bytes, 0, bytes.length)
  ...
}
```

`TextEncoder` is **UTF-8 only** by specification — it has no encoding parameter. The interner's
stored names are raw bytes sliced from the source buffer, in **the document's own encoding**, which
invariant 7 says is preserved rather than converted.

So for any document whose encoding is not UTF-8, `lookup` hashes a byte sequence that cannot match
what is stored, for any name containing a non-ASCII character. ASCII names work by coincidence — the
encodings agree there — which is exactly why this has never been noticed.

The comparison path is not at fault: `bytesEqual` compares raw bytes and the class header is
explicit that "comparison on hash collision is done on raw bytes, never on decoded text." The bug is
that the query's bytes were produced in the wrong encoding before they ever reached it.

## 2. Why it is silent

`lookup`'s own contract is what makes it invisible, and the contract is right:

> a name that doesn't exist in the document must intern to *nothing* (the query is then answerable
> as empty without touching the store), never silently create a new interned name no node will ever
> have.

"Not found" is a legitimate, expected answer — `//nonexistent` returning nothing is correct. There is
no way for a caller to tell that answer apart from "found nothing because I encoded your query
wrong." A user searching a windows-1252 document for `//größe` gets the same empty result they would
get for a genuine typo.

## 3. The fix

**`lookup` must encode in the document's encoding, not UTF-8.** The interner already knows the bytes
it stores; what it does not currently know is how to *produce* comparable bytes from a string.

Options, with a recommendation:

- **Pass the encoding in.** The document's encoding is already resolved at parse time
  (`core/encoding.ts`, invariant 7's machinery) and every `lookup` caller sits above a document that
  knows it. Encode the query with the same encoder the read path uses. **Recommended** — it fixes
  the cause rather than the symptom, and it keeps the "compare raw bytes" property intact.
- **Decode stored names and compare as strings.** Correct, and it discards the reason the interner is
  fast — it would decode on every lookup, against a class whose header says decoding "is reserved
  for `text()`, called lazily and cached." Rejected.
- **Return a third state ("cannot encode this query in this document's encoding") and surface a
  diagnostic.** Not a fix, but it is the honest fallback **for a character that genuinely has no
  representation in the target encoding** — `//日本語` against a windows-1252 document is not a
  failed lookup, it is an unanswerable query, and saying so is better than "no results." Worth
  building alongside the fix rather than instead of it.

**Do not change `src/core/types.ts`** to carry this. If the fix appears to need a contract change,
that is a design signal to report — the encoding is renderer/parse-side state and the interner is
constructed per document.

## 4. Verify

- **A windows-1252 fixture with a non-ASCII element name**, queried by that name, returns the node —
  the regression test, and the one that fails today.
- The same query against a UTF-8 document with the same logical name still works — i.e. the fix did
  not simply move the assumption.
- A genuinely absent name still returns `null` with no diagnostic, and an *unrepresentable* name
  returns the new third state with one. These must be distinguishable; that distinction is the point
  of §3's third bullet.
- Existing `test/interner.test.ts` and `test/nodeNameSearch.test.ts` pass unmodified. A test that
  needed changing would mean the fix changed ASCII behaviour, which it must not.

**Fixtures worth checking for while here:** the encoding suite (`test/encoding.test.ts`,
`test/encodingPipeline.test.ts`) may already have a non-UTF-8 document to reuse rather than
authoring a new one.

---

## Results

Built via the plan's own recommended option: pass the document's encoding in, encode the query the
same way the document's own bytes are encoded, keep the "compare raw bytes" property intact.

**`src/core/textEncode.ts`** (new) — `encodeText(text, encoding): Uint8Array | null`, the inverse of
`TextDecoder` (which has no encoding parameter beyond UTF-8, by spec — there is no built-in "encode
to windows-1252" in either the platform or a dependency already in `package.json`, and "no new
dependencies without asking" ruled out reaching for one). Three families, no new dependency:

- **UTF-8** — `TextEncoder`, unchanged from what `lookupEncoder` did before.
- **UTF-16LE/BE** — a direct code-unit write. A JS string already *is* UTF-16 internally, so this
  is not a re-encoding and every character (surrogate pairs included) is representable.
- **Every other declared encoding** (`windows-1252`, `iso-8859-1`, …) — probed once per label:
  decode all 256 possible byte values with `new TextDecoder(encoding)` and invert the resulting
  map. A genuine single-byte code page decodes 256 bytes to exactly 256 code points; anything else
  (a real multi-byte encoding) fails that shape check and correctly falls through to `null` rather
  than producing wrong bytes silently. Every encoding this project's own fixtures and `detectEncoding`
  actually produce is single-byte, so this covers the real cases without a general-purpose transcoder.

**`Interner.lookup(text, encoding = 'utf-8')`** now encodes through `encodeText` instead of a fixed
`TextEncoder`, and returns the third state the plan's §3 asked for: `'unrepresentable'`, distinct
from `null`, when `encoding` cannot represent a character in `text` at all. The default parameter
means the existing production call and every existing test that omits the second argument keeps its
old behaviour exactly — §4's "existing tests pass unmodified" verified directly (`test/interner.test.ts`,
`test/nodeNameSearch.test.ts` both untouched, both still pass).

**The third state had to be threaded one layer further than `interner.ts` itself.** `NameResolver`
(`core/path/parse.ts`) widened from `(name: string) => number | null` to `... => number | null |
'unrepresentable'`, and `parsePath` now fails with a diagnostic — `'<name>' cannot be represented in
this document's encoding`, pointing at the name's own offset — instead of building a step with a
`null` `nameId` that would silently evaluate as "empty" indistinguishable from a real absence. This
is the one place the fix reaches past `interner.ts`'s own file, and it stays inside `core/path/`; no
`src/core/types.ts` change was needed, matching the plan's own expectation.

**`Palette.tsx`'s one production call site** now passes `document.sourceBuffer.encoding`:
`document.store.interner.lookup(name, document.sourceBuffer.encoding)` — previously unencoded
(implicitly UTF-8, wrong for any other document).

**Found and reported, not fixed here: the query grammar itself is ASCII-only.** `core/path/parse.ts`'s
`NAME_CHAR` is `/[A-Za-z0-9_.:-]/` — a query like `//größe` fails to parse as a name at all
(`consumeName` stops at `ö`, and the leftover text fails as an unexpected trailing character), before
`resolveName`/`lookup` is ever reached. This means **the specific user scenario R53's own opening
quote describes — typing `//größe` into the Palette — cannot reach the fixed code today**, because a
separate, adjacent gap blocks it one layer earlier. This was found while building the end-to-end
regression test (`test/pathQueryJob.test.ts`), which had to bypass `parsePath` entirely and construct
a `PathStep` by hand to demonstrate the fix, once the grammar itself refused the fixture query.
**Per "report rather than work around," this is disclosed rather than silently absorbed into R53's
scope or left for someone to rediscover.** Widening `NAME_CHAR` to accept Unicode letters is a small,
separable change (bounded to `core/path/parse.ts`'s grammar, not the interner) — recorded as a
follow-up rather than done here, since it wasn't in R53's own plan and deserves its own review rather
than riding in on this one. `docs/FINDINGS.md` carries a pointer.

**Verified**, per §4 exactly:

- A windows-1252 fixture with a non-ASCII element name resolves via `Interner.lookup` and evaluates
  to the right node (`test/interner.test.ts`'s two new `lookup`-encoding tests; the full parse-through-
  evaluate path in `test/pathQueryJob.test.ts`, constructing the `PathStep` directly for the reason
  above).
- The same logical query against a UTF-8 document still works — every existing `lookup(text)` call
  (no second argument) is untouched behaviour, confirmed by the unmodified existing suites passing.
- A genuinely absent name returns `null` with no diagnostic (`test/interner.test.ts`'s "genuinely
  absent ASCII name" case); an unrepresentable one (`日本語` against `windows-1252`) returns
  `'unrepresentable'` at the `Interner` layer and a `PathDiagnostic` at the `parsePath` layer
  (`test/pathParse.test.ts`'s two new tests) — the two are distinguishable, per §3's third bullet.
- `test/interner.test.ts` and `test/nodeNameSearch.test.ts` pass unmodified.
- New: `test/textEncode.test.ts` (11 tests — the three encoding families plus the unrepresentable-
  character and unrecognized-label cases).

Full node suite: 1167 tests, 90 files. `npm run typecheck` and `npm run lint` both clean (3 known
warnings, unchanged).

`docs/FINDINGS.md`'s "`Interner.lookup` encodes query names as UTF-8" entry is retired by this fix
(replaced by a pointer to the `NAME_CHAR` gap found above) — see that file.
