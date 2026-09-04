# R143 — YAML: what it actually costs, and the decisions it forces

<!-- status: built-caveat -->

**§2 (R143 itself) built — see §11's Results. Everything else in this document (§3–§10) is still
open investigation**, not implementation: `docs/TASKS.md`'s Owed table records this as "the rest of
the YAML round not started" rather than letting the single `built-caveat` marker imply more landed
than did. This is turn one of a planning session, not a finished plan: §3–§8 each end in a
recommendation that needs your yes or no, and §9 lists what nobody has measured.
**Implementation ids beyond R143 are not allocated yet** — they get allocated when §9's questions are
answered, so the range in `docs/TASKS.md` grows rather than being guessed at now.

`CONCEPT.md` §12 budgets M8 as *"its own milestone, deliberately… budget it comparably to the XML
parser, not alongside TOML."* That is the right instinct and this document does not argue with it.
What it does is separate the part that is genuinely hard (the parser) from the parts that only
*look* hard, and find the two places where §2's claim — *"the application requires no changes to
accept them, only a parser"* — is not quite true.

---

## 1. The claim under test

M6 existed to prove "adding a format is only writing a parser" before the expensive format arrived.
It proved it for TOML. **For YAML the claim holds for the tree, the grid, search, the query
language, the Raw view and the row index — and fails in exactly two places**, both found by reading
code rather than by reasoning about YAML:

1. **The shared splice graft accepts a `parseRange` result with more than one root and silently
   orphans nodes** (§2). Not a YAML bug — a live latent defect in `subtreeSplice.ts` that XML, JSON
   and TOML cannot easily reach and YAML reaches by pressing Backspace at the start of a line.
2. **A parser has no way to mark a node as an alias or attach a link to its anchor** (§4).
   `NodeFlags.IsAlias` exists and its comment says *"reserved for TOML/YAML anchors"*, but every
   flag in that enum is set by the **sink**, inferred from `openNode`'s kind or from an `attribute()`
   call. `NodeSink` has no method that a parser could use to set one. `CONCEPT.md` §4.2 nonetheless
   promises *"YAML alias nodes render as references and jump to their anchor on activation"*.

Everything else in this document is either a mapping that already works or a decision about scope.

## 2. R143 — the splice graft must refuse a multi-root reparse

**This is ready to build and does not depend on any YAML decision.** It should land first.

`decideSplice` (`src/renderer/session/subtreeSplice.ts`) validates four things: the format supports
incremental reparse, a containing node exists, `result.complete`, and `result.bytesConsumed ===
newSpanEnd`. **It never checks that the fresh parse produced exactly one root**, and the graft that
follows assumes it did — fresh ref 0 is written into `spliceNode`'s slot and given the old node's
parent and sibling links, while every other fresh ref is remapped relative to it.

**Demonstrated, not inferred.** A synthetic `FormatModule` whose `parseRange` emits two siblings
covering the target range (the exact shape a YAML outdent produces) was run through the real
`spliceSubtree`:

```
splice ACCEPTED a two-root parseRange result. Resulting store:
  ref=0 kind=0 parent=-1 firstChild=1 span=[0,9)
  ref=1 kind=1 parent=0  firstChild=2 span=[0,9)
  ref=2 kind=1 parent=1  firstChild=-1 span=[2,4)
  ref=3 kind=1 parent=-1 firstChild=-1 span=[4,6)
  ref=4 kind=1 parent=1  firstChild=-1 span=[6,9)
reachable from root: 4/5; orphaned refs: [3]
```

`ref=3` has `parent = -1`, occupies a real span, and **is unreachable from the root**. No
diagnostic, no failure, no fallback — a node that exists in the arrays and is invisible to every
tree walk, grid build and query. It is the R42/R100 failure mode again: the model and the bytes
disagree and nothing says so.

The existing `bytesConsumed` net does *not* cover this. It was added (correctly) for a fresh parse
that stops **short** of the range; a two-root parse consumes the range exactly. A TOML attempt to
reach the same shape by typing a second `[b]` header inside `[a]`'s span **was** refused
(`reason: 'malformed'`), which is why this has never been seen — the other three formats reach it
only through narrow paths, if at all.

