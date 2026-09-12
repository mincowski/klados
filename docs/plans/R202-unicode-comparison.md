# R202–R205 — Unicode comparison: normalization, then one folding algorithm

<!-- status: open -->

**Open.** Planned after R201's audit found that nothing in the codebase calls `normalize`, and after
re-reading R72 §6 and D-082, which investigated the folding half deliberately and accepted it.
**R205 reverses D-082 and needs a decision before it is built** (§ 7); R202–R204 do not.

## 1. What NFC is

Unicode lets the same visible character be written more than one way. `é` is either:

| | code points | UTF-8 bytes |
|---|---|---|
| **composed** | U+00E9 | 2 |
| **decomposed** | U+0065 `e` + U+0301 combining acute | 3 |

These are **canonically equivalent** — same character, same meaning, identical on screen — but
different byte sequences, so `===`, a hash and a byte comparison all say "different".

Unicode defines four *normalization forms* that rewrite text into one canonical spelling:

| Form | Does |
|---|---|
| **NFD** | decompose — `é` becomes `e` + `◌́` |
| **NFC** | decompose, then recompose — `é` becomes U+00E9. The **most composed** form |
| NFKD / NFKC | the same, plus **compatibility** mappings: `²`→`2`, `ﬁ`→`fi`, fullwidth `Ａ`→`A` |

**NFC is the one that applies here.** It is what the web platform recommends, what most text already
is, and — unlike NFK\* — it only equates spellings of the *same* character, never different
characters that happen to look alike. D-082 already rejected NFKC for exactly that reason: it
equates `²` with `2`, which is a real content change in a tool whose premise is byte-faithful
inspection.

**NFC also collapses canonical singletons** — characters that normalize to a *different single*
character: U+212B ANGSTROM SIGN → U+00C5 `Å`, U+2126 OHM SIGN → U+03A9 `Ω`. R72 §6 identified these
and it is why normalization, not case folding, is the right tool for those pairs.

**Where decomposed text comes from:** macOS filesystem paths (APFS stores NFD), so any export
listing filenames from a Mac; Korean and Vietnamese pipelines; some macOS-authored XML. It renders
identically, so nobody can see it.

**The constraint that shapes everything below:** NFC is meaning-preserving but **not byte-preserving**,
and invariants 1, 6 and 7 mean the document is never decoded wholesale, never rewritten, and always
saved as its original bytes. **So normalization can only ever apply to a comparison, never to the
document.** Every section below is a consequence of that.

## 2. The three places this project compares text, and what each costs

They are usually discussed as one problem. They are not: they differ by an order of magnitude each,
and only the third is hard.

| Site | Compares | Offsets involved? | Cost |
|---|---|---|---|
| Grid quick filter (`gridFilter.ts:33`) | a decoded cell string | **no** — returns row indices | **one call** |
| Path name resolution (`Interner.lookup`) | encoded query bytes vs stored name bytes | **no** — returns a `nameId` | small, bounded by *name count* |
| Find (`textFind.ts`) | needle vs a decoded ~64 KB window | **yes** — must return document byte offsets | the round |

## 3. R202 — the grid quick filter

`cellTextLower` already decodes the cell to a string and lowercases it. It returns **row indices**,
never offsets, so the hard problem is absent.

```ts
return (cellOf(store, source, row, nameId).text ?? '').normalize('NFC').toLowerCase()
```

Normalize the filter text the same way, once, rather than per cell. **The smallest real Unicode fix
in the codebase**, and it is listed first so it is not lost behind R204.

## 4. R203 — path name resolution

`Interner.lookup` encodes the query and finds candidates by **hash** of the encoded bytes, then
confirms with `bytesEqual`. An NFC-spelled query against an NFD-spelled name misses at the hash, so
there is nothing to fall back to inside the current lookup.

**Build a second hash index over NFC-normalized names**, consulted only when the exact lookup
returns `null`. Bounded by **name count**, not document size — a 2 M-row, 10-column CSV interns ten
names (R145 acceptance 6) — so the whole index is tens to low thousands of entries.

Three things it must not do:

