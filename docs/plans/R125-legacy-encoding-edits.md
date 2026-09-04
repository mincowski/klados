# R125 — legacy single-byte documents are editable; the encoder already exists

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. `encodeForRoundTrip` used to refuse every edit to any
document that is not UTF-8 or UTF-16, under a comment saying real codec tables would be "a
separate, sizable piece of scope." R53 had already built that mechanism —
`src/core/textEncode.ts`, D-074 — for a different caller, and nothing connected the two.
**This round was wiring, not new capability**, exactly as scoped below.

**It is also not a new decision.** D-009 already settled the behaviour: *"Where re-encoding an edit
into a legacy code page would be lossy, the edit is refused with an explanation rather than
substituting characters."* That is a **per-edit, per-character** rule. What shipped is a blanket
per-*encoding* refusal. R125 makes the code match the decision that was already taken.

**Every question in this document is settled.** The round-trips in §2 were measured against the real
`encodeText`, not inferred from its comments.

---

## 1. What is there today

Two call sites refuse, both through the same three-case switch in
`src/renderer/session/documentEdits.ts`:

```ts
export function encodeForRoundTrip(text: string, encoding: string): Uint8Array | null {
  switch (encoding.toLowerCase()) {
    case 'utf-8':     return new TextEncoder().encode(text)
    case 'utf-16le':  return encodeUtf16(text, true)
    case 'utf-16be':  return encodeUtf16(text, false)
    default:          return null
  }
}
```

- `createEdit` (`documentEdits.ts`) — *"Editing isn't supported yet for X-encoded documents."*
- `applyReplaceAll` (`documentSession.ts`) — *"Replacing isn't supported yet for X-encoded
  documents."*

And `src/core/textEncode.ts` exports `encodeText(text, encoding): Uint8Array | null` — **the same
signature and the same `null` semantics** — which handles UTF-8, UTF-16 LE/BE, *and* every
single-byte code page, by probing `TextDecoder` with all 256 byte values once and inverting the
result (D-074). No codec tables, no dependency.

`encodeForRoundTrip` is a strict subset of a function that already ships, is already tested
(`test/textEncode.test.ts`, including an all-256-byte round-trip), and is already used in
production by `Interner.lookup`.

**A note on the UTF-16 branch**: it can never fire. `parse.worker.ts` refuses UTF-16 with a `Fatal`
diagnostic before a document ever becomes editable ("both parsers are byte-oriented"). Left in place
— it costs nothing and becomes correct the day the parsers become encoding-aware (D-009's own note
at `DECISIONS.md`) — but recorded here so nobody reads its presence as evidence UTF-16 editing works.

## 2. Measured, not assumed

`encodeText` run directly:

| Encoding | Text | Result |
|---|---|---|
| `windows-1252` | `Grüße — Preis 20€ für Müller` | 28 B, decodes back **identically** |
| `iso-8859-1` | `Grüße, Motörhead, naïve café` | 28 B, decodes back **identically** |
| `iso-8859-15` | `Preis 20€` | 9 B, decodes back **identically** |
| `windows-1252` | `日本語` | **`null`** — no representation, correctly refused |
| `shift_jis` | `abc` | **`null`** — multi-byte, not invertible by probing |
| `utf-8` | `Grüße 日本語` | 17 B, identical |

So the encodings people actually meet — Windows-1252 and the Latin-1 family — round-trip exactly,
and the two failure modes are distinguished by the function's own return value.

## 3. The design point: `null` now means two different things

This is the part that is **not** a one-line delegation, and getting it wrong makes the app *worse*
than today.

`encodeText` returns `null` for two unrelated reasons:

| | Cause | True statement |
|---|---|---|
| **(a)** | The encoding is not invertible at all — `shift_jis`, `gb18030`, `big5`, `euc-kr` | "NodePad can't write this encoding." |
| **(b)** | The encoding is fine; **this text** has a character it can't represent — `日` into `windows-1252` | "Windows-1252 can't represent 日." |

Today's message — *"Editing isn't supported yet for windows-1252 documents"* — is a conservative
truth for the blanket refusal. After delegation it becomes an **outright lie** in case (b): the user
has been editing that document happily, pastes one CJK character, and is told the encoding they have
been using all along is unsupported.

**So `EditRefusal` splits.** `unsupported-encoding` keeps its meaning for (a); a new
`unrepresentable-character` carries the offending character for (b):

```ts
| { readonly kind: 'unsupported-encoding'; readonly encoding: string }
| { readonly kind: 'unrepresentable-character'
    readonly encoding: string
    readonly character: string }
```

with messages:

- (a) `NodePad can't write ${encoding} — it isn't a single-byte encoding.`
- (b) `${encoding} can't represent "${character}". The rest of the edit was not applied.`

This is D-009's *"refused with an explanation"* taken literally: the explanation has to name the
character, because the character is the thing the user can act on.

### Telling them apart

`textEncode.ts` gains one export:

```ts
/** Whether `encoding` can be written at all, independent of any text —
 * false only for genuinely multi-byte non-UTF encodings. */
export function canEncode(encoding: string): boolean
```

Implementation is the check `encodeText` already makes internally: UTF-8/UTF-16 are always true,
otherwise `singleByteReverseMap(encoding) !== null`. Do **not** infer it by calling
`encodeText('', encoding)` and testing for null — that works today by accident of evaluation order
and would break silently if the empty-string case were ever short-circuited.

