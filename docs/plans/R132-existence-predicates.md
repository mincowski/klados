# R132 — existence predicates

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. `[@id]` — "has an `id` attribute at all", no value test.
Negation (`[not(@id)]`) was planned here as R133 and is **dropped in favour of
`docs/plans/R138-boolean-predicates.md`**, which owns it as a real operator; §3 records why.
Follow-up to `docs/plans/R129-query-predicates.md`, whose grammar has
exactly two predicate kinds (`positional`, `comparison`) and no way to ask whether something is
merely *present*.

**Why this round exists, and it is not the reason it looks like.** It came out of investigating
attribute nodes for XPath. The conclusion there was that **NodePad path should only ever return
element nodes** — an attribute is a way of *selecting* a node, never a thing you select — which is
the user's own rule and the right one for this app. But under that rule `//car/@id` means "cars that
have an id", which is `//car[@id]`, and **the grammar cannot say that today**. So the entire
user-visible value of the attribute-node work turns out to be one missing predicate, reachable
without touching the data model, the ref encoding, or a single byte of memory.

**Every question in this document is settled.**

---

## 1. What is missing, precisely

R129's `PathPredicate` is `positional | comparison`, and every comparison carries an operator and a
literal. There is no form with a subject and nothing else. So:

| Question | Today |
|---|---|
| `//car[@id="c-1"]` — id equals a value | ✅ R129 |
| `//car[price>100]` — price over a threshold | ✅ R129 |
| **`//car[@id]` — has an id at all** | **not expressible** |
| **`//car[not(@id)]` — is missing an id** | **not expressible** |

The second pair is the data-quality question — *which records are missing this field* — and it is
the one a person opening an unfamiliar 200 MB export actually asks first.

## 2. R132 — the existence predicate

**Grammar.** `[` *subject* `]`, where *subject* is what R129 already parses on the left of an
operator: a child element name, `@name`, or `*` / `@*`.

```
car[@id]        has an id attribute
car[price]      has a price child element
car[@*]         has at least one attribute
car[*]          has at least one child element
```

The wildcard forms come along because `isWildcard` is already a concept on `PathStep`; supporting it
in subject position is consistency, not new surface. Both are one comparison in the loop.

**Semantics — existence is about the node, not its value.** This is the detail to get right, and it
is where the obvious implementation is wrong:

- `[price]` is **true** for `<price></price>` and for `<price><a/></price>`. XPath's `[price]` means
  *"the node-set selected by `price` is non-empty"*, and an empty element is still a node.
- `[@id]` is **true** for `id=""`.

**The existing code will get this wrong if reused as-is.** `childSubjectMatches` currently walks to
a value and `continue`s when there is none (`start === NO_VALUE` → `valueBearingChild` → `continue`),
because a comparison against a missing value is false. Existence must stop at the **name match**,
before any value lookup happens. Same for `attributeSubjectMatches`.

**Implementation.** A third `PathPredicate` kind carrying only `subjectAxis`, `subjectName`,
`subjectNameId` and an `isWildcard` flag. The two candidate loops R129 built are already 90% of it —
they find the subject by `nameId`; existence is the same walk with the `valueMatches` call removed.
Allocation-free by construction, since it reuses R131's indexed accessors.

## 3. R133 is dropped, before implementation

R133 was planned here as `not(...)` — a **special form**: one keyword, one nesting level,
`not(not(…))` rejected. Its own text closed with the reason it should not exist for long:

> *"the day a second function is wanted, the right move is a function-call grammar that **subsumes**
> `not`, not a second special form."*

`docs/plans/R138-boolean-predicates.md` is that day, and **nothing had been built when this was
noticed**, so there is no reason to write the special form and then delete it. R138's expression
parser owns `not` as a unary operator, where nesting falls out for free and the depth-1 restriction
never has to exist.

**R133 stays allocated and dropped**, per `CLAUDE.md`'s rule that a dropped id stays visible — a
commit or a decision entry that referred to it can still be resolved to what it was going to be.

**The negation argument itself is not dropped, only its home.** It is the reason R138 is worth
scheduling near R132 rather than much later, so it is restated where it now applies:

| Predicate | Matches |
|---|---|
| `[price>100]` | price over 100 |
| `[price<=100]` | price 100 or under — **excludes** records with no price |
| `[not(price>100)]` | price 100 or under **or no price at all** |

