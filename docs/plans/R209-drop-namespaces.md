# R209 — remove XML namespace resolution

<!-- status: built -->

**Built.** **Decided by the project lead after the alternatives were measured** (§ 3): namespace
resolution is removed rather than repaired. `inv:price` and `s:price` are two names now, as
written. Results in § 9; the decision and its measurements are D-101.

**An earlier draft of this plan proposed the opposite** — merging namespace state across the
incremental splice so resolution survived an edit. It was rewritten before reaching `main`, so there
is no separate document to look for. § 2 records why it was abandoned, because the reasoning is the
useful part and a plan that simply appeared as "delete it" would look arbitrary.

## 1. The defect that started it

Namespace resolution survives opening a document and does not survive editing one. Reproduced
against the real code, two prefixes bound to one URI:

```xml
<catalog xmlns:inv="http://ex.com/i" xmlns:s="http://ex.com/i">
  <inv:price>10</inv:price>
  <s:price>20</s:price>
</catalog>
```

```
BEFORE EDIT  inv:price -> resolved id 0     s:price -> resolved id 0     same? true
AFTER EDIT   inv:price -> resolved id 3     s:price -> resolved id 4     same? false
```

One character changed, nowhere near an `xmlns`. After the splice the store has forgotten namespaces
entirely and fallen back to raw name ids — silently, with nothing marked stale.

## 2. Why repairing it was abandoned

**The memory was never the problem.** R134 already made the state per-name and per-declaration:
`nsResolvedIdArr` is one `Int32` per distinct name, `nsDeclarations` one record per `xmlns`
attribute. Kilobytes.

**The problem is the shape.** It is derived state living *outside* `NodeStoreBuffers` that must be
hand-carried through every path rebuilding a store. There are two such paths and **both got it
wrong** — the worker round trip was caught in review, the splice is still broken. Two for two is a
design signal.

**And the repair had a trap.** Carrying the resolution cache across the graft cannot be built from
what the store exports: resolution is memoized by `` `${uri} ${local}` `` and only the URI half is
exported, so the key map cannot be rebuilt. A store mixing transferred ids with newly minted ones
would give one name two identities — the same defect, in a harder-to-see form.

**A third option existed and was not taken.** `xmlns` attributes are stored as ordinary attributes,
so declarations are recoverable from the buffers and the state could have been *derived on demand*
rather than transferred — removing the defect class while keeping the feature. It was rejected on
what the feature is worth (§ 3), not on whether it would work.

## 3. What the feature was worth, measured

**Three consumers, all in the Detail grid**: `gridDetection.ts:82`, `gridColumns.ts:88`, and one
header tooltip at `Grid.tsx:1036`. Nothing else — not the tree, not search, not path queries (R137
was never built). `prefixOf`/`localNameOf` have **no consumers outside the namespace code itself**.

**What it changes on screen**, measured through the real `detectGrid` on a merged feed — two
suppliers, two prefixes, one URI, three `a:item` and two `b:item`:

| | groups found | table rows |
|---|---|---|
| with resolution | one group of 5 | **5** |
| without | 3 and 2 | **3**, with the other 2 in the list beneath |

**The remainder is not lost.** D-014 renders non-winning children as a list below the grid, and
`Detail.tsx` implements it — the records are visible, split across two presentations instead of one
table.

**And the trigger is narrow**: it fires only when one document uses **two different prefixes for the
same URI**. One prefix throughout — the overwhelmingly common case — and resolution changes nothing
at all.

So the feature buys: a merged table instead of a table-plus-list, on documents that mix prefixes.
The price has been ~112 lines of `NodeStore`, an interner split with no other consumer, two Owed
entries, a README limitation, and a defect in both store-rebuilding paths.

**Decided: not worth it.** A tool premised on byte-faithful inspection showing `inv:price` and
`s:price` as the two names the file actually contains is defensible on its own terms, not merely a
retreat.

## 4. What comes out

