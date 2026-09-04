# R134–R137 — XML namespaces: resolution that costs per *name*, not per node

<!-- status: built-caveat -->

**R134–R136 built; R137 not started — see the Owed table in `docs/TASKS.md` and §8's Results.**
Register: `docs/TASKS.md`. Namespace resolution — the second of the three items the XPath
sizing turned up, and the one CONCEPT already specifies in two places without any of it existing.
Sibling investigations: `docs/plans/R132-existence-predicates.md` (the third item, planned) and the
attribute-node question (deferred; §7 explains why this round settles part of it).

**The headline is a memory result, and it inverts the attribute-node conclusion.** Because §6.5
interns every name, resolution is a function of the **distinct name count**, not the node count.
The two corpora measured for R129 hold **8** and **10** interned names against 2,400,002 and 400,002
nodes. A per-name resolution table is **kilobytes**. There is no version of this that costs
megabytes, which is the opposite of what attribute nodes would have cost.

**Every question in this document is settled except one**, named in §7 and deliberately deferred.

---

## 1. What exists today: nothing, in three places that each imply otherwise

| Where | Says | Reality |
|---|---|---|
| `CONCEPT.md` §2 | *"The interned name is the qualified name as written; the prefix/local split is recorded on the intern table entry"* | `Interner` has `intern(source, start, end)` and `text(id)`. **No split, no URI.** |
| `CONCEPT.md` §6.5 | *"a second interned id for the resolved `(URI, localName)` pair used by grouping and query matching"* | **Does not exist.** |
| `FormatCapabilities.hasNamespaces` | `true` for XML | Nothing reads it for resolution. |

The XML parser *does* build a `prefix → URI` map — in `resumeContextFor`, reconstructed from
ancestor attributes, **only** for the incremental-reparse resume context. It is never consulted
during a full parse and never reaches the store.

And the gap is already documented as blocking a shipped feature, in `gridDetection.ts`:

> *"Namespace resolution is not reachable from `NodeStore` yet — `nameIdOf` returns the raw interned
> id of the local name as written, not a URI-resolved one. Using it here is a **known gap**."*

So this round has a customer before XPath ever arrives.

## 2. The use cases — an educated guess, stated as a guess

No real namespace-heavy corpus was available to measure here, so what follows is reasoned from the
formats that actually use namespaces (SOAP, XBRL, SVG, OOXML, Atom, XSD, Maven POMs, Android
layouts) rather than observed. **Where a use case turns out wrong, it should be cut rather than
worked around.**

| # | Use case | Why it matters | In scope |
|---|---|---|---|
| 1 | **Grid grouping keys on `(URI, localName)`** | CONCEPT §2: two sections using different prefixes for one namespace *"must group into one table, or the feature fails on exactly the documents that need it most"*. A SOAP envelope with `soap:` and a payload with `s:` is the canonical shape. | **Yes** — R136 |
| 2 | **Path queries match on the resolved pair** | `//inv:price` should find `//i:price` when both bind the same URI. Without it the query language quietly means "as spelled", which is wrong on precisely the documents namespaces exist for. | **Yes** — R137 |
| 3 | **Display keeps the prefix as written, tooltip shows the URI** | CONCEPT §2, so *"what the user sees matches what is in the file"*. Prefix-as-written already works (it is the interned name); the tooltip is new and small. | **Yes** — R136 |
| 4 | **XPath NameTests** | The later item. Needs exactly 1 and 2's machinery and nothing more. | Prerequisite only |
| 5 | `xmlns` shown as an ordinary attribute | CONCEPT §2 asks for it and it is already true — declarations are attributes and the facet table shows them. | **No change** |
| 6 | Namespace-aware **editing** (rewriting or adding prefixes) | Invariant 6: editing is byte-level in Raw. Nothing here changes that. | **No** |
| 7 | XPath's **namespace axis** | A third ref kind; see §7. | **No** |

## 3. The mechanism — per name, not per node

**A qualified name always carries the same prefix.** `inv:price` is one interned id; its prefix is
`inv` on every occurrence. So the question "what URI does name *n* resolve to" depends on the
prefix and on **which binding is in scope**, not on the node.

If a prefix has exactly one binding in the whole document — the overwhelmingly common case, and the
one every listed format above produces — then resolution is a **pure function of `nameId`**:

```
resolvedId: Int32Array   // indexed by nameId, sized by interner.size
```

Sized by the intern table: **8 entries on the R129 corpus, 10 on the attribute-heavy one**, and a
few hundred on a schema-driven document. Kilobytes, allocated once.

**R134** therefore does three things, all at parse time and all cheap:

1. The interner records each name's **prefix/local split** — a colon scan at intern time, once per
   *distinct name*, never per node. CONCEPT §2 already specifies this and it was never built.
