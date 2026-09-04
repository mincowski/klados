# R129–R131 — M7's comparison predicates, and the two things they actually cost

<!-- status: built -->

**Built.** All nine acceptance criteria met — see § "Results" at the end, which also corrects two of
this plan's own measurements and records the cost the plan missed entirely (an attribute-range
binary search, not the allocation §7 blames).

Register: `docs/TASKS.md`. CONCEPT §12's **M7 — Query predicates**: comparison predicates
in the path syntax (`car[price>100]`) *"and the type-coercion rules they require"*, placed after
TOML and before YAML. TOML landed at R14–R17, so this is next in the document's own ordering.

**The headline is that the expensive part is not the part the milestone is named after.** Comparison
predicates measure at **17.5 ms over 400,000 candidate nodes on a 75 MB document** — cheaper than
the facet predicate this app already ships, which measures at **239–255 ms** on the same corpus.
The two real costs are elsewhere: a predicate is **not preemptible mid-step** (a disclosed, unfixed
finding since G10), and the existing attribute accessor **allocates three objects per node visit**.

**Every question in this document is settled**, and every number below was measured against the real
store and the real evaluator on two generated corpora, not extrapolated from a microbenchmark. One
estimate given verbally before this plan (an "~11×" facet improvement) was **wrong by 5×** and is
corrected in §7 with the measurement that corrected it.

---

## 1. Is M7 still relevant?

Yes, and for one reason that did not exist when CONCEPT was written.

The original case still holds but is weaker than it looks: the grid already lets a human sort and
scan repeating records, which covers much of "show me the expensive cars." What the grid cannot do
is *answer* — its quick filter is text matching, not comparison, so "every car over 50,000" is not
expressible anywhere in the app today.

The new argument is the headless direction (CLI/MCP). An agent working on a file too large to read
wants `car[price>50000]` far more than a human with a grid does — it is the difference between one
query and a written script — and §2 shows it costs 17.5 ms. Whatever comes of that direction, the
predicate is the primitive it would be built on.

And M7 is genuinely load-bearing for XPath, though not in the way "shared feature list" suggests:
XPath needs its own parser, axis model and function library, none of which M7 provides. What M7
provides is the *number-from-bytes primitive and the comparison semantics* — the part that decides
whether XPath can ever be fast, and the part where getting the rules wrong is expensive to undo.

## 2. What was measured

Two generated corpora, parsed through the real pipeline, queried through the real
`evaluatePath`/`NodeStore`. **Corpus A**: 46.1 MB, 400,000 `<car>`, **1** attribute, 5 child
elements. **Corpus B**: 75.5 MB, same 400,000 records with **5** attributes each — the realistic
shape, and the one that corrected §7.

### The predicate M7 adds

| Operation (corpus A) | Median |
|---|---|
| `//car` alone — the baseline walk | 10.8 ms |
| Walk to each `price` child, no number work | 8.9 ms |
| **`car[price>50000]` — decode to a string, then `Number()`** | **155.3 ms** |
| **`car[price>50000]` — parse the number from the bytes** | **15.5 ms** |
| `car[make="BMW"]` — decode, then `===` | 89.3 ms |
| **`car[make="BMW"]` — compare bytes** | **11.6 ms** |

The number work itself is **6.6 ms for 400,000 values** (15.5 − 8.9). Decoding first costs **146 ms**
for the same answer — 22× more, all of it string allocation. On corpus B the same numeric predicate
measures **17.5 ms**.

### The predicate that already ships

| Operation (corpus B, 5 attributes) | Median |
|---|---|
| `//car` no predicate | 13.6 ms |
| **`//car[@id="…"]` — existing evaluator, attribute 1 of 5** | **255.0 ms** |
| **`//car[@vin="…"]` — existing evaluator, attribute 5 of 5** | **239.2 ms** |
| Byte-level comparison, existing generator kept | **126.6 ms** |

`pathQueryJob.ts` already discloses this class of problem — G10 measured a facet predicate at
163–314 ms on a 100–200 MB fixture, recorded in `M4-RESULTS.md` §4 as unfixed. These numbers are
consistent with it and localise the cause (§7).

That first-attribute and last-attribute cases measure the *same* is itself the finding: the cost is
per **node visit**, not per attribute compared.

## 3. The reframe — M7 needs no type system

"Type coercion rules" reads like a data-model change. It is not one. M7 adds **no per-node type
tag, no inferred column types, no coercion table, and no parse-time work**. Invariants 2 and 3 are
untouched, and `NodeStore`'s arrays do not change.