**The fix is one check in `decideSplice`**, before the graft: every fresh ref other than 0 must have
a parent, or equivalently ref 0's subtree must cover `freshCount` nodes. On failure, return
`{ ok: false, reason: 'malformed' }` — the existing fallback-to-full-reparse path, which is already
correct behaviour for a structure-changing edit. Cost is O(1) if `NodeStore` can report its root's
subtree size, O(fresh nodes) otherwise, and fresh-node count is bounded by the spliced subtree, not
the document.

**Why this is R143 and not part of the YAML round.** It hardens three shipped formats against a
defect that produces silent tree loss, and a YAML round that also happened to fix it would bury the
one change that matters to documents people have open today.

## 3. The node model maps cleanly, and §3.2 already said so

| YAML | NodeKind | Notes |
|---|---|---|
| block/flow mapping | `Object` + `Property` children | as JSON |
| block/flow sequence | `Array` | scalar elements stay unnamed `Scalar`, per §3.2 |
| scalar value of a key | folded into the `Property`'s own value span | §3.2 names YAML explicitly |
| comment | `Comment` | `hasComments: true` |
| document stream (`---`) | children of the root `Document` | see below |

`CONCEPT.md` §3.2's folding rule already reads *"YAML and TOML follow the same rule when they
arrive"*, so the grid, `composite`, and the Detail view need nothing.

**Multi-document streams need no contract change.** A stream of three documents becomes the root
`Document` node with three children — the same shape a single-document file produces with one child.
`---` and `...` markers fall inside the following child's span. This works today with zero changes
anywhere.

**Decision needed:** the tree then shows three unnamed roots with no visible marker that they are
separate documents. Options are (a) leave it — the spans and the Raw view tell the truth; (b) name
them (`document 1`, …), which invents text that is not in the file; (c) a flag, which needs §4's
contract answer anyway. **Recommendation: (a) for the first round**, revisited if multi-document
files turn out to be common in practice. Multi-document YAML is overwhelmingly Kubernetes manifests,
where the child's `kind`/`metadata.name` is what a user actually navigates by, and that is already
visible.

## 4. Anchors, aliases and tags — the one real contract question

`&anchor`, `*alias`, `<<: *base` and `!!tag` have no home in the model. Three options.

**Option A — plain scalars, nothing special.** `*base` is a `Scalar` whose value span is the text
`*base`. Zero cost, zero new mechanism, and it is *honest*: the Raw view shows exactly that, and
NodePad's whole premise is showing the document as authored. **Loses `CONCEPT.md` §4.2's promised
jump-to-anchor**, and a reader of a heavily-anchored file gets no help at all.

**Option B — pseudo-facets through the existing `attribute()` call.** The parser emits `&base` as an
attribute named `anchor` with value `base`, `*base` as `alias`, `!!str` as `tag`. **Zero contract
change**: `attribute()` already takes four offsets, the sink already interns attribute names into
the shared table, and R131's accessors already read them allocation-free. `hasAttributes: true` for
YAML makes the Detail view's scalar-facet table show them. Jump-to-anchor becomes "find the node
whose `anchor` facet equals this `alias` facet" — a scan over the attribute side table, which is
fine for a one-off user-initiated jump and would never sit in a hot loop.

The objection is semantic: `hasAttributes` is documented as *"the scalar-facet table"*, and §2's
format table says YAML's scalar facets are *scalar entries*, not anchors. So B labels three
different things "facets". Against that: `Interner.splitsNamespaces` is already precedent for a
capability-gated behaviour inside `core/` that only one format uses, and the mechanism fits without
being bent — an anchor genuinely is out-of-band metadata attached to a node, which is what an
attribute is.

**Option C — extend the contract.** A `flag()` or `link()` method on `NodeSink`, plus an alias→ref
side table. Cleanest model, and **`CLAUDE.md` forbids doing it without reporting first**, which this
section is. It also costs a side table nothing else uses and a new concept (a node-to-node link) in
a store that deliberately has none.

**Recommendation: B**, with `hasAttributes: true`. It delivers §4.2's jump, needs no `types.ts`
change, and is reversible — if it reads badly in the Detail view, A is a subtraction, not a rewrite.

One concrete sub-item it forces, which is worth fixing regardless of the answer here:
`Detail.tsx:213` renders the facet section with a hard-coded `<h3>Attributes</h3>`. That is an
XML-specific word living above `src/formats/`, which is what invariant 8 exists to prevent — the
capability gates *whether* the table appears but nothing supplies its *label*. B needs a per-format
label ("Attributes" / "Anchors and tags"); A and C leave the existing wrongness in place for a
format that does not have attributes.

