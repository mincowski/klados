# R209 — namespace state does not survive an incremental splice

<!-- status: open -->

**Open.** The `R134–R137` Owed entry, planned. § 4 is the finding: the obvious fix — carry the
resolution cache across the graft and top it up — **cannot be built from the state the store
currently exports**, and the plan says so before anyone spends a day discovering it.

## 1. What the defect is

XML lets a document give its element names a prefix bound to a URI:

```xml
<root xmlns:inv="http://example.com/inventory">
  <inv:price>10</inv:price>
</root>
```

`inv:price` is not really named `inv:price` — it is named `price` **in** `http://example.com/inventory`.
The prefix is a local nickname, and the same document may use a different nickname, or rebind the
same one, for the same URI. R134–R136 taught the store to resolve that: `resolvedNameIdOf(node)`
returns a **document-wide identity for `(URI, localName)`**, so two sections using different prefixes
for the same namespace group together in the grid rather than appearing as two unrelated names.

**That resolution survives opening a document and does not survive editing one.**

Open a namespaced file and it resolves correctly. Type one character, and the incremental reparse
rebuilds the store **without** its namespace state — so `resolvedNameIdOf` silently falls back to the
raw `nameIdOf`, and from that moment `inv:price` and `i:price` are two different names again, until
the document is closed and reopened.

**Silently** is the operative word: nothing errors, nothing is marked stale, and the grid simply
regroups.

## 2. Why it happens

Namespace state deliberately lives **outside** `NodeStoreBuffers`. The buffers are the tree's shape;
this is derived per-name and per-declaration data, so it travels separately through
`exportNamespaceState()` / `importNamespaceState()`.

The worker round trip threads it through correctly — and even that was found in review rather than by
a test, because every namespace test up to that point built its `NodeStore` directly and never went
through the round trip.

The splice does not. `subtreeSplice.ts:514` and `:733`:

```ts
const finalStore = NodeStore.fromBuffers(request.newBytes, request.interner, finalBuffers)
```

No fourth argument. `fromBuffers`'s own doc comment names this gap explicitly, so the omission is
disclosed rather than accidental — it leaves the new store at "nothing declared yet", which is
exactly what `resolvedNameIdOf`'s first line tests:

```ts
if (!this.nsEnabled || !this.nsAnyDeclarationSeen) return nameId
```

## 3. What a merge actually needs

The graft is three contiguous segments, and `nsDeclarations` records
`{ declaringNode: NodeRef; prefix; uri }` — keyed by **node ref**, which the graft renumbers. So the
declaration list needs the same piecewise remap the graft already performs on every other ref:

| Old declaration at | Becomes |
|---|---|
| `declaringNode < spliceNode` | unchanged |
| `spliceNode <= declaringNode < boundary` | **dropped** — that node no longer exists |
| `declaringNode >= boundary` | `declaringNode + refDelta` |

plus the reparsed fragment's own declarations, offset by `+ spliceNode` exactly as `remapFresh` does.

**The fragment does record them.** Its store is built with `request.interner`
(`subtreeSplice.ts:449`), and `nsEnabled` is `interner_.splitsNamespaces`, so a namespaced document's
fresh parse populates `nsDeclarations` for the range it parsed. `anyDeclarationSeen` is then the OR of
the two sides.

**That much is mechanical** — the same arithmetic `graft` already applies to `parent`, `firstChild`
and `nextSibling`, over a list sized per *declaration* rather than per node.

## 4. The finding: the cache cannot be carried forward

The attractive design is to keep the fast path — carry `resolvedIdArr` across the graft, since most
edits touch no `xmlns` at all, and resolve only the fragment's new names. **It cannot be built from
what the store exports**, and the reason is worth stating precisely because nothing about it is
visible from the call site.

Resolution is memoized in two places that must agree:

```ts
private readonly nsResolvedKeyToId = new Map<string, number>()   // `${uri} ${local}` -> id
private nsUriByResolvedId: string[]                              // id -> URI
```

`exportNamespaceState` exports **`uriByResolvedId` only**. The key map is not exported, and
**`importNamespaceState` never rebuilds it** — after any transfer, `nsResolvedKeyToId` is empty while
`nsNextResolvedId` resumes past the transferred ids.

**It cannot be reconstructed either.** The key is `` `${uri} ${local}` `` and the export carries the
URI without the local name. The information is simply not there.

So a store that mixes **transferred** ids with **newly minted** ones would give the same
`(URI, localName)` two different resolved ids — and two identical names would group separately,
which is the defect this round exists to fix, reintroduced by its own fix.

### Why this is not a live defect today

Checked rather than assumed, because it looks like one. `resolvedNameIdOf` never mixes the two:

```ts
if (this.nsHasRebinding) return this.resolveNamespaceLive(node, nameId)   // live ids only
const resolved = this.nsResolvedIdArr[nameId]                            // transferred ids only
```

A rebinding document takes the live path for **every** name and ignores the cache; a non-rebinding
one takes the cache and never resolves live. One id space either way, so the empty key map is
harmless — **today**. It stops being harmless the moment a round tops up a transferred cache, which
is precisely what R209 would otherwise do.

## 5. R209

**Merge the declarations (§ 3), and take the live path for the rest.**

1. Export the old store's namespace state before the graft.
2. Remap `declarations` piecewise; append the fragment's, offset by `spliceNode`.
3. `anyDeclarationSeen` = old OR fresh.
4. **Do not carry `resolvedIdArr` across.** Hand the merged state over with the resolution cache
   empty and the store set to resolve live, so every id in the post-splice store comes from one
   space.
5. Pass the merged state as `fromBuffers`'s fourth argument at both call sites — `:514` and `:733`.
   **Both**: the chunked path is the one a large document actually takes, and it is the easier of the
   two to forget.

**The cost is the fast path, and it is affordable.** `resolveNamespaceLive` is a linear scan of
`nsDeclarations` per resolution — a list sized per declaration ("a few hundred on a schema-driven
document"), scanned only for names actually displayed, not for every node in the document. R135
already accepts exactly this cost for any document containing a rebinding.

**Correct-and-slower beats fast-and-wrong**, and today's behaviour is not merely slower — it is the
wrong answer with no indication it is wrong.

### The alternative, named rather than hidden

**Export the key map** — add the `(uri, local)` keys to `NamespaceResolutionBuffers` so a transferred
cache can be topped up. That preserves the fast path across both the worker round trip and the
splice, and it is a wider change: a new field on a transferred structure, a matching import, and the
worker path re-verified. **Worth doing if post-splice resolution ever measures too slow — and not
before**, since § 4 shows the current format cannot support the fast path at all, and a measurement
is what should decide it.

## 6. Non-functional expectations (`PLANNING.md` § 3)

- **The remap is O(declarations), not O(nodes).** `nsDeclarations` is sized per `xmlns` attribute;
  walking the node arrays to find declarations would make an edit cost document size and defeat the
  point of an incremental splice.
- **Nothing here decodes the document** (invariant 1). Declarations already hold their prefix and URI
  as short strings, captured at parse time.
- **No new object per node** (invariant 2). The merged list is the same shape as the one exported.

## 7. Rejected

**Carrying `resolvedIdArr` across and topping it up.** § 4 — not buildable from the exported state,
and it would reintroduce this round's own defect in a form that is harder to see.

**Reparsing the whole document after an edit.** Correct, trivial, and discards the entire reason
`subtreeSplice.ts` exists. R19's 12.6 GB hang is what incremental reparse is protecting against.

**Marking the document stale and asking the user to reopen it.** Honest, but it turns a fixable
internal gap into a permanent workflow cost, and the merge is O(declarations).

**Leaving it and documenting it better.** It is already documented — in `fromBuffers`'s doc comment,
in the Owed table, and in the README's own limitations list. **A user-visible wrong answer that three
documents apologise for is worth fixing rather than describing again.**

## 8. Acceptance

1. Open a namespaced document, edit it, and `resolvedNameIdOf` still resolves — asserted **through a
   real splice**, not against a directly constructed `NodeStore`. This is the specific gap that hid
   the worker-round-trip defect from every namespace test R134 wrote, and a test built the same way
   would hide this one identically.
2. Two sections using **different prefixes for the same URI** still group together after an edit.
3. A splice that **adds** an `xmlns` declaration inside the replaced range brings it into effect.
4. A splice that **deletes** the element carrying a declaration removes it — the dropped-declaration
   case in § 3's table, and the one a remap that only shifts refs would get wrong.
5. An edit **after** a declaration leaves it in force, with its `declaringNode` correctly shifted by
   `refDelta`.
6. The same assertions pass through the **chunked** splice path (`:733`), not only the direct one.
7. A document with a **rebinding** still resolves position-aware after a splice.
8. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 9. What this does not fix

**R137 — `//inv:price` matching `//i:price` in a path query — is a separate Owed entry and stays
open.** R209 restores namespace resolution to what it is on a freshly opened document; it does not
teach the query grammar to resolve prefixes against declarations. The README lists both, and only the
first is closed by this round.

## 10. Version

**Ask on landing.** Candidate: patch — restores documented behaviour after an edit; no new capability.
The README's limitations list loses an entry, which is the user-visible part.