What it adds is one function — *read a number out of a byte range without allocating* — called at
predicate-evaluation time. Roughly thirty lines, and §2 shows it is the fast path rather than the
cost.

**There is also no runtime type inference**, because XPath 1.0's rules do not need any:

- `<`, `<=`, `>`, `>=` convert **both operands to numbers, always**. A non-numeric value becomes
  NaN and the comparison is false. Nothing asks what type anything is.
- `=` and `!=` choose string or numeric comparison from the **literal's syntactic form**, which is
  known when the query is parsed. `price>100` is numeric because `100` is a number literal;
  `make="BMW"` is string because `"BMW"` is a string literal.

So the "type system" §6.3 worried about — *"what `>` means when values are strings, or absent on
some rows"* — is answered by a rule table with four entries and no state.

## 4. XPath 1.0 is the rule set, and its `number()` is not JavaScript's

Adopt XPath 1.0's coercion rules verbatim rather than inventing NodePad's own: they are specified,
twenty years implemented, and exactly what the later XPath work needs, so the two query languages
cannot drift.

That decision has teeth, because **XPath's `number()` is not `Number()`**. Measured against a
byte-level implementation of XPath's grammar (`-? digits ('.' digits?)? | -? '.' digits`, with
surrounding whitespace allowed):

| Input | XPath `number()` | JS `Number()` |
|---|---|---|
| `1e3` | **NaN** | 1000 |
| `0x10` | **NaN** | 16 |
| `""` | **NaN** | 0 |
| `+5` | **NaN** | 5 |
| `Infinity` | **NaN** | Infinity |
| `.5`, `1.5`, `-3`, `␣␣42␣␣` | agree | agree |

**Five of nine diverge.** So reaching for `Number()` is not merely slower — it produces different
answers from every other XPath engine. Implementing XPath's grammar directly is required for
correctness *and* is the fast path; the two goals coincide, which is worth taking while they do.

**Known gap, recorded rather than discovered later:** exponent notation. `1.5e-7` is NaN under
XPath 1.0, so a scientific dataset's values will not compare. This is the one case where users will
notice, and the choice is deliberate — accepting more syntax later is a compatible relaxation,
accepting less is not, and a NodePad-path grammar that quietly differed from NodePad's own XPath
mode would be worse than a documented limitation. If it needs an escape hatch, it should be a named
function, not a looser default.

## 5. R129 — the comparison predicate

**Grammar.** `[` *subject* *op* *literal* `]` where *subject* is a child element name or `@name`,
*op* is one of `=` `!=` `<` `<=` `>` `>=`, and *literal* is a quoted string or a number.

```
car[price>100]           child element's value, numeric
car[price>=100]
car[make="BMW"]          child element's value, string
car[@year<2000]          attribute value, numeric
car[@id="c-001"]         attribute value, string  ← what the existing facet predicate means
```

**The existing `facet` predicate folds into this as a special case.** `PathPredicate`'s two kinds
(`positional | facet`) become (`positional | comparison`), and `@id="c-001"` parses to a comparison
with `op: '='`, `axis: 'attribute'`. This is not tidying: it is what makes R131 a retrofit of one
code path rather than a second implementation beside it.

**What resolves when.**

- **Attribute and element names resolve at parse time**, through the `NameResolver` `parsePath`
  already takes — element names already do this and attribute names go through the same interner,
  so this is the existing mechanism applied to the operand that was missing it. §7 is where the
  payoff is measured.
- **Number literals parse at parse time**, to a JS number.
- **String literals encode to bytes at evaluation time**, once per query, from
  `SourceBuffer.encoding`. Not at parse time: `parsePath` has no encoding and should not grow one
  for this, and once-per-query is already off every hot path.

**Semantics**, from §4: relational operators convert both sides to numbers; `=`/`!=` compare as
the literal's form dictates. A missing subject (no such child, no such attribute) yields no value
and the comparison is false — including for `!=`, which is XPath's behaviour and the one place the
rule surprises people, so it gets a test of its own.

## 6. R130 — predicates become preemptible

**This is the real risk, and it is not arithmetic.** `pathQueryJob.ts` says so already:

> *"A single expensive step is not itself preemptible mid-step; chunking happens between steps, not
> within one."*