- **Not normalize at intern time.** Stored names are the document's own bytes (invariant 7, R53);
  rewriting them breaks the round trip that makes `lookup` correct at all.
- **Not lose R53's third state.** `'unrepresentable'` must still be distinct from `null`; a fallback
  that collapses them re-introduces exactly the defect R53 fixed.
- **Not report a normalized match as an exact one**, if anything downstream ever distinguishes them.

## 5. R204 — Find, and the offset problem

This is the round. The decoded path builds a ~64 KB window string and maps a match back to a byte
offset with `utf8Encoder.encode(prefix).length` (`textFind.ts:305`). Normalizing the window breaks
that: **NFC changes lengths**, so an index in the normalized string does not correspond to any index
in the original.

**`String.prototype.normalize` returns a string and no index correspondence.** Building one is the
work:

- Split the window into **grapheme clusters** (`Intl.Segmenter`), normalize **each cluster**, and
  record for every output position the original index it came from — an `Int32Array` map alongside
  the normalized text.
- Canonical composition joins a starter with its following combining marks, which is a
  grapheme-cluster boundary, so per-cluster normalization should equal whole-string normalization.
  **"Should" is not good enough**: assert `segments.map(normalize).join('') === window.normalize('NFC')`
  over the fixture corpus, and treat a mismatch as a finding rather than rounding it away.
- A match at normalized `[i, j)` then maps to original `[map[i], map[j])`, and from there to bytes
  exactly as today.

**The byte path is deliberately left alone** (§ 9), so this applies only where a window is already
being decoded.

## 6. R205 — one folding algorithm

**Only after R204.** D-082 is reversed: `indexOfCaseInsensitive` is deleted, and plain search on the
decoded path becomes `new RegExp(escape(needle), 'gi')` — the same engine the regex mode already
uses, so the two agree **by construction** rather than by a shared fold being implemented twice.

D-082 costed "one shared case-folding implementation over both paths" and rejected it as more work
than it looks. That is true of *writing a fold*; it is not what this does. Measured on a 64 KB
window, 200 passes, identical 2427 matches:

| | |
|---|---|
| `indexOfCaseInsensitive` today | **366.2 ms** |
| plain-as-regex | **35.5 ms** |

**10.3× faster**, because the current implementation allocates a slice and lowercases it at every
position.

Two things it must carry:

- **Overlap parity.** The regex branch advances `lastIndex` by the match length; the plain branch
  advances by one and its comment says overlapping matches are allowed, *"same as the byte path"*.
  Plain-as-regex must advance by one, or `aa` in `aaa` silently drops from two matches to one.
- **The footnote goes with it.** D-082's UI note exists to warn about a divergence R205 removes.
  Leaving it would warn about behaviour that no longer happens.

## 7. The ordering is load-bearing, and R205 needs a decision

**R205 before R204 regresses three of the five documented pairs.** Measured against
`test/fixtures/confusables.xml`'s own cases, with codepoint escapes and a guard (§ 8):

| Pair | plain today | regex today | after R205 alone | after R204 + R205 |
|---|---|---|---|---|
| `µ` U+00B5 / `μ` U+03BC | miss | find | **find** ✓ | **find** ✓ |
| `Σ` U+03A3 / `ς` U+03C2 | miss | find | **find** ✓ | **find** ✓ |
| `Å` U+00C5 / `Å` U+212B | find | miss | **miss** ✗ | **find** ✓ |
| `Ω` U+03A9 / `Ω` U+2126 | find | miss | **miss** ✗ | **find** ✓ |
| `ß` U+00DF / `ẞ` U+1E9E | find | miss | **miss** ✗ | **miss** ✗ |

Angstrom and ohm are canonical singletons, so **R204 restores them**; that is R72 §6's own finding,
and it is why normalization is the prerequisite rather than the optional follow-up.

**`ß`/`ẞ` is a permanent loss and the plan does not soften it.** Regex folds *up* and
`'ß'.toUpperCase()` is `'SS'` — a length change no normalization form repairs. Today plain finds it;
after R205 neither mode does.

**So R205 is a trade, not an improvement, and it is the project lead's call.** Today: plain gets
3 of 5, regex gets 2 of 5, and which you get depends on a toggle most users will not connect to the
result. After R204 + R205: **4 of 5, the same answer in both modes.** Better on balance and worse for
German capital sharp s.