**Not in scope under any option: resolving aliases or applying merge keys.** `<<: *base` displays as
written. Expanding it would mean the tree shows keys that are not in the file, which contradicts
every other thing this tool does.

## 5. Block scalars: the value span stays the source text

A `|` block's logical value is not a contiguous byte range — the indentation of each line is
stripped and the chomping indicator decides the trailing newlines. So either the model stores
something that is not a span, or the value shown is the source text as authored.

**The precedent already exists and points at the second.** JSON's scalar value spans **include the
surrounding quotes** (`scanScalarToken` starts at the `"`), and escapes are never decoded —
`previewOf` slices bytes and collapses whitespace. So `"a\nb"` already displays with its quotes and
a literal backslash-n. The value span is the token *as written*, in every format, today.

**Recommendation: keep that rule for YAML.** A block scalar's value span is the whole block
including its indentation; `previewOf`'s existing `\s+ → ' '` collapse makes the Tree preview read
sensibly, and the Detail view shows the source. It costs nothing, contradicts nothing, and it is the
only option that keeps `<name>Golf</name>` and `"name": "Golf"` and `name: Golf` behaving
identically — §3.2's stated reason the folding rule exists at all.

**Stated honestly:** this is more visible in YAML than elsewhere, because a block scalar is the one
place where the source text and the value differ by a lot rather than by two quote characters. If it
reads badly once rendered, the fix is a display-layer concern (a Detail view that strips block-scalar
indentation for presentation), not a model change — and per `docs/PLANNING.md` §1 that decision
should be **rendered before it is settled**, not argued about here.

## 6. Incremental reparse is viable, and its fallback rate will be worse

`ResumeContext` is opaque and format-owned, so YAML's can carry what it needs: the **column** the
node starts at, whether the resume point is in flow or block context, and the enclosing block-scalar
state. Column is not in `AncestorView`, but `parseRange` receives `source` and can scan backward
from `start` to the line start — O(line length), which is the same order TOML's header re-scan
already costs.

**What is different from TOML is the fallback rate, not the mechanism.** Any edit that changes a
line's indentation changes which node it belongs to, and that is a structural change outside the
edited node — precisely §2's case. With §2's guard in place those edits fall back to a full reparse,
which is *correct* and, on a 200 MB file, slow. **State it as a non-functional expectation now**
(`docs/PLANNING.md` §3): a YAML round must measure what fraction of realistic edits fall back, and
the answer decides whether anything further is needed. Do not pre-emptively build an indentation-aware
splice; measure first.

## 7. Detection: a `.json` file is valid YAML, and must stay JSON

`selectFormat` takes the highest confidence over all modules and JSON returns **0.7 from content
alone** (leading `{` or `[`). Any YAML sniffer that also fires on `{` would be competing with that
on documents where JSON is plainly the better answer.

**Recommendation:** `.yaml`/`.yml` → 0.9, matching the other three. A leading `%YAML` directive or
`---` at the first non-blank, non-comment line → a moderate content signal. **Everything else → 0.**
No sniffing for `key: value`: it matches too much (including TOML-ish and plain prose), and the cost
of being wrong is a document parsed by the wrong module, which is far worse than a document with no
format that the user can be asked about. This keeps `.json`, `.toml` and extension-less JSON exactly
where they are.

## 8. The formatter should be `canFormat: false` in the first round

`CONCEPT.md` §5.7 already constrains it — *"block scalars carry significant indentation and are
never reflowed. Flow-vs-block style is preserved as authored"* — and once both of those hold, what
is left for a YAML formatter to do is normalize indentation width and inter-key blank lines.

**In YAML, re-indenting is a semantic operation, not a cosmetic one.** Getting it wrong reparents
nodes silently, which is the same silent-wrong-answer class as §2. The XML formatter's own history
here is the argument: R11 left it unable to report what it skipped, R18 was a stack overflow in it
at depth ~5000, and M5g was a performance round about it. **Recommendation: ship YAML with
`canFormat: false`**, which is a supported state in the contract, and revisit it as its own round
with its own acceptance criteria. Comments in YAML are load-bearing documentation (§5.3), and a
formatter that moves them is worse than no formatter.

## 9. What is not settled — the questions for the next turns

1. **§4 — anchors and tags: A, B or C?** This is the only one that touches the contract, and it
   gates the parser's sink calls, so it should be answered first.