Chunking at step granularity was right for R72's grammar, where a step's own work was a name match.
A predicate makes one step arbitrarily long: 17.5 ms at 400,000 candidates here, and linear in
candidate count, so a 200 MB document crosses `M4-PLAN.md`'s hard rule 3 (*"anything that could exceed ~50 ms is
chunked, cancellable, and reports progress"*) inside a single unit the scheduler cannot interrupt.

**R130 adds a resumable predicate loop** — `applyPredicate` becomes a state machine over the
candidate array that `runChunkedJob` can suspend, exactly as `evaluatePathChunked` already suspends
between steps. This also retires G10's disclosed finding, which is the same defect seen from the
facet side.

**Batch the deadline check. Measured, because the naive version is worse than the work it guards:**

| Deadline check | Median | Overhead |
|---|---|---|
| none | 17.5 ms | — |
| every 256 candidates | 19.1 ms | +1.6 ms |
| every 1,024 candidates | 20.5 ms | +3.0 ms |
| **every candidate** | **45.0 ms** | **+27.5 ms** |

A clock read per node costs **more than the entire numeric evaluation**. Per-batch it is ~2 ms and
the difference between 256 and 1,024 is within noise, so pick one and do not tune it. Checking per
candidate is the obvious implementation and it is the wrong one.

## 7. R131 — the facet retrofit, and the estimate that was wrong

**The correction first.** Before this plan, the facet fix was estimated at "~11×" from corpus A,
where each record has one attribute. On corpus B — five attributes, the realistic shape — replacing
the decode with a byte comparison takes **239.2 ms → 126.6 ms**, which is **1.9×, not 11×**. The
flattering number came from a corpus that barely exercised the thing that actually costs.

**What the remaining 113 ms is.** `store.attributesOf` is a generator, and per node visit it
allocates:

1. a `[number, number]` tuple, from `attrRangeOf` returning an array;
2. the generator object itself;
3. **one `AttributeRef` object per attribute yielded**.

On corpus B that is 400,000 tuples + 400,000 generators + 2,000,000 objects for one query. It is
also why the first-attribute and last-attribute cases measure the same (§2): the per-visit cost
dominates the per-attribute one.

**So R131 is two changes, and the second is the one that pays:**

1. Compare attribute **names by `nameId`** (R129 resolves them at parse time) and **values by
   bytes**, never by decoding. Removes ~113 ms of the 239.
2. Add an **allocation-free attribute accessor** to `NodeStore` — an index range plus
   `attrNameIdAt(i)` / `attrValueStartAt(i)` / `attrValueEndAt(i)` — and use it here.
   `attributesOf` stays for callers that want the convenience.

This is not a `types.ts` change: `AttributeRef` and `attributesOf` live in `nodeStore.ts`, and the
format-module contract does not mention them. It also moves *toward* invariant 2 rather than away —
an object per attribute visit is the same shape the invariant exists to forbid, one level down.

**Expected result is stated as a target, not a measurement**: the child-element predicate does its
walk through `firstChildOf`/`nextSiblingOf`, which allocate nothing, and measures 17.5 ms. A facet
predicate doing the same amount of comparison with the same allocation profile should land near it.
**Measure it; do not assume it.** If it lands materially above ~40 ms, something else is going on
and that is a finding worth writing down rather than shipping past.

## 8. The grid keeps `Number()`, deliberately

`gridSort.ts`'s `isNumericColumn` uses JS `Number()`, so it calls `1e3` and `0x10` numeric where
R129 will not. **Leave it alone**, and record the divergence in `DECISIONS.md` rather than
unifying:

- The grid's question is *"should this column right-align"* — cosmetic, already sampled and
  therefore already approximate, and `Number()`'s leniency costs nothing there.
- The query engine's question is *"does this row match"*, where XPath conformance is the whole point.

Two questions, two answers. The reason to write it down is that they look like one function and the
next person will try to share them. The user-visible edge — sorting a column numerically and then
querying it with `>` disagreeing on exponent-notation values — is the §4 gap seen from the grid
side, and the same escape hatch answers both.

## 9. Non-functional expectations

Stated because the obvious implementation of each is the slow one:

- **Never decode a value to compare it.** Not for numbers (§2: 22×), not for strings (§2: 7.7×).
  `SourceBuffer.slice` in a predicate loop is the defect this milestone exists to avoid repeating.
