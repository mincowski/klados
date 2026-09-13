# R199 — a ragged CSV row discloses less than it should, and warns more than it should

<!-- status: built-caveat -->

**Built, with the grid limitation disclosed rather than closed** — which is what the round set out
to do, and § 3 says why closing it needs a `src/core/types.ts` change that is reported instead of
made. Raised from a question about `docs/plans/R145-csv.md`'s first Owed entry. Investigating it
found that the entry describes the symptom accurately and the cause wrongly, so § 2 corrects the
record before § 4 proposes anything. Results in § 8.

## 1. What happens now

`parseRow` emits an attribute for **every** field on a long row, including the unheadered extras
(`src/formats/csv/index.ts:238`). The spans are correct and the store holds them all. Each extra is
named with an **empty span** — there are no bytes in the file that name column 6 of a 5-column
header — and `Interner.intern` hashes *content*, so every extra field in the document interns to
the same id.

Two display sites then collapse them:

| Site | Behaviour |
|---|---|
| `src/renderer/components/Detail/gridColumns.ts:171` | `if (findField(attr.nameId) !== -1) continue` — a field whose name was already seen is skipped |
| `src/renderer/components/Detail/gridCell.ts:384` | `if (!result.has(attr.nameId))` — the first attribute with that name wins |

So the second and later extras on a row are **absent from the grid**. Separately, one
`csv.long-row` Warning is emitted per offending row, uncapped.

## 2. This is not data loss, and the Owed entry should stop saying it is

`docs/TASKS.md`'s entry reads *"collapses them to one shared empty-name column, keeping only the
first"*. That is true of the grid and false of the document:

- the bytes are never modified, and Save is byte-identical (invariant 6);
- the Raw view shows the row exactly as written;
- the store holds an attribute per extra field, with correct spans.

The loss is a **projection** — what the grid can show — not a loss from the file. It is a quirk on
input that RFC 4180 § 4 already makes invalid, which lowers the bar from "render it faithfully" to
"do not lie about it". **Reword the Owed entry** as part of this round.

## 3. Why the obvious fixes do not reach it

**The blocker is naming, not counting.** `NodeSink.attribute(nameStart, nameEnd, …)`
(`src/core/types.ts:101`) names a facet by a byte range **in the document**, and two facets are the
same column exactly when their name bytes are equal. Nothing in the file names column 6.

That forecloses the natural proposals:

- **Deriving the column count from the first data row.** Knowing there are three extras supplies no
  names for them; and raggedness can begin at row 40,000, so the first row is not evidence about
  the file.
- **Creating an untitled column.** Already what happens, and it *is* the defect.

This is the same wall R147's headerless probe hit, recorded in `src/formats/csv/header.ts:1` — three
distinct columns collapsed to one against a real `NodeStore`/`Interner`/`collectColumns` round trip.

**Reported rather than proposed, per `CLAUDE.md`'s contract rule.** `Interner.intern` already
*copies* name bytes (`src/core/interner.ts:124`), so interning `"6"` from a scratch buffer would
work with no interner change at all; only `NodeSink.attribute`'s offsets-only signature blocks it.
It is not proposed here because it would break the property that every interned name comes from the
document — which is what makes `internExisting`'s *"a name that doesn't exist in the document must
intern to nothing"* meaningful, and would let a path query match a column that is not in the file.

## 4. R199 — disclose it, and stop the warning flood

**(a) The message tells the truth about what is not shown.** `csv.long-row` currently reports the
arity mismatch only. It should also say that the extra values are not individually addressable in
the grid and are visible in the Raw view — the one place they can actually be read.

**(b) One diagnostic for the file, not one per row.** A 1,240-row flood is noise; a single entry
naming the count is a finding. This is where the "check the row width" idea earns its place — not
to name columns, but to state the shape: *header has 5 columns; 1,240 rows have more.*

