# R241 — the `u` flag in Find, as a change to D-097

<!-- status: open -->

**Open.** Planned 2026-10-19, from R239 §6.4 (`docs/plans/R239-regex-find.md`): turning `u` on changed a
test result, so the project lead shipped R239's worker without it and asked for `u` as its own change
to D-097. This plan decides the five questions that change raises (§3–§7) and measures what each
answer costs. **Nothing here is built yet, and the decisions take effect when the project lead
approves the plan.**

D-097, unchanged in purpose: Find has **one folding algorithm**, so plain and regex mode agree **by
construction**, and equivalence is **canonical**, not compatibility. Turning on `u` keeps all three.
It changes which folding algorithm that one algorithm is: from the engine's legacy `toUpperCase`
canonicalization to Unicode simple case folding.

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
    `ß`/`ẞ` recovered; §3's routing; §4's display. D-097 itself gains a pointer to it.
13. **`docs/FINDINGS.md`**: the entry on code points that fold to ASCII (*"Only two non-ASCII code points
    lower-case to ASCII"*) gains the `iu` pairs of §2.1, and a new entry records §2.3's trap, since it
    bites any `lastIndex` loop under `u`, not only Find's.
14. **`src/core/textFind.ts`'s module comment** is corrected: its claim that ASCII folding and the
    engine's agree on every case for an ASCII needle stops being true under `u` (`:46`), and the third
    "limit" gains `ß`/`ẞ` as found.

## 8. Not in scope

- **The grid quick filter** (`gridFilter.ts`), which folds with `toLowerCase`. It is not Find, and
  D-097 does not bind it.
- **Path queries.** They do not take user regexes.
- **The `v` flag** (§2.10).
- **Compiling with `u` and falling back to no `u` when that fails.** Two folding algorithms, chosen by
  whether a pattern happens to be `u`-valid, is exactly what D-097 removed.
- **Normalizing for ASCII patterns** (§2.4's decomposed row). That is R204's rule, and a change to it is
  its own question.