- **Encode the string needle once per query**, outside the candidate loop.
- **Batch the deadline check** (§6: per-candidate costs more than the work).
- **No allocation inside the candidate loop** — no tuples, no iterator objects, no `AttributeRef`.
- The number parser reads `Uint8Array` directly and returns a JS number. It never builds a string,
  not even for the fallback path.

## 10. Acceptance criteria

Node-project tests plus one benchmark run, on a generated fixture matching corpus B's shape
(`npm run fixtures:generate`; §2's corpora are throwaway and are not committed).

1. **R129** — `car[price>100]`, `>=`, `<`, `<=`, `=`, `!=` each return the correct set on a small
   hand-checked fixture, for both a child element and an `@attribute` subject.
2. **R129** — XPath number conformance, asserted case by case: `1e3`, `0x10`, `""`, `+5`,
   `Infinity` are all **NaN** (so comparisons against them are false), and `.5`, `1.5`, `-3`,
   `"  42  "` parse. This is §4's table as a test, so the divergence from `Number()` cannot be
   "fixed" by someone who thinks it is a bug.
3. **R129** — a missing subject makes **every** operator false, `!=` included.
4. **R129** — `car[@id="c-001"]` returns exactly what it returns today: the existing facet tests
   pass unchanged against the unified predicate, since the parse tree changed and the meaning did
   not.
5. **R130** — a predicate over ≥400,000 candidates yields to the scheduler at least once, asserted
   through `runChunkedJob`'s own resumption, not by timing.
6. **R130** — cancelling mid-predicate leaves no partial result visible, the same guarantee
   `evaluatePathChunked` already gives between steps.
7. **R131** — `//car[@vin="…"]` on the corpus-B fixture completes in **under 40 ms** (measured
   239.2 ms today). A wall-clock budget, in the shape of R110's Replace All regression test.
8. **R129** — `car[price>50000]` on the same fixture completes in **under 40 ms**.
9. 7 and 8 **checked to fail before the fix** — 7 fails today at ~239 ms; 8 fails today because the
   grammar rejects the query, which is the honest form of "fails".

## 11. Out of scope, deliberately

- **XPath itself.** M7 builds the primitive and settles the rules; the parser, axes and function
  library are the post-v1 item CONCEPT §6.4 describes, and nothing here commits to their shape.
- **Boolean operators in predicates** (`car[price>100 and year<2000]`). A real want, and a separate
  grammar question — precedence, short-circuiting, and whether `or` can be evaluated cheaply — that
  should not ride along with the type rules. Flagged now because it is the first thing anyone will
  ask for after `>` works.
- **Functions** (`count()`, `contains()`, `starts-with()`). Same reasoning.
- **Any change to `isNumericColumn`** — §8.

---

## 12. Results — built, with two of this plan's numbers corrected

Landed as one round: R129's grammar and XPath semantics, R130's resumable predicate, R131's
allocation-free attribute access. **All nine acceptance criteria in §10 are met.** Every number
below was measured on this machine against the fixture described next, not carried over from §2.

### The corpus

`spike/generate-fixtures.ts` grew `cars-attrs-400k.xml` — **86.5 MB, 400,000 `<car>` records, five
attributes each (`id year color plant vin`, `vin` deliberately last) and five child elements
including a numeric `<price>`**. That is §2's corpus B's shape at 86.5 MB rather than 75.5; every
field is a **pure function of the record index with no PRNG**, so `test/pathPredicateBudget.test.ts`
recomputes the expected match count from the same formulas instead of asserting whatever the query
returned. A predicate that is fast and wrong fails it.

### Measured — the two budgets, and the before

| Query (400,000 candidates, 86.5 MB) | Before | After | Budget |
|---|---|---|---|
| `//car[@vin="…"]`, attribute 5 of 5 | **223.0 ms** | **30.0 ms** | 40 ms ✓ |
| `//car[price>50000]` | *did not parse* | **30.6 ms** | 40 ms ✓ |
| `//car[engine="electric"]`, string over a child element | *did not parse* | **26.4 ms** | 40 ms ✓ |
| `//car` — the no-predicate baseline | 11.0 ms | 0.3 ms | — |

The "before" for the facet query is the **pre-R129 `applyPredicate` facet branch run verbatim** over
this corpus (`attributesOf` + `textOf` + `SourceBuffer.slice`), not an estimate: 223.0 ms, close to
§2's 239.2 ms on its own 75.5 MB corpus. **7.4× faster**, against §7's target of "near 17.5 ms, and
materially above ~40 ms is a finding."

### Correction 1 — §2's 17.5 ms is not reachable here, and the reason is memory, not code

§2 has `car[price>50000]` at **17.5 ms** with `//car` alone at 13.6 ms — a predicate costing under
4 ms over its own baseline. This round could not reproduce that shape and can say why. Measured in
isolation, a bare walk from each of the 400,000 candidates to its `price` child — five `NodeStore`
array reads per child visit, **no comparison at all** — costs **5–7 ms**, and adding *only* the
number read takes it to **~30 ms**. The same walk with a byte comparison instead of a number costs
**~25 ms**. Both are dominated by cache misses: each value read touches a fresh line of an 86.5 MB
buffer, and each child visit touches four separate 9.6 MB `Int32Array`s at the same index.

So the floor here is memory bandwidth over the document, not the arithmetic §2 measured — which is
consistent with §2's own oddity that "walk to each price child, no number work" (8.9 ms) measured
*less* than `//car` (10.8 ms), i.e. those two rows were not measuring the same amount of pipeline.
**§2's ratios hold and its conclusions are unaffected** (decoding really is 22× and 7.7×; the
byte-level implementation really is the fast path); its absolute floor does not. Recorded because
the next person to measure this will otherwise think they have regressed something.

