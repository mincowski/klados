# R31 — CSV: the quoted-newline spike

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Third of the three topics planned together (notifications →
tabs → CSV), and deliberately **a spike, not a milestone** — it answers one question so CSV can be
estimated honestly.

Timeboxed. Its output is an answer and a recommendation, not shipped support.

---

## 1. Why CSV at all

`CONCEPT.md` §2 already lists it: *"Later candidates: HTML, INI, CSV (as an array of records),
plist, protobuf text format."* This is on-plan, not a new direction.

The case is stronger than it was for TOML. Every architectural investment this project has made —
the byte buffer, the row index, the windowed Raw view, the virtualized grid — is close to ideal for
CSV, and large CSV is precisely where existing tools are worst. It is also the format where the
signature feature *is* the whole product: a 200 MB CSV opening into a sortable, filterable grid is
the clearest demonstration NodePad has of what it is for.

It would also validate `detectGrid` from the opposite direction. R17 proved the *parser* interface
is format-agnostic; CSV would prove grid mode is not quietly XML/JSON-shaped. That is the same kind
of check M6 was, and it was worth doing then.

---

## 2. The one question this spike exists to answer

**A record can span multiple rows.** A quoted CSV field may contain a raw newline, so record
boundaries and the row index disagree. Everything else about CSV is ordinary; this is the part
that touches load-bearing architecture.

Two consequences, and the second is the serious one:

**2a. The windowed Raw view can slice mid-field.** `computeWindowBounds` snaps to row boundaries
from the row index, and a row boundary inside a quoted field is not a record boundary. Probably
benign — the Raw view shows source text and does not care about records — but it needs confirming
rather than assuming, because the gutter's line numbers and `hasMeaningfulLines` both read the same
index.

**2b. Incremental reparse cannot derive quote state from the ancestor chain.** This is the real
risk. `subtreeSplice.ts`'s `resumeContextFor` reconstructs enough context to resume parsing at an
arbitrary node by walking that node's ancestors. **"Am I inside a quoted field?" is not a property
of any ancestor** — it is a property of every byte before the resume point.

Take this seriously: R17's exhaustive check found *two* real bugs in exactly this area for TOML —
a close offset computed after the next key had been scanned, and `resumeContextFor` misreading a
standalone comment as an implicit table's first key — and both were invisible to tree-shape
assertions. CSV's version of that problem is structurally worse, because the missing information is
unbounded rather than merely subtle.

### What "answered" looks like

Pick one and justify it with a measurement, not a preference:

1. **Quote state is recoverable cheaply.** Scan backward from the resume point to a provably
   unquoted position — a newline outside quotes. Requires an invariant that makes such a position
   findable in bounded work; establish whether one exists, and what the worst case costs on a file
   that is one giant quoted field.
2. **Record starts are indexed.** A second index alongside the row index, holding record
   boundaries, so resume points are always record-aligned. Costs memory (measure it against §8's
   budget) but makes 2b disappear.
3. **CSV opts out of incremental reparse**, falling back to a full reparse on edit. `FormatModule`
   already expresses capabilities rather than format ids (invariant 8) — establish whether a
   capability flag for this exists or would need one, and **stop and report if it would mean
   touching `core/types.ts`.**
4. **The problem is not real in practice** — e.g. the row index's `maxRowBytes` behaviour already
   makes it moot. A legitimate answer, but it needs a generated-corpus check behind it, not an
   argument.

---

## 3. Method

Follow M0-PLAN B12's rule, since this is parser-adjacent: **invariant-tested, not example-tested.**
A generated corpus of CSV with quoted newlines, escaped quotes (`""`), ragged rows, and a field
containing thousands of newlines — then run every node through `resumeContextFor` + `parseRange`,
the real `subtreeSplice.ts` production path, exactly as R17 did. That exhaustive fixture check is
what found TOML's two bugs after hand-written examples and a 300-sample corpus had both missed
them.

Fixtures live in `spike/fixtures/`. A few hundred KB is enough — `cars-small.min.xml` reproduced
R19's hang in under a second, and small fixtures made every iteration cheap.

---

## 4. Out of scope for the spike, but decided before CSV proper is planned

Recorded now so they are not re-derived, and so the spike is not tempted to solve them:

- **Dialect sniffing** — delimiter (`,` `;` `\t` `|`), quote character, line terminator. Heuristic,
  needs a UI override, and the override needs a command (invariant 10).
- **Header row detection** is a guess, and a visible one: guessing wrong names every column wrong.
  Needs an override too.
- **`canFormat: false`.** Aligning columns with padding would change bytes for cosmetic reasons and
  buys nothing a grid does not already give.
- **The Tree becomes a flat list of a million rows.** Acceptable — the grid is the point — but it
  means one of the three synchronized views carries no information for this format. Decide what
  the Tree *shows* for CSV rather than letting it be an accident.
- **Spreadsheet expectations.** A grid invites sort-and-save, edit-a-cell, add-a-column; invariant 6
  refuses all three by design. This is a UX expectation mismatch to answer deliberately, in the
  CSV plan, rather than in feedback after release.
- **Very wide tables.** 200 columns is ordinary in CSV and unheard of in the XML/JSON fixtures, so
  the grid's header, column sizing and horizontal virtualization have never been stressed. Likely
  the second-biggest cost after §2, and worth a look during the spike even though it is not the
  question.

---

## 5. Deliverable

A section appended to this file: which of §2's four answers holds, what it measured, and a
recommended size for CSV proper. **"This is more expensive than it looks, here is why" is a
successful outcome** — the spike exists to make that discoverable before a milestone is scoped
around a guess.

---

## Results (built)

**Answer: Option 4 — the problem is not real in practice, validated by measurement, not assumed.**
`resumeContextFor` never needing quote state was not an oversight; for a `Document -> Row -> Field`
grammar there is nothing CSV-specific for it to recover in the first place, and the generic safety
net `subtreeSplice.ts` already has for every format (`bytesConsumed !== newSpanEnd`, added long
before this spike) turns every case where that *would* matter into a safe fallback rather than
silent corruption.

### Method and code

`spike/csv-quoted-newline/` (spike-only, no shipped code touched, per §5):

- `csvSpikeParser.ts` — a minimal but real `FormatModule` (`detect`/`parse`/`parseRange`/
  `resumeContextFor`), grammar `Document -> Row(Array)* -> Field(Scalar)*`. `resumeContextFor`
  derives its resume kind purely from `ancestors.length` (0/1/2+) — never from CSV-specific state,
  the concrete version of the claim being tested.
- `generateCsv.ts` — a `mulberry32`-seeded corpus generator (same PRNG `test/invariants.test.ts`
  uses), producing ragged rows, escaped-quote fields (`""`), fields spanning 2-4 physical lines, and
  an optional field with thousands of embedded newlines.
- `run.ts` — the check itself, `npx tsx spike/csv-quoted-newline/run.ts`. Three sections, matching
  §2's method (real `subtreeSplice.ts`/`spliceSubtree`, not a reimplementation) and the two
  secondary questions (§2's Option 1 and Option 2 costs).

### 1. Exhaustive edit-and-compare (the real question)

A 400-row corpus (16.9 KB, seed `0xc5f`), 260 rows containing a quoted-newline field. For every such
row: insert a character inside the quoted field, insert a comma inside it (does it split the
field?), insert a raw newline inside it, delete the opening quote, delete a byte near the closing
quote — the exact boundary cases §2b worries about. Plus a broad sweep, a single-character insertion
every 37 bytes across the whole corpus, for ordinary-edit coverage outside quoted fields too.

**1,757 edits. 0 mismatches.** Every edit that `spliceSubtree` accepted (80.3%, 1,411 edits)
produced a tree identical to a fresh full parse of the edited text. Every edit it declined (19.7%,
346 edits — 345 `malformed`, 1 `no-containing-node`) is safe by construction: the caller falls back
to a full reparse, per `decideSplice`'s existing contract. No edit was ever silently accepted with a
wrong result.

Why this holds: a `Field`'s span always starts at its own delimiter (opening quote or field-start
byte), a `Row`'s span always starts right after a genuine unquoted newline, and `parseRange`'s own
`bytesConsumed !== newSpanEnd` check (already generic, not added for this spike) catches the one way
a stale resume decision could go wrong — the fresh parse consuming a different amount than the old
span predicted — and routes it to `malformed`, which is a safe fallback, not a partial or silently
wrong tree. R17's TOML bugs were invisible to tree-shape assertions because parent/child/value all
still resolved and only a span boundary was off; this check compares full flattened trees
(kind + text + child count, node by node) precisely to catch that shape, and found nothing.