Finding the offending character is a scan of `text` for the first code point missing from the
reverse map. Cheap, and only on the refusal path.

## 4. Blast radius

| Site | Change |
|---|---|
| `documentEdits.ts` `encodeForRoundTrip` | delegates to `encodeText`; the stale comment goes |
| `documentEdits.ts` `createEdit` | splits the refusal per §3 |
| `documentSession.ts` `applyReplaceAll` | same split, same two messages in its own voice |
| `FindBar.tsx` `wouldBeUndoable` | none — it only needs the byte length, and `null` still means refuse |
| `core/textEncode.ts` | gains `canEncode` |

Nothing else in the app tests an encoding label. The BOM refusal (`kind: 'bom'`) is orthogonal and
untouched.

**Invariant 7 is not strained — it is better served.** Nothing here converts anything: an edit to a
Windows-1252 document is encoded *as Windows-1252* and saved in the document's own encoding, which
is precisely what the invariant asks for. Before this round those documents were read-only in
practice, so the invariant was upheld by making the case unreachable rather than by handling it.

**No new `DECISIONS.md` entry.** D-009 already covers it. Add a cross-reference from D-009 to D-074
naming `encodeText` as the mechanism, so the next reader does not repeat R125's discovery.

## 5. The tests that must flip

These currently assert the behaviour being removed, and are the honest signal that this is a
behaviour change rather than a refactor:

- `test/documentEdits.test.ts:232–234` — `encodeForRoundTrip('a', 'windows-1252' | 'iso-8859-1')`
  expects `null`. Both must now return bytes. `'shift_jis'` **stays** `null`.
- `test/documentEdits.test.ts:268–272` — a `windows-1252` buffer expects
  `{ kind: 'unsupported-encoding', encoding: 'windows-1252' }`. That edit must now succeed.

Flip them deliberately, in the same commit, with the assertion inverted rather than deleted — a
removed test is indistinguishable from one that was never written.

## 6. Non-functional expectations

`singleByteReverseMap` is memoized per encoding label (`textEncode.ts`'s own cache), so the 256-byte
probe runs **once per encoding per session**, not per edit. Do not add a second cache, and do not
call `canEncode` in a loop over matches — Replace All needs it once, before the loop, not per match.
The character scan in §3 runs only when an encode has already returned `null`.

## 7. Acceptance criteria

1. An edit to a `windows-1252` document containing `é` applies, and the resulting bytes decode back
   to the expected text through `TextDecoder('windows-1252')` — asserted on **bytes**, not on the
   decoded string alone, since the whole point is what lands in the file.
2. Replace All on the same document does the same.
3. An edit inserting `日` into a `windows-1252` document is refused with
   `kind: 'unrepresentable-character'`, and the message contains `日`.
4. An edit to a `shift_jis` document is refused with `kind: 'unsupported-encoding'`.
5. The document's `encoding` is unchanged after 1 and 2 — nothing silently became UTF-8.
6. A `utf-8` document is byte-for-byte unaffected by this round: the existing edit tests pass
   untouched.
7. `test/textEncode.test.ts` is untouched and still passes — the mechanism is not being modified,
   only called.

## 8. What this deliberately does not do

**The convert-to-UTF-8 offer.** It is the natural sequel and it hooks onto §3's
`unrepresentable-character` refusal, which is exactly the moment conversion is the right answer. It
is a separate round because it rewrites every byte, invalidates every span, needs a reparse (it is
structurally a Transform), must rewrite an XML prolog through `FormatCapabilities`, and needs an
undo-budget confirmation. None of that is required to make Windows-1252 documents editable, and
building it first would wire it to a refusal that should not have been firing.

## 9. Results

Built exactly as specified — no deviation from §3's design or §7's acceptance criteria.

`encodeForRoundTrip` is now a one-line delegation to `encodeText`; the dead `encodeUtf16` helper
that only it called was removed along with it, rather than left as unreachable code. `EditRefusal`
and `ReplaceRefusal` both gained `unrepresentable-character` alongside the narrowed
`unsupported-encoding`, with the exact two messages from §3. `canEncode` and a new
`findUnrepresentableCharacter` (not named in the plan, but needed to fill `character` in the
refusal without re-deriving the scan at each of the two call sites) both live in
`core/textEncode.ts` next to `encodeText` and `singleByteReverseMap`, reusing the same memoized
probe rather than adding a second cache, per §6.

`FindBar.tsx`'s `wouldBeUndoable` needed no change, confirmed by reading it: it only calls
`encodeForRoundTrip` and branches on `null` vs. not, which is exactly as true after this round as
before.

The two tests flagged in §5 were flipped in place, not deleted. Six new tests were added — one
per acceptance criterion in §7 that didn't already have direct coverage — split between
`test/documentEdits.test.ts` (`createEdit` in isolation) and `test/documentSession.test.ts`
(through a real XML prolog and a real parse, matching that file's existing convention for
encoding-related tests). All pass, along with the full existing `test/textEncode.test.ts` and
`test/documentSession.test.ts` suites, untouched apart from the two flips and the encoding label
swapped from `windows-1252` to `shift_jis` in the two tests that specifically wanted a
never-encodable encoding (windows-1252 no longer qualifies, which is the whole point of the round).
`npm run typecheck` and `npm run test:node` (1420 tests) both pass.