### Correction 2 — the facet cost is *not* mostly the allocation §7 identifies

§7 attributes the residual 113 ms to `attributesOf`'s three allocations per node visit, and that is
real. But with the allocations gone and the decode replaced by a byte comparison,
`//car[@vin="…"]` still measured **74 ms**, and a direct probe found where: **`attrStartOf` +
`attrEndOf` alone cost 43.8 ms** for 400,000 candidates — two binary searches per candidate over a
2,000,000-entry `attrOwner` table, ~42 random reads into 8 MB, essentially all cache misses. That is
larger than the allocation §7 blames, and it was present in `attrRangeOf` before this round too.

The fix is in `NodeStore.attrStartOf`/`attrEndOf`, which now take an optional **lower-bound hint**:
`attrOwner` is non-decreasing, so the answer is monotone in the node ref, and a caller walking
candidates in ascending order passes the previous range's end and gets a **galloping** search over
the gap — a handful of sequential reads — instead of a binary search over the whole table. The
predicate loop keeps the hint only while its candidate walk actually ascends and resets it to `0`
otherwise: a nested context set (`//a` inside another `<a>`, then a child step) can genuinely
produce a descending candidate, and too high a hint would return the wrong range silently. That took
the query from 74 ms to ~39 ms.

### The third cost, which no section predicted

The remaining ~9 ms was `startPathStep` copying an already-perfect `Int32Array` into a JS
`number[]`. For the one shape where the candidate set *is* already an `Int32Array` — single context,
descendant axis, resolved name, which is exactly what `//car[…]` is — the name index's zero-copy
`subarray` is now used directly, and `Int32Array.from` copies only when the result escapes. This
also took the **no-predicate** `//car` from 11.0 ms to 0.3 ms, because `Int32Array.from(number[])`
walks the iterator protocol where `Int32Array.from(Int32Array)` is a `memcpy`. A real, unrelated win
this round happened to find.

### What shipped

- **`src/core/path/xpathNumber.ts`** (new) — XPath 1.0 `number()` over a byte range, plus
  `bytesEqual`. Never builds a string on any path, including failure. Two scanners over one grammar:
  an ASCII-transparent one written with direct `bytes[i]` reads, and a UTF-16 one driven through a
  stride/offset helper (digits are ASCII in every encoding this app parses except UTF-16, which
  interleaves a zero byte). Splitting them was worth 3× on the ASCII scanner.
- **`parse.ts`** — `PathPredicate`'s `positional | facet` union is now `positional | comparison`.
  `car[@id="c-001"]` parses to `op: '='`, `subjectAxis: 'attribute'`, `literalKind: 'string'`; its
  *evaluation* tests pass **unchanged**, which is acceptance 4. Subject names resolve at parse time
  through the `NameResolver` `parsePath` already takes, `'unrepresentable'` included. Exponent
  notation is rejected **at parse time with an offset** rather than becoming a query that matches
  nothing.
- **`evaluate.ts`** — `startPathStep` returns a `PathStepJob` whose `advance(batch)` filters at most
  `batch` candidates; `evaluatePathStep` is the synchronous drive-to-completion form and every
  existing caller is unchanged. `PREDICATE_BATCH` is **512**, the middle of §6's measured 256–1,024
  band, and is not tuned further. The candidate loop allocates nothing: attributes are walked by
  index, children through `firstChildOf`/`nextSiblingOf`, the operator is an integer, and the string
  needle is encoded once per query from `SourceBuffer.encoding`.