2. The sink accumulates `prefix → URI` from `xmlns` / `xmlns:*` attributes as it descends (it
   already knows how — `resumeContextFor` does exactly this reconstruction; this is the same walk
   done forward, during parse, instead of rebuilt afterwards).
3. It interns each resolved `(URI, localName)` pair and fills `resolvedId[nameId]`.

**The one case this misses is a prefix rebound to a different URI** in different subtrees. That is
legal, does happen (a SOAP envelope whose payload redeclares), and makes resolution depend on
*position*, not just name.

**R135 is the fallback, and it is pay-per-use.** The sink already sees every declaration; noticing
that a prefix was bound to a second URI is a `Map` check. When — and only when — that happens, the
document also gets a **scope table**: `(startRef, endRef, prefixId, uriId)` rows. Resolution becomes
a range lookup instead of an array read.

**This is where the flat store pays off again.** Refs are contiguous in document order and
`subtreeEndRef` is O(depth), so a namespace scope *is* exactly a ref range — `[declaringNode,
subtreeEnd)` — and the table is naturally sorted, making lookup a binary search over a table with
one row per declaration, not per node. Documents with no rebinding never build it and never search
it; `resolvedId[nameId]` stays the whole answer.

## 4. R136 — grid grouping, and the display half

`gridDetection.ts`'s `GroupInfo.nameId` becomes the **resolved** id, closing the known gap its own
comment documents. Column headers keep displaying the prefix as written — they render from the
node's own `nameId`, not the group key, so this is a change to what groups *merge*, not to what is
shown.

The tooltip on a column header gains the resolved URI (CONCEPT §2's *"the resolved URI appears in
the header tooltip"*). One string, and it is the only way a user can tell **why** two differently
prefixed sections merged into one table — without it the feature works and looks like a bug.

**Two rows this changes that are worth asserting**: two sections with different prefixes for one URI
now produce **one** group; two sections with the *same* prefix bound to different URIs now produce
**two**. The second is the case R135 exists for and the one that would silently stay wrong if only
R134 landed.

## 5. R137 — path queries

`//inv:price` resolves `inv` against the document, then matches on the resolved pair — so it finds
`i:price` too when both bind the same URI.

**The prefix comes from the document, not from the query.** XPath takes prefix bindings from the
expression's own context (in XSLT, the stylesheet's declarations); a standalone viewer has no such
context, so the only sensible source is the open document. Consequences, stated because they are
surprising if discovered rather than read:

- A prefix the document never declares cannot resolve. It follows `NameResolver`'s existing
  three-way answer (`number | null | 'unrepresentable'`) — this is a fourth case, *"prefix not
  declared in this document"*, and it deserves its own diagnostic rather than folding into "no
  results", the same reasoning R53 gave for `'unrepresentable'`.
- With **R135's rebinding** in play, one query prefix can resolve to two URIs in one document. The
  honest behaviour is to match either — the user typed a prefix, and both bindings are what that
  prefix means somewhere in this file — with the diagnostic line saying so.
- An **unprefixed** name in a query matches an unprefixed name in the document. It does *not* pick
  up the default `xmlns` binding, because XPath 1.0 itself does not: an unprefixed NameTest matches
  no-namespace names only. Following XPath here rather than being helpful keeps R129 §4's rule that
  the two query languages cannot drift.

## 6. Non-functional expectations

- **Nothing here is per node — except R135's rebinding path, which is.** The colon scan is per
  distinct name at intern time; the resolution table is per name; the scope table is per
  *declaration*. In the common case an implementation that walks nodes to resolve names has taken
  the wrong shape. R135 is the deliberate exception, and it has its own bullet below.
- Full parse must not regress measurably. R129's corpora parse at 963 ms (46 MB) and 511 ms (44 MB);
  namespace accumulation is a `Map` write per `xmlns` attribute, which those corpora have none of —
  so **a namespace-free document must measure unchanged**, and that is the regression test.
- The scope table is built **only** when a rebinding is seen. A document with no rebinding must
  allocate no table at all, asserted directly rather than assumed.
- Resolution is consulted on the query hot path (R137), so in the common case it must stay an array
  read — `resolvedId[nameId]`, never a `Map` lookup inside a candidate loop.

### The rebinding path is per-node, and it is not measured

**This is the one number in this plan that is a guess, and it is written down as one.** Once a
prefix is bound to two URIs, a name's resolution stops being a pure function of `nameId` and starts
depending on the node's *position* — so the candidate loop can no longer read `resolvedId[nameId]`
and must do a range lookup into the scope table **per candidate**: O(log declarations) instead of
one array read.

