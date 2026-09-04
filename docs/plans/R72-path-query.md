# R72–R76 — the path query, and the seams it shows

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Four reports about the palette's `/` mode, from someone who
likes it but cannot tell what it is for. `CONCEPT.md` §6.3 is the design; M4's G7–G9 built it.
Related: `docs/plans/R69-focus-and-find.md` (which already found Find mounted in the wrong place) and
R65's shortcuts panel, which is where palette *modes* have to be documented by hand. Results at the
end of this file.

Answers first, since three of the four questions have one and the fourth is a real defect.

---

## 1. What it is for, and what happens with several matches

§6.3: "a deliberately small syntax evaluated against the unified node model, and therefore identical
on every format." It is the **structural** counterpart to Find's text search — Find asks "where does
this string occur", the path query asks "which nodes are at this position in the shape."

The grammar, verified working against `cars-small.xml` in the built app:

| Typed | Result |
|---|---|
| `/garage/cars/elements/car[2]/name` | 1 match — child chain plus positional |
| `/garage//name` | 1,202 matches — descendant axis |
| `/garage/*/elements/car` | 1,202 matches — wildcard step |
| `/garage//car[@color="red"]` | 145 matches — facet predicate |

**So yes, there are placeholders**, three of them: `*` for any name, `//` for any descendant, and
`[n]` / `[@attr="value"]` as predicates. There is no partial-name wildcard (`car*`), and comparison
predicates (`car[price>100]`) are deferred to M7 by §6.3 itself — that is where a small syntax
starts needing a type system.

**Multiple matches are the normal case, and the feature already handles them** — this is just
invisible until you commit. Before you press Enter the palette already says
`Enter to show 145 matches`. On Enter, `runPathQuery` (`Palette.tsx:307`) publishes every matched
node's span as a `SearchResult`, opens Find, and jumps to the first. From there `F3` / `Shift+F3`
and the Find bar's own next/previous step through all 145, and Raw highlights them, and the Tree
and grid mark them — because a path result and a text-find result are deliberately the *same*
offset-set shape.

## 2. "It opens the Find modal without a search string" — correct, and that is the defect

Not a bug in the sense of something failing: `openFind()` is called on purpose, because Find already
owns the count, the next/previous buttons and the match highlighting. Reusing it is why 145 path
matches behave exactly like 145 text matches with no extra code.

But the Find bar was built around a *text* query, so it renders an empty `Find…` input above a live
result. That reads as "it forgot what I searched for," or as though nothing happened — which is
precisely how the report describes it. **The surface is telling the user nothing about where those
145 matches came from.**

**R74: show the origin of a direct result.** `searchStore.ts` already tracks this state separately —
its own comment calls it *"there's a live result, but nothing this store itself can re-run"* — so
the information exists and simply is not rendered. Options, cheapest first:

1. Put the query in the input as read-only text, prefixed to show it is a path (`/garage//name`)
   rather than a needle. Typing replaces it and starts an ordinary text search, which is the right
   escape.
2. Or leave the input empty and label the count: `145 matches for /garage//name`.

Prefer (1): it also answers "what would I edit to change this", which (2) does not.

### And no, Find does not accept path syntax

Worth stating plainly because the report asks. Find searches **bytes** — literal or regex, per
`chooseFindPath`. The path query is evaluated against the **node model**. They share their *result*
representation and nothing else. Typing `cars/car` into Find looks for that literal text and will
usually find nothing.

That is a defensible split (§6.3 argues the structural query belongs to the model, not the text),
but the two surfaces currently look identical at the moment of confirming a path query, which is
what makes the question arise at all. R74 fixing the label fixes the confusion too.

## 3. R73 — `//name` at the top level silently returns nothing

The one real defect, and it is in the most natural thing to type.

`parsePaletteInput` strips **exactly one** leading `/` as the mode prefix. But `//` is also the
grammar's descendant axis. So:

| Typed | Query after prefix-stripping | Result |
|---|---|---|
| `/garage//name` | `garage//name` | 1,202 matches ✓ |
| `//name` | `/name` | **No matches** |

A user typing `//name` — "every `name` anywhere in the document", the single most obvious use of a
descendant axis — gets a silent zero. **The descendant axis is unreachable at the top level**, and
nothing says so: no diagnostic, just `No matches`, which is indistinguishable from a document that
genuinely has none.

Two candidate fixes, and the choice is a real one:

- **Treat a leading `/` in the query as the descendant axis from the root**, so `//name` (stripped to
  `/name`) means "any descendant named `name`". Matches XPath, where `//name` means exactly that.
- **Or strip the prefix and keep the rest verbatim**, so the user types `///name` for a top-level
  descendant search. Consistent, and unusable.