**R202–R204 need no such decision** — they only add matches that are canonically the same character.

## 8. Non-functional expectations (`PLANNING.md` § 3)

- **Normalize per window, never per position.** The defect being replaced (`indexOfCaseInsensitive`)
  is slow precisely because it allocates and folds per position; a normalization pass that repeats
  that would be worse than what it fixes.
- **Skip the whole apparatus when the window is already NFC**, which is the overwhelmingly common
  case — all-ASCII text is NFC by definition. `normalize()` on an unchanged string is cheap and its
  result compares equal, so one check per window gates both the Segmenter pass and the index map.
  **Without this, every ASCII search on a 200 MB document pays for a problem it does not have.**
- **Author every fixture from `\uXXXX` escapes, and assert the codepoints before asserting
  behaviour.** Not a style preference: R72 hit this writing `confusables.xml`, and **this plan hit it
  again** — two measurements taken while drafting § 7 were wrong because typing `Å` U+212B into a
  script let something NFC it away to U+00C5, so the pair silently became one character and the
  divergence vanished. A test asserting only match counts passes on a normalized fixture and tests
  nothing.
- **The index map is an `Int32Array`**, not an array of objects (invariant 2's shape), and is built
  once per window alongside the normalized text rather than being recomputed per match.

## 9. Rejected

**Normalizing the document.** Invariants 1, 6 and 7. Not available at any price, and worth stating
so nobody proposes it as the simple version.

**Normalizing the needle only.** Cheap and wrong in both directions: it fixes NFD documents for NFC
needles only by breaking the reverse, and no single choice of form is right for both.

**NFKC.** D-082 rejected it with numbers — 2112 disagreeing pairs in the same range, because it
deliberately equates compatibility variants. It would get `µ`/`μ` "right" as a side effect of
equating characters that are not the same character, in a tool whose premise is byte-faithful
inspection.

**Extending normalization to the byte path.** The byte path never decodes, so it cannot normalize;
making it try means routing every ASCII needle through the decoded path and losing Boyer–Moore on
large documents. **The consequence is stated rather than hidden**: an ASCII needle `cafe` matches
decomposed `café` today and still will, because the byte path sees `c a f e` followed by a combining
mark. That is a permissive result, not a missed one, and the harmful direction is missing.

**The regex `u` flag.** D-082 measured it: fixes 58 of 154, leaves 96, and rejects Annex B loose
syntax (`\-`, `a{`) that parses fine without it — `decodedTextMatches` catches the throw and returns
`[]`, so a user's working regex silently starts reporting zero matches.

**Flagging confusables in the document instead** (R72 §6's alternative framing — ambiguity is a
property of the content, not the search). Still the better long-term idea and still its own round;
it does not resolve NFC/NFD, which is not an ambiguity but two spellings of one character.

## 10. Acceptance

1. The grid quick filter matches a decomposed cell from a composed query, and the reverse.
2. `//café` resolves against a document whose element name is decomposed, and `'unrepresentable'`
   stays distinct from `null`.
3. Find locates a decomposed occurrence from a composed needle **and reports the correct byte
   offset** — asserted on the offset, not on the match count. R17's span bugs were invisible to
   every shape assertion, and this round's whole risk is the mapping.
4. Per-cluster normalization equals whole-string normalization across the fixture corpus, asserted
   directly rather than assumed.
5. An all-ASCII search over a large document does **not** build an index map — asserted on the gate,
   since this is the difference between a fix and a regression.
6. The five pairs in `test/fixtures/confusables.xml` match § 7's "after" column exactly, including
   `ß`/`ẞ` still missing, so the accepted loss is pinned rather than discovered later.
7. Every new fixture is authored from escapes and guards its codepoints (§ 8).
8. If R205 lands: plain and regex return identical counts for all five pairs, and D-082's footnote
   is removed.
9. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 11. Version

**Ask on landing.** Candidate: minor for R202–R204 — searches that previously returned nothing now
return results, which is a behaviour change users will notice — and the same bump covers R205 if it
lands with them.