**(b) is delivered by R200's general cap rather than a CSV-local counter**, because unbounded
diagnostics are not a CSV defect (`docs/plans/R200-diagnostic-volume.md`). R199 owns the wording and
the CSV-specific summary text; R200 owns the mechanism. **R200 lands first, or they land together.**

## 5. Rejected

**Synthetic column names via a contract change.** § 3 — reported as a design signal, not built.

**Folding the extras into the last headered column's value span.** Tempting: byte spans only, no
naming problem, nothing hidden. Rejected because it puts **wrong data in a named column**, which is
worse than losing an unnamed one — a user reading or sorting that column gets a bogus value with no
marker in the cell itself.

**Dropping the extra fields at parse time.** Makes the grid honest by making the store lossy, and
buys nothing: the grid already cannot show them and Raw already can.

**Suppressing the per-row Warning entirely.** The rows are genuinely malformed and the diagnostic is
how the scrubber marks them. The problem is the volume, not the existence.

## 6. Acceptance

1. A file with 1,000 long rows produces a **bounded** number of diagnostics, not 1,000 — asserted on
   `store.diagnosticCount`.
2. The summary diagnostic names the header width and the count of rows exceeding it.
3. The `csv.long-row` message mentions the Raw view.
4. **The store still holds one attribute per extra field** — asserted on the store, not on the grid,
   which is what pins § 2's claim that this is a display projection and stops a later round
   "fixing" it by dropping fields.
5. `docs/TASKS.md`'s Owed entry is reworded, and the R145 plan's own entry with it.
6. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 7. Version

Asked on landing, per `CLAUDE.md`. Candidate was no bump, and **the project lead chose no bump**
for the round as a whole.

## 8. Results

**Built.** All six acceptance criteria met. Landed on the same branch as R200 and after it, per
§ 4's *"R200 lands first, or they land together."*

### 8a. What landed

**(a) The per-row message tells the truth about what is not shown.** `csv.long-row` now reads
*"Every value is kept in the file and readable in the Raw view; the grid can show only the first
unheadered extra, because nothing in the file names the others."* `csv.short-row` gained the
matching half — that the missing trailing fields render as absent rather than empty (D-068), which
was equally undisclosed.

**(b) One summary for the file.** `emitRaggedSummary` emits a single `csv.ragged-rows` Warning at
end of parse naming the header width and the counts: *"Header has 3 column(s); 300 have more and
100 have fewer (RFC 4180 requires every row to have the same number of fields)."* Anchored on the
**header row**, since the header's width is what it reports.

**Emitted only from `parse`, never from `parseRange`.** A single-row incremental reparse has no
standing to make a statement about the whole document, and it does not see the other rows.

**The volume fix came from R200 as planned**, with no CSV-local counter: the per-row flood is
bounded by the general per-code cap, and R199's summary is its own code, so it is never the entry
that gets suppressed.

### 8b. What did not change, and is asserted not to have

`test/csvParse.test.ts` gained *"every extra field reaches the store, however many there are"*,
asserting five attributes with five correct values on a two-column header — **on the store, not on
the grid**. That is acceptance 4, and it exists so that a later round reading the Owed entry cannot
make the grid honest by making the parser lossy. § 5 rejects that, and now a test does too.

### 8c. The record, corrected

`docs/TASKS.md`'s Owed entry and `docs/plans/R145-csv.md`'s own both said the parser *"collapses
them … keeping only the first"*. Both now say what is true: the store holds every field, and the
collapse is in the grid. The entry stays open — the grid limitation is real — but it no longer
describes data loss that does not happen.

### 8d. Review

Reviewed against `git diff` before the commit. It found the `parseRow` doc comment still pointing
at R145's Owed entry as the place the limitation was "disclosed rather than fixed here", which is
now this plan; and three existing tests asserting `diagnosticCount` as a bare number, which the
summary changes — updated with the reason stated at each, rather than renumbered silently.