| Location | Removed |
|---|---|
| `core/nodeStore.ts` | `nsResolvedIdArr`, `nsUriByResolvedId`, `nsResolvedKeyToId`, `nsDeclarations`, `nsAnyDeclarationSeen`, `nsHasRebinding`, `nsNextResolvedId`, `nsEnabled` |
| | `finalizeNamespace`, `resolveNamespaceKey`, `resolveNamespaceLive`, `recordNamespaceDeclaration`, `ensureResolvedIdCapacity` |
| | `resolvedNameIdOf`, `namespaceUriOf`, `namespaceUriOfName`, `hasNamespaceRebinding` |
| | `exportNamespaceState`, `importNamespaceState`, `NamespaceResolutionBuffers`, and `fromBuffers`'s fourth parameter |
| `core/interner.ts` | the prefix/local split — `splitsNamespaces`, `prefixOf`, `localNameOf`, `colonAt`, `findColon`, and the `namespaces` constructor argument |
| `worker/parse.worker.ts` | the namespace-state threading |
| `Detail/gridDetection.ts`, `gridColumns.ts` | `resolvedNameIdOf` → `nameIdOf` |
| `Detail/Grid.tsx` | the namespace-URI header tooltip |
| `formats/xml/index.ts` | `capabilities.hasNamespaces`, if nothing else consumes it |

**Check `hasNamespaces` before removing it from `FormatCapabilities`** — it is on the contract in
`src/core/types.ts`, which `CLAUDE.md` says not to modify without reporting. **If removing the field
is the right end state, stop and report rather than editing the contract.** Leaving a now-unread
field is the safe interim.

## 5. Rejected