### 2. Option 1's real cost (rejected — not just slow, unsound as stated)

Measured on an adversarial fixture: one field with 200,000 embedded newlines (1.0 MB total),
resuming from the field's own midpoint (byte 549,660) — the worst case, since every byte between the
resume point and the field's own opening quote must be crossed before a provably-safe newline can be
found.

The first draft of the backward-scan function was **wrong, not just slow**: it counted quotes
crossed only *during* the backward scan and declared "even so far" safe. That is unsound whenever
the resume point itself starts inside a quoted field — which it does here — because the count is
relative to the wrong reference point. It reported a "safe" newline after scanning back exactly one
byte, which was one of the field's own embedded newlines, not a record boundary. The bug reproduced
immediately, on the very first run.

The corrected version bootstraps real quote parity with a forward pre-scan from byte 0 before the
backward scan can even start. Measured cost: **1,099,251 bytes touched, 4.75 ms** — essentially the
entire file up to the resume point. A "cheap local backward scan" is not locally decidable without
either an index checkpoint (Option 2) or ancestor-derived state (which §2b already established
doesn't exist for this grammar) — so a sound version of Option 1 costs the same order as a full
reparse of everything before the edit, not the bounded local scan its description suggests.

### 3. Option 2's cost (not needed, but priced)

A record-start index (`Int32Array`, one entry per record, mirroring the row index's own shape) on a
200,000-record, 8.3 MB fixture: **0.76 MB, 9.2% of source size** for this fixture's short synthetic
records (~7 bytes/field average); real CSV records run longer, so the real ratio would be smaller
still. Cheap against §8's ~2.5x budget, but moot — Option 4 already holds, so this index would add
memory and a second index to keep in sync for no correctness gain.

### 2a — Raw view windowing (confirmed benign)

`core/rowIndex.ts`'s `buildRowIndex` is a pure byte scan for `\n` with a `maxRowBytes` cap — entirely
CSV-quote-unaware, so a row boundary the index reports genuinely can fall inside a quoted field.
Confirmed benign, not just assumed: Raw view windowing has always been byte-position/structure-
agnostic (D-031) — it shows source text, not records, and every other format's Raw view already
slices at arbitrary byte positions with no structural awareness. Nothing about CSV changes that
contract; a window boundary landing mid-field is the same kind of event as one landing mid-attribute-
value in XML today.

### Very wide tables (§4, noted not measured)

Flagged in §4 as "worth a look even though it is not the question" — left there. It touches grid
rendering (`components/Detail/grid*`), not the parser or `subtreeSplice.ts`, so it is genuinely
separable from this spike's one question and belongs in CSV proper's own plan rather than folded into
this timeboxed check.

### Recommendation for CSV proper

**No format-specific safety net, no record index, and no incremental-reparse opt-out are needed.**
CSV's `Document -> Row -> Field` grammar can use the existing `subtreeSplice.ts` pipeline exactly as
XML/JSON/TOML do — `canIncrementalReparse: true`, `resumeContextFor` as simple as JSON's (a constant,
possibly even simpler), no new `core/types.ts` surface. The quoted-newline problem that motivated
this spike turns out to be architecturally free: the existing generic safety net already covers it.

That reframes CSV's real cost, which is everything §4 already named and none of it touches the parts
this spike checked: dialect sniffing (delimiter/quote-char/line-terminator detection plus a UI
override), header-row detection (guessing, and an override for it), what the Tree view shows for a
format that is one giant flat list of records, the spreadsheet-expectations mismatch (sort/edit/add-
column, all refused by invariant 6), and wide-table grid rendering (untested at CSV's realistic column
counts). None of those is a parser-correctness risk the way §2b looked like one — they are UI/UX and
scope decisions, which makes CSV proper a milestone-sized product-and-UI task, not a parser-risk one.
Size it accordingly: comparable to M6 (TOML) for the parser and incremental-reparse layer (now
de-risked by this spike), plus a genuinely new UI-design pass for the four out-of-scope items §4
already listed, which TOML never needed.