Under XPath's rules a comparison against an empty node-set is false, so `price>100` and
`price<=100` are *both* false for a record with no price. Only `not(...)` reaches it — which is the
same missing-data question §1 says this round exists for.


## 4. What this deliberately does not do

- **Attribute nodes, tagged refs, `NodeKind.Attribute`.** The investigation that produced this round
  concluded they are an **XPath prerequisite**, not a NodePad-path feature, precisely because
  results are always element nodes. Nothing user-visible waits on them.
- **`not`, `and` and `or`.** All three belong to `docs/plans/R138-boolean-predicates.md`'s
  expression parser (§3). This round adds the *operand* they combine; it adds no operator and does
  not touch `parsePredicateBody`'s dispatch beyond one more case.
- **Any change to how results are displayed.** A match is an element node and highlights the same
  way it does today, in all three panes.

## 5. Non-functional expectations

Existence is strictly *cheaper* than the comparison R129 measured at 17.5 ms over 400,000
candidates: same walk, no number parse, no byte compare, and it exits on the first name match.
It must stay allocation-free — R131's indexed attribute accessors, `firstChildOf`/`nextSiblingOf`
for children, never `attributesOf` or `childrenOf`. And it inherits R130's resumable predicate loop
unchanged; do not add a second chunking path.

## 6. Acceptance criteria

1. `car[@id]` selects exactly the cars carrying an `id` attribute, including one with `id=""`.
2. `car[price]` selects cars with a `price` child, **including** `<price></price>` and
   `<price><a/></price>`. This is the case §2 says the reused code gets wrong, so it fails before
   the fix for the right reason.
3. `car[@*]` selects cars with at least one attribute; `car[*]` cars with at least one child
   element.
4. A subject name absent from the document's interner makes the predicate false without touching
   the store — R129's existing `subjectNameId === null` path, reused.
5. `car[price<=100]` **excludes** a car with no `price` element at all. Asserted here, in the round
   that has no negation, because it is the baseline the `not(...)` criterion in
   `docs/plans/R138-boolean-predicates.md` is measured against — and because it is the behaviour
   someone will otherwise report as a bug.
6. An existence predicate over ≥400,000 candidates yields to the scheduler, inheriting R130's loop —
   asserted through `runChunkedJob`'s resumption, not by timing.

## 7. Results

**Built, together with `docs/plans/R138-boolean-predicates.md`.** The two rounds touch the same
function (`parsePredicateBody`) and were implemented in one pass, per §6's build order in the R138
document — R138's expression parser replaced the old string-pattern predicate body first, then
R132's existence operand was added into it as one more operand production alongside the existing
comparison. `ExistencePredicate` is a new `PathPredicate` kind (`src/core/path/parse.ts`) carrying
`subjectAxis`/`subjectName`/`subjectNameId`/`isWildcard`; evaluation (`src/core/path/evaluate.ts`,
`existenceMatches`) stops at the name match exactly as §2 specifies — it does not reuse
`childSubjectMatches`/`attributeSubjectMatches` (those `continue` past a subject with no value,
which is correct for a comparison and wrong for existence).

All six acceptance criteria hold, including the two subtle ones: `<price></price>` and
`<price><a/></price>` both satisfy `[price]` (criterion 2, `test/pathEvaluate.test.ts`), and
`car[price<=100]` excludes a car with no `price` element at all (criterion 5) — the baseline
`docs/plans/R138-boolean-predicates.md`'s `not(price>100)` criterion is measured against, both
asserted side by side in the same test. Criterion 6 (resumable over ≥400,000 candidates) is a
dedicated test in `test/pathQueryJob.test.ts` showing an existence predicate suspends through the
*same* `advance`/`PredicatePlan` loop a comparison predicate does — R138's evaluator generalized
the one resumable loop to a plan tree rather than adding a second chunking path, so this criterion
and R138's own acceptance 9 are the same code path.

**Review**: read as a diff against the ten invariants, `git diff`, before commit. No object-per-node
was introduced (leaves and internal nodes of the plan tree are built once per *query*, not per
candidate); the attribute-range gallop hint is computed at most once per candidate regardless of how
many leaves in the tree read it (`planUsesAttributes`, `src/core/path/evaluate.ts`); one wording
inconsistency was found and fixed (an unterminated `not(...)`'s diagnostic offset pointed just past
the word "not" instead of at the `(`, unlike the plain-paren case) before commit. R133 stays
allocated and dropped, as planned — nothing in this round or R138 built the special form.