The estimate is that this stays small — with ~50 declarations that is ~6 comparisons per candidate,
so single-digit milliseconds over the 400,000 candidates R129 measured against — but **nothing here
measured it**, and an unmeasured "should be fine" on a per-node path is exactly the shape R108 came
from (`docs/PLANNING.md` §3). So it gets a budget rather than an assurance, in acceptance criterion
12.

Two mitigations exist if the budget is missed, recorded so the round does not have to rediscover
them: resolve **once per (nameId, scope region)** rather than per node, since regions are few and
names fewer; or, if a document rebinds at all, fall back to resolving the whole query's target set
up front. Neither should be built speculatively.

### The colon scan must be capability-gated

`Interner` lives in `src/core/` and is shared by **every** format — JSON and TOML keys go through
the same `intern()`. A colon is an ordinary character in a JSON key, so an unconditional split
would read `"12:30"` as prefix `12`, local `30`: latent wrongness, plus a scan on every distinct key
in documents that can never have namespaces.

Gate it on **`FormatCapabilities.hasNamespaces`** — `true` for XML, `false` for JSON and TOML — and
never on a format id (invariant 8). This is exactly the capability's purpose, and R134 is the first
round to give it one.

## 7. The one deferred question, and what this round settles about it

The attribute-node investigation left a ref-encoding choice open: a one-bit tag (`node` /
`attribute`) is enough only if no *third* ref kind ever arrives, and XPath 1.0's **namespace axis**
is exactly such a kind — its members are namespace nodes.

**This round does not need namespace nodes**, and §2 puts the axis out of scope: every use case
above is answered by resolving *names*, which is what CONCEPT §2 and §6.5 actually asked for. So the
encoding question stays open — but it is now open with a much better prior: **the namespace axis is
the only remaining candidate for a third ref kind, and nothing in NodePad's own feature set wants
it.** It exists for XPath conformance alone.

Recommendation carried forward, not decided here: keep the encoding behind
`isAttrRef` / `attrIndexOf` / `attrRef` so it is one module's private business, and do not use bare
`~i` — `~0 === -1` collides with `NodeStore`'s own `NO_REF`.

## 8. Acceptance criteria

Fixtures: a namespace-free document (the regression baseline), a two-prefix-one-URI document, and a
one-prefix-two-URI document. None exists today; all three are small and hand-written, not generated.

1. **R134** — `inv:price` and `i:price`, bound to one URI, resolve to the **same** id; the interner
   reports their prefix/local split correctly, including a name with no prefix and a name containing
   a colon in a position that is not a prefix separator.
2. **R134** — a namespace-free document parses to the same store as today, and **measurably no
   slower**: same wall-clock budget shape as R110's regression test.
3. **R135** — the scope table is **not allocated** for a document with no rebinding, asserted on the
   store, not inferred from timing.
4. **R135** — with one prefix bound to two URIs, two same-prefix names in different subtrees resolve
   to **different** ids.
