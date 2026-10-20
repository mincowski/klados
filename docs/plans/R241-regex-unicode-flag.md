# R241 — the `u` flag in Find, as a change to D-097

<!-- status: built -->

**Built** (§9). Every Find regex compiles with `u`; D-125 amends D-097. One plan decision was
replaced by the plan's own fallback: routing every `k`/`s` needle to the decoded path cost 12× in
the renderer, so the byte path is kept unless the document can hold U+212A or U+017F (§9.2).

Planned 2026-10-19, from R239 §6.4 (`docs/plans/R239-regex-find.md`): turning `u` on changed a
test result, so the project lead shipped R239's worker without it and asked for `u` as its own change
to D-097. This plan decides the five questions that change raises (§3–§7), adds one D-082 never
considered (§4a, keeping today's harmless escapes working), and measures what each answer costs.
**§0 records that `u` was rejected twice before (D-082, R202), and why neither reason still holds**,
including a regression in R205 that those measurements could not see.

**Confirmed by the project lead on 2026-10-19, after reviewing §0's history:** `u` is taken up, as
this plan describes, including §4a's rewrite of harmless escapes.

D-097, unchanged in purpose: Find has **one folding algorithm**, so plain and regex mode agree **by
construction**, and equivalence is **canonical**, not compatibility. Turning on `u` keeps all three.
It changes which folding algorithm that one algorithm is: from the engine's legacy `toUpperCase`
canonicalization to Unicode simple case folding.

## 0. `u` was rejected twice before — what changed since

**R72 §6 measured `u` and rejected it, recorded as D-082. R202 §10 rejected it again, citing D-082.**
Neither rejection was wrong when made. Both rested on two arguments, and the ground under each has
moved.

**Argument 1: "fixes 58 of 154, leaves 96; it moves the boundary rather than unifying the two
algorithms".** The 154 were disagreements *between the modes*: plain folded with `toLowerCase`, regex
with the engine's `Canonicalize`, and `u` changed only the regex side. **R205 removed that premise**:
plain case-insensitive search *is* the regex now (D-097). With `u` on in both modes, the modes cannot
disagree, except for the four byte-path pairs that §3 closes. And R72's own yardstick for a *correct*
fold was "Unicode simple case folding as the reference (what JS's regex `u` flag uses)": it scored
`toLowerCase` at 94 wrong pairs and the round trip at 6. Under `u`, the engine's fold *is* that
reference.

**Argument 2: "it rejects Annex B syntax (`\-`, `a{`, `[a-\d]`), and `decodedTextMatches` swallows the
throw, so a working regex silently reports zero matches. A worse failure than the one it fixes."**
Two halves:
- **The silence** is fixed by §4, which is needed regardless: `a(` and `*a` are invalid today and are
  already shown as "No matches".
- **The breakage** is mostly removed by §4a, which was not considered in D-082: rewrite escapes of
  harmless punctuation (`\-`, `\:`, `\#`, …) before compiling. Measured: same matches as today on 26
  of 26 patterns, 22 of them rescued from a syntax error. What still breaks is rarer (a lone `]` or
  `}`, `a{`, `[a-\d]`, `\1` without a group), and it now says so.

**What D-082 and R72 did not measure: R205 lost case-insensitive matching above U+FFFF.** Both measured
U+0020–U+2FFF only. Measured now over every code point (§2.12): the pre-R205 plain fold
(`toLowerCase`) equated **686 ordered pairs that today's fold does not**. **614 of them are astral**:
Deseret, Osage, Adlam and others are not found case-insensitively in **either** mode today, because
`Canonicalize` without `u` folds code units. The rest are the pairs D-097 already lists (`ß`/`ẞ`) or
R239 §6.4 found (`ϴ`, Greek with ypogegrammeni). **`u` restores all 686.** So `u` repairs a regression
nobody had measured, as well as D-097's accepted `ß`/`ẞ` loss.

**What does not change from D-082/D-097:**
- **Canonical, not compatibility.** NFKC stays rejected; `u` is case folding, not normalization.
- **R76's length-changing mappings.** Simple case folding is one code point to one, so `İ` U+0130
  still does not find `i̇`, and `ß` still does not find `ss`. The module's third limit stands.
- **R204's NFC gating** on non-ASCII needles.

## 1. What `u` changes, from R239 §6.4

- **One existing test changes:** `/ß/iu` also finds `ẞ` U+1E9E (`test/textFindConfusables.test.ts:85`).
  D-097 recorded that pair as an accepted loss; `u` recovers it, in both modes.
- **680 ordered code-point pairs newly match in plain mode, 684 in regex mode.** Nothing stops
  matching. 614 of the pairs are in astral scripts (Deseret, Osage, Adlam, …), which without `u` the
  engine never folds, because it folds code units.
- **4 pairs are regex-only**: `k`/`K` against U+212A KELVIN SIGN, and `s`/`S` against U+017F LATIN SMALL
  LETTER LONG S. A plain ASCII needle takes the byte path, which `u` does not reach (§3).
- **Patterns valid today become syntax errors**: `\-`, `\:`, `\#`, a lone `]` or `}`, `a{`, `[a-\d]`,
  `\1` without a group, and others (§4's table). Find shows any pattern that fails to compile as
  "No matches", today as well (§4).

## 2. Measured for this plan, 2026-10-19

Node 24.15.0 (V8, the engine Electron 44 also uses) on Windows 11, unless a row says otherwise. Scripts
in the planning session's scratch directory, not kept; every number the plan rests on is here.

**2.1 Folding, confirmed per pair** (`new RegExp(n, 'i').test(c)` against `'iu'`):

| Needle | Against | `/i` | `/iu` |
|---|---|---|---|
| `k`, `K` | U+212A | no | **yes** |
| `s`, `S` | U+017F | no | **yes** |
| `ß` | U+1E9E | no | **yes** |
| `i` | U+0130 | no | no |
| `µ` U+00B5 | U+03BC | yes | yes |

**2.2 Plain mode's escaped literal always compiles under `giu`.** `escapeForRegex`
(`src/core/textFind.ts:567`) escapes only syntax characters, which stay valid escapes under `u`. Checked
for every printable ASCII character inside a needle, and for `café`, `日本`, an astral character, a
lone high surrogate and a lone low surrogate: **no failures.** So plain mode never meets §4's errors.

**2.3 The advance loops never terminate under `u`.** This is the finding that makes §6 a correctness
fix, not a refinement. When `lastIndex` points **inside a surrogate pair**, V8 under `u` moves it
**back** to the pair's start: `/x*/gu` with `lastIndex` 2 over `a😀b` matched at index 1. Both of
Find's loops then make no progress:

| Loop, today's advance | Without `u` | With `u` |
|---|---|---|
| regex branch, `index + max(length, 1)`: `/(?:)/g` over `a😀b` | `0 1 2 3 4` | `0 1 1 1 1 1 …` forever |
| plain branch, `index + 1`: `😀` over `😀😀` | `0 2` | `0 0 0 0 …` forever |

The plain branch runs on the main thread (`decodedTextMatches`, `src/core/textFind.ts:638`), so `u`
without §6 would **freeze the window on a case-insensitive search for any emoji**, and grow the match
array until the renderer ran out of memory. In regex mode the worker would hit R239's 2 s deadline
and show `(stopped)`. Today's code is safe only because, without `u`, the engine never backs up.

**2.4 `\p{Lu}+` over precomposed and decomposed text**:

| Text | Matches |
|---|---|
| `ÄÖÜ` (precomposed) | one, `0:3` |
| `A`+U+0308, `O`+U+0308, `U`+U+0308 (decomposed) | three, `0:1 2:1 4:1` |

The pattern is ASCII, so R204 does not normalize the window (D-097: an ASCII needle pays for none of
it), and a combining mark is not `\p{Lu}`. That is existing behaviour for ASCII patterns, not this
round's to change. Today `\p{Lu}` without `u` compiles as the literal text `p{Lu}`: a search for it
finds `p{Lu}` and not `Ä`.

**2.5 Which encodings can contain U+212A or U+017F.** None of the 28 single-byte code pages Klados
decodes (`windows-125x`, `windows-874`, `iso-8859-*`, `ibm866`, `koi8-*`, `macintosh`, `x-mac-cyrillic`)
maps any byte to either code point. UTF-8 encodes them as `C5 BF` and `E2 84 AA`. The multi-byte legacy
encodings Klados opens (`shift_jis`, `gb18030`, `big5`, …) were not enumerated; GB18030 encodes every
code point.

**2.6 Cost of `u`, per 64 KB window** (median of 7 passes, ms; `u` against today's flags):

| Pattern | ASCII text | Non-ASCII-rich text |
|---|---|---|
| plain `status` (escaped, `gi`) | 0.144 → 0.115 | 0.073 → 0.076 |
| plain `größe` (escaped, `gi`) | 0.010 → 0.010 | 0.045 → 0.042 |
| `\d{4}-\d{2}` | 0.129 → 0.126 | 0.150 → 0.158 |
| `<year>\d{4}` | 0.069 → 0.069 | 0.059 → 0.055 |
| `[a-z]+`, `i` | 0.889 → 0.450 | 0.439 → 0.466 |
| `.` | 3.051 → 3.156 | 2.515 → 2.644 |

Between 0.51× and 1.06×: **no measurable regression**. In the renderer it is re-measured (criterion
11), per FINDINGS (*measure in the renderer rather than trusting a Node bench*).

**2.7 The byte path is not faster than the decoded path, in Node.** 200 MB of cars-like XML, plain
case-insensitive `status`, median of 3:

| Text | Byte path (`findAsciiInRange`) | Decode 64 KB windows + `gi` literal (`decodedTextMatches`) |
|---|---|---|
| ASCII | 489 ms | 345 ms (0.7×) |
| Non-ASCII-rich | 434 ms | 421 ms (1.0×) |

The decoded figure omits `mapWindowMatches` (mapping each match back to a byte offset), which the app
does per match, so it is a lower bound. **That is why §3 makes the renderer measurement a gate**, not
a formality.

**2.8 A presence scan** for `C5 BF` or `E2 84 AA` over the same 200 MB, using
`Uint8Array.prototype.indexOf` on the lead byte and checking the following bytes (no `Buffer`, so it
runs in the renderer): **122 ms** (ASCII) and **260 ms** (non-ASCII-rich, where `E2` lead bytes are
common). Found nothing in either.

**2.9 What V8 reports for an invalid pattern** (the text after `Invalid regular expression: /…/flags: `):

| Pattern | Without `u` | With `u` |
|---|---|---|
| `\-` `\_` `\:` `\#` `\@` `\%` `\=` `\!` `\,` `\"` `\'` `\<` `\ ` `\1` `\8` `\x4` | ok | `Invalid escape` |
| `]` `}` `{` `{,2}` | ok | `Lone quantifier brackets` |
| `a{` | ok | `Incomplete quantifier` |
| `[a-\d]` `[\w-x]` | ok | `Invalid character class` |
| `\c` | ok | `Invalid Unicode escape` |
| `\k` | ok | `Invalid named reference` |
| `[\-]` `\/` | ok | ok |
| `a(` | `Unterminated group` | same |
| `*a` | `Nothing to repeat` | same |
| `[z-a]` | `Range out of order in character class` | same |

The last three show that invalid patterns reach Find **today**, and are shown as "No matches".

**2.10 The `v` flag** (the stricter successor of `u`) rejects even `[(]` (`Invalid character in
character class`). It would invalidate more of what users type, for no folding difference. Not used.

**2.11 Nothing else compiles a user pattern.** The only other `new RegExp` in `src/` is
`fileErrors.ts`'s fixed tag pattern. Replace works from match spans, so it inherits the result.

**2.12 Three folds over every code point.** All 3,037 code points that case mapping or folding
touches; an ordered pair counts when needle `c` finds text `d`. The bare fold, without R204's NFC, so it
differs slightly from R239's pipeline count (680), which already includes what NFC recovers:

| Fold | Pairs, all | U+0000–U+2FFF | Above U+FFFF |
|---|---|---|---|
| `toLowerCase` (plain mode before R205) | 2,990 | 1,904 | 614 |
| regex `i` (both modes today) | 2,392 | 1,916 | **0** |
| regex `iu` | 3,090 | 1,998 | 614 |

- **686 pairs** that `toLowerCase` equated are not equated by today's fold: **614 astral** (e.g. Deseret
  `𐐀`/`𐐨` U+10400/U+10428, Osage U+104B0/U+104D8, Adlam U+1E900/U+1E922), and 72 below U+FFFF: the
  Kelvin and angstrom signs, `ß`/`ẞ`, `ϴ`, and 54 Greek letters in U+1F80–U+1FFF.
- **`iu` equates all 686.** None remains lost.
- **R72's range (U+0020–U+2FFF) contains none of the 614**, which is why R205's regression for astral
  scripts was never visible.

**2.13 Rewriting harmless identity escapes keeps today's meaning under `u`.** For each pattern, the
matches of the rewritten pattern under `u` were compared with today's matches without `u`, over a
probe string containing every rewritten character. The rule: `\` followed by a character that is
**not** `A–Z`, `a–z`, `0–9` and **not** one of `^ $ \ . * + ? ( ) [ ] { } | /` becomes `\x` and two hex
digits.

| Pattern | Rewritten | Under `u` today | Same matches as today without `u` |
|---|---|---|---|
| `\-` `\_` `\:` `\#` `\@` `\%` `\=` `\!` `\,` `\"` `\'` `\<` `\>` `\ ` `\~` `` \` `` `\&` `\;` | `\x2d` … | throws | yes, all 18 |
| `x\-y`, `\d\-\d`, `[\:\#]+`, `\.\-` | `x\x2dy`, … | throws | yes |
| `[a\-z]`, `[\-]`, `[\w\-]+` | `[a\x2dz]`, … | ok | yes |
| `\\-` (an escaped backslash, then `-`) | unchanged | ok | yes |

**26 of 26 keep their meaning, and 22 that throw under `u` stop throwing.** `\xHH` is a literal character
both inside and outside a class, so the rewrite needs no class tracking: a left-to-right pass that
consumes `\` with the character after it, so `\\-` is not misread.

## 3. Decision 1 — the four regex-only pairs: route `k`/`s` needles to the decoded path

**Decided:** a **case-insensitive, all-ASCII, plain** needle that contains `k`, `K`, `s` or `S` takes
the decoded path. Every other all-ASCII plain needle keeps the byte path, and case-sensitive search is
untouched (no folding, so `u` changes nothing there). One rule in `chooseFindPath`
(`src/core/textFind.ts:92`), used by both `findAll` and the search store, so the two cannot diverge.

**Why this one:**
- **Correct by construction.** The decoded path for a plain needle is the escaped literal under the
  same `giu` the regex mode uses, so the four pairs agree because there is one fold, not because a
  table lists two exceptions. That is D-097's own principle.
- **Smallest change.** The byte path stays exactly as it is.
- **Not measurably slower in Node** (§2.7). Needles with `s` or `k` are common (`status`, `class`,
  `key`), so the renderer measurement decides whether this stands as is (criterion 11).

**If the renderer measurement misses the budget**, the refinement is decided here, so the implementer
does not have to invent one: send such a needle to the decoded path **only when the document can
contain either code point**.
- **UTF-8:** a presence scan for `C5 BF` / `E2 84 AA` (§2.8, 122–260 ms per 200 MB), run once and cached
  against the `sourceBuffer` object, so an edit (which replaces it) invalidates the answer.
- **Single-byte code pages:** never (§2.5, measured: none of the 28 can encode either).
- **Multi-byte legacy encodings:** always the decoded path (GB18030 can encode both, and these
  documents are rare).

**Rejected:**
- **Teaching the byte path the two code points.** `k` would have to match one byte or the three bytes
  `E2 84 AA`, so match lengths become variable inside a Boyer–Moore–Horspool scan whose shift table
  assumes a fixed-width needle, and the byte sequences are UTF-8-specific. All of that to keep a path
  §2.7 did not find faster.
- **Accepting the four-pair disagreement.** It re-opens exactly what D-097 closed, and "plain finds
  less than `.*` for `k`" is the kind of difference a user cannot connect to its cause.

## 4. Decision 2 — what Find shows for a pattern that does not compile

**Decided:** the counter reads **`Invalid pattern`**, and the footnote row under the bar gives the
engine's reason, as path mode already does for a path that does not parse (R87,
`FindBar.tsx`'s `find-footnote-path`). The input gets `aria-invalid="true"`. No colour change: the
footnote row's existing style, so no new theme token (invariant 9).

**Rendered before deciding** (PLANNING.md §1), in the real Find bar against the app's stylesheets,
both themes, at a 1280 px viewport, with `<price>(\d+` typed in regex mode:

| Light | Dark |
|---|---|
| ![Invalid pattern, light](../screenshots/r241-invalid-pattern-light.png) | ![Invalid pattern, dark](../screenshots/r241-invalid-pattern-dark.png) |

Five candidates were drawn: today's `No matches` alone; `Invalid pattern` alone; `Invalid pattern`
with the engine's reason (chosen); `No matches` with a sentence in the footnote; and `Invalid pattern`
with a full sentence, *"This is not a valid regular expression (unterminated group)."* The counter
alone says *that* the pattern is wrong but not *where*, and `No matches` with a footnote says two
different things at once. The full sentence repeats the counter.

**Measured while rendering:**
- **The counter's hidden sizer must reserve the label**, as R239 did for `(stopped)` (`countSizer`,
  `FindBar.tsx:648`). With it, the bar grows from 569.1 to 574.0 px and the 200 px input keeps its
  width. The first rendering, in the test harness's default narrow viewport, squeezed the input instead;
  the bar's width is what absorbs the label, and only at a normal width does it have room to.
- **The reason is shown as V8 words it**, minus the `Invalid regular expression: /…/flags: ` prefix,
  which repeats the pattern. Some of V8's wording is odd: a lone `]` reports *Lone quantifier
  brackets* (§2.9). It is accepted rather than mapped to Klados's own phrasing: a translation table
  would need to track V8's messages, and an imperfect reason still says more than none.
- **While typing**, `<price>(` shows `Invalid pattern` until the `)` is typed, after Find's 150 ms
  debounce. Path mode avoids this by running only on Enter. Regex mode is live, so a transient
  `Invalid pattern` is accepted: it is accurate, and it disappears with the next keystroke.

**Plain mode never shows it**: its escaped literal always compiles (§2.2), and a test keeps it so.

The compile failure has to reach the UI as a state, not as an empty result. Today
`decodedTextMatches` returns `[]` on a compile error, which is indistinguishable from no matches.
The pattern is compiled **once, before the search starts**, on the main thread, and an invalid one
ends the search with that state, without starting the worker.

## 4a. Decision 2a — today's harmless escapes keep working

**Decided, and confirmed by the project lead on 2026-10-19:** before compiling in regex mode, rewrite
every identity escape of a non-alphanumeric, non-syntax character to its `\x` form (§2.13's rule), so
`\-`, `\:`, `\#` and the rest mean what they mean today. **Non-ASCII too**: `\` followed by a non-ASCII
character becomes `\u{…}`, which `u` accepts and which is the same literal.

**Why:** escaping punctuation "to be safe" is a habit from PCRE, Python and .NET, which all accept it,
so it is what a user is most likely to type. Without the rewrite, `u` breaks exactly those patterns.
That is the larger half of D-082's objection (§0), and §2.13 shows the rewrite preserves meaning.

**What stays an error**, shown through §4: a lone `]`, `}` or `{`, `a{`, `{,2}`, `[a-\d]`, `[\w-x]`, `\1`
without a group, `\8`, `\c`, `\x4`, `\k`. Making those work means re-implementing Annex B's grammar,
and they are rare in hand-typed searches. Not proposed.

**Shown as typed.** The rewrite is internal: the Find field keeps the user's text, and an error reason
in the footnote refers to it as typed.

**Cost:** one linear pass over the pattern, once per search. Plain mode needs none, since
`escapeForRegex` emits only syntax-character escapes (§2.2).

## 5. Decision 3 — `u` applies to plain mode too

**Decided: yes.** Plain case-insensitive search **is** a regex (R205), and D-097 requires the two
modes to fold identically. Turning `u` on in regex mode only would make plain mode miss all 684 pairs
that regex mode gains. The escaped literal compiles as `giu`; the case-sensitive plain path stays
`indexOf`, which does not fold.

With §3's routing, both modes gain the same 684 pairs, and §2.1's table is the same in both.

## 6. Decision 4 — every advance steps by code point

**Decided:** one helper, used by both loops in `decodedTextMatches`, steps **one code point**: two
code units when the index is at a high surrogate followed by a low one, otherwise one.
- **Regex branch** (`:594`): after a match, `lastIndex` = the match's end if it is non-empty, else one
  code point past its start.
- **Plain branch** (`:638`): `lastIndex` = one code point past the match's start, which keeps today's
  overlapping matches (`aa` twice in `aaa`).

**Required, not cosmetic** (§2.3): without it, `u` loops forever. **Both loops also gain a
development-only assertion** (`import.meta.env.DEV`, per `CLAUDE.md`'s conventions) that `lastIndex`
strictly increases, so a regression throws in a test instead of hanging the test runner, where a
vitest timeout cannot fire because the loop never yields.

## 7. Decision 5 — acceptance criteria

1. **Plain and regex mode agree on every pair.** A node test builds a document of the code points case
   mapping or case folding touches (R239 §6.4's set, 3,037), searches it for each one in both modes
   through `findAll`, and asserts identical match sets. That includes `k`, `K`, `s`, `S` against
   U+212A and U+017F, through the real path choice. Mutation: removing §3's routing turns those four
   rows red.
2. **`test/textFindConfusables.test.ts:85` changes deliberately:** `ß` finds `ẞ` in both modes, and the
   comment above it (`:65–69`) is rewritten: the loss D-097 accepted is recovered.
3. **`\p{Lu}+` finds `ÄÖÜ`** in a UTF-8 fixture, precomposed: one match covering six bytes. And over
   the decomposed spelling, three matches, with a comment citing §2.4 so nobody "fixes" it here.
4. **A zero-length match over an astral character never splits it:** `x*` over `a😀b` matches at code
   unit indices `0 1 3 4`, never `2`, and every byte offset lands on a UTF-8 character boundary.
5. **The plain-mode hang cannot come back:** case-insensitive `😀` over `😀😀` finds two matches and
   returns. Mutation: restoring `index + 1` turns this red through §6's assertion, rather than hanging.
6. **Invalid patterns**, in a browser test of the real Find bar: `a(` (invalid today) and `\-` (invalid
   only under `u`) each show exactly `Invalid pattern` in the counter, the engine's reason in the
   footnote (`Unterminated group`, `Invalid escape`), and `aria-invalid="true"` on the input. No worker
   is started for them. `[\-]` and `\/` still search.
7. **Plain mode never reports an invalid pattern:** every printable ASCII character, and §2.2's
   non-ASCII needles, compile as escaped literals under `giu`.
8. **The sizer reserves the label:** with an invalid pattern, the input's width is unchanged from the
   valid state at a 1280 px viewport.
9. **The worker path agrees with the in-thread path** (R239's table in `test/regexFindJob.test.tsx`),
   with an astral zero-length row added.
10. **Path choice**: `chooseFindPath` returns `decoded` for case-insensitive `status`, `KEY` and `s`,
    and `byte` for case-sensitive `status` and for case-insensitive `price`. Exact values.
11. **Cost, in the renderer**, with `spike/r239-regex-find.ts` extended, on `cars-200mb.xml`, median of
    three, before and after:
    - regex `\d{4}-\d{2}` and `<year>\d{4}` within **1.1×** (§2.6 found no regression);
    - plain case-insensitive `status` (now the decoded path) within **1.25×** of the byte path. If it
      misses, §3's presence-scan refinement is built and measured before landing; if that also
      misses, it goes to the project lead.
12. **`docs/DECISIONS.md`**: a new entry amending D-097: one fold, now Unicode simple case folding;
    `ß`/`ẞ` and the astral scripts recovered (§0); §3's routing; §4's display; §4a's rewrite. It answers
    D-082's and R202's rejection of `u` point by point (§0), so the question is not reopened by
    accident in the other direction. D-097 itself gains a pointer to it.
13. **`docs/FINDINGS.md`**: the entry on code points that fold to ASCII (*"Only two non-ASCII code points
    lower-case to ASCII"*) gains the `iu` pairs of §2.1, and a new entry records §2.3's trap, since it
    bites any `lastIndex` loop under `u`, not only Find's.
14. **`src/core/textFind.ts`'s module comment** is corrected: its claim that ASCII folding and the
    engine's agree on every case for an ASCII needle stops being true under `u` (`:46`), and the third
    "limit" gains `ß`/`ẞ` as found.
15. **Astral scripts are found again, in both modes**: case-insensitive `𐐀` U+10400 finds `𐐨` U+10428
    (Deseret), and likewise one pair each from Osage and Adlam, built from `\u{…}` escapes with a
    code-point guard (R202's fixture rule). Each row is red against today's build.
16. **§4a's rewrite**: a node test over §2.13's 26 patterns asserts that the rewritten pattern under
    `u` gives the same matches as the original without `u`, on the same probe string, and that `\\-`
    is left alone. In the Find bar, regex `x\-y` finds `x-y`. Mutation: dropping the rewrite turns the
    18 single-escape rows red, as `Invalid pattern`.

## 8. Not in scope

- **The grid quick filter** (`gridFilter.ts`), which folds with `toLowerCase`. It is not Find, and
  D-097 does not bind it.
- **Path queries.** They do not take user regexes.
- **The `v` flag** (§2.10).
- **Compiling with `u` and falling back to no `u` when that fails.** Two folding algorithms, chosen by
  whether a pattern happens to be `u`-valid, is exactly what D-097 removed.
- **Normalizing for ASCII patterns** (§2.4's decomposed row). That is R204's rule, and a change to it is
  its own question.

## 9. Results

**Built**, with one decision taken from the plan's own fallback: §3's routing as first written
missed the cost budget by 10×, so §3's presence-scan refinement was built, in a cheaper form than
planned (§9.2). D-125 amends D-097; D-097 gains a pointer to it.

### 9.1 The criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Plain and regex agree on every case code point | green: 3,037 code points (the count matches R239 §6.4), each searched in both modes through `findAll`, no disagreement; `k`/`K`/`s`/`S` each find three of `k K U+212A` / `s S U+017F` in both modes. Mutation, routing removed: red (the 3,037 sweep, the k/s row, and path choice) |
| 2 | `ß` finds `ẞ` | `textFindConfusables.test.ts`'s row changed deliberately to 2 / 2 / 1, its comment rewritten |
| 3 | `\p{Lu}+` | precomposed `ÄÖÜ`: one match, bytes 0–6. Decomposed: three, `0:1 3:4 6:7`, commented as §2.4's existing behaviour. Case-sensitive: under `iu`, `\p{Lu}` also matches lower case |
| 4 | Zero-length match over an astral character | `x*` over `a😀b` at code units `0 1 3 4`, bytes `0 1 5 6`, none on a continuation byte |
| 5 | The plain-mode hang | `😀` over `😀😀`: two matches. Mutation, `index + 1` restored: red through the development assertion (*"Find stopped advancing: a match at 0 after one at 0"*), in 2.7 s, no hang |
| 6 | Invalid patterns in the real Find bar | green, `test/findInvalidPattern.test.tsx`: `a(`, `\k` and `a{` show `Invalid pattern`, the reason (`Unterminated group`, `Invalid named reference`, `Incomplete quantifier`), `aria-invalid="true"`, and the spawn counter unchanged. `[\-]`, `\/`, `a\/b` and `x\-y` search, each starting one worker. **Deviation:** the plan named `\-` as the `u`-only invalid case, but §4a, confirmed after the criterion was written, makes `\-` valid; `\k` takes its place |
| 7 | Plain mode never invalid | every printable ASCII character finds itself under `giu`; `café`, `日本`, an astral character and both lone surrogates compile |
| 8 | The sizer reserves the label | at 1280 × 800 the input's width is identical with and without `Invalid pattern` |
| 9 | Worker agrees with in-thread | R239's table gains `x*` over `a😀b 😀`; green |
| 10 | Path choice | `status`, `KEY`, `s` case-insensitive: **`byte-checked`**, not the plan's `decoded` (§9.2); `status` case-sensitive and `price` case-insensitive: `byte`; regex and non-ASCII: `decoded` |
| 11 | Cost in the renderer | §9.2 |
| 12–14 | D-125, FINDINGS, module comment | done; the module comment also corrected a wrong claim that `µ`/`μ` do not match (they do, through case folding, in both modes, before and after) |
| 15 | Astral scripts | Deseret U+10400/U+10428, Osage U+104B0/U+104D8, Adlam U+1E900/U+1E922 find each other in both modes, both directions. Mutation, `u` removed (today's flags): all three red |
| 16 | §4a's rewrite | the 26 patterns of §2.13 give, rewritten under `u`, the same spans as the original without `u` on one probe string; 22 of them throw under `u` unrewritten; `\\-` is left alone; `\é` and `\😀` become `\u{…}`. Mutation, rewrite dropped: 23 node tests red (the 18 single escapes, the 4 in context, and `\u{…}`), and the Find bar shows `Invalid pattern` for `x\-y` |

### 9.2 Cost, and the refinement it forced

`spike/r239-regex-find.ts` gained a plain case-insensitive `status` row. `cars-200mb.xml`, the built
app, Electron 44, Windows 11; `main` before, this branch after:

| Search | Before | After, §3 as planned | After, with the scan |
|---|---|---|---|
| regex `\d{4}-\d{2}`, median of 3 | 6,947 ms | 6,980 ms (1.00×) | 6,941 ms (1.00×) |
| regex `<year>\d{4}`, median of 3 | 9,006 ms | 9,035 ms (1.00×) | 9,321 ms (1.03×) |
| plain `status`, median of 3 | 625 ms | **7,628 ms (12.2×)** | 641 ms (1.03×) |
| plain `status`, first search after opening (the scan runs), 3 launches | 659 ms (659, 666, 630) | — | 790 ms (776, 793, 790), **1.20×** |

**§3 as planned missed its 1.25× budget by 10×**: every `k`/`s` needle on the decoded path decodes
and normalizes all 200 MB. Node's bench (§2.7) had put the two paths level, without the mapping
back to bytes, the windowing or the scheduler. So, per §7.11, §3's refinement was built.

**Built differently from §3's sketch, for the same answer.** The plan had the presence scan run
once, ahead of the search. That would be a 120–260 ms long task on the main thread. Instead the
scan runs inside the byte path's own 1 MiB steps. If it finds U+212A or U+017F, the matches
collected so far are dropped and the search restarts on the decoded path. Either way the answer is
cached against the byte buffer, which an edit replaces. Two store tests cover the restart, and
mutating it (not dropping the earlier matches, or not scanning) turns them red.

**Its first build was quadratic.** `Uint8Array.indexOf` from the chunk's start searches to the end
of the buffer, not to the end of the chunk, so each of 200 steps rescanned the rest: the first
`status` took 13,855 ms, and later ones were fast only because the answer was by then cached. The
scan now searches a `subarray` of the chunk.

### 9.3 Review

The diff was read before the commit. Beyond §9.2's two findings, the review moved `decodedWindowsFor`
out of the byte path, which the restructured job had started building for every plain search, and
found the `µ`/`μ` claim in `textFind.ts`'s module comment wrong (§9.1, row 12–14).