2. **§3 — multi-document streams: leave the roots unnamed?**
3. **§8 — agree to `canFormat: false` for the first round?**
4. **How much of YAML 1.2?** A proposed subset, for you to cut or extend: block and flow
   collections; plain, single- and double-quoted scalars; `|`/`>` with indentation and chomping
   indicators; comments; `---`/`...`; anchors, aliases, merge keys and tags **parsed and displayed
   but never resolved**; `%YAML`/`%TAG` directives parsed and ignored. **Explicit keys (`? `) and
   non-scalar keys are the open cut** — they are rare, they are real, and supporting them means a
   `Property` whose key is itself a collection. The key *is* a contiguous byte range, so `openNode`
   can be called; what does not fit is that **the name would be interned**, and §6.5's whole premise
   is that names repeat massively (millions of `<car>` elements share one id). A multi-line unique
   key text per occurrence inflates the intern table with entries that are never compared equal to
   anything — interning's cost with none of its benefit. My inclination is to parse them, emit a
   diagnostic, and give the property a synthetic empty name; that needs your agreement because it is
   the one place the model genuinely does not fit.
5. **Does comment *attachment* (§5.3) belong to this milestone or its own round?** `types.ts` lists
   it under "deliberately NOT in this contract — shared infrastructure", so it is not YAML parser
   work at all; it is a shared feature YAML motivates. It should probably be its own range, before
   or after, but not inside.

## 10. What nobody has measured

Stated so that none of it gets quoted later as if it were known.

- **Node density and store size for YAML.** XML is ~32 B/node and JSON was measured at M0b; YAML has
  no figure. It should be comparable to JSON's, but "should be" is what §3.2 warns against.
- **Parse throughput.** YAML's scanner does more per byte than JSON's — indentation tracking, plain-
  scalar lookahead for `: `, context-sensitive plain-scalar termination. A 2–4× penalty against JSON
  would be unsurprising and would matter at 200 MB.
- **The §6 fallback rate**, which is the number that decides whether editing large YAML feels like
  editing large XML.
- **Parser size.** TOML is 1,757 lines, XML 1,234, JSON 756. A YAML parser meeting §9.4's subset is
  realistically **2,500–4,000 lines** — an estimate from those three and the grammar's shape, not a
  measurement, and the largest single piece of work in the project since M0.

## 11. Results — §2 (R143) only

**Built.** `decideSplice` (`src/renderer/session/subtreeSplice.ts`) now checks, after `parseRange`
returns and before the graft, that the fresh parse produced exactly one root: no fresh ref other
than 0 may have `parent === NO_REF`. On failure it returns the existing `{ ok: false, reason:
'malformed' }` — the same fallback-to-full-reparse path a broken edit already takes, so nothing new
was added to the failure surface, only a missing check on an existing one. Cost is O(fresh nodes),
the plan's own disclosed fallback to the O(1) option (a `NodeStore`-reported subtree size), which
was not built — fresh-node count is bounded by the spliced subtree, never the document, so this was
judged not worth the extra surface for a first pass.

Both `spliceSubtree` (the synchronous path) and `beginSpliceSubtree` (H2d's chunked path) share
`decideSplice`, so the fix covers both without duplication — asserted directly, one test per path,
in `test/subtreeSplice.test.ts`. The demonstration from §2 itself is reproduced through the real
`spliceSubtree`, not a synthetic model of it: a `FormatModule` built from real `xmlFormatModule`
with only `parseRange` overridden to open and close two top-level sibling nodes (no enclosing
frame, so both get `parent === NO_REF` in the fresh store — the exact orphaning shape). **Both tests
were checked to fail before the fix** (the guard temporarily disabled, the run showing the accepted
splice with an orphaned node, then restored) rather than trusted to be correct by construction.

Every pre-existing `subtreeSplice.test.ts`/`documentSession.test.ts` test — none of which reaches
the multi-root shape, per the plan's own observation that XML/JSON/TOML can't reach it or are
refused earlier as `malformed` some other way — passed unmodified, confirming the added check
changes nothing for the normal, single-root case.

**Review found nothing further to fix.** The equivalence the doc comment states ("no ref but 0 has a
parent" ⟺ "ref 0's subtree covers every fresh node") holds because fresh refs form a strict tree
with no cycles by construction (a parser's own nested `openNode`/`closeNode` stack discipline) — a
single other root would otherwise mean an unreachable component, never a second path to the same
node.