**Deriving the state from the buffers instead** (§ 2's third option). It works and it removes the
defect class, and it would have been the recommendation if the feature were worth keeping. It is not
rejected as unsound — only as unnecessary once § 3 settled what the feature buys.

**Keeping resolution and fixing only the splice.** The original R209. It preserves the shape that
produced two defects in two paths.

**Keeping the tooltip.** Without resolution there is no resolved URI to show, and a tooltip that
printed a prefix's declaration would be a new feature, not a leftover.

**Removing the prefix/local split from `Interner` in the same commit as the rest.** It is a separate
`R` id's worth of blast radius (`exportBuffers` carries `colonAt`, and the worker rebuilds it). Do
`NodeStore` first, confirm the suite, then the interner — **review per `R` id**, per `CLAUDE.md`.

## 6. What this closes, and what it does not

**Closes** the Owed entry for namespace state across the splice, and **R137** — *"path queries
resolving a prefix against document declarations"* — which becomes not-applicable rather than
outstanding. Both README limitation bullets go.

**Does not close** the question § 3 exposed underneath it: a document whose composite children fall
into two groups shows one as a table and the rest as a list, and **that is true with or without
namespaces**. Dropping resolution makes it reachable more often; it did not create it. That is
`docs/plans/R210-grid-grouping.md`.

## 7. Acceptance

1. `inv:price` and `s:price` are two distinct names in the grid, **before and after an edit** —
   asserted through a real splice, the shape that hid the original defect from every test R134 wrote.
2. A single-prefix namespaced document renders exactly as it does today. **This is the case that
   must not regress**, and it is almost every namespaced document.
3. `NodeStore.fromBuffers` has no namespace parameter, and the worker round trip carries no
   namespace state.
4. `test/namespaceResolution.test.ts` is **rewritten to assert the new behaviour**, not deleted —
   the file is where a future reader will look to find out whether this was considered.
5. `docs/CONCEPT.md` §4.3's detection algorithm no longer keys on a resolved id, and D-013's
   "grouping keys on name alone" now means the raw interned name.
6. A decision entry records the reversal of R134–R136 with § 3's measurements, so the next person to
   propose namespace support finds the numbers rather than re-deriving them.
7. Both README limitation bullets are removed.
8. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 8. Version

**Ask on landing.** Candidate: **minor** — a deliberate, user-visible behaviour change, not a fix.
A document that showed one table will show a table plus a list. Recorded in § 10.

## 9. Results

**Built, in the two commits § 5 asked for.** § 4's inventory was accurate — every location it
named came out, plus three the plan did not list — and § 3's measurements held, so this section is
mostly about what was found rather than what was decided.

### What came out beyond § 4's table

- **`subtreeEndRefOf`** (`nodeStore.ts`). `resolveNamespaceLive` was its only caller — a local
  duplicate of `evaluate.ts`'s own subtree-boundary trick, kept local because `core/path/` depends
  on `nodeStore.ts` rather than the other way round.
- **`COLON`** (`interner.ts`), whose only reader was `findColon`.
- **`ParseDoneMessage.hasNamespaces`.** § 4 listed the worker's *namespace-state* threading but not
  this, and it is dead the moment the interner's flag goes: it existed solely to tell
  `Interner.fromBuffers` whether to recompute the prefix/local split.

### `FormatCapabilities.hasNamespaces` — reported, then removed

§ 4 said to stop and report rather than edit the contract, and `CLAUDE.md` says the same, so it
was reported unread and left in place. **The project lead decided to remove it** — *"if that is
not used anymore, we should not drag it around. If we re-introduce namespaces, we can always add
this back."* Gone from `src/core/types.ts` and all four format modules.

Two comments in the contract went with it, because they had become **false** rather than merely
unused: the `NodeSink` header calling namespace resolution the sink's responsibility, and the
"deliberately NOT in this contract" list entry claiming the sink recognizes `xmlns` attributes
and maintains scope. A contract file that describes a removed mechanism as a live obligation is
the same defect class this round spent three commits removing.

**A last piece of namespace machinery came out with it, in the parser rather than the contract.**
`XmlResumeContext.namespaces` — a `prefix -> URI` map `resumeContextFor` accumulated from every
ancestor's attributes on every resume — was **built and read by nothing**.
`R134-xml-namespaces.md` noticed exactly that when it planned to build on it, and R209 removed
the feature that would have. `xml:space` is what that function actually resumes, and it is the
only thing it does now. Not asked for specifically; done on the same stated principle and
recorded separately so it is easy to object to.

### Both fromBuffers parameters were optional, and that is the finding

`NodeStore.fromBuffers`'s fourth parameter and `Interner.fromBuffers`'s fourth parameter were both
**optional with a safe-looking default**. That is why the defect was invisible rather than loud:
`subtreeSplice.ts` omitting the first was not a type error, and it produced a store that worked in
every respect except the one nobody asserted.

§ 2 called the shape the problem and it was right, but the sharper statement is narrower: *derived
state reconstructed through an optional parameter*. Making it required would have turned both
defects into compile errors on the day they were written. The tests now assert arity on both
functions so a future optional parameter of that kind fails immediately.

### The tests were inverted in place, and two of them were wrong first

`test/namespaceResolution.test.ts`, `test/gridDetection.test.ts`'s R136 block and
`test/interner.test.ts`'s R134 block are all rewritten rather than deleted (acceptance 4), because
they are where the next person to propose namespace support will look.

**Three mistakes worth recording, all found by running rather than by reading:**

1. The JSON fixture filtered children by `NodeKind.Element`, which a JSON property is not — so it
   silently produced an empty list and asserted against garbage instead of failing. Exactly
   `CLAUDE.md`'s "tests that assert shape but not exact values", one level down: a *traversal* that
   quietly matches nothing is worse than an assertion that quietly passes.
2. The worker round-trip test passed one argument to a two-argument synchronous function and
   `await`ed the result. It ran correctly; only `tsc` caught it.
3. `expect(Interner.length).toBe(1)` — `Function.length` counts only parameters before the first
   defaulted one, so it reads 0 whether the constructor takes one optional parameter or three, and
   could not say what it was written to say. Removed rather than adjusted to match, since the
   compiler already gives the stronger guarantee. `fromBuffers` has no defaults and its arity
   assertion is real.

**One test now passes for a different reason than it used to**, and says so: two `p:car` groups
under different parents are separate because `detectGrid` groups one parent's own children, not
because their resolved ids differ. A test whose outcome survives a change to the mechanism it was
written for is worth annotating rather than leaving to look untouched.

### A CI failure this round did not cause, and one record it nearly orphaned

`windows-latest` went red after the contract commit, on `interner.test.ts`'s wall-clock budget:
**509.2 ms against `< 500 ms`**. It is not a regression. The same loop measures **82.7 ms before
R209 and 83.4 ms after** on one machine — the removed colon scan ran in `add()`, fifty times, and
was never in the hot path — and the previous CI run on this branch passed on a commit whose
successor does not touch interning at all.

`R183-ci-flakes.md` §6 forbids raising such a ceiling without a measurement, and §6's first
branch says what to do once the measurement clears the code: **the shape is wrong for CI, not the
constant.** So the test now asserts the algorithmic property instead — interning is a hash lookup,
so growing the distinct-name count 100× must not grow the cost per occurrence. Measured **1.48×**;
the mutation run (collapsing every hash into one bucket, so `intern` must scan candidates) takes it
to **89.3×** against a 5× bound. Both halves run back to back in the same test, so contention lands
on both. The absolute ceiling survives only as a catastrophe net.

**And investigating it found a record this round had already orphaned.** `docs/TASKS.md`'s Owed
table carried R185's *"the ceiling has a blind spot: a 2.7× per-node regression passes silently"*,
pointing at a wall-clock ratio test **in `test/namespaceResolution.test.ts`** — the file § 7's
acceptance 4 had this round rewrite. The test was deleted before anyone noticed the entry named it.
It closes here, and by removal rather than by repair: the entry said closing it needed *the
mechanism* asserted, that no per-node namespace work runs on a declaration-free document, and R209
removed the per-node namespace work.

### Acceptance

1. **Met.** `inv:price` and `s:price` are two names before and after a real `spliceSubtree` —
   the shape that hid the original defect from every test R134 wrote, since those built a
   `NodeStore` directly and the state only went missing on a path that *rebuilt* one.
2. **Met.** A single-prefix namespaced document is asserted to group exactly as before, in
   `gridDetection`. It never depended on resolution: one prefix resolved to its own raw name.
3. **Met.** `NodeStore.fromBuffers` takes three parameters, asserted on arity; the round trip
   carries no namespace state, asserted on the response object.
4. **Met**, above.
5. **Met.** `CONCEPT.md` §4.3 keys on the interned name id, and §2's XML-namespaces section is
   rewritten to describe what is true — with a paragraph saying it previously specified the
   opposite, since that section is the reason R134 existed. D-013's "grouping keys on name alone"
   now says which name is meant.
6. **Met.** D-101, with § 3's measurements.
7. **Met.** Both README bullets are gone.
8. **Met.** `npm test` 2127 passing, 5 skipped, 173 files; `npm run typecheck`, `npm run lint` and
   `npx stylelint` clean — exit codes captured directly.

### Review

Per `CLAUDE.md`, a separate pass against `git diff` before each of the two commits. It found the
three test defects above and one orphaned helper (`subtreeEndRefOf`) that grep for
`namespace|ns[A-Z]` did not, because its name says nothing about namespaces — a reminder that a
removal is bounded by *callers*, not by naming.

Two documentation gaps were found and fixed on the way, both pre-existing:

- **`DECISIONS.md`'s index table stopped at D-097.** D-098 through D-100 were added last round
  without indexing them — my own miss — and **D-094 and D-095 were never indexed at all**. All six
  are in now.
- Nothing else. `git diff` on the source was otherwise clean.

**Net:** 861 lines removed against 308 added, across both commits.

## 10. Version

**No bump** — the project lead's call, against §8's own **minor** candidate and the fourth
round running at 1.0.0.

Worth stating plainly, since this round is the first of the four that changes what an existing
document looks like on screen: an XML file mixing two prefixes for one URI showed one merged table
and now shows a table plus a list beneath it. That change is unreleased along with R199–R208, and
whenever a bump does happen it carries all of them — this and R202–R205' search behaviour are the two
parts that will need naming in a release note.