- **`nodeStore.ts`** — `attrStartOf`/`attrEndOf`/`attrNameIdAt`/`attrValueStartAt`/`attrValueEndAt`,
  plus `valueStartOf`/`valueEndOf` (the same argument one level down: `valueOf` returns a `Span`
  object, which is an allocation per candidate). `attributesOf` and `AttributeRef` are untouched, as
  §7 says. **`src/core/types.ts` was not modified.**
- **`pathQueryJob.ts`** — one `runChunkedJob` step is now one predicate batch, so the scheduler reads
  the clock once per 512 candidates. G10's disclosed "not preemptible mid-step" finding is retired,
  and the module comment says so instead of disclosing it.
- **The Palette's grammar help** gained a `car[price>100]` row. It is the only place the query
  syntax is discoverable, and shipping a grammar nothing announces is half a feature.

### Tests

`test/xpathNumber.test.ts` (new) asserts §4's table case by case **including what `Number()` answers
for the same input**, so a row cannot quietly stop being a divergence. `test/pathEvaluate.test.ts`
gained the six operators against both subject axes on a hand-checked five-record fixture, asserting
the **exact id set** each returns rather than a count; the missing-subject rule (every operator
false, `!=` included) has its own test, as §10 asks. `test/pathQueryJob.test.ts` asserts R130 through
`runChunkedJob`'s own resumption over 400,000 candidates in a **single-step** query — a two-step
query would yield once between its steps even under the old shape and prove nothing — with
`performance.now` stubbed so the slice boundary is deterministic rather than a race with the host.
`test/pathPredicateBudget.test.ts` (new) holds the two wall-clock budgets and skips when the
generated fixture is absent, following `test/invariants.test.ts`'s precedent.

### Review pass — what it found

Four things, all fixed before the commit:

1. **A closure allocated per candidate.** `NodeStore.gallop`'s first draft carried its
   strict/inclusive choice into the loop as an arrow function — one allocation per candidate,
   breaking §9's own rule inside the code written to satisfy it. Replaced by an integer `limit`
   (owners are integers, so "`< owner`" is "`<= owner - 1`").
2. **A hint that could silently return the wrong attribute range.** The first draft assumed
   candidates always ascend. `startPathStep`'s child axis over a nested context set does not
   guarantee it, and a too-high hint is a wrong answer rather than a slow one. Now reset on any
   descending step.
3. **Module-level scratch slots standing in for a `Span`.** Workable but reentrancy-fragile, and
   they leaked between step jobs. Removed entirely; both offsets are locals now, with the rare
   lone-Text-child branch split into its own function.
4. **`advance` meant two different things after completion** — `completed()` answered once then
   `null`, the predicate job rebuilt its array on every call. Both now return the same array on
   every later call, and the interface says so.

Also checked and clean: no recursion over user input anywhere (parser, evaluator, `gallop` and
`subtreeEndRef` are all loops — invariant 4); no O(n) conversion in a hot loop, which is what
findings 1–3 above were each an instance of; and no decode of a document value on any path, which
grepping `source.slice` under `src/core/path/` confirms.

### One divergence recorded rather than unified

`gridSort.ts`'s `isNumericColumn` keeps JS `Number()`, per §8 — now written down as **D-085** in
`docs/DECISIONS.md`, because the two look like one function and the next person will try to share
them.

### Known limits, stated

- **Exponent notation is NaN** (§4's deliberate gap). `car[price>1e3]` is now a *parse error* with an
  offset, which is the friendliest form of that gap.
- **Numbers beyond 15 significant digits or a ±10^22 exponent** may differ from `parseFloat` by an
  ulp: the excess digits are truncated rather than fed through a big-integer rounding path, because
  the alternatives are a decimal-string round trip (which §9 forbids for a 22× reason) or a full
  Grisu inverse. Every value with ≤15 significant digits is correctly rounded and identical to
  `parseFloat`.
- **A string needle the document's encoding cannot represent** (`é` against a pure-ASCII code page)
  encodes to `null`, which makes `=` false and `!=` true for every value that exists. That is what an
  unequal needle would do anyway and it is XPath-correct, but it is silent rather than a diagnostic.