Take the first. It also makes the pasted-path case in §4 keep working, since `toXPath`'s single
leading `/` is stripped as the prefix and the remaining path is a child chain.

**Check the empty-query and root cases while there**: `/` alone, and `/*` (which currently returns
the root's one child, correctly).

## 4. Copy Path round-trips on XML and silently fails on JSON

The report's mental model — copy an element's path, paste it into `/`, land there — is real and it
works. Tested end to end in the built app, clipboard included:

| Fixture | Copy Path produced | Pasted into the palette |
|---|---|---|
| `cars-small.xml` | `/garage/cars/elements/car[3]` | **`Enter to show 1 match`** ✓ |
| `deep-10k.json` | `/0/0/0/0/…` | **`No matches`** ✗ |

The XML case works partly by luck and partly by design: `toXPath`'s single leading `/` is consumed
as the palette's mode prefix, and everything after it is already valid path-query syntax, `[n]`
predicates included. That is a genuinely nice property and worth protecting with a test.

**The JSON case cannot work as written.** `copyPathFor` picks its serializer from
`capabilities.hasAttributes` — XPath when true, **JSON Pointer** when false — and JSON Pointer
addresses an array element by a bare numeric segment (`/books/0/title`). The path grammar reads
every segment as a *name*, and no node is named `0`, so the step resolves to `nameId: null` and the
query is answerable as empty without touching the store. Silent zero again.

Two further JSON Pointer features break the same way, and should be checked rather than assumed
absent: its escapes (`~0` for `~`, `~1` for `/`) are not path-query syntax either, so any key
containing a slash also fails silently.

**R75: make Copy Path produce something the query mode can consume.** The honest options:

- **Emit the NodePad path syntax for every format** (`books[1]/title`), so one string works
  everywhere and the round trip is format-independent — which is exactly §6.3's argument for having
  a unified query at all. Cost: JSON users lose a JSON Pointer they might have wanted for other
  tools.
- **Or offer both**, as two commands (`Copy Path` / `Copy JSON Pointer`), with the query-compatible
  one as the default.

Recommend the first, with the second available if anyone asks. Note `detailModel.ts:146`'s own
comment already flags `hasAttributes` as the wrong axis for this decision — *"a third format whose
path syntax doesn't line up with its attribute-having-ness (plausible for TOML) is a real reason to
add [a capability], not to keep stretching this."* R75 is that reason arriving. **Adding a
capability means `src/core/types.ts`, so stop and report** rather than doing it inside this task;
emitting NodePad path syntax for every format needs no capability at all, which is a further
argument for it.

## 5. R72 — guidance when you type `/`

The palette's placeholder advertises the mode (`…, / to query`), and the mode's own empty state
shows one example:

```
Type a path query, e.g. cars/car[@id="c-001"]
```

One line, and it leads with the most complex form in the grammar — a facet predicate with a quoted
string. Someone meeting the feature there has no way to learn that `*`, `//` and `[n]` exist.

**Fix: replace the single line with the grammar itself**, which is five lines and is already written
in `parse.ts`'s header and `CONCEPT.md` §6.3 verbatim:

```
cars/car            children by name
cars//price         any descendant
car[3]              the 3rd
car[@id="c-001"]    by attribute value
*                   any name
```

Shown when the query is empty, replaced by the live match count as soon as the user types — which
the mode already does. This is the cheapest possible version of R65's shortcuts panel, in the one
place the syntax is actually needed.

**Also improve the error line.** A malformed query currently renders
`Error at 7: <message>` — an offset the user has to count characters to use. Render the query with a
caret under the offending character instead; `PathDiagnostic` already carries the offset, so this is
presentation only.

**Feed the same text to R65.** The shortcuts panel derives its command list from the registry, and
`@` / `:` / `/` are palette *modes*, not commands — no registry can list them. R65's curated section
is where they belong, and R72's grammar block is the content.

## 6. The technical string — what it is, and what it is actually warning about

Not ambiguous after all; my first scan missed it, because it is a multi-line JSX text node rather
than a quoted string. `FindBar.tsx:247` renders, in a `.find-footnote` span:

> Case-insensitive matching uses byte-exact ASCII folding for plain text, platform Unicode casing
> for non-ASCII or regex searches — the two can occasionally disagree.

It renders whenever `regex === false && caseSensitive === false` — **the default state**, so it is on
screen essentially always, including over a path-query result with an empty input (confirmed in the
built app: empty input, `0 of 1202`, this footnote).

### What the two algorithms are

From `core/textFind.ts`, `chooseFindPath(needle, options)` is `!options.regex && isAsciiOnly(needle)
? 'byte' : 'decoded'`:

| Search | Path | Case-insensitive comparison |
|---|---|---|
| ASCII needle, no regex | byte | `asciiFold` — `A-Z` ↔ `a-z`, nothing else |
| non-ASCII needle, no regex | decoded | `slice.toLowerCase() === needle.toLowerCase()` |
| any needle, regex | decoded | `new RegExp(needle, 'gi')` |

### What actually differs, brute-forced rather than reasoned about

Comparing the plain-search result against the regex result for every single-character needle/text
pair in U+0020–U+2FFF: **154 divergent pairs.** A representative sample:

Five of them, run through the real `findAll` (not a reimplementation) on realistic text, with match
counts as returned:

| # | You type | Document contains | Plain | Regex |
|---|---|---|---|---|
| 1 | `µm` (micro sign U+00B5) | `pitch 250μm tolerance` (Greek mu U+03BC) | **0** | 1 |
| 2 | `Σ` (U+03A3) | `total ς here` (final sigma U+03C2) | **0** | 1 |
| 3 | `straße` | `STRAẞE amount` (capital sharp s U+1E9E) | 1 | **0** |
| 4 | `Å` (U+00C5) | `lattice 3.6Å` (angstrom sign U+212B) | 1 | **0** |
| 5 | `Ω` (U+03A9) | `load 220Ω` (ohm sign U+2126) | 1 | **0** |
| — | `car` | `a Car and a CAR` | 2 | 2 |

The last row is the control: an ASCII needle, where the two paths agree. Every case-sensitive run of
the five returns 0, which is the other half of the point — case-sensitive search never diverges.

**Neither path is a superset of the other**, which is the easy thing to assume and the thing that
decides how bad this is. Of the 154: **84 the regex path finds and the plain path misses; 70 the
plain path finds and the regex path misses.** So "stay on plain search and you just get a few extra
hits" is not what happens — in the larger half you get *fewer*, and a missed match is the harmful
direction, because it reads as "this document does not contain that" rather than as noise.

**And with an ASCII needle: zero divergences, across the whole range.** That is what actually makes
this tolerable, rather than the direction of the error. A search for a tag name, an attribute name
or English content can never hit it.

**Every divergence involves a non-ASCII needle.** For an ASCII needle the two paths agree completely
— `asciiFold` does not fold non-ASCII to ASCII, and JS `RegExp`'s `i` flag without `u` does not
either. That is the finding that matters, because:

**The footnote's render condition is close to backwards.** It shows for *every* plain
case-insensitive search, including the ASCII ones where no disagreement is possible, and it is
**hidden when regex is on** — one of the two behaviours it is describing. Key it on
`!isAsciiOnly(needle)` instead, reusing `textFind.ts`'s own exported predicate rather than a
re-derived test, so the note and the behaviour cannot drift.

### Why they diverge in *opposite* directions: one folds down, the other folds up

The examples look inconsistent — the regex path treats the two mu characters as equal but not the
two angstroms — until you look at which direction each algorithm folds:

| Pair | `toLowerCase` | `toUpperCase` | Plain | Regex |
|---|---|---|---|---|
| `µ` U+00B5 / `μ` U+03BC | U+00B5 vs U+03BC — **differ** | both U+039C — **converge** | miss | match |
| `Å` U+00C5 / `Å` U+212B | both U+00E5 — **converge** | U+00C5 vs U+212B — **differ** | match | miss |
| `Ω` U+03A9 / `Ω` U+2126 | both U+03C9 — **converge** | U+03A9 vs U+2126 — **differ** | match | miss |

An exact inverse, and the mechanism is visible in the source: `indexOfCaseInsensitive` compares
`slice.toLowerCase() === needle.toLowerCase()` — it **folds down**. ECMAScript's regex `i` flag does
not lowercase; its `Canonicalize` operation is defined in terms of **`toUpperCase`** — it **folds
up**. Each path therefore matches whichever pairs happen to converge in its own direction, and
Unicode case mappings are not symmetric: the angstrom sign has a lowercase mapping to `å` but no
uppercase mapping, while the micro sign has an uppercase mapping to Greek capital Mu but no
lowercase one.

**Three layers, worth separating:**

1. **Unicode** — that some characters converge when lowercased and different ones when uppercased is
   inherent, and every tool faces it.
2. **ECMAScript** — that regex `i` canonicalizes via uppercase rather than case folding is a JS
   language decision. A different regex engine would draw the line elsewhere.
3. **NodePad** — picking `toLowerCase()` for one path and the JS regex engine for the other is ours,
   and it is what makes the two disagree inside one search box.

### The obvious fix does not work, measured

`decodedTextMatches` builds `new RegExp(needle, 'gi')`. Adding the `u` flag switches JS from
`Canonicalize` to proper Unicode simple case folding, and it does fix all three examples above. It
is not the answer:

- **It removes 58 of the 154 divergences, not all of them** — 96 survive. It moves the boundary
  rather than unifying the two algorithms, so the note in the UI would still be needed.
- **It turns patterns that work today into syntax errors.** Under `u`, JS rejects the Annex B
  loose syntax: `\-`, `\ `, `a{`, `[a-\d]` and `\p` all throw where they parse fine today. And
  `decodedTextMatches` catches the throw and returns `[]` — so a user's working regex would silently
  begin reporting **no matches** rather than erroring visibly. That is a worse failure than the one
  it fixes.

This is why the divergence is accepted rather than patched: the cheap fix is not cheap, and the real
one is a single case-folding implementation shared by both paths.

### What it means for a user, which is the part the current wording never reaches

- **You always match exactly what you typed.** Neither path fails to find the literal characters.
  The difference is only about *additional* characters that some definition of "equal ignoring case"
  considers equivalent — different Unicode characters that look the same or mean the same.
- **Case-sensitive search is unaffected.** Both paths compare exactly when `caseSensitive` is true
  (`text.indexOf`, and the un-folded byte compare). The note is only about case-*insensitive*
  search, which the current wording does say but buries.
- **The effect is: toggling `.*` can change the number of matches for the same needle.** That is the
  whole observable symptom, and it is worth saying outright.
- **Ours or general?** The underlying problem is general — Unicode has several distinct notions of
  case-equality, and every tool picks one. What is specific to NodePad is having **two of them in
  one search box**, selected implicitly by the needle and the regex toggle.

### Where the confusable flag goes: the Raw pane, not the find box

They answer different questions and both are worth having, but only one of them is the
zero-dependency 80% version:

- **Raw pane — "this document contains a character that looks like something else."** A decoration
  on the character itself, the way `rawDecorations.ts` already decorates. It is a property of the
  document, so it is useful when nobody is searching at all — which is the point of framing this as
  a document problem. Cost is bounded for free: decorations are computed for the visible window,
  and D-031 caps that at ~1 MB regardless of file size.
- **Find box — "your search term may not match what you expect."** That is the note, below.

They compose rather than compete: once the Raw pane can identify a suspicious character, the find
box can reuse the same predicate to say something *specific* instead of something general (tier 3).

Start with the Raw pane. The heuristic — a non-ASCII character sitting inside an otherwise-ASCII
run — needs no table and catches the realistic case: a Greek mu pasted into Latin text, a Cyrillic
`а` inside an English identifier. **Deliberately not** a general confusables check; a document that
is legitimately Greek throughout must not light up end to end, which the "inside an ASCII run"
condition already prevents.

### The note: first work out where one is even possible

The two toggles and the needle give four relevant states, and only two of them can diverge:

| Case-sensitive | Regex | Needle | Note? |
|---|---|---|---|
| **on** | any | any | **none** — both paths compare exactly; measured, all five example pairs return 0 |
| off | any | **ASCII** | **none** — measured, zero divergences across the whole range |
| off | off | non-ASCII | yes — plain fold |
| off | on | non-ASCII | yes — regex fold |

So the report's instinct is right — the note should depend on the settings — but it is **two notes,
not four**, and the bigger win is that the note disappears from almost every search. That is what
makes it credible when it does appear; a warning shown always is a warning nobody reads.

### Tier 1 — do this now

Two notes, symmetric, each naming the other mode without advising a switch:

- **Plain**: *Look-alike characters: `.*` mode matches a slightly different set.*
- **Regex**: *Look-alike characters: plain mode matches a slightly different set.*

Neither says "try the other one", deliberately. In regex mode that would be actively bad advice —
the user's pattern may depend on metacharacters, and turning regex off would silently change what
they are searching for, not just how it folds.

**Not "find is exact and does not find similar-looking but different characters."** Proposed in
review, and it is inaccurate in the direction that matters: case-insensitive find is **not** exact,
and it **does** match some look-alikes — `Å` U+00C5 finds `Å` U+212B, and `Ω` U+03A9 finds `Ω`
U+2126, both in §6's measured table. A user who read that and then hit a look-alike anyway would
trust the note less, not more. "Some do, some do not" is the honest shape, which is why both notes
above say *a different set* rather than *fewer*.

### Tier 2 — the target: replace the note with a measurement

In **plain mode** the comparison can simply be run. Escape the needle, search again as a regex, and
compare the counts. Verified that the escaping makes this meaningful: `a.b` escaped to `a\.b` no
longer matches `axb`, so the shadow run tests the same literal against the other fold rather than
against a different query.

Then the UI shows **nothing at all** when the two agree — which is the overwhelming majority even
among non-ASCII searches — and something concrete when they do not:

> 12 matches (`.*` mode: 14)

That is strictly better than any wording, because it is true, specific, and self-suppressing. The
user learns there is something to look at exactly when there is.

Two things to get right:

- **It is plain-mode only.** An arbitrary regex has no plain-text equivalent, so the reverse shadow
  run is not well-defined. Regex mode keeps tier 1's note.
- **It costs a second chunked pass**, on a path that is already rare (non-ASCII needle,
  case-insensitive). Run it *after* the primary result completes so it never delays the visible
  count, and consider a document-size gate above which it falls back to tier 1's note. Do not run it
  eagerly on every keystroke — the same debounce the primary search uses applies.

### Tier 3 — once the Raw-pane detection exists

With a confusable predicate available, the find box can name the actual character:

> `µ` (U+00B5) — this document also contains `μ` (U+03BC).

This is the version that explains itself with no Unicode vocabulary at all. It depends on the
document-side work, which is the argument for doing that first regardless.

**Recommendation: tier 1 now** (it is a render condition plus two strings, and it removes the note
from nearly every search), **tier 2 as the target**, tier 3 when the confusable work lands.

### The fixture: `test/fixtures/confusables.xml`

**We did not have one.** `spike/fixtures/nonascii-10mb.xml` is the closest, and it is not close:
scanned, it contains `ü é ñ Š`, CJK and emoji, plus `Å` U+00C5 and `ß` U+00DF — but **neither of
their look-alike partners** (U+212B, U+1E9E). It exercises multi-byte decoding, which is what it was
built for, and cannot show this divergence at all.

**Not by editing `cars-10mb.xml`.** `spike/fixtures/` is entirely untracked — `git ls-files` returns
zero — and `.gitignore`'s own comment explains why: the set is *"deterministic, and regenerable —
never committed."* A hand edit there is invisible to everyone else and destroyed by the next
`npm run fixtures:generate`. Ten megabytes is also the wrong size for a behaviour test whose whole
value is an exactly-checkable count.

**Added instead: `test/fixtures/confusables.xml`**, 1.7 KB, tracked (`test/fixtures/` already holds
the TOML grammar fixtures). Measured through the real `findAll`:

| Needle | Plain | Regex | Case-sensitive |
|---|---|---|---|
| `µ` U+00B5 / `μ` U+03BC | 1 | **2** | 1 |
| `Å` U+00C5 / `Å` U+212B | **2** | 1 | 1 |
| `Ω` U+03A9 / `Ω` U+2126 | **2** | 1 | 1 |
| `ß` U+00DF / `ẞ` U+1E9E | **2** | 1 | 1 |
| `unit` (ASCII control) | 7 | 7 | 7 |

Every pair diverges, in both directions, and the case-sensitive column is 1 throughout — the
baseline that shows folding is the only thing at issue. The ASCII control agrees across all three,
which is the assertion that would fail if someone "fixed" the fold by making it fuzzier.

It also carries `İ` U+0130 for R76's length-changing case and a Cyrillic `а` U+0430 inside `Ivan`
for the confusable detector, so one fixture serves all three pieces of work.

#### The trap, found by walking into it

**Authoring this by typing the characters does not work, and fails silently.** The first draft
reached disk with U+212B replaced by U+00C5 and U+2126 by U+03A9 — they are *canonical singletons*,
so any NFC-normalising step in the authoring path removes them. The fixture then measured 2/2 on
both pairs: no divergence, everything looking fine, testing nothing.

Two consequences, both written into the file's own header comment:

- **Generate it from `\uXXXX` escapes**, which are ASCII in the source and cannot be normalised away.
- **Assert the codepoints are present before asserting behaviour.** A test that only checks match
  counts passes on a silently-normalised fixture — precisely the failure above. The guard is one
  loop over the ten expected codepoints.

Note the asymmetry that made this hard to spot: `µ`/`μ` and `ß`/`ẞ` survived untouched, because those
are *compatibility* mappings rather than canonical ones. Only the two canonical singletons vanished,
so three of the five pairs still looked right.

#### If a large-scale case is wanted later

Add the pairs to `generateNonAsciiXml` (`spike/generate-fixtures.ts:491`) rather than editing any
generated file, so it stays deterministic and regenerable. Worth doing only if something needs the
behaviour *at scale*; the small fixture is what the tests want.

### Is there a library that fixes this?

Two different problems hide behind that question, and only one of them has a library.

**a. Making search fold better.** Measured against Unicode simple case folding, over the same range:

| Fold | Wrong pairs | Characters whose length changes |
|---|---|---|
| `toLowerCase()` — today | 94 | 1 |
| `toUpperCase().toLowerCase()` | **6** | 91 |
| `NFC` + `toLowerCase` | 160 | 39 |
| `NFKC` + `toLowerCase` | 2112 | 243 |

**Normalization is not the answer, and the number needs reading carefully.** NFKC gets all five
example pairs right — including `ß`/`ẞ`, which the round trip breaks — but it disagrees with case
folding on 2112 pairs because it deliberately equates *compatibility* variants: `ﬁ` with `fi`, `²`
with `2`, fullwidth `Ａ` with `A`, circled and math-alphanumeric letters with their plain forms.
Those are not errors in NFKC; they are a different equivalence, and a broader one. For a tool whose
premise is byte-faithful inspection, silently equating `²` and `2` in search is a real behaviour
change, not a bug fix. **So the round trip remains the better fold**, and NFKC is the wrong tool for
matching — no library required either way, both are built into JS.

**b. Detecting confusables in the document**, which is the VS Code approach and the better framing.
That does have a standard behind it: **UTS #39, Unicode Security Mechanisms**, whose
`confusables.txt` maps characters to a skeleton form for exactly this purpose. VS Code's
ambiguous-character highlighting is built on that data. npm implementations exist; adding one is a
dependency decision under this project's own rule, and the data table is not small — **evaluate
before adopting, and note it is a data file that ages with the Unicode version.**

There is also a **zero-dependency 80% version** worth costing first: flag a non-ASCII character
sitting inside an otherwise-ASCII run. That catches the realistic case — a Greek mu pasted into
Latin text, a Cyrillic `а` in an English identifier — without the table, and it is a *document*
annotation rather than a change to matching, so it cannot make search quietly fuzzier.

**Framing this correctly matters more than the fix**: this is a property of the document, not of the
search. Every attempt above to fix it in the fold either misses cases or over-matches, because the
search cannot know whether two look-alike characters were *meant* to be the same. The document can
show that they differ. That is the direction to take if this is ever reopened.

### Round-trip folding — `toUpperCase().toLowerCase()` — measured

Proposed while reviewing the above, and it is much better than the current fold. Measured over the
same range, with **Unicode simple case folding as the reference** (what JS's regex `u` flag uses):

| Fold | Pairs it gets wrong |
|---|---|
| `toLowerCase()` — what `indexOfCaseInsensitive` does today | **94** |
| `toUpperCase().toLowerCase()` | **6** |

It fixes **all 94** of the current fold's errors, including all three of the example pairs
(`µ`/`μ`, `Å`/`Å`, `Ω`/`Ω`) — the round trip pulls both members of each pair through their shared
uppercase form and back down to a shared lowercase one. It introduces **6**, which is two real cases
counted in both directions:

| Case | Round trip | Folding says | Effect |
|---|---|---|---|
| `ı` U+0131 dotless i vs `i` / `I` | match (`'ı'.toUpperCase()` is `'I'`) | not equal | **false positive** — an extra hit in Turkish text |
| `ß` U+00DF vs `ẞ` U+1E9E | no match (`'ß'.toUpperCase()` is `'SS'` → `'ss'`) | equal | **false negative** — a regression, today's fold gets this right |

So: **no, it does not converge for every case** — but 94 → 6 is a large improvement, and the two
residuals are narrower than what it fixes.

**The blocker is not correctness or cost, it is length.** `indexOfCaseInsensitive` compares
`text.slice(i, i + needle.length).toLowerCase()` against a needle of fixed length. **91 single
characters in this range change length under the round trip** (`ß` → `ss` is 1 → 2), against a
handful under `toLowerCase` alone. So adopting it makes R76's defect dramatically worse, and the two
have to move together: **R76 is a prerequisite for this, not an independent tidy-up.** That is a
change to R76's recommendation — "document the limit rather than rewrite the inner loop" was right
when the loop bought nothing; it now unlocks a 94%-better fold.

**And it only fixes one of the two paths.** The regex path hands the pattern to the JS engine, which
canonicalizes internally — a regex pattern is syntax, not text, so it cannot be pre-folded the way a
plain needle can. Plain-versus-regex divergence would therefore remain; it would move rather than
close. Closing it needs the regex side to move too, and the `u` flag is measured above as the wrong
way to do that.

Cost is not the objection: `indexOfCaseInsensitive` already calls `toLowerCase` once per candidate
position, so this is roughly 2× the same work, not a new order of magnitude.

Normalization was measured alongside it and is *not* a better fold — see "Is there a library that
fixes this?" below; NFKC answers a broader question than case folding and would change what search
means.

**Status: still accepted as-is**, per the decision above — this is recorded so that whoever revisits
it starts from a measurement rather than from the idea.

### The other mitigation, from a different angle

VS Code does not try to unify case matching; it flags **confusable characters in the document**,
highlighting a Greek mu sitting in otherwise-Latin text as unexpected. That treats the ambiguity as
a property of the *content* rather than of the search, and it surfaces the problem at the point
where it was introduced. It is a genuinely different design and a better fit for a tool whose job is
inspecting a file — worth considering on its own terms if this is ever reopened, rather than as a
variant of the folding question.

### Decision: accept the divergence; fix only the note

Accepted after review of the measurements above: the search behaviour stays as it is, and R72 §6 is
scoped to the footnote's condition and wording. The reason is the ASCII-needle result, not the size
of the divergence — the pairs involved are compatibility look-alikes (micro sign vs mu, angstrom vs
A-with-ring, ohm vs omega, final sigma), and reaching them at all requires typing a non-ASCII needle
into a tool whose documents are mostly ASCII-named structure. Unifying the two algorithms would mean
one case-folding implementation over both the byte and decoded paths, which is a real piece of work
for input this tool is unlikely to be searching — and the cheap alternative, adding the regex `u`
flag, is measured above as fixing 58 of 154 while silently breaking regexes that work today.

R76 (below) is accepted on the same terms and for the same reason.

### Two things found while checking this

**a. The module comment's own example does not demonstrate what it claims.** `textFind.ts`'s header
says the two algorithms disagree "(e.g. Turkish dotless/dotted I)". Verified: `'I'.toLowerCase()`
is `'i'` — `String.prototype.toLowerCase` is locale-independent, so the Turkish rule never applies
here — and `'İ'.toLowerCase()` is `'i̇'`, two code units, which is the *next* finding rather than a
disagreement between the paths. Replace the example with one of the measured pairs above.

**b. R76 — `indexOfCaseInsensitive` cannot express a length-changing case mapping.** It compares
`text.slice(i, i + needle.length).toLowerCase()` against `needle.toLowerCase()`, so the slice is
always exactly `needle.length` code units. Any case mapping that changes length can therefore never
match, regardless of needle:

| Character | `toLowerCase()` | Code units |
|---|---|---|
| `İ` U+0130 | `i̇` | 1 → 2 |

This is not a disagreement between the two paths — it is a case *neither* can express, and it is
invisible today because the footnote talks about something else. Small, self-contained, and it
wants a decision rather than a patch: either accept it and document it as a limit next to the two
`textFind.ts` already writes down ("Two limits, written down rather than discovered"), or compare
case-folded on both sides with a scan that does not assume equal lengths. **Recommendation revised** by the round-trip measurement above: documenting it as a third limit was
right while the rewrite bought nothing, but a length-tolerant comparison is the prerequisite for a
fold that is 94% more accurate than the current one. So document it now *and* record that it is the
gating change if the fold is ever revisited — not a standalone tidy-up.

### And it upgrades R70

Confirmed while probing: with the Raw pane hidden, a path query runs, produces its matches, calls
`openFind()` — and **renders nothing anywhere**, because `<FindBar />` is mounted inside `Raw.tsx`.
`Ctrl+F` doing nothing is confusing; a query that reports 1,202 matches to a surface that does not
exist is worse, because the result set is then live and completely invisible. R70's hoist fixes
both, and this is the stronger argument for it.

---

## Results

**R73** (`core/path/parse.ts`'s `consumeSeparator`): a single leading `/` at position 0 now means
**descendant**, not child — the fix targets exactly the palette-boundary case the defect lives in.
`parsePaletteInput` strips exactly one leading `/` as the mode prefix, so `//name` typed in the
palette arrives at `parsePath` as `/name`, one lone leading slash; before this it parsed identically
to `name` (plain child of root), so the descendant axis was unreachable at the top level. `//name`
(literal, two slashes, reachable directly or mid-query) was already correct and is untouched — the
fix is scoped to `atStart` in `consumeSeparator`, not a grammar change. Verified the round-trip case
(§4's own XML path, which never has a leading slash left after the palette's strip) is unaffected.

**R74** (`session/searchStore.ts`, `Palette.tsx`, `FindBar.tsx`): `SearchStore` gained
`getDirectResultOrigin()` alongside a new optional `origin` parameter on `setDirectResult` — cleared
everywhere `hasDirectResult` already was, so it never outlives the result it describes. `runPathQuery`
passes `` `/${query}` `` (the literal typed text, mode prefix included, so it reads as a path rather
than a needle — option 1 of §2's two, chosen for also answering "what would I edit to change this").
`FindBar.tsx` syncs its local `text` state to the origin via a `useEffect` keyed on the origin
*changing*, not read fresh every render — otherwise a keystroke starting the escape-into-text-search
would be overwritten by the same origin value on the very next render before `search()`'s own
`directResultOrigin = null` had a chance to land.

**R72** (`Palette.tsx`, `CommandPalette.css`): the `/` mode's empty state now renders the grammar
itself (`PathQueryGrammarHelp`, a five-row table already quoted verbatim from `parse.ts`'s own header
and `CONCEPT.md` §6.3) instead of one line leading with the hardest form. A malformed query renders
`PathQueryError` — the query text, a caret row (`--font-mono` on both, load-bearing for alignment),
and the message on its own line — replacing `Error at N: message`. The `@`/`:`/`/`/`>` prefixes were
also fed to R65's shortcuts panel as a fourth curated group (`Shortcuts.tsx`'s `IN_PANE_KEYS`), per
this section's own closing note — they're palette *modes*, not commands, so the registry-derived half
of that panel could never find them on its own.

**R75** (`Detail/detailModel.ts`, D-081): a new `toNodePadPath` replaces the `hasAttributes`-keyed
choice between `toXPath` and `toJsonPointer` inside `copyPathFor` — always the grammar every format's
documents can actually be queried with. Building it surfaced a defect in `toXPath` itself, not just
in the JSON Pointer path: `pathSegmentsOf` only computes `sameNamePosition` by comparing siblings'
*names*, so an unnamed JSON array element (`name === null`) always reads `sameNameCount === 0` and
`toXPath` prints a bare `*` for it — every element in an array looks identical, position lost
entirely. `toNodePadPath` addresses that case with `siblingIndex` instead (0-based "position among
all the parent's children," converted to the grammar's 1-based `[n]`): `*[3]`. `toXPath`/`toJsonPointer`
are untouched, independently tested, and still exported. `copyPathFor` dropped its now-unused
`capabilities` parameter.

**§6 (R76 folded in, D-082):** the footnote's render condition changed from `!regex && !caseSensitive`
(shown on nearly every search) to `!caseSensitive && !isAsciiOnly(needle)` (`textFind.ts`'s own
exported predicate — shown on almost none, the only region a divergence can occur), with two
symmetric messages naming the other mode rather than one that was backwards half the time. The actual
fold divergence is **accepted as-is**, per the plan's own decision — recorded in full at D-082, along
with R76 (a length-changing case mapping matches on neither path) being folded into the same decision
rather than treated as independent, since the natural-looking fix for one turns out to need the other
fixed first. `core/textFind.ts`'s module comment now documents three limits instead of two, and its
Turkish-dotless-I example (verified inapplicable — `toLowerCase` is locale-independent) is replaced
with one of the actually-measured pairs.

**The fixture** (`test/fixtures/confusables.xml`) was already checked in — added during this plan's
own research phase, alongside the write-up of the trap in authoring one (canonical-singleton
normalisation silently destroying the two hardest pairs), which is also already in `docs/FINDINGS.md`.
What this round added was the actual test consuming it: `test/textFindConfusables.test.ts` asserts
every expected codepoint is present (the guard the fixture's own header calls for) before trusting any
match count, then reproduces §6's own measured table against the real `findAll` — all of it held.

**Review.** One finding, fixed before commit: the palette path-query tests initially asserted a
match-count string ("1 of 2") that `setDirectResult` never actually produces on its own (`moveTo`
picks the "current" match; a fresh direct result doesn't) — caught rereading the assertion against
what the code actually does, not what seemed like it should be true, and narrowed to what's
guaranteed. Two real-Chromium test files needed a longer post-paint wait than a bare `setTimeout(0)`
on their very first render specifically (not on later renders in the same file) — bumped to 50ms,
`grid.test.tsx`'s own precedent for a first-paint-sensitive assertion, rather than chased further.

**Tests.** `test/pathParse.test.ts` (+3, R73), `test/searchStore.test.ts` (+4, R74's
`getDirectResultOrigin`), `test/findBarOrigin.test.tsx` (+6: 3 for R74's origin display, 3 for §6
Tier 1's footnote condition), `test/palettePathQuery.test.tsx` (new, 2, real Chromium, R72's grammar
help and caret error), `test/detail.test.ts` (+6, R75's `toNodePadPath` including a real
`parsePath`-consumes-it round trip), `test/textFindConfusables.test.ts` (new, 17, the fixture's
codepoint guard plus the measured divergence table). `npm run typecheck` and `npm run lint` both
clean; the full suite passes (one pre-existing, unrelated flaky timeout in `jsonParser.test.ts`,
confirmed to pass in isolation, the same one recorded against earlier rounds this stretch).
