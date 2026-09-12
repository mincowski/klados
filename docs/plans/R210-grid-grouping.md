# R210–R211 — when does a table appear, and what goes in it

<!-- status: open -->

**Open.** Raised while deciding R209: a document whose composite children fall into two groups shows
one as a table and the rest as a list. **That is true with or without namespaces** — dropping
resolution makes it reachable more often, it did not create it.

**R210 renders the options and decides; R211 implements the choice.** The threshold is not a separate
task, for the reason in § 2.

## 1. What happens today

`detectGrid` counts composite children by name. A group qualifies at **≥2 members and ≥5% coverage**
(`GRID_MIN_MEMBERS`, `GRID_MIN_COVERAGE`); the **largest qualifying group** becomes the table and
every remaining child renders in a list beneath it (D-014, implemented via `Detail.tsx`'s `exclude`).

**`GRID_MIN_COVERAGE = 0.05` is explicitly a guess.** Its own comment says so — *"§13 lists it as a
guess awaiting real documents (E10)"* — and `CONCEPT.md` §13 still carries it as open.

**The case it goes wrong on is not the obvious one.** A low floor is harmless when the largest group
is dominant: 1000 `<car>` and one `<metadata>` gives a 1000-row table either way. It bites when
**every** group is small — twenty differently-named groups of three under one parent produces a
**three-row table and a fifty-seven-row list**, because three of sixty clears 5%.

## 2. The three proposals are one question

Raising the threshold, unioning the groups, and rendering several tables are not independent
choices — **the threshold's correct value is a consequence of the rendering model**:

| Model | What the floor should be |
|---|---|
| One table + remainder list | **High.** If only one group can ever be shown, a group covering a twentieth of the children is a misleading thing to promote |
| Several tables | **Low, or none.** Every qualifying group gets shown, so a floor only decides what is too small to tabulate at all |
| One unioned table | **Irrelevant.** There is always exactly one table |

D-014 set the floor at 5% *because* it wanted a second qualifying group to be arithmetically
possible — which only matters if several tables might one day render. **That day is a decision, not a
deferral**: D-014 says "multiple stacked grids deferred past v1", and v1 has shipped.

**So decide the model first.** The number falls out.

## 3. The models, measured against the same three documents

- **(i)** 1000 `<car>` + 1 `<metadata>` — the common case
- **(ii)** 3 `a:item` + 2 `b:item` — the merged feed, after R209
- **(iii)** twenty groups of three — the pathological case

| | (i) | (ii) | (iii) |
|---|---|---|---|
| **A — today** | 1000-row table, 1 in list | 3-row table, 2 in list | **3-row table, 57 in list** |
| **B — union all** | 1001 rows, metadata's columns empty on 1000 of them | 5 rows, **4 columns, no shared column** | 60 rows, up to 20 groups' columns wide |
| **C — several tables** | 1000-row table, metadata in list (1 member, below the floor) | **two tables, 3 and 2** | **twenty tables** |

**Each model fails on a different input**, which is the finding: none is universally right, so the
choice is about which failure is most tolerable.

### What the union actually produces here — measured

Run against the real store on document (ii), namespaces off:

```
group a:item: columns [a:sku, a:price]
group b:item: columns [b:sku, b:price]
UNION: [a:sku, a:price, b:sku, b:price]  -> 4 columns, 5 rows
columns shared between the two groups: NONE
each row fills 2 of 4 cells — the rest empty
```

**Zero overlap.** A namespaced document prefixes the children too, so the two groups share no column
names at all and the unioned table is two disjoint blocks stacked inside one grid, each row half
empty. For this case the union is **not** better than two tables — it is two tables with the gaps
drawn in.

That is specific to prefixed children. Union is more attractive where groups genuinely share fields
(`<car>` and `<vehicle>` both carrying `make`, `year`), which is exactly what R210 must find a real
document for rather than assume.

## 4. D-013 does not settle the union question, and it looks like it does

D-013 rejected folding shape into the grouping key: *"that splits `<car>` elements into separate
groups whenever one carries an optional field … Optional fields should widen the column set, not
break it apart."*

**That is an argument against shape as a splitter.** Using column overlap to *merge* two name groups
is the opposite direction, and D-013's reasoning does not reach it — a merge cannot fragment
anything. So "merge groups whose columns overlap above some share" is **available**, not precluded,
and is a fourth model worth rendering alongside the three.

Noted explicitly because the first reading of D-013 is that the question is closed, and it is not.

## 5. R210 — render before deciding (`PLANNING.md` § 1)

This is a visual decision, and § 1 of `PLANNING.md` is the whole reason this is a probe round rather
than an implementation round: **every visual decision this project rendered first survived contact,
and every one reasoned about came back as a follow-up round.**

R210 mounts all four models against the three documents in the browser test project, screenshots
them, and puts them in front of the project lead. **No model is recommended here on purpose.** What
can be said in advance is only what § 3 measures, and the sparse-union result is the one number that
already rules something out for one case.

**And find a real document.** `CONCEPT.md` §13 has listed the coverage threshold as "awaiting real
documents" since M2. A fourth round guessing at it is worth less than one file that actually has the
shape.

## 6. R211 — implement the chosen model

Scoped once R210 decides. Two things it carries regardless:

- **`GRID_MIN_COVERAGE` moves with the model** (§ 2), and `CONCEPT.md` §13's open question closes
  with a value and a reason rather than staying a guess.
- **D-014 is rewritten, not silently contradicted.** It currently records "largest group as grid,
  remainder as list; multiple stacked grids deferred past v1" — any of B, C or the merge model
  reverses part of that, and the entry must say so.

## 7. Non-functional expectations (`PLANNING.md` § 3)

- **Whatever the model, the column cap still applies per table.** `GRID_COLUMN_CAP` exists because a
  60-column grid is already unreadable; model B can exceed it by construction and must not simply
  widen past it.
- **Several tables means several virtualizers.** The grid virtualizes for a two-million-child parent
  (D9's stated normal case). Model C must not mount twenty unvirtualized grids, and a cap on *how
  many tables render* is part of that model, not a later refinement.
- **Detection stays one pass over the children.** E10 measured under 50 ms for 2 M children; a model
  that compares every group's column set against every other's must not turn that into a quadratic
  pass over groups.

## 8. Acceptance

1. Four models rendered against three documents, screenshotted, decided by the project lead.
2. At least one **real** document informs the threshold, or the round says plainly that none was
   found and the value stays a guess with that recorded.
3. The pathological case (§ 3 (iii)) is in the fixtures, since it is the one today's floor gets
   wrong and the one a new floor exists to fix.
4. `CONCEPT.md` §4.3 and §13, and D-014, are updated to whatever is chosen — including "unchanged,
   and here is why", which is a legitimate outcome.
5. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 9. Version

**Ask on landing.** Candidate: **minor** if the model changes — documents will render differently.
None if R210 concludes the current behaviour is right.
