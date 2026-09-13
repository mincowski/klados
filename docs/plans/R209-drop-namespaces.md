# R209 — remove XML namespace resolution

<!-- status: open -->

**Open.** **Decided by the project lead after the alternatives were measured** (§ 3): namespace
resolution is removed rather than repaired. `inv:price` and `s:price` become two names, as written.

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
A document that showed one table will show a table plus a list.