5. **R136** — two sections with different prefixes for one URI produce **one** grid group. (Fails
   today; this is `gridDetection.ts`'s documented gap.)
6. **R136** — two sections with the same prefix bound to different URIs produce **two** groups.
7. **R136** — the column header still displays the prefix **as written**, and its tooltip contains
   the resolved URI.
8. **R137** — `//inv:price` matches elements written `i:price` under the same URI.
9. **R137** — a query naming an undeclared prefix produces a `PathDiagnostic` saying so, distinct
   from "no results" and distinct from `'unrepresentable'`.
10. **R137** — an unprefixed query name does **not** match an element in the default namespace, per
    XPath 1.0. Asserted explicitly, because the opposite is the intuitive guess and would be a
    silent divergence.
11. 5 and 8 **checked to fail before the fix**.
12. **R135 — a wall-clock budget on the rebinding path**, in R110's shape: a fixture that rebinds one
    prefix, with a candidate set of at least 400,000, and a query over it completing in **under
    40 ms** — the same bound R129 set for a comparison predicate, since this is the same loop with a
    range lookup swapped in for an array read. **Report the actual number**, not just pass/fail: it
    is the measurement §6 says this plan does not have, and the round is where it gets taken.
13. **R134 — a JSON document's keys are not split.** A key containing a colon (`"12:30"`) interns
    with no prefix, because `hasNamespaces` is `false` — asserted on a JSON fixture, since the trap
    lives in shared `core/` code and no XML test can reach it.

## 8. Results

**R134, R135 and R136 built; R137 not started.** Implemented together with `docs/plans/R132-existence-predicates.md`
and `docs/plans/R138-boolean-predicates.md` in the same session but as a separate area of the
codebase (`Interner`/`NodeStore`/`gridDetection.ts`, not `core/path/`), so it lands as its own
commit.

**R134 — the prefix/local split and the per-name table**, exactly as designed: `Interner` gains a
`namespaces` constructor flag (`FormatCapabilities.hasNamespaces`, never a format id — invariant 8)
that gates a one-time colon scan per distinct interned name (`prefixOf`/`localNameOf`). `NodeStore`
accumulates `prefix → URI` scope as it descends (`attribute()` recognizing `xmlns`/`xmlns:*` by raw
byte comparison, the same technique `formats/xml/index.ts`'s own `resumeContextFor` uses, done
forward during a real parse) and resolves each element's own name to a small `resolvedId` at
`closeNode` — once its own scope, including any `xmlns` it declares on itself, is known to be
complete. Acceptance 1 (two prefixes, one URI, one resolved id), 2 (namespace-free parse
measurably unchanged, an A/B ratio test rather than an absolute-ms one — CI-hardware-safe), 4
(the `subjectNameId === null` shortcut generalizes) and 13 (a JSON key with a colon is never
split) all hold; `test/interner.test.ts` and `test/namespaceResolution.test.ts`.

**R135 — the rebinding fallback**: a document-wide `Map<prefix, lastUri>` flips `hasNamespaceRebinding`
the moment a second, different URI is seen for one prefix; `nsDeclarations` (one row per real
`xmlns` attribute, never per node) is collected unconditionally but the *scope table's* behavioral
signature — `resolvedNameIdOf` consulting it at all — only exists once rebinding is real (acceptance
3, asserted on the store directly). The range lookup (`resolveNamespaceLive`) is a **linear scan**
over `nsDeclarations`, not a sorted-table binary search the plan's own §3 sketched — a deliberate
simplification once it was clear `nsDeclarations` is sized by *declaration* count (the plan's own
"kilobytes… a few hundred on a schema-driven document"), where a linear scan and a binary search
are the same order of practical cost. **Acceptance 12's 40 ms budget was not measured** — no fixture
generator for a rebinding document at 400,000-candidate scale was built this round — recorded as an
Owed item rather than claimed, the same honesty `docs/plans/R138-boolean-predicates.md`'s own
acceptance 10 gap uses.

**R136 — grid grouping**: `GroupInfo.nameId` is now `NodeStore.resolvedNameIdOf(child)`, and
`gridColumns.ts`'s `collectGroupMembers` was updated to match on the same resolved id (a real bug
if left on the raw `nameIdOf` — found while implementing, not in the plan text, since the plan only
named `gridDetection.ts`). Column headers still render from a node's own raw `nameId` (`Grid.tsx`
unchanged there); the tooltip gains the resolved URI via a new `NodeStore.namespaceUriOfName`,
best-effort by design (one name id, no node context, so it cannot be position-aware — acceptable
for an informational tooltip, never consulted on a grouping or query path). Acceptance 5, 6, 7, and
11 (checked to fail first) all hold — `test/gridDetection.test.ts`.

**The one defect review found, not a test: namespace state did not survive the real worker round
trip.** `NodeStore.exportBuffers()`/`fromBuffers()` never carried the derived namespace-resolution
state (it isn't part of the tree's own shape), so `rehydrateParseResult` — what the actual app calls
after every worker parse — was reconstructing a store whose `resolvedNameIdOf` silently fell back to
the raw `nameIdOf` for *every* query, on *every* real document, namespaced or not. Every test up to
that point constructed its `NodeStore` directly and parsed into it, which never exercises
`fromBuffers` at all — exactly the "measured a component cleanly while the pipeline around it was
not" trap `CLAUDE.md` names four prior instances of. Fixed with a second, small transfer structure
(`NamespaceResolutionBuffers`, `NodeStore.exportNamespaceState`/`importNamespaceState`) threaded
through `ParseDoneMessage` and `parseClient.ts`, with a dedicated regression test driving
`runParseJob` + `rehydrateParseResult` together rather than a directly-constructed store. **The same
gap still exists on `subtreeSplice.ts`'s incremental-reparse graft path** (editing an already-open
namespaced document) — disclosed in `docs/TASKS.md`'s Owed table rather than fixed, since a correct
fix there needs to *merge* old-tree and new-fragment namespace state (including a graft that
introduces a fresh rebinding), which is a separate piece of work from the worker round trip.

**R137 — not started.** `//inv:price` resolving to match `//i:price` needs `core/path/parse.ts`'s
`PathStep`/`NameResolver` to carry a resolved key a candidate can match against several raw
spellings (not just one `nameId`), and `evaluate.ts`'s per-candidate loop to consult it against
`resolvedNameIdOf` — a real change to the query engine's matching contract, not an extension of
R134–R136's sink-side/grid-side work. Stopped and reported here rather than shipped half-built,
per `CLAUDE.md`'s own rule about a stated mechanism turning out to need more than the round budgeted
for.
