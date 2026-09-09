# NodePad — decision log

Settled decisions and the reasoning behind them. The purpose is to stop resolved questions
being reopened by accident, and to make clear when reopening one is legitimate.

Every entry records what was **rejected** as well as what was chosen — a decision without
its alternatives is just an assertion, and the alternatives are what make it reversible on
purpose rather than by drift.

Status: `settled` · `provisional` (awaiting measurement) · `superseded`

---

## Index

Entries below are grouped by area, so they do not run in numeric order — this is the lookup.
Search for the id to jump to one.

| | | |
|---|---|---|
| **D-001** | Electron + TypeScript, not C# / Avalonia |  |
| **D-002** | MIT, not Apache-2.0 |  |
| **D-003** | Flat parallel typed arrays, no object per node |  |
| **D-004** | Byte offsets in `Int32Array` |  |
| **D-005** | Interned names, not name spans |  |
| **D-006** | Row index in bytes, not characters |  |
| **D-007** | Editing only in the Raw view |  |
| **D-008** | Two write paths |  |
| **D-009** | Encoding preserved on save |  |
| **D-010** | Incremental reparse with a pending-delta list |  |
| **D-011** | One undo stack, owned by the document layer |  |
| **D-012** | Formatting is opt-in, never automatic |  |
| **D-013** | Grid grouping keys on name alone |  |
| **D-014** | Coverage is a floor, not a majority |  |
| **D-015** | Transparent wrappers are descended through |  |
| **D-016** | Literal vs. derived cells |  |
| **D-017** | Cell kind is per cell, not per column |  |
| **D-018** | Selecting a node shows that node |  |
| **D-019** | Tabs, but not a workspace |  |
| **D-020** | A unified path syntax, not per-format query languages |  |
| **D-021** | Search is per tab |  |
| **D-022** | XML and JSON first; TOML before YAML |  |
| **D-023** | Search ships before format breadth |  |
| **D-024** | Size limits are two-tiered |  |
| **D-025** | The format module contract is code, not prose |  |
| **D-026** | Command registry with surfaces |  |
| **D-027** | Fluent vocabulary, but a tight elevation budget |  |
| **D-028** | Themes are built in, not user-authored |  |
| **D-029** | Icon: amber N-node monogram on a lifted dark tile |  |
| **D-030** | A node carries its own scalar value; wrappers around a value are not modelled |  |
| **D-031** | The Raw View is windowed; there is no large-file threshold |  |
| **D-032** | Spans are absolute in the file as read; parsers skip the BOM |  |
| **D-033** | The command palette is built, not imported | `provisional` |
| **D-034** | A dedicated polish milestone, between M2 and M3 |  |
| **D-034a** | Tree row compaction is removed; single-child descendants auto-expand instead |  |
| **D-035** | Wrapper descent depth is a safety bound, not tuned to ~3 |  |
| **D-036** | Subtree splicing (F4) is not wired into the live reparse path |  |
| **D-037** | `FOLD_THRESHOLD` stays at 64, now for a measured reason |  |
| **D-038** | `Ctrl+F` opens document-wide Find; the grid's quick filter moves to `Ctrl+Alt+F` |  |
| **D-039** | The name index is rebuilt wholesale after a splice, not patched in place |  |
| **D-040** | Grid/Tree scroll frame time and wrap's first-paint cost stay unmeasured through a fourth milestone; M4's own "frame time during search" is a proxy, not the real thing |  |
| **D-041** | Search and query run chunked on the main thread, not in the worker |  |
| **D-042** | `evaluate.ts` keeps `number[]` step intermediates rather than reused `Int32Array` scratch | `provisional` |
| **D-043** | Streaming tree population is deferred; M5 spends itself on memory and responsiveness instead |  |
| **D-044** | The renderer owns the store and reads it synchronously; whole-document work is chunked, never relocated |  |
| **D-045** | XML formatting is not built in M5; `canFormat` stays `false` |  |
| **D-046** | A Transform above `TRANSFORM_CONFIRM_BYTES` is not undoable |  |
| **D-047** | H11 spike: go. A worker `fetch` on a custom protocol peaks at ~1× |  |
| **D-048** | H12 built: `document:read` replaced by token + protocol fetch |  |
| **D-049** | The manual grid/list override is removed; detection alone decides |  |
| **D-050** | Wrapper descent stays; the breadcrumb marks it and the Tree unfolds to it |  |
| **D-051** | One overlay scrollbar look across every pane (Tree, Detail, Grid, Raw) |  |
| **D-052** | Expand All / Collapse All act on the selected node's subtree |  |
| **D-054** | The title bar icon comes from the `.ico`, redrawn below 48px from `mark-16.svg` |  |
| **D-054a** | regeneration done; the rasterizer, the mark colour, and two title bars |  |
| **D-054b** | Every OS-facing raster is the tile again; the bare mark is renderer-only |  |
| **D-055** | The title bar is the toolbar; placement is by command scope |  |
| **D-056** | the title bar's "disabled, not hidden" needed a real registry gap closed |  |
| **D-057** | Format/Minify are *source-shape* commands; Format's button lives in Raw |  |
| **D-058** | D-045 reopened: XML formatting is built; `canFormat` is `true` |  |
| **D-059** | Redo stays; the undo bound moves from entry count to bytes |  |
| **D-060** | Memory moves off the status bar into a panel; no read-only badge |  |
| **D-061** | React's dev performance tracks are disabled; the props architecture is kept |  |
| **D-062** | Notifications replace the alert strip, which is deleted |  |
| **D-063** | R20 measured and closed as not worth doing |  |
| **D-064** | R24: the renderer spine is per-tab; `layoutStore` stays global |  |
| **D-065** | The initial selection is the wrapper-descent destination; comments still don't stop a descent |  |
| **D-066** | The grid's quick filter stays scoped to visible columns, and says what it excluded |  |
| **D-067** | The tab strip overflows into Firefox-style controls, shown only when it overflows |  |
| **D-068** | The grid's export distinguishes absent from present-but-empty, and classifies boolean columns exactly |  |
| **D-069** | The Raw view gets no "edit mode"; the `EditorView` stops being rebuilt instead |  |
| **D-070** | The pending-delta list is wired into the UI read paths |  |
| **D-071** | The grid derives its column widths and its height instead of hard-coding them |  |
| **D-072** | The lint gate ratchets on a stated warning count, rather than zero or an error severity |  |
| **D-073** | R26's `close`-interception is unit-tested against extracted logic, not through Playwright's `_electron` |  |
| **D-074** | `Interner.lookup` encodes a query by probing and inverting `TextDecoder`, not a new transcoding dependency |  |
| **D-075** | R59's zoom replaces R58's `did-finish-load` reset outright, rather than keeping both |  |
| **D-076** | R57's `info` severity keeps a sub-3:1 hairline and the plan's "background differs from the pane" test is scoped down, both disclosed rather than fixed |  |
| **D-077** | Dark elevation is carried by a border plus a small background step, not a large one |  |
| **D-078** | R62's grid header keeps F6/Ctrl+1/2/3 as the pane-focus model, and adds a header stop |  |
| **D-079** | R65's shortcuts panel reads `getAllCommands()` filtered by surface, not a second list |  |
| **D-080** | R70's Find bar anchors to `.layout`, not the viewport shell the plan named |  |
| **D-081** | `copyPathFor` always emits this app's own query grammar, not XPath or JSON Pointer |  |
| **D-082** | Find's byte/decoded case-fold divergence is accepted as-is; only the footnote changes |  |
| **D-083** | The current-match highlight is a ring, not a fill |  |
| **D-084** | A marker glyph's font is chosen per glyph string, not per surface or per format |  |
| **D-085** | `gridSort.ts` keeps JS `Number()`; the path query engine uses XPath's `number()` |  |
| **D-086** | The application is renamed **Klados**; `NodePad` is retired before the first push |  |
| **D-087** | The mark is a branching figure that reads as a logo, not a letterform with node dots |  |
| **D-088** | Grid detection's eligibility widens from "has children" to "has children or attributes" |  |

---


## Platform

### D-001 — Electron + TypeScript, not C# / Avalonia · `settled`

The codebase is AI-written, so the dominant factor is how well-represented the stack is,
not raw throughput. TypeScript + React + CodeMirror is among the most heavily documented
stacks in existence; Avalonia + TreeDataGrid is thin by comparison.

Avalonia's DataGrid was the specific blocker: Avalonia's own docs recommend against it and
point to TreeDataGrid, which moved under their commercial tier in October 2025. The grid is
NodePad's headline feature and polished UX is priority #1.

Rejected: C#/Avalonia; Tauri (a Rust toolchain plus an IPC boundary, on a project where the
author does not know Rust); native Qt.

Acknowledged cost: C# with `Span<byte>` parses perhaps 2–3× faster. That does not outweigh
an 80%-of-the-work UI advantage.

**Revisit if:** the M0a spike shows TypeScript parsing below 50 MB/s — but the answer then
is a WASM parser core, not a language change.

### D-002 — MIT, not Apache-2.0 · `settled`

An application rather than a library, so patent exposure is largely theoretical. Matches
every major dependency (Electron, CodeMirror, Fluent icons all MIT), stays GPLv2-compatible
which Apache-2.0 is not, and brevity lowers the contributor barrier.

**Revisit if:** corporate adoption behind legal review becomes a goal.

---

## Data model

### D-003 — Flat parallel typed arrays, no object per node · `settled`

A 500 MB document yields ~16.5 M nodes under D-030's modelling rules, or 48.9 M if every
text run is retained (measured, M0a). An object graph costs 5–10× the file size and drowns
in GC pressure; the flat store costs 38 bytes per node with none.

This is the decision that separates NodePad from the tools it competes with. XML Notepad's
maintainer has stated publicly that performance falls apart around 100 MB and the app would
need a redesign for larger files — its ~100 MB sample *loaded* in seconds, but Find and
subtree operations took minutes at under 10% CPU on a single core. That is the signature of
a DOM manipulated on the UI thread, and it is the failure being designed around.

### D-004 — Byte offsets in `Int32Array` · `settled`

Consequence: documents are capped at ~2.1 GB. This is a real architectural ceiling, not a
policy — raising it means Float64 or BigInt offsets throughout, which is a different design.
It is why the hard size limit is 2 GB rather than an arbitrary number.

### D-005 — Interned names, not name spans · `settled`

Millions of `<car>` elements share one name. Interning makes name comparison an integer
compare — the inner loop of both query evaluation and grid grouping — and the intern table
doubles as the search index. Replacing `nameStart`/`nameEnd` with a single `nameId` is also
a net saving of 4 bytes per node.

Attribute names are interned in the same table, for the same reason.

*Discovered while designing search; it turned out to matter more for the grid.*

### D-006 — Row index in bytes, not characters · `settled`

The row index serves virtualization only — mapping scroll position to a byte offset. It
needs to be deterministic and roughly uniform, not visually exact. Counting characters costs
a decode pass and still gives non-uniform width, since CJK and emoji render double. Actual
visual wrapping is left to the browser, which handles graphemes and East Asian width
correctly for free.

Row starts snap to character boundaries; a backward scan of up to 16 bytes prefers a break
character so tokens are not split mid-word.

Rejected: character counts; display-column counts; format-aware structural breaking. For
minified documents the Format command is the real remedy — the row index only has to stop
anything crashing.

### D-030 — A node carries its own scalar value; wrappers around a value are not modelled · `settled`

M0a measured pretty-printed XML at **10.7 bytes of source per node**, not the ~50–60 assumed
in §3.2 and §8. Whitespace-only text between elements is **40% of all nodes**; the sole text
child of a leaf element is a further 26%. At 200 MB that is 19.6 M nodes and a ~982 MB
footprint — 4.9× the file, against the ~2.5× §8 budgeted.

Two rules, applied unconditionally to all XML:

- **L1** — a whitespace-only text run between elements produces **no node**. A
  `droppedWhitespace` flag on the parent records that one was elided. Not applied inside
  `xml:space="preserve"`.
- **L2** — an element with exactly one text run and **no child nodes** writes that run into
  its own `valueStart`/`valueEnd` and produces no Text node. An element that has child nodes
  keeps its text runs as ordered Text nodes, so **mixed content is unaffected**.

One `<car>` record goes from 19 nodes to 7. At 200 MB the footprint returns to ~502 MB,
restoring §8's 2.5× rule of thumb and D-019's tab budget. Both rules are implementable in a
single streaming pass with one held span and one boolean per stack frame — O(depth), not
O(children).

Rejected: **keeping every text node** and revising the budget to ~5× — the draft of M0-PLAN
B9 that specified those nodes also said the flag existed "so higher layers can ignore it,"
conceding that 743 MB would be spent on rows every consumer then filters out.
**A cheaper side structure for whitespace** — it retains
positional data nothing reads, since `format?(source: Uint8Array, …)` takes bytes and
rescans, and Save writes the buffer. **A separate mode for mixed-content-heavy documents** —
L2 backs off automatically when child nodes are present, so there is nothing to detect or
switch on, and declaring mixed content unsupported would exclude SVG (named in
`types.ts`), XSLT and DocBook.

Precedent: XML Notepad defaults to hiding whitespace nodes and exposes "Preserve Whitespace"
as an opt-in. Its underlying `XmlDocument` retains *significant* whitespace, but significance
is defined by the DTD content model — NodePad has no schema layer by design (§1), so that
distinction is not computable for us, and is not computable for XML Notepad either on a
schemaless document.

Consequences: §2's "text content as a distinct child node" becomes conditional. XPath's
`text()` axis (post-v1) must synthesize a text node for folded elements — the element's value
span *is* the text node's span. `xml:space` scope must ride in `ResumeContext` alongside
namespace scope, so B9 tracks it even though M0 sets `canFormat: false`. **No change to
`src/core/types.ts`:** `value()` is already specified as content for the currently open node.

**JSON folds the same way** (added after the XML rules settled): a `Property` whose value is
a scalar carries it directly, with no `Scalar` child. A `Property` whose value is composite
keeps its child, and array elements cannot fold, so `Scalar` nodes survive only there.

Adopted for consistency more than for size. After the XML rules, folding one format and not
the other would leave `<name>Golf</name>` and `"name": "Golf"` with different shapes — which
breaks §2's unification claim exactly where a user would notice, in the grid, where an XML
column and a JSON column must be built by the same code. M0a measured node counts for XML
only; B13 should record the JSON figures so there is a baseline.

A consequence worth naming: `NodeKind.Text` now appears only in mixed content and
`NodeKind.Scalar` only as an array element. Both becoming uncommon is the intended outcome.

**Revisit if:** a consumer needs inter-element whitespace positions from the model, or
real-world documents measure materially less dense than the synthetic fixtures.

### D-032 — Spans are absolute in the file as read; parsers skip the BOM · `settled`

A byte-order mark is skipped by the parser, not stripped by the caller. The buffer handed
to `parse()` is the buffer read from disk, and every span indexes it.

M0b shipped two callers that disagreed. `inspect.ts` called `stripBom` and parsed the
stripped subarray, so its spans sat 3 bytes below the file's own offsets — B3 had said
plainly that spans must index the original buffer. `parse.worker.ts` did neither, so a
BOM'd JSON document produced two spurious diagnostics and a BOM'd XML document a phantom
`Text` node at span 0–3, silently.

Absolute-in-the-original is the only variant needing no correction term. Save writes that
buffer (D-007) and the Raw View windows it (D-031); a span off by `bomLength` from either
is a bug waiting for its first BOM'd file, and adding the offset back at each consumer is
the same fix applied N times and forgotten once. Strip-and-shift also puts a correction
into the window arithmetic of §4.4, which already has a documented trap around
non-integer offsets.

UTF-16 is refused rather than mis-parsed: both parsers are byte-oriented and assume an
ASCII-compatible encoding, and on UTF-16 input they currently emit a plausible tree built
from nonsense. A Fatal diagnostic with the encoding reported is §11.1's partial-document
path, not a violation of "parsers never throw."

**Revisit if:** a format arrives whose grammar makes a leading BOM significant, or real
UTF-16 support lands and needs the parsers to become encoding-aware.

---

## Editing

### D-007 — Editing only in the Raw view · `settled`

**The load-bearing decision.** Text becomes the single source of truth and the model a
derived projection, so the document is never regenerated from the model on save.

This eliminates the lossless-CST subsystem — the largest single cost in the project — and
makes fidelity a *property* of the architecture rather than a goal competing for effort.
Comments, key order, quoting style and indentation survive by construction.

Rejected: model-based editing with a CST for round-tripping.

**Never partially revert this.** A "small" save-from-model path reintroduces every problem
it removed.

### D-008 — Two write paths · `settled`

Save writes the byte buffer, byte-identical except where the user typed. Transform generates
new text from the model, is explicitly invoked, undoable, and visibly a rewrite.
Pretty-print, minify and format conversion are Transforms. Keeping them separate is what
stops the capability contaminating the normal save path.

### D-009 — Encoding preserved on save · `settled`

Detected on open, honouring the XML prolog over any heuristic. Never silently converted to
UTF-8. Where re-encoding an edit into a legacy code page would be lossy, the edit is refused
with an explanation rather than substituting characters — silent substitution would violate
D-007.

The mechanism is D-074's `encodeText` (`core/textEncode.ts`): built for `Interner.lookup`, wired
into the edit path by R125 (`R125-legacy-encoding-edits.md`), which also found this rule is
per-character, not per-encoding — a single-byte code page round-trips unless the specific text
being written has a character it can't represent.

### D-010 — Incremental reparse with a pending-delta list · `settled`

A full reparse per edit does not scale: 200 MB at measured throughput is ~1 s, so every
typing pause leaves the tree lagging. Subtree splicing handles reparsing; a short
`(position, delta)` list applied at span-read time handles offset invalidation without
rewriting millions of offsets.

Was `provisional` pending the M0a offset-shift probe, on the basis that a bulk shift under
50 ms would make the naive approach viable. It measured **51.4 ms** at the node count the
concept assumed — marginal — and **231.5 ms** at the density actually measured, since a real
500 MB document has 48.9 M nodes rather than 10 M. Four and a half times over the boundary,
so the marginal call disappeared. Cost is linear in node count at ~3.0 GB/s.

Note this stays true under D-030: at ~16.5 M nodes for 500 MB the shift is still ~78 ms.

**Still unmeasured:** §5.2 says M0a must also measure subtree reparse latency and the read
overhead of delta application. It did not — only the bulk shift was probed. Whether editing
a 200 MB file *feels* instant remains an assumption until M3.

### D-011 — One undo stack, owned by the document layer · `settled`

CodeMirror's history extension is disabled. Otherwise typing and Transforms accumulate in
two histories that desynchronise the first time a user does both — and under D-031
CodeMirror holds only a window, so its history could not cover an edit outside that window
even in principle. Every mutation is a patch against the byte buffer on one stack; entries
record selection, so undo restores where you were.

### D-012 — Formatting is opt-in, never automatic · `settled`

The Raw view always shows the actual bytes; its contract with the user is "this is what is
in the file," and the Tree and Detail views already provide the normalized representation.

Formatting is offered on open for minified files and can be enabled as a default, but saving
never reformats. Auto-formatting would produce whole-file diffs on one-value edits, which is
hostile for exactly the config files where NodePad is most useful.

It is also not universally *safe*: XML whitespace in mixed content is significant data, so a
correct formatter is necessarily conservative and partial.

**M0a nearly reversed this, then un-reversed it.** A2 measured a 100 MB single-line JSON
file at 179 ms p95 keystroke latency against 17.8 ms pretty-printed — a 10× cliff, which met
the plan's trigger for making Format-on-open mandatory and pulling it earlier in the
roadmap. A6 then measured the same file at **16.8 ms** once the editor is windowed (D-031):
the cliff was an artifact of loading the whole document, not a property of minified files.
Formatting stays a convenience, offered for readability, and stays in M5.

What did change: soft wrap is now *required* rather than optional for these documents, since
a single-line file has no vertical scroll surface and D-031's window advances on scroll.

---

## Views

### D-013 — Grid grouping keys on name alone · `settled`

An earlier draft folded attribute and child names into a shape signature. That splits
`<car>` elements into separate groups whenever one carries an optional field — fragmenting
exactly the table the feature exists to build. Optional fields should widen the column set,
not break it apart.

### D-014 — Coverage is a floor, not a majority · `settled`

An 80% threshold made a second qualifying group arithmetically impossible, since two groups
cannot both exceed 80%. Now ≥2 members and ≥5%, with the largest group rendering as a grid
and the remainder as a list. Multiple stacked grids deferred past v1.

### D-015 — Transparent wrappers are descended through · `settled`

`<cars><elements><car/>…` is ubiquitous. Selecting `cars` naively yields a one-row table
containing the word "elements". A node with exactly one composite child, no attributes and
no text is transparent; the view descends and shows the skipped path as a breadcrumb.

Deliberately narrow — a node with attributes *and* one child carries real information.

### D-016 — Literal vs. derived cells · `settled`

A cell either shows text appearing verbatim in the document, or text NodePad generated.
These must never look alike; a user who mistakes a summary for a stored value has been told
something false about their data. Derived cells are dimmed, with a badge or chevron.

Repeated scalars are dimmed too: an undimmed `Smith, Jones` is indistinguishable from a
single field whose literal value is the string `"Smith, Jones"`.

**Known gap:** CSV export loses this, since CSV has no styling. v1 copies displayed text and
accepts the imperfection.

### D-017 — Cell kind is per cell, not per column · `settled`

`<engine>` can be a nested object in one row and the plain string `petrol` in the next —
legal and common. Each cell is styled by its own kind; the header shows the widest kind
present.

### D-018 — Selecting a node shows that node · `settled`

Not the parent's grid with the row highlighted. Row highlighting would unify tree and table
navigation, but it makes drilling into an individual child awkward, and the tree is the
natural place to explore depth.

### D-035 — Wrapper descent depth is a safety bound, not tuned to ~3 · `settled`

M2-PLAN.md's own text estimated "~3" for D-015's descent limit, sized against Appendix A's
XML shape. Measured against the JSON equivalent of the same document (M2's E2): XML's
`garage → cars → elements` is 2 hops, but JSON's `garage → {cars → {items → […]}}` is 5,
because D-030's folding is asymmetric — a scalar Property value folds onto the Property, but
a composite one keeps a separate Object/Array node, so JSON's wrapper chain for a given shape
is always longer than XML's. A depth cap sized to feel right for XML silently truncates the
identical document's JSON descent partway through, which breaks D-030's own unification claim
for no reason the cap defends: each hop is O(1) (a wrapper has exactly one composite child by
definition), so there is no performance case for capping it tightly.

`resolveWrapperTarget` now stops only at the first node that isn't itself a transparent
wrapper. The `maxDepth` parameter is a safety bound against a pathologically deep single-child
chain (default 1000), not a UX limit — see `M2-RESULTS.md`'s E2 section for the measurement.

### D-049 — The manual grid/list override is removed; detection alone decides · `settled`

M2's E9 added a per-group override — a "Show as grid" / "Show as list" button in the Children
heading, backed by `gridOverrideStore.ts` and reachable from the palette as
`nodepad.grid.toggleView`. Removed at M5b, on the project lead's call, as visual clutter in a
pane whose header had just been stripped back for the same reason
(`docs/plans/UI-FEEDBACK.md`, "The Detail header repeats itself").

**All three go, not just the button.** Deleting the visible control while leaving the palette
command would leave a command that silently changes how the pane renders, with no affordance
and no indication of the resulting state — strictly worse than the button it replaced. So:
the button, `gridOverrideStore.ts`, and the command registration. No keybinding referenced it
and no test asserted on it, so nothing else unwires.

**What is given up, stated rather than glossed.** D-014's floor (≥2 members, ≥5% coverage)
means a single-occurrence child — `<cars><car/></cars>` — never qualifies as a grid, and E9's
override was the only way to force one anyway. After this, that document can only render as a
list. Accepted: a one-row grid shows a header and a single row, which tells a reader nothing
a list does not, and the column set it would display is exactly the field list the list view
already shows. The capability being removed is real but its value was near zero, and its cost
— a control on every Children section, present whether or not it would change anything — was
paid on every node.

**Rejected: keeping the command palette-only.** That is the "invisible state change" case
above. **Rejected: keeping the override but hiding the button behind a submenu** — the same
clutter argument applies one level down, and it preserves a code path (`gridOverrideStore`'s
per-group-name persistence) for a case nobody asked for twice.

**Revisit if:** real documents turn up where detection's answer is wrong often enough to want
a manual escape hatch. The honest fix then is to change detection (D-013/D-014's thresholds
are themselves flagged as guesses in §13's "Grid coverage floor"), not to re-add a per-node
override on top of a rule that is misfiring.

### D-050 — Wrapper descent stays; the breadcrumb marks it and the Tree unfolds to it · `settled`

`resolveWrapperTarget` (D-015, D-035) descends through transparent wrappers, so selecting
`garage` in a `garage → cars → elements → car…` document renders the Detail pane from
`elements`. The rule is right — the alternative is a one-row table containing the word
"elements", which is what D-015 exists to prevent — but nothing on screen said a descent had
happened, so the pane appeared to disagree with the Tree. Reported in
`docs/plans/UI-FEEDBACK.md`'s round 2.

**Chosen, two halves, neither of which adds a new UI element:**

1. **The breadcrumb marks the descent.** It already renders the full path. The segment the
   user actually selected renders in normal weight, the descended-through segments dimmed,
   and the destination emphasised — so `garage › cars › elements` reads as "you clicked here,
   you are seeing there". A CSS class and a `skipped`-membership test; no new chrome in a
   header that was deliberately stripped back.
2. **The Tree unfolds along the descent.** Selecting a wrapper expands exactly
   `WrapperDescent.skipped` — which `resolveWrapperTarget` already returns, root-first,
   including the selected node itself — so the destination becomes a visible row and the
   breadcrumb's path is legible as tree structure. **`skipped` is precisely the right set:
   expanding it reveals `destination` without expanding `destination` itself**, which matters
   because the destination is the node with the repeating children and may have millions of
   them.

**Expanding is not selecting.** The selection stays on the node the user clicked. This is
§4.4's "Navigating is not selecting" applied to the Tree, and it is what keeps D-034a's
promise that every level stays individually selectable.

**Rejected: moving the Tree selection to the destination.** The most principled option on
paper — §4.5 defines a single `{ selectedNode, caretOffset }`, and Detail rendering something
other than what that names is the actual inconsistency. Rejected because it makes a wrapper
node unselectable in the Tree, directly reversing D-034a, which was itself adopted in response
to feedback in this same file. Reversing a user-requested behaviour that recently needs
stronger evidence than one confusing case.

**Rejected: a "showing contents of garage › cars" line in the Detail header.** Explicit, but
it puts chrome back into the header that `docs/plans/UI-FEEDBACK.md`'s own header entry had just
removed, and the Tree half above conveys the same fact on a surface the user is already
reading. Kept as the fallback if the breadcrumb treatment tests too subtle in practice.

**One tension to record rather than discover.** D8 deliberately made single-click *not* toggle
expansion, because "a single-click toggle would reshape the tree under the pointer every time
you clicked through siblings to compare them in Detail" (`docs/plans/UI-FEEDBACK.md`). Half 2 does
reshape the tree on a single click. The scope is much narrower than what D8 rejected: it only
ever *expands* (never collapses, so it cannot flip-flop), only for a node that is a transparent
wrapper (a node with nothing of its own to show), and only along the chain that is already
being rendered elsewhere. Selecting an ordinary node changes nothing. A user who deliberately
collapses a wrapper and re-selects it will see it re-expand; expanding only when `selectedNode`
actually *changes* keeps that out of the common path.

**Do not unify this with `autoExpandChain`.** They look like the same mechanism and are not:
`autoExpandChain` (D-034a) requires exactly one child, while `wrapperCompositeChild` ignores
`Comment`/`ProcessingInstruction`/`DocType` children, so a wrapper carrying a comment — the
Appendix A shape, exactly — descends here and stops there.

### D-019 — Tabs, but not a workspace · `settled`

Several documents per window. No folder tree, no cross-file search, no project config.
Memory is the binding constraint at ~2.5× file size per document — measured in M0a, and true
only because of D-030 (without its text rules it is ~5×) and D-031 (without windowing the
editor's own copy adds another ~2.2×, which this figure silently excluded). All document
state is per tab; a small fixed worker pool rather than one worker per tab.

Tab names use **middle** truncation — end truncation discards the extension and version,
which are the most distinguishing part of a filename.

---

## Performance

### D-031 — The Raw View is windowed; there is no large-file threshold · `settled`

CodeMirror 6 is the editor at every file size, because it is never given more than ~1 MB of
the document at once — a window around the current position, sliced at row boundaries, with
absolute offsets reconstructed as `origin + localOffset`.

This replaces the tiered Raw View: two implementations behind an interface, switching to a
custom byte-based viewer above ~50 MB. M0a measured that premise wrong in both directions.
CodeMirror holds a 500 MB document at 17.5 ms p95 keystroke latency, so 50 MB was low by 10×;
but it *scrolls* that document at a 266 ms median frame, so simply raising the threshold
would have shipped a file that can be edited and cannot be navigated. Typing cost is
independent of document size; scrolling cost is not.

Measured at 500 MB, whole document → 1 MB window: open 2890 ms → **16.1 ms**; renderer
memory +1116 MB → **−3.1 MB**; wheel scroll p95 635 ms → **25.0 ms**; jump p50 395 ms →
**16.7 ms**; minified keystroke p95 179 ms → **16.8 ms**.

The cost is re-centring the window: **16.8 ms typical, 20.8 ms worst** — the vsync floor —
roughly once per 600 KB scrolled, against a quarter of *all* frames stuttering at 200 MB
whole-document.

Retires in one move: the size threshold, the second Raw View implementation, large-file
mode, the minified typing cliff (see D-012), the unbounded decoration set, the soft-wrap
threshold question, and CodeMirror's standing exception to the byte-buffer rule.

Rejected: **keeping the tier and re-aiming it at scrolling** — because CodeMirror edits fine
at 200 MB, a read-only viewer there is a regression, so the viewer would need real
single-span editing, reviving the open question the threshold result was meant to retire.
**Lowering the editing threshold to 200 MB** — gives up measured capability to preserve a
document's structure. **A scrubber alone with no windowing** — cheapest, but leaves 500 MB
unusable to scroll and keeps the editor's ~2.2× memory cost.

Consequences: a text selection cannot exceed a window, so `Select all`-style operations
become document-layer patches (§5.6) rather than editor selections. The window must never be
user-visible, which makes incremental re-windowing at the shared edge a requirement, not an
optimization. Soft wrap becomes affordable, and becomes mandatory for single-line documents.

**The re-window mechanism is part of the decision, not an implementation detail.** A
crossing dispatches exactly two edge changes — drop the front, append the back, shared
middle untouched — with no accompanying selection or scroll-into-view effect. CodeMirror
maps position through the change set itself. A full-window replacement stays as the
fallback for the no-overlap case (a large jump), never as the steady-state mechanism.

`settled` on A6 plus A6b. A6's own decision table returned "stop and report", but on bars
that were badly written — the re-slice bar was set below the harness's vsync floor, and the
crossing bar used p95 over 20 samples, which is the maximum rather than a tail. The median
crossing, 29.2 ms, was inside the bar. A6b then measured the two things A6 had inferred:
incremental edge patching drops crossing from 29.2/43.2 ms to **16.8/20.8 ms p50/max**, and
drift from ~32 bytes to **exactly 0** across 60 crossings — with *less* code, since the
manual repositioning A6 needed turned out to be what caused the drift. Soft wrap gives a
100 MB single-line document a genuine ~5,800-row scroll surface, at a one-off ~400 ms
first-paint cost. Every A6b bar passed.

**Revisit if:** M1 finds that viewport decorations push in-window latency off the floor.

> **Closed on M1 D15 (`docs/plans/M1-RESULTS.md`).** They don't. Same-process A/B on
> `cars-500mb.xml`, real `viewportDecorations` wired into a real `EditorView`: scroll p95
> 19.4 ms → 23.0 ms, crossing p95 17.9 ms → 18.7 ms, both configurations at 0% frames over
> 32 ms across 200 scroll frames. D15 also re-confirmed the window size itself at 1 MB —
> 256 KB performs about the same, 4 MB regresses crossing p95 to 45.3 ms with decorations on
> — so `WINDOW_BYTES` stays as shipped.

### D-039 — The name index is rebuilt wholesale after a splice, not patched in place · `settled`

M4-PLAN.md G1 named this as its own "real difficulty": `subtreeSplice` renumbers node refs
(a constant shift for everything after the edit), so `nameId → node refs` is not merely
stale after a splice but *wrong in a way that reads as plausible* — a stale ref could
silently point at the wrong node. Two options were on the table: patch the index in place
(shift refs ≥ the splice point by `refDelta`, drop and re-insert the edited range's own
entries) or rebuild it wholesale against the post-splice store.

**Chosen: rebuild.** `docs/plans/M4-RESULTS.md` §2–3 measured rebuild cost directly against the
splice it rides alongside, across the full fixture range (10–500 MB): **rebuild costs
roughly 8–12% of the splice's own cost, and the gap widens at larger sizes** (2.2 ms rebuild
against a 38.3 ms splice at 10 MB; 98.1 ms against 1177.4 ms at 500 MB). At that cost, a
patch could only ever save the ~90% that is already cheap — in exchange for a second,
ref-shifting algorithm with its own correctness surface, precisely the "wrong node ref
returned silently" failure mode G1's own plan text called out as worse than a slow search.

**Rejected:** patching the index in place. The complexity was judged not to earn its keep
against a measured rebuild cost this low, not because patching is impossible — `subtreeSplice.ts`
already computes the exact `refDelta`/shift information a patch would need, so the work
exists to be reused if a future measurement changes this calculus.

**Revisit if:** a future document density or editing pattern makes rebuild cost a
measurable fraction of the splice's own responsiveness budget (§13's ~100 ms bar) — nothing
in the current fixture range approaches that.

### D-040 — Grid/Tree scroll frame time and wrap's first-paint cost stay unmeasured through a fourth milestone; M4's own "frame time during search" is a proxy, not the real thing · `settled`

`M2-RESULTS.md`'s E10 and `M3-RESULTS.md`'s §2 both flagged the same gap: no harness exists
that mounts real React components (Tree's virtualized rows, Grid's virtualized cells) under
a real `requestAnimationFrame` loop — the M1 D15 harness (deleted at R155; results in
`docs/plans/M1-RESULTS.md`, raw output in `docs/spikes/raw-measurements.md`) drove a real
CodeMirror `EditorView` this way, but nothing analogous exists for React component trees.
M3-PLAN.md's own text called a third deferral "a decision rather than a consequence" and
asked for an explicit choice, recorded here rather than left implicit a fourth time.

M4-PLAN.md G10 asked for "frame time during search, under a real `requestAnimationFrame`
loop" — the same harness gap applies: there is no real `EditorView` + real rAF loop driving
a real Find-highlighted document to measure against. `docs/plans/M4-RESULTS.md` §5 measured the
closest honest proxy available instead — the real wall-clock interval between consecutive
slices of G3's actual `runChunkedJob`, via real (not faked) `setTimeout(0)` scheduling in
Node, over the two largest fixtures. That number (worst case 23.6 ms at 500 MB, comfortably
under the ~50 ms progress bar §6.6 sets) is evidence the *scheduler* behaves as designed; it
is not evidence about dropped frames in a real, painting browser window, which is what the
plan's own wording asks for.

**Chosen: accept the gap through M4, explicitly, rather than build the harness now.** What
is being accepted in exchange: Grid/Tree scroll frame time and wrap's first-paint cost
remain design-time claims (D11/D12) rather than measured facts, and M4's own search-path
frame-time claim rests on a scheduler-level proxy rather than real paint measurement. A
headless-but-real-paint harness (jsdom does not lay out or paint; this needs a real browser
automation surface or an in-process Chromium) is real, scoped work — not a tuning tweak
inside a measurement pass — and remains undone across four consecutive milestones' own
measurement sections.

**Revisit if:** a future milestone budgets this harness as its own scoped task, or a user-
reported scroll/search responsiveness complaint makes the design-time claim worth checking
against reality sooner.

---

## Search

### D-020 — A unified path syntax, not per-format query languages · `settled`

NodePad's proposition is one tool for every hierarchical format. A query language that
changes with the file undercuts that directly. Since the model is already unified, a unified
query costs nothing extra.

XPath 1.0 is offered *additionally* for XML, because users have existing expressions in
scripts and documentation they want to paste in. JSONPath is deliberately skipped:
standardized only recently (RFC 9535) after years of incompatible implementations, so it
does not name one agreed thing the way XPath does.

### D-021 — Search is per tab · `settled`

Searching all open tabs is the first step toward the workspace behaviour ruled out in D-019,
and tabs are independently opened files rather than a set.

### D-038 — `Ctrl+F` opens document-wide Find; the grid's quick filter moves to `Ctrl+Alt+F` · `settled`

M2b bound `Ctrl+F` to the grid's own quick-filter box (`89a0f94`) — reasonable at the time,
since nothing else wanted the chord. M4-PLAN.md G5 flagged the resulting collision
explicitly: two different operations (document-wide text find vs. narrowing one rendered
grid's own rows) cannot share one binding on the strength of "which pane has focus" without
becoming unpredictable — a `when`-clause dispatch would mean the same keystroke does a
different thing depending on where the caret happens to be, discoverable only by trying it.

**Chosen: `Ctrl+F` is document-wide Find** (`nodepad.find.open`), because it is the
conventional binding for "find" in essentially every text-editing tool this app's users
already know, and CONCEPT.md §8 frames search as the operation this project is most
concerned about getting right — it should own the expected key. The grid's quick filter
(`nodepad.grid.focusFilter`) moves to **`Ctrl+Alt+F`**, unclaimed and not a plausible
target for a `when`-clause fallback; both keybindings remain global (`keybindings.ts`'s own
rule that everything it knows about requires a modifier, never a bare printable key), so
neither depends on which pane has focus.

**Rejected:** binding both to `Ctrl+F` gated by focus. Two commands answering to identical
muscle memory differently depending on unstated state is exactly the "becoming
unpredictable" G5's plan text warned against — worse than either command simply moving.



### D-044 — The renderer owns the store and reads it synchronously; whole-document work is chunked, never relocated · `settled`

D-043's memory findings (open peak at 4.11× the file size) raised the obvious question: does
the *architecture* need to change to stop duplicating the document, rather than the two
specific copies being patched? Three routes were evaluated. This entry records the rule that
was chosen and, more importantly, why the two more ambitious routes were not — both are
reasonable enough to be re-proposed by someone who hasn't seen this.

**The rule.** The renderer owns the source buffer, the node store, the interner and every
index, and reads them **synchronously**. Any operation that touches the whole document is
**chunked** through `session/searchJob.ts` (`runChunkedJob` / `JobSlot`) so it yields to
paint — it is not moved somewhere else to make it someone else's blocking call. The parse
worker stays what it is: a place a *parse* happens, handing ownership back on completion.

This generalizes D-041 from search to everything, and it is what makes M5's H2b/H2c/H2d add
up to a coherent design rather than three unrelated patches.

**Rejected: `SharedArrayBuffer` for the store and source.**

The decisive fact is a platform one, not a preference: **`SharedArrayBuffer` does not cross
OS processes.** It shares memory between agents in one agent cluster — a renderer and its own
web workers. The Electron main process is a separate process with a separate address space,
so SAB **cannot touch the main↔renderer hop at all** — and that hop holds the *larger* of the
two measured double-holds (1055 MB in the main process alone on a 500 MB file). It would fix
`exportBuffers`, which H2c fixes for roughly ten lines.

Two further costs, recorded because they outlast the arithmetic. First, today's design has an
ownership rule the *platform* enforces: a transfer detaches the sender's copy, so two agents
can never touch the same memory. SAB replaces that with two agents able to read and write one
buffer concurrently, enforced only by discipline — a poor trade on a project whose most
expensive bugs have been ordering and state bugs (`documentSession`'s supersede race,
`childrenOf`'s unbounded walk). Second, it needs cross-origin isolation the app does not have
(`loadFile`, no COOP/COEP), and every growable array — `NodeStore`'s doubling, `Interner`,
`buildRowIndex`'s accumulator — would need a `maxByteLength` guessed before the node count is
known.

**SAB remains the right tool for the two things it was actually proposed for** — worker-side
search (D-041) and streaming (D-043) — and both of those revisit clauses stand. It is simply
not the tool for the memory problem, which is what it was being considered for here.

**Rejected for now, and recorded as the intended v2 direction: the worker owns everything,
and only display data is requested back.**

This is the correct long-term architecture for this class of tool, and it solves structurally
what the chosen rule only patches: the splice, grid column collection and search all leave the
main thread by construction rather than by each being chunked. It is not rejected on merit.

It is rejected on *sequencing*, for one concrete reason: it puts an **async boundary in front
of a data structure explicitly designed for synchronous reads**. `Tree.tsx` calls
`store.childrenOf(node)` inside render; the grid calls `cellOf` per visible cell; D-003's
whole argument is that these are integer compares with no allocation. Behind `postMessage`,
each becomes a message, a response and a cache — which means a batched windowed query API
("rows 400–460 with labels, kinds, child counts and previews"), prefetch, and placeholder
rows, plus reworking every view that reads the store. That is M1 and M2, i.e. most of the
codebase. It is a v2 architecture, not a milestone task, and adopting it *now* would also mean
designing its query protocol against memory behaviour that H2c is about to change.

**Adopted alongside, not in conflict with, this rule: H11's fetch-based read.** Having the
worker `fetch` the document over a custom protocol removes the main-process read entirely, so
the document materializes once in the process that parses it. It reduces duplication without
moving ownership, which is precisely why it survives this decision while the two routes above
do not. Spiked at the end of M5, gated on whether `Response.arrayBuffer()` peaks at 1× or 2×.

**Revisit if:** the fine-tuning pass after M5 finds that chunking a specific operation is not
enough — i.e. some whole-document operation cannot be sliced under a frame at all, rather than
merely being slow. That is the finding that would make relocation necessary rather than
merely tidier, and it is the honest trigger for the v2 direction above.

### D-043 — Streaming tree population is deferred; M5 spends itself on memory and responsiveness instead · `settled`

`CONCEPT.md` §3.4 has promised since M0 that the parse pipeline is *"streaming: emits nodes
as it goes… the tree becomes browsable before parsing completes, for very large files."* It
never has been, and M5 was the milestone scheduled to make it true. It will not.

**The project lead's call, and the reasoning is the decision:** a user opening a large file
can reasonably expect to wait a few seconds. Waiting is the *weakest* of the three problems
M5 could spend itself on, and it is the only one the user has already priced in.

**What the same review found instead, which is what makes this the right trade rather than
merely a cheaper one.** Measured through the real functions, sampling RSS between stages:
the open pipeline peaks at **822 MB for a 200 MB document (4.11×)** and **1922 MB for a
500 MB document (3.84×)**, against §8's ~2.5× budget — from two independent double-holds,
each inside a single process (`document:read`'s `readFile`-then-`.slice()`, and
`NodeStore.exportBuffers()` slicing all fifteen columns while the originals are still live).
Separately, every edit burst blocks the main thread for 1.48 s at 200 MB and 3.82 s at
500 MB (D-036's correction addendum).

Against those, streaming saves ~4 s **once**, at open. And it would have made the memory
figure *worse*, not better: route (a)'s checkpointed appends mean a second live copy of the
store region being shipped, on a pipeline already at 4×.

**Rejected: building streaming anyway and fixing memory afterwards.** The ordering matters
because streaming's own design (how often to checkpoint, how much to copy per checkpoint)
would have been tuned against a pipeline whose memory behaviour was about to change
underneath it.

**What is accepted in exchange:** §3.4's claim stays unfulfilled and `CONCEPT.md` should be
read as describing an intention there, exactly as §6.5's "the intern table is the name index"
did before M4 built it. §13's *"Streaming tree presentation"* question is deferred rather
than answered — no partial tree will exist, so there is nothing to present.
`NodeFlags.SubtreeComplete` (set at `closeNode` since M0) and `SearchResult.provisional` (G4)
remain unused seams. Both cost nothing to keep and are what a reversal would need.

**Revisit if:** `SharedArrayBuffer` is adopted for an independent reason — D-041's own
revisit clause names search wanting a worker home, and shared bytes would make streaming
nearly free rather than a seam change, flipping this calculation entirely. Or if real use at
500 MB+ shows the open wait is worse in practice than a lead's estimate of it, which is the
kind of thing only real use settles.

### D-041 — Search and query run chunked on the main thread, not in the worker · `settled`

**A deviation from `CONCEPT.md` §6.6**, which states: *"Queries run in the worker, against
the same store, so the UI never blocks."* That sentence does not describe the architecture
that exists, and M4 shipped against the architecture rather than the sentence.

**Why it cannot be done as written.** `parseInWorker` spawns a worker per parse, and the
`done` message *transfers* the store buffers, the interner buffers and the source bytes to
the renderer (`transferablesFor`). A transfer detaches the sender's copy, and the worker is
terminated immediately afterward. **After a parse completes there is no worker-side store
for a query to run against.** The three ways to change that, and their costs:

- **Transfer the store back per query** — detaches the renderer's copy for the query's
  duration, so the Tree and grid cannot render while a search runs. Unusable.
- **`SharedArrayBuffer`** — needs cross-origin isolation, which this app does not have
  (`loadFile` in production, no COOP/COEP headers), plus a review of every place the
  pipeline slices, grows or transfers a buffer. A real seam change, and M4 had no
  independent reason to make it.
- **Chunked, time-sliced work on the main thread** — chosen.

**§8's own requirement is the disjunction, not the worker:** *"Find, filter, sort and
expand-all must be tight loops over the typed arrays, and **chunked or moved off-thread** so
the UI never blocks."* Chunking satisfies it. `session/searchJob.ts`'s `runChunkedJob`/
`JobSlot` is the single seam every whole-document search operation goes through — G2's
scans, G8's path evaluation via `navigation/pathQueryJob.ts` — specifically so that moving
this work off-thread later is a swap behind one interface rather than a rewrite of every
call site.

**Rejected:** letting individual call sites reach for `setTimeout` directly. That is the
version of "chunked" that cannot later become "off-thread" without touching everything.

**What is accepted in exchange:** search competes with rendering for the same thread, and
`M4-RESULTS.md` §5 could only measure the scheduler's own inter-slice interval (worst case
23.6 ms at 500 MB) rather than real dropped frames — the same harness gap D-040 records.

**Revisit if:** `M5-PLAN.md`'s H1 adopts `SharedArrayBuffer` for the streaming parse. That
decision would give search the worker home §6.6 always described, at no additional cost —
which is why M4 deliberately did not pre-build for it and deliberately did not preclude it.

### D-042 — `evaluate.ts` keeps `number[]` step intermediates rather than reused `Int32Array` scratch · `provisional`

**A deviation from `CONCEPT.md` §6.6** ("Node sets are `Int32Array` of node indices
throughout — never materialized objects") and from M4-PLAN.md's own hard rule 2, which
sharpened it to *"allocated per step against a reused growable scratch buffer."*

What shipped: `evaluatePathStep`'s `matches`, `childMatches`'s return value,
`descendantMatches`'s wildcard branch and `applyPredicate`'s accumulator are all plain
`number[]`, converted to an `Int32Array` only at each step's boundary. The *step results*
that cross the public API are `Int32Array`, so the letter of "never materialized objects"
holds — a `number[]` of small integers is not an object graph — but the reused-scratch shape
is not there, and a step producing a very large intermediate (`//*` over a big subtree, or
any predicate step, which collects its full candidate set before filtering) allocates and
discards proportionally to the match count rather than reusing one buffer.

A second instance of the same shape, not previously recorded: `applyPredicate`'s positional
branch builds a `Map<parent, rank>` sized by *distinct parents*, so `//type[1]` on a
200 MB document allocates on the order of the record count in map entries.

**Provisional, not settled** — this is recorded as a known deviation awaiting measurement,
not as a decision that the deviation is right. `docs/plans/M4-RESULTS.md`'s review addendum states
why it was not fixed in that pass (correctness findings took the review's time budget first,
and this is a design-adherence and allocation-cost gap rather than a wrong answer). It is
listed here so it is not re-discovered as a surprise, and so the fine-tuning pass planned
after M5 has it in the one place that survives milestone boundaries.

**Revisit if:** the fine-tuning pass measures the allocation cost on a wildcard-descendant
or predicate step at 200–500 MB. If it is material, the fix is the scratch buffer §6.6
already specifies; if it is not, this becomes `settled` with the number attached.

### D-022 — XML and JSON first; TOML before YAML · `settled`

Adding a format requires only a parser — that is what the unified model buys. But it does
not make them equal work: TOML is cheap, YAML is the hardest of the four (anchors, aliases,
tags, block scalars, flow-in-block, multi-document streams, implicit typing, merge keys) and
gets its own milestone.

TOML comes first specifically as the **test that the abstraction holds**. If adding it
requires touching anything above the parser layer, the design has leaked — better discovered
on the cheap format.

### D-023 — Search ships before format breadth · `settled`

Contradicts the stated priority order, deliberately. Search is the operation that most
reliably makes tools of this kind feel slow, and the name index it depends on is load-bearing
for grid detection anyway. Shipping the store without validating the index is riskier than
delaying TOML.

### D-024 — Size limits are two-tiered · `settled`

500 MB soft cap, configurable, presented as a confirmation showing estimated memory — never
a refusal, because the real constraint is available RAM and someone with 64 GB should not be
told no by a constant. ~2 GB hard ceiling, refused, for the reason in D-004.

---

## Design

### D-025 — The format module contract is code, not prose · `settled`

An interface described in a document drifts from the real one within a week.
`src/core/types.ts` is the specification. Parsers push into a `NodeSink` with byte offsets
and never decode — a pull iterator would allocate an event object per node, ten million
allocations, exactly what the flat store avoids.

Resume context for incremental reparse is recomputed by walking ancestors rather than stored
per node, which would cost more than the node store itself.

### D-026 — Command registry with surfaces · `settled`

Every action is registered once with a `surfaces` list; palette, keybindings, command bar and
pane headers are all generated by filtering it. Cheap to establish, painful to retrofit, and
it is what makes keyboard parity automatic.

### D-027 — Fluent vocabulary, but a tight elevation budget · `settled`

Fluent's elevation language targets content-light apps; NodePad is data-dense, and every
elevated surface costs padding while padding costs visible rows. One elevated command bar
plus transient surfaces; the three panes stay flat. Row height 22–24px, not Fluent's 32–44px
touch-influenced defaults.

Elevation is a token *pair* (background + shadow) because shadow does not read on dark
surfaces — dark mode expresses depth as progressively lighter backgrounds instead.

Icons: Fluent UI System Icons, MIT, drawn separately at each size so 16px glyphs stay crisp.

### D-028 — Themes are built in, not user-authored · `settled`

Light and dark from day one, switchable via a palette command; no user themes in v1. Dark is
authored independently rather than derived by inversion, since accents need different
saturation and lightness to hold contrast.

### D-029 — Icon: amber N-node monogram on a lifted dark tile · `settled`

Amber rather than blue because a developer's dock is already almost entirely blue. Two nodes
at the traversal's turning points, not four at every vertex — four makes every vertex equal
so none marks anything, and the extra mass fills the letter's counters at 16px.

No gradient on the mark: invisible below 48px, discarded by the tray, and the most templated
look in software. Depth goes on the tile instead — a vertical lift plus a top-edge highlight,
which degrades to flat on its own at small sizes.

Light surfaces darken the amber to `#A9701E`; `#E9A33C` measures about 1.9:1 against the
light tile, under the 3:1 minimum for a UI element.

### D-034 — A dedicated polish milestone, between M2 and M3 · `settled`

The roadmap had no milestone about how the application looks and feels, and icon
integration proved it: `Command.icon` is typed `IconRef = string` with a comment deferring
to "the icon component once one exists", M1's D8 wants a per-node-kind icon, and everything
in `assets/README.md` — the title bar, the application icon, the Regular/Filled state pair —
has no consumer at all. Half-specified across two milestones and owned by neither.

**M2b**, keeping the letter-suffix convention M0b/M0c established, so nothing downstream
renumbers. Placed after M2 because that is the first build worth showing anyone, and
placed before M3 because editing adds chrome that should follow settled conventions rather
than be retrofitted into them.

**Bounded on purpose.** "Polish" is the one milestone name that never says no to anything,
so it takes a fixed entry list plus `docs/plans/UI-FEEDBACK.md`, and anything larger than about a
day spins out as its own item rather than growing the milestone. It also does not replace
per-milestone close-out: §9.6's theme checks are a per-task discipline, and deferring them
to one pass is how dark mode rots.

**Revisit if:** M2's grid turns out to need its own visual language settled before it can
be built, which would pull the token and density work earlier.

### D-034a — Tree row compaction is removed; single-child descendants auto-expand instead · `settled`

M2b's first `docs/plans/UI-FEEDBACK.md` entry reversed a settled decision (M2-PLAN.md E2, formerly
recorded against CONCEPT.md §4.3): compacting `garage → cars → elements` into one row saved
clicks but made every folded ancestor unselectable and unlabeled on its own — the opposite of
what the Tree, a structure view, is for. The Detail view's own transparent-wrapper descent
(D-015) stays exactly as it was; the two mechanisms address different panes and only one of
them turned out to be wanted.

**Replacement:** expanding a node also expands every descendant reached through an unbroken
chain of single-child nodes, down to the first node with zero or more than one child
(`autoExpandChain` in `treeModel.ts`), bounded by `MAX_AUTO_EXPAND_DEPTH` (1000, the same
order of magnitude as D-035's `DEFAULT_WRAPPER_DESCENT_DEPTH`). Every level is still its own
row, individually selectable and its own `aria-posinset`/`aria-setsize`. Collapsing the node
hides the whole chain without needing to separately track or discard the chain's expansion
state — `buildVisibleRows` already stops recursing at the first node absent from `expanded`,
so re-expanding restores the same view, giving "collapse as one unit" for free rather than as
extra bookkeeping.

`treeCompactionStore.ts`, `buildCompactVisibleRows`, `CompactedTreeRow` and the
`nodepad.tree.toggleCompaction` command are deleted rather than defaulted off — the setting
existed to make compaction optional, and there is no reason left to keep two code paths once
the default nobody chose is also the only one anybody wants.

### D-033 — The command palette is built, not imported · `provisional`

§10.1 named "`cmdk` or equivalent" to avoid rebuilding fuzzy-match UI. On inspection the
trade is worse than it looks. `cmdk` is 82 KB and MIT, but it pulls four Radix packages,
and `@radix-ui/react-dialog` alone pulls fifteen more — roughly twenty-five packages
transitively, more than doubling M1's runtime dependency tree for a filtered list.

The shape is also wrong. D-026 requires the palette to be *generated from the registry*
with `when`-clause filtering, recency ranking, and three prefix modes (`>` commands,
`@` jump to node, `:` go to position). None of that is cmdk's model and all of it would be
fought in. What is genuinely reused is fuzzy matching and roving focus — on the order of
200 lines over an array that already exists.

M1's full runtime set is therefore eleven packages, all MIT, from three direct choices:
React, CodeMirror 6 (`state` + `view` only), and `@tanstack/react-virtual`.
`@codemirror/commands` is excluded for the same reason at smaller scale — it depends on
`@codemirror/language` and `@lezer/common`, an entire syntax-tree layer NodePad does not
use because decorations come from its own parse tree (§4.4), and M1's read-only editor
needs none of the editing commands it exists to provide.

**Provisional** pending the user's sign-off on the dependency table in `docs/plans/M1-PLAN.md`,
and pending a genuine attempt at D5. If building the palette proves materially harder than
estimated, reversing this costs nothing that adding cmdk now would have saved.

**Revisit if:** the prefix modes or recency ranking turn out to be the easy part and the
keyboard and focus handling the hard part — that is the case where a component library
earns its tree.

### D-036 — Subtree splicing (F4) is not wired into the live reparse path · `settled`

M3-PLAN.md F10's measurement pass (`docs/plans/M3-RESULTS.md` §0) found that `spliceSubtree`
(F4) — correct, tested against a full-reparse equivalence oracle, and measured 4–7× faster
than a full reparse at every size from 10 to 500 MB — was never actually called by
`documentSession.ts`'s `runReparse`. Every real edit, undo, redo and external-change reload
paid a full reparse, unconditionally: **8.9 s at 500 MB**, not the ~1.2 s `spliceSubtree`
measures when actually used.

**Closed**: `runReparse` now tries `spliceSubtree` first (`trySpliceReparse`), falling
through to the existing full-reparse-via-worker path whenever splicing isn't attempted
(nothing tracked as dirty, an unsupported format) or doesn't succeed (`spliceSubtree`'s
own `'malformed'`/`'no-containing-node'`/`'unsupported'` refusal). `documentSession.ts`
tracks the union of edited regions since the last successful reparse
(`recordEditForSplice`, called from `applyEdit`) in that reparse's own store coordinates —
`spliceSubtree`'s own `dirtyStart`/`dirtyEnd` contract — handling edits within one
debounced burst landing in any order (forward-sequential, a backward cursor jump, or
overlapping), not just the common sequential-typing case. Undo/redo's own patches don't go
through `applyEdit`, so they're deliberately excluded from splice eligibility (the tracked
dirty range is cleared before their own forced reparse) — always a full reparse, unchanged
from before this closed.

**The revisit clause below turned out not to apply**: no separate debounce/abort handling
was needed — `trySpliceReparse` runs synchronously inside the same `runReparse` the
debounce already calls, and a splice failure just falls through to the untouched
full-reparse code in the same function call.

**What this does trade off, recorded rather than silently accepted:** `spliceSubtree` runs
synchronously on the *main thread* — unlike a full reparse, which always goes through
`parseInWorker`. Its own worst-case measurement (~1.2 s at 500 MB) is a brief main-thread
block, not the non-blocking-but-much-slower alternative a full reparse already was. A
worker-based splice was considered and set aside for this pass: `spliceSubtree`'s own
contract requires reusing the *same* `Interner` the old store uses (that's what makes
splicing avoid remapping names at all), and a full reparse's worker path constructs a
fresh interner per parse with no shared state — transferring interner state to a worker
for every splice is real, separate protocol design, not "swap which function runs." For
documents at the sizes this app is mainly used for (well under 500 MB), a sub-second,
occasional main-thread block reads as more responsive than an off-thread multi-second one;
worth a real measurement of frame impact if that assumption is ever challenged.

**Original revisit clause, superseded by the above:** ~~wiring `spliceSubtree` into
`runReparse` turns out to need more than swapping which function `runReparse` calls — e.g.
if the fallback-to-full-reparse path... needs its own debounce/abort handling distinct
from what `runReparse` already has for the always-full-reparse case.~~

> **Correction on the M5 planning review: the "~1.2 s at 500 MB" figure above is the
> `spliceSubtree` component alone, not the main-thread block this decision actually bought.**
> `trySpliceReparse` (`documentSession.ts`) also rebuilds the row index, the line index and
> the name index — all three over the **whole document**, all three synchronously, on the
> same main thread, immediately after the splice returns. M3-RESULTS §1 timed `spliceSubtree`
> in isolation, so none of that appears in its table. Measured directly against the same
> fixtures and the same one-byte-deeper-leaf edit shape:
>
> | Fixture | `spliceSubtree` | `buildRowIndex` | `buildLineIndex` | `buildNameIndex` | **Real block** |
> |---|---:|---:|---:|---:|---:|
> | `cars-200mb.xml` | 501.9 ms | 887.9 ms | 34.4 ms | 51.7 ms | **1476.0 ms** |
> | `cars-500mb.xml` | 1299.1 ms | 2315.1 ms | 94.3 ms | 113.8 ms | **3822.3 ms** |
>
> **The splice is 34% of its own cost at both sizes; the row-index rebuild is ~60%.** The
> decision itself still holds — 1.48 s beats the ~2.9 s full reparse it replaced, and the
> splice is genuinely `O(subtree)` — but the number it was recorded against understated the
> block by 3×, and the dominant cost is not the thing this decision is about. This is the
> same shape as M2's `isNumericColumn` finding and M0's row-index pre-scan claim: a component
> was measured, the pipeline around it was not.
>
> **The row index does not need a full rebuild after a splice** — a splice knows its byte
> range and its `delta`, so rows before the edit are unchanged, rows after shift by a
> constant (`core/deltaList.ts`'s `fold` is exactly that operation, and is still unwired per
> D-037), and only rows overlapping the edited range need rebuilding. `M5-PLAN.md`'s H2b owns
> this; until it lands, every edit burst on a large document blocks the UI for the figures
> above.

> **H2b closed.** `core/rowIndex.ts` gained `incrementalRowIndex`: rows before
> `dirtyStart` are copied verbatim (`.set()`, not pushed one at a time — an earlier version
> of this function pushed the whole unaffected prefix/tail through `GrowableInt32`, which
> cost as much as the full rebuild it was meant to avoid once "unaffected" meant "millions of
> rows"), rows from `dirtyStart` onward are re-scanned with the same per-row cutting rule
> (`nextRowStart`, factored out of `buildRowIndexUncapped`) until a produced row start lines
> back up with an old one at or past `dirtyEnd`, and everything after that point is copied
> with a constant `+ delta` shift. Falls back to scanning to EOF (still correct, just without
> the saving) if realignment never happens — the case for an edit very close to the end of the
> document. `buildLineIndex` and `buildNameIndex` are unchanged (still full rebuilds, per
> D-039 and this file's own note above — neither was the problem).
>
> Re-measured on the same fixtures and the same one-byte-deeper-leaf edit shape used above:
>
> | Fixture | `spliceSubtree` | `incrementalRowIndex` | `buildLineIndex` | `buildNameIndex` | **Real block** |
> |---|---:|---:|---:|---:|---:|
> | `cars-200mb.xml` | 462.2 ms | 20.2 ms | 35.4 ms | 46.8 ms | **564.6 ms** |
> | `cars-500mb.xml` | 1156.5 ms | 56.8 ms | 127.6 ms | 106.7 ms | **1447.7 ms** |
>
> Against the 1476.0 ms / 3822.3 ms figures above: the row-index share drops from 887.9 ms to
> 20.2 ms at 200 MB (2315.1 ms to 56.8 ms at 500 MB) — a ~44× and ~41× reduction on that one
> component, and a ~2.6× reduction in the whole main-thread block at both sizes. The splice
> itself (`spliceSubtree`, unchanged by H2b) is now the dominant cost, which is `M5-PLAN.md`'s
> H2d's task, not this one's.

> **H2d closed.** The graft's O(document) part — the "after" segment loop `graft`'s own doc
> comment already named as the sliceable piece — now runs through `searchJob.ts`'s existing
> `runChunkedJob`/`JobSlot` seam (D-041) instead of blocking synchronously.
> `subtreeSplice.ts` gained `beginSpliceSubtree`, whose decide phase (`decideSplice` — the
> same `findSpliceNode`/`resumeContextFor`/`parseRange`/malformed-guard sequence
> `spliceSubtree` already ran) stays synchronous and bounded by the edited subtree's own size,
> so `runReparse` still learns "splice or full reparse" immediately; only `graftChunked`'s
> after-segment and after-attribute loops yield, in batches of 4096 elements
> (`GRAFT_BATCH_SIZE`). `spliceSubtree` (fully synchronous) stays as the reference
> implementation the chunked path is tested against — `test/subtreeSplice.test.ts`'s existing
> full-reparse equivalence oracle applies to both.
>
> Measured against the same fixtures and edit shape, instrumenting a self-rescheduling
> `setTimeout(0)` prober to approximate the longest single main-thread block between yields:
>
> | Fixture | synchronous `spliceSubtree` | chunked wall time | max single block |
> |---|---:|---:|---:|
> | `cars-200mb.xml` | 412.8 ms | 748.7 ms (43 ticks) | ~23.6 ms |
> | `cars-500mb.xml` | 962.3 ms | 2302.9 ms (137 ticks) | ~22.6 ms |
>
> **The block drops from ~400–960 ms to ~23 ms — a ~18–40× reduction in what the main thread
> is ever blocked for at once** — at the cost of roughly doubling total wall-clock time for
> the whole graft, spent yielding rather than working. That trade is the point: H2d was never
> about making the graft faster, only about not freezing a frame while it runs. The ~23 ms
> figure did not move when `GRAFT_BATCH_SIZE` was tried at 1024 instead of 4096, which points
> at Node's own `setTimeout` scheduling granularity (coarser than a browser's, and Windows'
> default timer resolution in particular) as the likely floor on this measurement rather than
> the batch's own synchronous cost — worth re-measuring inside the real Electron renderer
> (Chromium's timer resolution, not Node's) before treating 23 ms as a hard number, though the
> qualitative result (one long block replaced by many short ones) does not depend on which
> runtime measured it.

### D-037 — `FOLD_THRESHOLD` stays at 64, now for a measured reason · `settled`

§13 called folding at ~64 pending deltas "a guess." `docs/plans/M3-RESULTS.md` §5 measured
`shiftedOffset`'s actual per-call cost curve and found it linear in list size, not
logarithmic — the binary search that locates the relevant entry is `O(log n)`, but the
cumulative sum that follows it is `O(n)` in the worst case (a query near the end of the
list). At 64 entries that worst case costs ~65 ns; at 10,000 entries it costs ~13.6 µs,
consistent with the 156×-size/~210×-time scaling actually measured.

64 stays the threshold — not because a higher one was tried and rejected, but because nothing
in the current architecture reads through `core/deltaList.ts` on a real hot path yet (F1–F9's
repeated note: no Tree row, grid cell, or Raw decoration read calls `shiftedOffset` — the
delta list itself is unwired, same shape as D-036's gap). At the cost this pass measured,
64 was never the bottleneck; there was no evidence to move it.

**Revisit if:** a future task wires `core/deltaList.ts` into a real read path *and* wants a
threshold materially above 64 — at that point `shiftedOffset`'s linear-sum step needs a
prefix-sum precomputation (built once per fold cycle, not per read) before raising the
threshold is safe, per the cost curve this decision cites.

### D-045 — XML formatting is not built in M5; `canFormat` stays `false` · `settled`

M5-PLAN.md H6, verbatim: *"is a conservative XML formatter worth building for M5, or does
the Format command ship JSON-only at first?"* Answered: JSON-only.

§5.7's rules for XML formatting are not a simple whitespace pass — they require **detecting
mixed content per element** (an element with any non-whitespace text child alongside element
children must be left byte-identical, not just "indented carefully") and **tracking
`xml:space="preserve"` as inherited, overridable scope** down the ancestor chain during the
traversal, re-deriving the same kind of state `resumeContextFor` already rebuilds for subtree
splicing. `NodeFlags.IsMixed` and the `xml:space` scope logic already exist (set at
`closeNode`, rebuilt by `resumeContextFor` for M3's splicing) — the plan's own note that "the
formatter finds itself re-deriving either, look at what exists first" is a real head start —
but reusing them correctly inside a from-scratch re-emission pass, then proving it
byte-identical over every mixed-content and `xml:space` shape in the XML test fixtures, is
real format-aware serializer work, not a small extension of H5's JSON traversal. H5 already
proved the byte-exact re-emission shape (`GrowableBytes`, verbatim scalar/string copies,
whitespace-policy-only traversal) works; XML's version of that traversal has to additionally
decide, node by node, whether it is allowed to touch the whitespace around it at all — a
different and harder problem, not a mechanical port.

Given M5's actual budget after H2b–H2d, H4, H5, H7, H8, H9, H10 and H11, building and proving
a correct conservative XML formatter did not fit. JSON was the one format §5.7 itself calls
"the only format where formatting is unconditionally safe and total" — building that first
and shipping XML formatting later, once there is real usage signal for whether users want it,
is the lower-risk order. Nothing about H4's chunked write path or H7's undo/command wiring is
JSON-specific — a future XML `format()` plugs into both unchanged.

**`xmlCapabilities.canFormat` stays `false`** (already was, since M0b — never enabled). The
palette's Format/Minify commands are gated on `capabilities.canFormat` (H7), so no command
that does nothing is ever offered for an XML document; a user opening a large, unformatted
XML file still gets §5.7's soft-wrap-and-row-index behavior, just not a Format command.

**Revisit if:** real usage shows XML users specifically want pretty-printing (as opposed to
JSON users, who were the ones §5.7 already predicted this would help most) — at that point,
`NodeFlags.IsMixed` and the splicing `xml:space` scope logic are the two pieces of existing
state to build from, per the note above.

### D-046 — A Transform above `TRANSFORM_CONFIRM_BYTES` is not undoable · `settled`

M5-PLAN.md H7 names the real memory problem: `undoStack.ts`'s `UndoEntry` holds `Patch`es,
not snapshots, specifically so a burst of keystrokes costs only the edited region — but a
whole-document Transform expressed as one patch holds a full copy of the *new* document in
`patches[0].replacement`, and its inverse (`inversePatchOf`) holds a full copy of the *old*
one. At 200 MB that is 400 MB of undo state for one Format, stacked on top of §8's own
~503 MB budget for the document itself.

**Chosen, of the plan's three options:** refuse to make the entry undoable above a size,
stated up front rather than discovered. `applyTransform(kind, undoable)` decides `undoable`
once, before the async worker round trip starts (`requestTransform`/`confirmTransformAnyway`,
`documentSession.ts`) — a document under `TRANSFORM_CONFIRM_BYTES` (50 MB) runs immediately
and pushes exactly one ordinary entry; at or above it, `requestTransform` already has to ask
first (§11.2's soft-cap shape — the same threshold, not a second one: the size past which a
whole-buffer undo entry costs too much to keep is the same size past which asking before
running is warranted in the first place), and the confirmation is where the user learns the
run that follows won't be undoable. Confirming still runs the Transform — this is not a
refusal, only a refusal to also retain the undo cost.

**Why not the other two options.** Bounding the *count* of whole-buffer entries retained (one
or two, dropping the oldest) was rejected: `pushEntry`'s existing eviction already drops from
one end of a linear array, but a whole-buffer entry sitting in the *middle* of the stack (an
ordinary edit made after it, then undone past it later) cannot be evicted alone without
breaking every entry after it — each entry's own patches/inverses are only valid relative to
the buffer state immediately before/after it, and removing one from the middle desyncs the
chain for everything downstream, not just the entry removed. Spilling the pre-transform
buffer to a temporary file was rejected as real, separate I/O-lifecycle scope (a leaked temp
file on crash, a second write path with its own error handling) for a case M5 has no evidence
is common enough yet to justify.

**Revisit if:** real usage shows Format/Minify used routinely on documents past 50 MB, at
which point spilling to a temp file (the option set aside above) is the one that scales
without corrupting the undo chain's own invariants — bounding *count* remains ruled out
regardless of what else changes, for the structural reason above, not a threshold choice.

### D-047 — H11 spike: go. A worker `fetch` on a custom protocol peaks at ~1× · `settled`

M5-PLAN.md H11's own gate: "`Response.arrayBuffer()` on a streamed body may accumulate
chunks and concatenate, which would reintroduce the very 2× spike this removes... Measure
peak RSS in the fetching process at 200 MB and 500 MB, with `Content-Length` set and
without. A 1× peak is a go."

**Spiked** (a standalone Electron harness, deleted at R155 — see
`docs/spikes/M5-H11-protocol-fetch.md` for the full table and methodology): a custom scheme served through
`protocol.handle` via a streamed `fs.ReadStream`, fetched from inside a genuine dedicated
`Worker`, with `app.getAppMetrics()` reading the renderer process's own RSS before and after.
**Result: ~1.00–1.03× at both 200 MB and 500 MB, identical with and without
`Content-Length`.** The plan's own uncertainty was whether `Content-Length` would matter;
measured, it doesn't — better than the plan's best-case assumption, not worse, since it means
no upstream requirement to know the file's size before the response starts.

**Go.** `document:read`'s IPC hop, its `.slice()` (already fixed by H2c, but still a copy
that exists only because the bytes have to leave the main process at all), and the
structured-clone across `ipcRenderer.invoke` all go away under this route — the document
exists once, in the worker that parses it, for the whole open path rather than three times
across two processes.

**What H12 (not built this milestone — M5's own definition of done only asks for the spike
and the verdict) would need, recorded so it isn't re-derived cold:**

- **The security requirement is not optional and not deferrable.** A protocol handler that
  maps a URL path straight to a filesystem path is an arbitrary-file-read oracle reachable
  from any script that ends up running in the renderer. Main must mint an opaque, single-use
  token when the Open dialog returns (or when a path is otherwise explicitly accepted by the
  user), keep a token → path map, and refuse every request whose token isn't in it. **The URL
  must never carry a path** — this spike's own `/fixture` route is a fixed, hardcoded path
  used only because the spike's whole purpose was measuring streaming behavior, and is
  explicitly not the shape to ship.
- **Verify the `npm run dev` shape too** (`ELECTRON_RENDERER_URL`, an `http://` origin) before
  shipping — the spike only measured the packaged-build shape (`loadFile`, a `file://`
  origin). Custom protocol registration is scheme-level, not origin-level, so there's no
  structural reason to expect a difference, but it wasn't measured and the plan asks for both.
- **`document:read`'s own IPC handler and its `.slice()` guard (H2c) would be replaced, not
  kept alongside** — two live paths to read a document would be two things to keep consistent
  for no benefit once the token-scoped route exists.

**Revisit if:** the `npm run dev` check turns up a real difference, or a future Electron
version changes `protocol.handle`'s streaming behavior (this measurement is
version-specific, not a guaranteed-forever platform fact).

### D-048 — H12 built: `document:read` replaced by token + protocol fetch · `settled`

Implemented D-047's sketch, past what M5's own definition of done asked for (H12 was
explicitly out of scope for M5; built anyway on direct request). `document:mintReadToken`
(main) mints an opaque, single-use, TTL-swept token for a user-chosen path;
`registerReadTokenProtocol`'s `protocol.handle(READ_TOKEN_SCHEME, ...)` serves the file as a
streamed `Response` keyed by that token, never a path in the URL; `parse.worker.ts`'s
`runParseFromUrlJob` does the `fetch` from inside the worker itself. `document:read` and its
IPC handler are gone, not kept alongside, per D-047's own note. `documentSession.ts`'s
`startParse` and `reloadFromDisk` both go through `mintReadToken` + `parseFromUrl`;
`runReparse`'s in-memory-buffer reparse path is untouched — it has no on-disk file to
token-mint against.

The single-use/TTL logic was pulled out of `main/documents.ts` into `core/readTokenRegistry.ts`
(no Electron or Node import) specifically so it has direct unit tests
(`test/readTokenRegistry.test.ts`) — `src/main` otherwise has no test coverage anywhere in
this codebase, and this is the one piece of H12 that *is* the security model, worth testing
on its own rather than only indirectly through the wiring around it.

**The deferred `npm run dev` check (D-047's own condition for shipping) is now done.** Launched
`npm run dev` (http-origin renderer, `ELECTRON_RENDERER_URL`/`localhost:5173` — the one shape
H11's spike didn't cover) and opened a JSON and an XML file through the real Open dialog: both
loaded, Tree/Raw views populated, no error banner. Terminal showed no error tied to scheme
registration, `mintReadToken`, or the protocol handler — only a benign DevTools
`Autofill.enable`/`setAddresses` protocol-mismatch warning, unrelated to this app. DevTools
console showed only Chrome's own `[Violation] 'message' handler took...ms` long-task
advisories from React's render path — a pre-existing property of rendering a document's worth
of nodes at once, not something H12 introduced, and not an error. No path-in-URL, no failed
fetch, nothing referencing `nodepad-file://` at all in either surface. The packaged/`loadFile`
shape remains what H11's spike measured directly; nothing here gives reason to expect the two
shapes diverge.

**Reviewed** (independent pass over both commits building H12): token model, single-use
enforcement under racing requests, TTL sweep, protocol registration ordering
(`registerSchemesAsPrivileged` at module load vs `protocol.handle` inside
`app.whenReady()`), and the supersede/abort logic in `startParse`/`reloadFromDisk` — now with
an async IPC round-trip (`mintReadToken`) ahead of the fetch that didn't exist under the old
synchronous-bytes path — all checked out with no bug found. One minor, accepted finding: the
protocol handler's `stat()`-then-`createReadStream()` has a TOCTOU window (the file can
change size or vanish between the two) — documented in `documents.ts` rather than fixed,
since a mismatched `content-length` makes the fetch fail loudly (caught by
`runParseFromUrlJob` as an ordinary read error), not silently wrong.

### D-051 — One overlay scrollbar look across every pane (Tree, Detail, Grid, Raw) · `settled`

`docs/plans/M5c-PLAN.md`'s appendix, scrollbar-inconsistency item (M5c-PLAN.md J4), decided with the project
lead against two alternatives: a scrubber-only Raw view with no Tree/Detail/Grid change, and
restoring CodeMirror's own native scrollbar in Raw. The chosen shape: a new
`src/renderer/components/Scrollbar/Scrollbar.tsx`, an overlay track drawn over a natively-
scrolling element (`overflow: auto`, native bar hidden via `.scrollbar-host`) that drives
`scrollTop`/`scrollLeft` on it directly — never a re-implementation of scrolling, and never
an assumption that a meaningful `scrollHeight` exists to derive a thumb from. Used by Tree,
Detail's children list, and the Grid (both axes).

Raw does **not** adopt the component itself — its ~1 MB window (D-031) has no real
`scrollHeight` to draw a thumb from, which is the Scrubber's whole reason to exist. Raw's
Scrubber instead adopts the component's *visual language* (same `--scrubber-width`, same
thumb shape/radius, same hover/active colors) and gains the interaction pieces that were
missing for it to read as one control with the others: wheel-over-strip scrolls, a track
click pages by one viewport (dragging the thumb keeps the existing continuous ratio-scrub —
different gesture, same as a real scrollbar distinguishes them), and hover/active thumb
states.

The native scrollbar was considered and rejected again, for the same reason D11/M5b already
found: it describes the ~1 MB window, not the document, so its thumb is always near-full and
jumps on every re-slice. That was never fixed by J1–J3's performance work — it's a mismatch
between what CodeMirror's own scrollbar can show and what the document actually is, not a
smoothness problem.

**R33 addendum.** Carrying the decision out fully surfaced three gaps, all fixed in R33: (1)
Detail's *outer* pane still had a native scrollbar — only its children list had been converted;
now wrapped in `.detail-viewport` (a positioning context, same role as `.tree-viewport`) with its
own `Scrollbar`, and `.detail-children-list` gained `overscroll-behavior: contain` so wheeling
past its edge doesn't chain the scroll to the pane around it. (2) The thumb used `--elev-2-bg`, an
*elevation* token that happens to be the lightest surface in the light theme — near-invisible on
a near-white pane, a semantically-wrong-but-lint-passing token (invariant 9 checks a token is
used, not that it means the right thing). Replaced by real control tokens
(`--scrollbar-track-bg`/`--scrollbar-thumb-bg`/`-hover-bg`/`-active-bg`, `themes/light.css` and
`themes/dark.css`) with a stated >= 3:1 thumb-vs-track contrast minimum, asserted in both themes
by `test/scrollbarContrast.test.tsx` (real Chromium, computed colors — a screenshot proves
nothing for a contrast bug). Scrubber.css moved to the same tokens, per this decision's own "same
visual language" clause. (3) The track was `transparent`, deliberately per this decision — the
project lead's call in R33 is that it should be visible instead, so it now uses
`--scrollbar-track-bg` too.

**R33 addendum 2 (built).** A second pass measured every pane's strip in real Electron and found the
colours are now genuinely identical — track `236,238,242`, thumb `113,123,140`, in all four panes
at `devicePixelRatio` 1, with the Tree strip re-checked unchanged at 1.25. What still differs is geometry, and it comes from the same root
cause the addendum above already named twice: `Scrubber.css` keeps a `border-left` no
`.scrollbar-track` has, which also narrows Raw's usable track to 14 px and its thumb to 12 px
against 13 px elsewhere. **The decision this adds:** the two files stop being maintained in
parallel — the shared strip styling (track background, width, thumb geometry, radius, transition,
hover/active) moves into one stylesheet both import, with `Scrubber.css` keeping only what is
genuinely Raw's. This does **not** merge the components, and §1d's reason for keeping them separate
is unchanged; it merges the styling that was only ever duplicated by accident, and which three
separate addenda have now failed to keep in sync by convention. Detail in
`docs/plans/R33-scrollbars-and-selection.md`'s addendum 2.

### D-052 — Expand All / Collapse All act on the selected node's subtree · `settled`

M5c-PLAN.md J6, from `docs/plans/M5c-PLAN.md`'s appendix, "no Collapse All; Expand All's scope is the whole
document." Both commands (`nodepad.tree.expandAll`, and the new `nodepad.tree.collapseAll`)
now resolve their scope the same way: the current selection, falling back to the Tree's own
root when nothing is selected. Matches the Windows Explorer `*` key convention `Tree.tsx`
already binds to expand — pressing it on a selected node has always meant "expand from here,"
this just makes the palette/pane-header commands agree with that instead of always meaning
the whole document.

`Tree.tsx`'s `runExpandAll`/`runCollapseAll` read the selection through a ref
(`selectedNodeRef`), not the `selectedNode` prop closed over directly — `registerTreeController`'s
effect only re-runs on a `store` change, and the selection changes far more often than that
without remounting anything, so the controller closure needs to read it fresh at call time
rather than whatever it was when last registered.

Selecting the Document root and expanding is exactly today's old document-wide behaviour —
the argument D-053 gives for keeping that row rather than making the Tree a forest.
`treeModel.ts`'s `collapseSubtree` mirrors `expandAll`'s own bounded breadth-first walk
(`EXPAND_ALL_LIMIT` bounds the queue, not just the result) but doesn't need to know which
nodes are *actually* expanded — it returns every node with children in the subtree (a safe
superset) for the caller to remove from its own `expanded` set, keeping the function pure and
independent of `Tree.tsx`'s particular state shape.

Context-dependent command titles ("Expand Subtree" vs. "Expand All" depending on whether
something's selected) were considered and dropped: the command registry has no mechanism for
a title that depends on live app state, and adding one for a label wasn't judged worth it —
the static titles stay.

### D-054 — The title bar icon comes from the `.ico`, redrawn below 48px from `mark-16.svg` · `settled`

M5c-PLAN.md J7, from `docs/plans/M5c-PLAN.md`'s appendix, "title bar icon renders poorly." `src/main/index.ts`
was passing `icons/256.png` for `BrowserWindow`'s `icon` option on every platform — Windows
resamples that 256px gradient tile down to 16px for the title bar, which reads as a blurry
sticker rather than a crisp mark. Fixed on Windows only (`process.platform === 'win32'`) by
passing `assets/build/icon.ico` instead, whose 16/24/32px frames `tools/generate.py` now
renders from `mark-16.svg` — the bare monogram, no tile — rather than `icon-flat.svg`; 48px and
above keep the tile (those are the dock/taskbar/installer sizes the tile is for). macOS ignores
`icon` on `BrowserWindow` entirely, so it's untouched — no per-platform mark decision needed
there, only the file this option happens to point at.

The alternative — a frameless window with NodePad-drawn chrome, which `assets/README.md`'s own
"Title bar" section describes and which is the only way to get the theme-token `currentColor`
the SVG actually specifies — is not being built now; recorded as the real answer for later, not
silently dropped.

**Note the side effect rather than discovering it later**: `icons/16.png`/`24.png`/`32.png`
switch the same way (`tools/generate.py`'s change is one source swap feeding both `icon.ico`
and the loose PNGs), so the Windows taskbar at small sizes also becomes the bare mark. Judged
an improvement, and the price of not building the frameless window.

### D-054a — regeneration done; the rasterizer, the mark colour, and two title bars

Amends D-054 rather than replacing it. Regeneration was previously deferred for lack of a
Python interpreter; it has now run, and three things came out of actually doing it.

**The toolchain was never runnable on Windows, and that is why the assets were stale.**
`tools/generate.py` imported `cairosvg`, which needs libcairo as a *system* library — there is
no pip-installable cairo on Windows, so the script failed at import (`OSError: no library
called "cairo-2" was found`) no matter how Python was installed. It now uses **`resvg-py`**,
which ships a prebuilt binary in the wheel, run through `uv` so there is nothing to install
globally: `uv run --with resvg-py --with pillow tools/generate.py`. `svglib`+`reportlab` was
the other pip-only candidate and is wrong for these files — it reports `mark-16.svg` as 12×12.

**Two real bugs in the generator, both silent.**

- It wrote to `build/` and `build/icons`, relative to the repo root. Every consumer reads
  `assets/build/` (`electron-builder.yml`'s `buildResources`, `src/main/index.ts`'s `?asset`
  import, `assets/README.md`'s table). Running it would have created a second, unread output tree
  while the real assets stayed exactly as stale as before.
- The `.ico` was written as `images[256].save(..., format="ICO", sizes=[...])`. That hands
  Pillow **one** image and resamples it into every frame — so the 16/24/32 frames were a
  downscaled *tile*, precisely what D-054 says they must not be, while this file and
  `assets/README.md` both documented the opposite. The frames have to be passed individually via
  `append_images`, and the call must be made on the **largest** frame: Pillow's ICO writer
  skips any requested size larger than the image `save` was called on, so doing it from the
  16px frame yields a valid single-frame `.ico` with no error at all. `generate.py` now
  asserts the written frame list before exiting.

Verified after regeneration: seven frames present; 16/24/32 at ~25% opaque coverage with
transparent corners (the bare mark), 48+ at ~97% (the tile).

**The mark colour for OS-facing rasters is `#A9701E`, not `#E9A33C`.** D-054 inherited
`assets/README.md`'s light/dark amber pair without noticing that a raster handed to the OS has no
theme to follow: a Windows title bar takes the *system* theme, which NodePad neither controls
nor is told about, so one file must work on both. Measured contrast (3:1 is the non-text UI
minimum `assets/README.md` already cites): `#E9A33C` is **1.94:1** on the Win11 light title bar — it
fails outright — while `#A9701E` is 3.77:1 light and 3.90:1 dark. It is the only amber in the
palette that clears both. `generate.py` substitutes it into `mark-16.svg`'s `currentColor`.

**The theme-aware title bar on the roadmap needs no new assets.** Raised as "should we make a
monochrome N in light and dark versions?" — no, and the reason generalizes: once the title bar
is NodePad-drawn (frameless window, renderer chrome), the icon is an **inline SVG using
`currentColor` plus a theme token**, which is what `mark-16.svg` was authored for. A light/dark
raster pair would be two files to keep in sync, would not follow a theme changed at runtime,
and would be blurry at fractional DPI. The `.ico` stays regardless — the taskbar, the `.exe`
and the installer consume it and none of them can read an SVG. `assets/README.md`'s "Title bar" section
is now split along exactly this line so the two are not planned as one thing.

**Still not verified:** the acceptance criterion is "verify by running the app," which needs a
GUI session. The frames are confirmed correct in the file; the title bar itself has not been
looked at.

### D-055 — The title bar is the toolbar; placement is by command scope · `settled`

The question put: should NodePad have a toolbar (open / save / undo / pane toggles, growing
over time), or none, pushing those into pane headers? Settled as **neither shape exactly** —
no toolbar *row*, but the M5d title bar (R1) carries the window- and document-scope commands,
which is where JetBrains' 2022 UI and VS Code both ended up. → `docs/plans/M5d-PLAN.md` R2, R3, R7.

**The fact that decided it: NodePad has no menu bar** (`autoHideMenuBar: true`). Every app
worth comparing against — Sublime, VS Code, Zed — gets away with no toolbar because the menu
is the discoverability backstop. Without one, 25 of NodePad's 31 registered commands are
reachable only through the palette, which is itself gated behind knowing `Ctrl+Shift+P`. The
real question was never "toolbar or not," it was "what is the persistent discovery surface,"
and the honest answer before this decision was that there wasn't one.

Two symptoms of that, found while counting rather than assumed: **document scope is the
largest command group (10) and had no home at all**, and **`navigate.back`/`forward` exist but
are completely invisible** — a mouse user has no way to learn NodePad has history.

**The rule.** Placement follows the command's *scope*, not its implementation:

| Surface | Scope | Contents |
|---|---|---|
| Title bar | window + document | pane toggles, Open, Save (beside the dirty dot), Undo/Redo |
| Pane header | that pane only | Raw: wrap. Tree: expand/collapse all. Detail: grid actions |
| Palette | everything | all 31, enforced by the invariant 10 parity test |

**Undo is document scope, not Raw scope**, and this is the concrete reason the rule is
scope-based rather than "put it where it's used." Editing happens only in Raw today, which
makes Raw's header look like undo's natural home — but a Transform (`document.format` /
`document.minify`) mutates the byte buffer and is undoable below D-046's threshold, with Raw
uninvolved and possibly hidden. Undo in a pane header would be wrong the first time someone
formats a document with that pane closed.

**Constraints that keep this from drifting back into a toolbar:**

- **Disabled, not hidden.** A Save button that disappears when the document is clean makes the
  strip reflow and destroys pointer muscle memory.
- **Every title-bar button keeps its chord in the tooltip** — `Layout.tsx`'s `tooltipFor`
  already does this and must survive the move. For a mouse user, clicking Save and pressing
  `Ctrl+S` cost about the same; what a persistent surface actually buys is *discovery*, so a
  button that advertises its shortcut is worth more than two that don't.
- **The strip stays small.** A toolbar earns its space in proportion to frequent, global,
  mouse-reachable actions, and NodePad's frequent actions are navigation and selection, which
  happen by clicking inside the panes. Open happens once a session; Save is rare in a viewer.
  The title bar's natural width pressure is a feature, and once tabs land (§11.4) that row is
  contested — both JetBrains and VS Code ended at title bar / tab strip / content.

**Panes stay hidden, not collapsed** — the paired question. Collapsing to a labelled rail is
the better *interaction* (the restore affordance sits where the pane was), but it does not
remove the toggle buttons, which was the reason to want it: a collapsed rail restores a pane
and cannot collapse a visible one, so the control moves into the three pane headers rather
than disappearing, landing in exactly the headers this decision is trying to keep thin. Two
collapsed rails also cost more permanent chrome (~56px) than the toolbar row they would save
(~36px). And hiding's usual danger doesn't apply with three named panes in a fixed
arrangement: a user who hides the Tree knows the Tree is gone. Checked while deciding —
`clampTreeWidth`/`clampRawHeight` enforce a minimum, so there is no drag-to-zero gesture
competing with either option.

A per-pane collapse chevron *alongside* the title-bar toggles stays available as a later
refinement; that redundancy is normal (VS Code's sidebar has a close button, `Ctrl+B`, and a
menu entry).

**Expected to be refined once it is in use** — recorded as the starting shape, not a final
one, at the project lead's own framing.

### D-054b — Every OS-facing raster is the tile again; the bare mark is renderer-only · `settled`

Reverses D-054's central choice while keeping the bug fixes D-054a landed alongside it.
Reported from the running app: after D-054a's regeneration the **Windows taskbar** showed the
bare monogram, and the expectation — correctly, and matching `assets/README.md`'s own rule — was
the dark tile there.

**D-054 was wrong, for a reason it could not have seen from the file.** Windows picks an `.ico`
frame by **pixel size, not by which surface is asking**. There is no "title bar frame." The
title bar asks for the small icon (~16px at 100% scaling, ~24px at 150%); the taskbar asks for
the large one (~32px at 100%, ~48px at 150%). D-054's split put the boundary at 48px, straight
through the range the taskbar uses — so the same build showed a **bare mark in the taskbar at
100% scaling and the tile at 150%**. An icon whose identity changes with display scaling is
incoherent whichever of the two you prefer, and that is the finding, independent of taste.

**And the original complaint was misdiagnosed.** `docs/plans/M5c-PLAN.md`'s appendix, "the icon in the title-bar
renders not so nicely" was caused by *resampling* — `src/main/index.ts` passed a 256px gradient
tile and Windows squeezed it into 16px — not by the tile artwork. Rendering the tile natively
at 16/24/32 (which D-054a's `append_images` fix made possible for the first time; before it,
every frame really was one resampled bitmap) fixes the blur while keeping the tile. Compared
side by side at 5× before deciding: the natively-rendered tile is clearly legible at 24 and 32
and acceptable at 16.

So: `tools/generate.py` renders `icon.svg` at **every** size for `icon.ico` and `icons/*.png`.
`mark-16.svg` is no longer rasterized at all.

**What survives from D-054/D-054a**, and must not be re-broken:

- The `.ico` path in `src/main/index.ts` (`process.platform === 'win32'`). Still right — it is
  what stops Windows resampling one PNG, which was the actual bug.
- `append_images` from the largest frame, and the post-write frame-list assertion.
- `assets/build/` as the output directory; `resvg-py` via `uv` as the rasterizer.
- The macOS iconset's single padded source (D-054a's follow-up).

**What is now moot**: D-054a's `#A9701E`-for-OS-rasters conclusion. The measurement stands and
stays in `assets/README.md` as reference, but nothing consumes it — no OS raster contains the bare mark
any more. Inside the app the theme is known, so the mark uses `#E9A33C` on dark and `#A9701E`
on light as the palette always said.

**This was always going to be temporary.** M5d R1 has NodePad draw its own title bar, after
which Windows draws no title-bar icon at all and the `.ico` has exactly one audience left — the
taskbar, the `.exe`, the installer and file associations, every one of them a tile surface.
D-054 optimised a consumer that is being removed, at the cost of the ones that remain.
`assets/README.md` §Title bar's two-part split ("native, today" / "NodePad-drawn, roadmap") is
unchanged and is the right frame; only the raster half of the "today" half was wrong.

### D-056 — the title bar's "disabled, not hidden" needed a real registry gap closed · `settled`

M5d-PLAN.md R7 named this as a possible outcome rather than assuming it away: "This needs the
registry to express enablement; if it can't yet, that is a real gap to report rather than route
around by hiding." Checked, and it couldn't — `Command.when` was the only gate `commandsForSurface`
had, and it controls existence, not enablement. The palette relies on that exact behaviour on
purpose (M3-PLAN.md F9: Undo/Redo/Save are hidden there, not greyed out, when they'd be a no-op)
and R7 must not change it just because a second surface showed up wanting the opposite.

**The fix adds a second, independent field rather than overloading `when`.** `Command
.enabledWhen` (`commands/registry.ts`) is evaluated by `isCommandEnabled`, and only consulted by
surfaces that render commands via the new `commandsForSurfaceUnfiltered` — which skips the
`when` filter entirely rather than adding a parameter to `commandsForSurface` that would have to
be threaded through the palette and pane headers too, for a behaviour only the title bar wants.
The title bar is currently the only caller. Save/Undo/Redo keep their existing `when` (so the
palette is byte-for-byte unchanged) and gained an `enabledWhen` carrying the identical
expression, which reads as duplication for exactly one release — the moment a second command
needs different palette-visibility and title-bar-enablement conditions, that duplication stops
being incidental and starts being the point.

**A second, smaller gap found the same way**: R7's own text lists "document" as one of four
icons needing "no asset work," but `document` is already `nodepad.layout.toggleDetail`'s icon
(M1-PLAN.md D7) and both buttons are visible in the title bar at once. Fixed by importing
`folder_open_20_regular` for `nodepad.document.open` (R4) instead — one new static SVG import,
not new raster asset work, so R7's framing was right about the *kind* of gap even where it
under-specified the *icon*.

### D-057 — Format/Minify are *source-shape* commands; Format's button lives in Raw · `settled`

Refines D-055 rather than making an exception to it. The question: D-055 puts document-scope
commands in the title bar, and Format rewrites the byte buffer for the whole document — but
users would look for pretty-print in the Raw view, because Raw is the only place its effect is
visible.

**The effect really is confined to Raw, and that is by design rather than coincidence.**
D-030 does not model insignificant whitespace, so formatting an XML document leaves the Tree
**literally unchanged** — same nodes, same structure. The Detail view changes only its
source-range labels ("line 42" becomes a different number) because spans shift. Raw is the
only view whose subject is the source's *shape*.

That points at a sharper rule than "document scope vs pane scope", and it falls straight out of
the architecture the whole project rests on — the byte buffer (source) against the model
(content):

> A command belongs to a pane when **the pane's subject is what the command acts on**, not
> merely where it happens to be used. Raw's subject is the source bytes.

Format changes the source representation and provably does *not* change the model — which is
exactly why it is safe to offer at all, and exactly why mixed content is the hard case (there
it would change the model, so §5.7 leaves it byte-identical). So Format is a source-shape
command, Raw is the source-shape surface, and the button belongs there. No exception needed.

**The rule does not leak**, checked against the two neighbours it could:

- **Undo/Redo** — subject is the *edit history*, not the source shape. It can undo a Transform
  issued from the palette with Raw closed. Stays document scope, title bar (D-055/R7).
- **Save** — subject is the file on disk. Title bar.

**Placement:**

- `nodepad.document.format` → **Raw pane header** + palette.
- `nodepad.document.minify` → **palette only.** Same category by this rule, but the pane header
  budget is real (D-055's "keep the strip small" applies to headers too), Minify is rare, and
  it carries its own confirmation flow. Recorded so its absence reads as a decision rather than
  an oversight.
- Both stay palette-reachable — invariant 10, enforced by test.

**Raw shows the file as it is; formatting is only ever user-initiated.** The project lead's own
framing, and it is already the shipped behaviour — `settings.ts`'s "Format minified files on
open" is **off by default**, with the banner as the default experience ("offer, never impose",
§5.7). Nothing to change; recorded because the principle is worth being explicit about, and
because a future reader finding an auto-format path should treat it as a regression.

**Blocked in practice for XML.** `canFormat` is `false` for XML (D-045), so this button is
permanently disabled on the format most used with NodePad until the deferred XML formatter is
built. See `docs/plans/M5e-PLAN.md` §2 — the placement is settled here, the capability is not.

### D-058 — D-045 reopened: XML formatting is built; `canFormat` is `true` · `settled`

M5e-PLAN.md R11. D-045 deferred XML formatting because a correct implementation needs two things
"real format-aware serializer work" beyond H5's JSON traversal: per-element mixed-content
detection and inherited, overridable `xml:space="preserve"` scope. Both turned out to be **already
built and load-bearing for other features** by the time R11 started — `NodeFlags.IsMixed` (set at
`nodeStore.ts`'s `closeNode`) and `Frame.preserve`/`XmlResumeContext.preserveWhitespace` (kept
correct through M3's subtree splicing) — so D-045's own head start note ("look at what exists
first") turned out to cover both blockers, not just point at them.

**The one genuinely new piece: `format()` receives bytes, not the `NodeStore`** (`core/types.ts`'s
contract, off limits per the hard rule), so it cannot read `IsMixed` directly, and mixed-content
detection needs lookahead an element isn't known to be mixed until every child has been seen.
Resolved with two passes, neither a second parser: pass 1 runs the *real* `parse()` through a
recording `NodeSink` (`collectFormatInfo`, `src/formats/xml/index.ts`) to get provably-correct
`IsMixed`/`preserve` verdicts per element-start offset; pass 2 re-walks the same tokenizer
(`scanName`, `scanAttributes`, `skipWhitespace`, `matchesLiteral`, `scanUntilLiteral` — the same
functions `parse` itself uses) to emit, looking each element up in pass 1's map rather than
re-deriving anything. A mixed or `xml:space="preserve"` element is copied byte-identical and
**not recursed into at all** — `captureVerbatimSpan` reuses `runParser`'s own
`stopAtStackLength` resume shape (the same mechanism `parseRange` uses) to find where such a
subtree ends without re-implementing tag-matching.

**A real bug found and fixed while building this, worth recording so it isn't reintroduced:** the
Document root node's span always starts at byte 0 — the same offset as its first child whenever
there is no leading whitespace or prolog. Pass 1 originally keyed its `Map<Offset, FormatInfo>`
by span-start alone, so the root's own (irrelevant) entry silently clobbered its first child's
correct one, since the root closes *after* its child and `Map.set` on the same key overwrites.
Fixed by never recording an entry for `NodeKind.Document` (pass 2 never looks one up for it
anyway) rather than trying to make the key richer. Caught by the invariant test suite
(`test/xmlFormat.test.ts`'s structural round-trip check over a 300-sample generated corpus, not a
hand-picked example) — this shape only shows up when a document has no leading content before its
root element, which a hand-written example set is exactly the kind of thing likely to miss.

**Encoding**: `format()`'s contract carries no encoding parameter, and never decodes text (every
byte range not being reformatted is copied verbatim — invariant 7) — but *inserting* new
whitespace bytes for indentation is only safe for an ASCII-compatible single-byte encoding.
Resolved by BOM-then-declared-then-UTF-8, the same order `core/encoding.ts`'s `detectEncoding`
already uses elsewhere, and refused (thrown, caught by `applyTransform`, surfaced as
`pendingParseError`) for anything except UTF-8 — narrower than `documentEdits.ts`'s own
UTF-8/UTF-16 editing boundary, but currently unreachable from the UI regardless: Format is gated
on `!isReadOnly`, and every UTF-16 document already opens read-only, so no UI path can reach a
UTF-16 document with Format enabled today.

**Whitespace-insertion judgement call, per D-045/§5.7's own open question:** introducing
indentation where none existed is the same trade every other XML pretty-printer makes (xmllint,
XMLSpy, VS Code) and is what makes the feature useful for its actual purpose — reformatting a
minified file. Gated on exactly `!IsMixed && !preserve && hasStructuralChildren` (an element
whose only children are elements/comments/PIs/DOCTYPE, not text/CDATA) — a leaf's own text or a
CDATA-and-text-only body is always left verbatim, never split across lines, since NodePad has no
schema to say that whitespace there is insignificant.

`xmlCapabilities.canFormat` is now `true`. R9 (the pretty-print button) is unblocked, per D-057's
already-settled placement — Raw pane header — but is not itself part of R11; see
`docs/plans/M5e-PLAN.md` §2.

**Addendum (raised against `<p>Text <b><a>with a link</a></b> and more text</p>`): the skip rule
is subtree-scoped, not element-scoped**, made explicit after the fact rather than left implicit —
"byte-identical to its input" read ambiguously enough to implement element-scoped by accident
(freeze `<p>`, then still descend into and reindent the non-mixed `<b>`/`<a>` inside it, inserting
whitespace into mixed content — exactly the corruption the flag exists to prevent). The
implementation was already subtree-scoped in behaviour (`captureVerbatimSpan` never recursed), but
has since been changed to also be subtree-scoped in *mechanism*: `FormatInfo` now carries the
element's own `end` (pass 1's `spanEnd`, free at `closeNode`), so a frozen subtree is copied by
jumping straight to that offset rather than re-tokenizing bytes pass 1 already walked once.
`test/xmlFormat.test.ts` has the trap case as a named, hand-written test — deliberately not left
to the generated corpus alone, since it needs a specific shape (a non-mixed element nested inside
a mixed one) a random generator is unlikely to hit reliably.

**Left open, not resolved: how the skip count reaches the alert strip.** `docs/plans/M5e-PLAN.md`'s
"Report what was skipped" section wants the document told how many elements a Format left
untouched. Pass 1 already computes this for free, but `format()`'s signature is fixed by
`core/types.ts` — `(source, options) => Uint8Array`, nothing else comes back — and that file is
off limits without stopping to report first. Four routes were sketched (extend `FormatModule` with
an optional capability method, mirroring `format?`; a `formatId` branch in
`parse.worker.ts`'s `runTransformJob`; an `IsMixed`-only approximation computed in the renderer,
which undercounts preserve-only freezes since preserve scope isn't persisted to the `NodeStore`;
or dropping the feature this round) — see `docs/plans/M5e-PLAN.md`'s own "Open question" callout for the
full reasoning on each. Deliberately not picked under time pressure; revisit before building it.

### D-059 — Redo stays; the undo bound moves from entry count to bytes · `settled`

Asked while planning R12's undo-history figure: when is the redo tail discarded, is there logic
for it, and should redo be dropped altogether?

**The truncation rule is already implemented and already right.** `undoStack.ts`'s `pushEntry`
does `state.entries.slice(0, state.index)` before appending — so the moment a new edit is made
after an undo, the undone entries are discarded, because they are no longer a valid future. The
same rule `navigation/history.ts` applies to `recordVisit`. Redo therefore survives an undo, and
only an undo; it does not survive the next edit. Nothing to build.

**Redo stays, and the deciding argument is that removing it would save no memory.** That is the
concern that prompted the question, so it is the one worth answering precisely: an undo entry's
memory peak is when it is **pushed**, not when it is undone. Redo does not create entries, it
only extends how long an already-existing one stays reachable — from "until the next edit" to
"until the next edit", in fact, since `pushEntry` truncates either way. Dropping redo would free
memory only in the window between an undo and the following edit. If memory is the goal, the
levers are the depth bound (below) and D-046's threshold, not the redo command.

Two supporting reasons, the first specific to this application:

- **Format → undo to compare → redo to keep is a natural NodePad flow**, and it is the one the
  Transform makes expensive to live without: re-running a Format instead of redoing costs ~1 s
  and ~8× the document in memory (`M5g-PLAN.md` §1). Redo turns that into a pointer move.
- **Redo is what makes undo safe to try.** Without it, an accidental `Ctrl+Z` is unrecoverable,
  and users hesitate to use undo at all — the feature that was kept ends up used less.

The cost of keeping it is one command, one `Ctrl+Y` binding, `canRedo`, `redoStep`, and the
`index` cursor — and the cursor would still be needed without redo, since `pushEntry`'s
truncation rule is what a plain stack would have to reimplement.

**The real finding: `DEFAULT_UNDO_MAX_DEPTH = 500` bounds the number of entries, not their
size.** That is fine while entries are keystrokes and wrong once they can be documents: a
Transform entry holds the whole old *and* new buffer, so it can approach ~100 MB at D-046's
50 MB threshold. 500 such entries is not a bound in any useful sense. Formatting is idempotent,
so repeated formats mostly push nothing once `M5g-PLAN.md`'s O1 lands — but that is a mitigation,
not a bound.

**A byte budget should sit alongside the count**, evicting oldest-first on either limit. Not
scheduled here: R12 makes the number *visible* (`M5f-PLAN.md` §3a) which is the prerequisite for
choosing a sensible figure, and picking it before anyone has watched the real number move would
be guesswork. Recorded so the gap is not rediscovered as a surprise.

### D-060 — Memory moves off the status bar into a panel; no read-only badge · `settled`

Two deliberate deviations from `CONCEPT.md`, both landing in the same R12 status-bar build, so
recorded together per `CLAUDE.md`'s working agreement that a deviation gets documented with its
reason in the same commit.

**4a. Memory moves off the strip, and the figure gains undo history (amends §8).** §8 says the
memory budget is *"tracked and surfaced in the status bar."* Two changes to that one figure:

- **The move.** Continuously displaying `822 MB (~4.1×)` in a strip that's visible at all times is
  anxiety-inducing noise during ordinary use, and it's the single item most likely to be misread
  as a problem when nothing is wrong. It also changes on every render, which is what made a
  pre-existing defect audible: the old strip carried `role="status"`, a live region, so a screen
  reader announced the recomputed figure continuously. The figure stays *surfaced* — one click on
  the `ⓘ` item away — which is what §8 was actually protecting; it just isn't standing chrome
  anymore.
- **The correction.** `computeMemoryBudget` had never summed the undo stack at all
  (`M5g-PLAN.md` §1.4's own finding) — so the total wasn't merely incomplete, it was **wrong**, by
  up to ~2× the document right after a Format. Fixed in the same pass (§3a, this milestone): the
  panel's memory table now has an "Undo history" row, with its own entry count, and the total sums
  it. §8's own budget table needs this same row added, not just the UI — noted here so a future
  reader doesn't have to re-derive that the two were fixed together.

§11.4's cross-tab footprint should land in the same panel once tabs exist — noted so that doesn't
get re-decided cold either.

**4b. No read-only badge (amends §11.2).** §11.2 asks for read-only state *"shown in the status
bar rather than discovered on a failed save."* There is no badge in the strip, by decision.

The requirement's intent is already met elsewhere: invariant 6 means editing happens only in the
Raw view, and `Raw.tsx` already shows a standing banner (*"This file is read-only — changes can't
be saved here"*) in the one pane where an edit could be attempted at all. A status-bar copy would
just restate it in a place you are not editing. It also buys the layout something real: with no
conditional items in either group, the strip's item count never changes across
dirty/read-only/diagnostic states — verified directly in `test/statusBar.test.tsx` rather than
left as an assumption.

**Amended by R90 (`R86-find-as-query-surface.md` §6) — the outcome stands, the stated reason
above does not.** "The one pane where an edit could be attempted at all" stopped being true the
moment Replace shipped: it splices bytes the same way `applyEdit` does (§6's own invariant-6
analysis — offsets come from a search over the bytes, never the model), and since R70 hoisted the
Find bar out of `Raw.tsx` it is reachable with the Raw pane hidden, where the banner above is not
shown at all. Still decided against a pre-emptive indicator — a read-only Replace refuses with a
clear notification on the attempt (R21-notifications.md's transient-warning shape, not a silent
no-op), which is judged sufficient for the same reason 4b's own "the one gap" paragraph below
judges Save's silence small: you learn it the moment you try, not before. What changes is only
which sentence a future reader should rely on when deciding whether Find needs its own standing
indicator — it does not, but not because Raw is the only place an edit can start anymore.

**The one gap, recorded rather than hidden:** with the Raw pane hidden, a read-only document shows
only a disabled Save button (R7/8b) and no stated reason nearby. Save As *is* permitted on a
read-only document, so someone could be briefly confused about why Save is dead. Judged small —
an unsaved change can't exist without the Raw pane having been open at some point, so the disabled
button is the correct state and the question rarely arises. If it turns out to bite in practice,
the fix is a tooltip on the disabled Save button, not a permanent strip item.

**Also not built this round, and said so rather than left implied:** `nodepad.edit.clearUndoHistory`
exists and is palette-reachable (§3a's own "optional, worth considering" suggestion), but is not
wired to a button in the statistics panel — the panel only shows the figure the command would
free. A deliberate scope cut for this session, not an oversight; adding the button is a small,
separate follow-up whenever it's wanted.

### D-061 — React's dev performance tracks are disabled; the props architecture is kept · `settled`

Under `npm run dev`, any in-place store replacement — Format, Minify, an edit's reparse,
undo/redo, reload — wedged the renderer within a second and grew it past **12.6 GB** before it had
to be killed. Not the formatter: `format()` runs the same file in 385 ms, and the **packaged app
does the same Format in ~1 s with flat memory**. Full investigation and measurements in
`docs/plans/R19-document-props.md`.

**Cause.** A DEV `react-dom` runs `logComponentRender` on every commit; when a component
re-renders with a props object that isn't referentially identical to the last one — every
re-render, since JSX allocates fresh props — it builds a readable prop diff for Chrome's
"Components ⚛" track. That walk recurses three levels and enumerates with `for...in`, and
`for...in` over an `Int32Array` yields **one entry per element**. `Tree`, `Detail`, `Raw`,
`StatusBar` and `Scrubber` all take `document` as a prop, so it reaches `store`'s parallel typed
arrays and the row/line/name indexes. It cannot fire on a first open (a mount has no `alternate`
to diff), which is why only in-place replacements showed it, and it is stripped from production
builds, which is why no packaged app ever could.

**The decision, two parts.**

**1. Keep the shim (R19).** `src/renderer/devPerformanceTracks.ts` deletes `console.timeStamp`
before `react-dom` is evaluated, which makes React's `supportsUserTiming` gate false and the whole
logging path inert. Dev-only, and the production bundle is byte-identical before and after. The
cost is the "Components ⚛" and "Scheduler ⚛" DevTools tracks, which were never usable here —
recording one *is* the hang. **Known fragility, recorded rather than discovered later:** this
depends on a React internal, so a version bump could silently bring the hang back; there is no way
to assert the gate from inside the app. `test/devPerformanceTracks.test.ts` guards the one thing
that *can* be asserted — that the import stays first in `main.tsx`, ahead of `react-dom/client`,
since an import sort is the realistic regression.

**2. Keep the architecture.** Single session as the source of truth, renderer owns the model,
panes receive what they need as props (D-044's rule, unchanged). Passing a large object *by
reference* through props is ordinary React and costs nothing at runtime — React never deep-compares
props in production. `for...in` over a typed array to build a tooltip is a defect in React's
instrumentation, met by any application that holds typed arrays in state. This is not evidence the
design is wrong, and it was not treated as such.

**The finding that made this decision easy, and the one most likely to be re-derived otherwise:
narrowing the props does not help, and the codebase had already tried it.** `TreeContentProps`
types `document` as exactly three fields — but `Tree` passes `state.document`, and structural
typing narrows only the compile-time view, so the whole 26-field object flows through at runtime.
*A narrow type is not a narrow value.* Narrowing the value would also not have worked: passing
`store` directly puts the typed arrays one level **shallower** in a three-level walk. Only
primitives-only props avoid it. Therefore **R20 does not make R19 revertable** — splitting
`OpenDocument` leaves `store` reachable from some pane's props, which is all the walk needs.

**Rejected:** moving the panes to read the session via hooks instead of props — the only complete
fix, but it costs the props test seam R10 was built around (`test/statusBar.test.tsx`,
`test/treeExpansion.test.tsx`), is a large change to the most-hardened part of the UI, and closes
only this one path, since React DevTools' own inspector still serializes hook values on selection.
Also rejected: underscore-prefixing the heavy fields (works, unreadable, touches everything),
making the typed arrays non-enumerable (object spread would silently drop them, and
`{...state.document}` is the update idiom everywhere), and a `Symbol.toStringTag` on `NodeStore`
(React's recursion at that depth is unconditional for objects; the type name is only a label).

**Left open as R20, on its own merits.** `OpenDocument` mixes the stable model with constantly
churning bookkeeping, and nothing in the renderer is memoized, so `syncUndoContext` updating
`undoBytes` re-renders every pane. It doesn't hurt today — the expensive derivations are
`useMemo`'d on `store` — so R20 is **gated on a measurement first, and closing it as not worth
doing is an acceptable outcome.**

**Amended when tabs were planned:** R20's *measurement* still stands alone and runs first, but its
*implementation* folds into `docs/plans/R24-tabs.md` R24. The twelve-singleton refactor reshapes the
session anyway, and doing the same surgery twice is waste. R20 keeps its id and its home in
`docs/plans/R19-document-props.md`; only where the work lands changed.

### D-062 — Notifications replace the alert strip, which is deleted · `settled`

The strip under the title bar (`DocumentStatus`, M5d R3) is a row in normal flow, so every message
it carries reflows the three panes. Replaced by a notification layer — bottom-right, above the
status bar, `position: fixed`, auto-dismissing unless it carries actions. Plan:
`docs/plans/R21-notifications.md` (R21–R23).

**The strip is removed entirely, not shrunk.** Its four messages split by a rule worth stating
once: **events and pending choices become notifications; standing conditions stay where they are.**
A surface that auto-dismisses is the wrong home for a fact that remains true — dismissal would
remove the only indication. So Raw's read-only banner stays exactly where D-060/4b put it, and the
partial-parse warning is dropped rather than moved: R12's `⊗`/`⚠` status-bar counters already
render that fact, already clickable through to `nodepad.navigate.nextDiagnostic`, so the strip's
banner was a second display of something already on screen. One transient notification announces
the event; the status bar carries the standing state.

**What made this more than a layout fix.** `CONCEPT.md` §11.3's external-change prompt was never
built, because there was nowhere to put it: `documentSession.ts` sets `externalChangeDetected` and
exposes `hasExternalChange`, `keepMine` exists with **no caller anywhere outside that file**, and
no component reads either. A file changing on disk *while there are unsaved edits* — the one case
§11.3 says must never be silent — tells the user nothing and offers nothing. R23 closes it. A
fixed-shape strip meant anything that did not fit its shape simply did not get built, which is the
strongest argument against keeping it.

**Two design rules recorded because they are easy to get wrong:**

- **Choice notifications are derived from pending session state, not pushed events.**
  `pendingTransform !== null`, `externalChangeDetected`, minified-and-not-dismissed are each
  already a field meaning "a decision is outstanding"; the notification renders *from* the field
  and clears with it. A pushed choice can be dismissed while the state stays pending forever —
  precisely the position `externalChangeDetected` is in today — and state cleared by another route
  leaves a stale prompt behind. `DocumentStatus` already derives and gets this right; the
  mechanism outlives the component.
- **Notifications are document-scoped from day one**, with exactly one document open. It is a
  constant today and load-bearing under `docs/plans/R24-tabs.md`; retrofitting scope onto a queue that
  never had it means auditing every call site later instead of choosing once. Same call
  `M5d-PLAN.md` §4 made for the title bar.

**A notification action that resolves pending state must also be a command** (invariant 10).
`confirmTransformAnyway`, `cancelTransform`, `dismissMinifiedBanner` and `keepMine` are session
methods with no palette route — tolerable as buttons on an always-visible strip, not on a surface
that can collapse into "*N more*".

**`CONCEPT.md` amendments:** §5.7 (the minified offer's "non-intrusive banner"), §11.3 (the
external-change "non-blocking banner"), and §9.4's elevation budget, which lists "the minified-file
banner" among elevated transient surfaces. None change intent — all three asked for non-blocking,
non-modal messaging, which is what this builds — but they are recorded per `CLAUDE.md`'s working
agreement that a deviation gets written down, including when it is an improvement.

### D-063 — R20 measured and closed as not worth doing · `settled`

D-061 left R20 (splitting `OpenDocument` into model/file/status slices with slice-scoped
subscriptions) open, gated on a measurement, with "closing it as not worth doing" already named as
an acceptable outcome. `docs/plans/R24-tabs.md` R24 restated the same gate before its own twelve-singleton
refactor could fold R20's implementation in.

**The measurement (`docs/plans/R19-document-props.md` §5a results, `test/documentPropsRenderCost.test.tsx`)**:
real `React.Profiler` timing over the five panes' props-driven inner components
(`TreeContent`/`DetailContent`/`RawContent`/`ScrubberContent`/`ReadyStatus` — `Detail`, `Raw` and
`Scrubber` gained the export this round, matching `Tree`/`StatusBar`'s existing pattern), replaying
the exact shallow-copy `document` object a typing burst, a Format, and an undo/redo cycle each
produce. **Every pane does re-render on every unrelated field change, confirming the smell — but
the cost is negligible**: a ten-keystroke burst costs ~3.3ms of render time *summed across all five
panes*, and a single Format or undo/redo replacement costs ~2–5ms total. Nowhere close to a 16ms
frame budget, even without accounting for the fact that this is worst-case (every pane mounted,
every one profiled at once).

**R20 is closed, not built.** The slice split (§5b) is not implemented, `OpenDocument` stays one
flat interface, and `docs/plans/R24-tabs.md` R24 no longer inherits an obligation — it inherits this
recorded figure instead, exactly as D-061's own amendment anticipated. If a future measurement
under real document sizes or a slower machine shows a different number, R20's id and its home in
`docs/plans/R19-document-props.md` are still there to reopen against.

### D-064 — R24: the renderer spine is per-tab; `layoutStore` stays global · `settled`

`docs/plans/R24-tabs.md` §9 flagged two things to report rather than guess before building R24. Both were
put to the project lead; both are recorded here.

**`layoutStore` (pane visibility/sizing) is global, not per tab.** §11.4's "all document state is
per tab" read as though it should apply, but a per-tab layout means the window rearranges itself on
every switch — the project lead chose one layout for the whole window, matching how most tabbed
editors behave. No code changed: `layoutStore.ts` never referenced `documentSession`/`activeSession`
in the first place, so this is a decision to leave it alone, not a fix.

**The twelve singletons split three ways, not the two the plan's own table implied.** §1's table
called `commands/context` "derived" and the rest either "yes" (per tab) or "no" (global) — building
it found a third shape those two words don't cover: **gated-write-plus-resync**. `documentSession`
and `navigationStore` both *write into* `commands/context` from deep inside their own internal
control flow (dozens of call sites, `setContext('isDirty', ...)` and the like, scattered through
`applyEdit`, `undo`, `applyReparseResult`...). Turning either into "one instance per tab" without
addressing those calls would mean a background tab's own reparse landing silently overwrites
context the *active* tab's panes are reading. The fix, in both: a `setCtx`/`setContext` wrapper
gated on a new `isActive(): boolean` dependency (default always-true, so every existing direct
`createDocumentSession()`/`createNavigationStore()` call — every test included — is unaffected), and
a `resyncContext()` method `tabs.ts` calls immediately after `setActiveTab` forces every owned key to
be rewritten from the newly-active instance's own state. `activeSearchStore` and `findStore` needed
no such gate — neither ever touches `commands/context` — so they're straightforward per-tab
instances behind a lookup, the same shape `activeSession.ts` already used for `documentSession`.

**The four "controllers" (`treeController`/`gridController`/`rawController`/`rawViewportStore`)
needed zero changes.** §1 flagged them for checking, not assuming; checked: all four already
re-register (or, for `rawViewportStore`, explicitly clear) on the same `[store]`-keyed effect that
already fires whenever the active document changes — a tab switch is, to that effect, indistinguishable
from today's in-place reparse, which is exactly why nothing needed to change. One correction to the
plan's own table: it grouped `rawViewportStore` with the other three's "registered... unregistered on
unmount" shape, but it's a plain pub/sub with an explicit `clearRawViewport()` call, not a
register-returns-cleanup controller — a different mechanism that happens to be wired to the identical
lifecycle moment, confirmed by reading `Raw.tsx` rather than assumed from the grouping.

**`paletteStore` needed no change** — one palette, one window, never referenced document state.

Full write-up: `docs/plans/R24-tabs.md`'s own Results section.

### D-065 — The initial selection is the wrapper-descent destination; comments still don't stop a descent · `settled`

Opening `cars-10mb.xml` highlighted `Document` in the Tree while every other pane showed
`elements`. Plan: `docs/plans/R33-scrollbars-and-selection.md` §2.

**Cause.** `documentSession.ts` sets the initial selection to node 0, and the Detail view
*independently* descends through transparent wrappers (§4.3, D-015) to the first non-wrapper node.
Neither half is wrong; they simply never agreed on who decides what is being looked at.

**Decided: the initial selection is `resolveWrapperTarget(store, root).destination`.** The Tree,
Detail, breadcrumb and Raw then agree from the first frame, and the click the descent exists to
save stays saved. Note the knock-on, recorded rather than discovered: R8f made selection move the
caret to the node's span start, so Raw now opens scrolled to the destination rather than to byte 0.

**Rejected: stopping the descent at a node that carries a comment.** Proposed on the reasoning that
a commented node is "non-empty" and so not transparent. It breaks the feature's main case — one
comment anywhere in a wrapper chain stops the descent, so `cars-10mb.xml` would open on `garage`, a
node with a single child and no table, which is precisely the document grid mode exists for. A
stray comment would decide whether the application's signature feature appears at all.

`wrapperCompositeChild` ignores `Comment`/`ProcessingInstruction`/`DocType` children deliberately,
as *"pure document metadata, never a data field a consumer could lose visibility into"*, and
`CONCEPT.md` Appendix A names `garage` and `cars` as wrappers **that carry comments**. **The
distinction D-015 turns on is data vs. metadata, not empty vs. non-empty**: a comment does not make
a wrapper data-bearing, it makes it documented.

**The reported inconsistency is resolved by the selection change, not by the wrapper rule.**
Selecting `Document` or `garage` surfaced `garage`'s comment beside `elements`' children while
selecting `elements` did not — that is `skippedComments` honouring §4.3's "comments on skipped
nodes are not lost," and both behaviours were individually correct. With the initial selection at
the destination, the default view skips nothing and surfaces nothing; the case now arises only when
the user *deliberately* selects an ancestor, where showing that ancestor's comment beside the
compacted table is right rather than confusing.

**Implementation note (R33).** `transparentWrapper.ts` moved from `components/Detail/` to
`src/renderer/wrapperDescent.ts` — a peer of `nodeDisplay.ts` — since `documentSession.ts` is not a
component and importing from under `components/` the other direction would have inverted the
layering. A plain move: every export, its behaviour, and its tests (`test/wrapperDescent.test.ts`)
are unchanged, only import paths updated (`Tree.tsx`, `Detail.tsx`, `gridCell.ts`). The presentational
check §2c called for (does it read clearly when a pane shows an ancestor the user deliberately
selected?) was not reopened — D-050's breadcrumb marker and Tree auto-expand already cover it, and
nothing in this round's testing found it unclear.

### D-066 — The grid's quick filter stays scoped to visible columns, and says what it excluded · `settled`

Raised by the CSV question: with `GRID_COLUMN_CAP = 60`, what happens when a quick-filter match
lands in a column that isn't shown? Plan: `docs/plans/R34-wide-grids.md` §5.

**Today it is silently wrong.** `filterIndices` matches with `columns.some(...)` over the *visible*
set, so a row whose only match sits in an unticked overflow column is dropped. The grid appears to
answer "rows matching anywhere" and actually answers "rows matching in the 60 columns I happen to
be showing." Reachable now on any XML/JSON document past 60 columns, not just CSV.

**The fact that decided it:** `Ctrl+F` document-wide Find already covers "find anywhere," and the
grid *already* marks matching rows from it —
`hasMatchInRange(searchResult.starts, store.spanOf(row).start, store.spanOf(row).end)`, a byte-span
test that is column-independent by construction. D-038 had already separated the two deliberately
(`Ctrl+F` document Find, `Ctrl+Alt+F` grid quick filter). So the quick filter was never the
find-anywhere tool; a better instrument for that job already exists, is chunked and cancellable
(G3), and is already wired into the grid.

**Decided:** the quick filter keeps visible-column scope — "narrow the table in front of me" — and
**reports what that excluded**: `12 rows — 47 more match in hidden columns [show]`. The row-major
rewrite (§5) touches every field anyway, so restricting the match is one `Set` lookup per field and
the excluded count is free in the same pass. Clicking through reveals *the columns that actually
matched*, bounded by the result rather than the overflow list, which answers "why did this row
match?" without the layout shifting while the user types. **Columns are never auto-enabled during
typing.**

The real defect was never the scoping — it was that **the scope was invisible**. "Filter what is
shown" is a fine contract when the header row states it; it is not when the shown set is "the first
60 by appearance," which nobody chose and nothing said.

**Rejected: search all columns always.** Complete, but it duplicates `Ctrl+F` while being the worse
of the two (no navigation, no match count, not chunked), and it lets rows appear with no visible
reason why.

**Rejected: remove the quick filter.** Tempting — it is a third search mechanism in an app that
already has document Find and per-column filters. But `Ctrl+F` *marks* rows rather than filtering
them, and on a million-row grid marking is far weaker. That asymmetry is the quick filter's real
justification. **Noted for later:** extending G6's filter-to-matches from the Tree to the grid would
collapse the two into one concept, and is the cleaner long-term shape if this ever needs revisiting.

**Also rejected, in the same round: capping the number of pinned columns** (`docs/plans/R34-wide-grids.md`
§4). Pinned columns render outside the virtualizer, so an unbounded pin set is the one genuinely
unbounded rendering path in the grid — but a cap reads as an arbitrary restriction, and pin order is
legitimately used to arrange columns for reading or for a screenshot. Instead the mechanism
degrades: only pins that *fit* stay sticky, the rest become ordinary virtualized leading columns in
the same order. Sticky positioning is meaningless once pinned width exceeds the viewport anyway.

### D-067 — The tab strip overflows into Firefox-style controls, shown only when it overflows · `settled`

Raised from using the app with many files open: *"When many tabs are open, should we have vertical
scrolling in the tab bar?"* Plan: `docs/plans/R35-tab-overflow.md`.

Measured first (§1 there): 16 tabs in a 1200 px window put `scrollWidth` at 1920 against a 928 px
`clientWidth`, with every tab already at its 120 px `min-width` floor — about eight tabs fit. The
strip does scroll horizontally today, but nothing ever scrolls it: `Ctrl+Shift+Tab` onto tab 16
left `scrollLeft` at 0 with the active tab sitting at x 1800–1920, entirely outside the visible
range. **That defect (R35) is separate from and more important than any of what follows** — the
strip failing to move when you switch tabs is the app appearing to ignore a keystroke.

The shape, chosen with the project lead: `[<] [tabs…] [>] [⌄] [+]`. The chevrons scroll the
viewport by one tab per click without changing the active tab; `⌄` opens a list of every open tab;
the wheel over the strip scrolls it (which needs an explicit handler — `overflow-x: auto` alone
does not give it, measured). It is the arrangement people already know from Firefox, and the
chevrons serve as the overflow indicator, which is why no scrollbar is added to the strip.

**All three controls are hidden when every tab fits** — the project lead's call, extended past the
chevrons to the menu button on the same reasoning: when every tab is visible, a list of the tabs
tells you nothing you cannot already see, and permanent chrome for a usually-false condition is a
worse trade than one reflow at the eighth tab. The state cannot oscillate — adding the controls
narrows the scroll area, which can only increase overflow, and the no-overflow state is measured
with them already absent — but that needs a comment where the condition is computed, because it
reads as a bug otherwise.

At the ends the chevrons are **disabled rather than hidden**, the same distinction D-055 drew for
the title bar: a control that vanishes reflows the strip and destroys pointer muscle memory, and
here a greyed-out `<` also answers "is there more that way?" where a missing one is ambiguous.

**Rejected: a multi-row / wrapping strip** (Notepad++'s shape, which this project followed for the
quit flow). The strip's height is fixed and the panes are sized against it, so wrapping makes the
chrome grow and shrink as files open — moving every pane underneath, a larger disruption than the
problem. **Rejected: a vertical tab list in a sidebar** — a different product decision, and it
competes with the Tree pane for the same edge. **Rejected: a visible scrollbar on the strip** — the
chevrons are more discoverable and more clickable than a 15 px horizontal track. **Rejected:
shrinking tabs below the 120 px floor** — past that the labels are gone and every tab looks alike.

**Keyboard access to a specific tab is `Alt+1`…`Alt+9`, not `Ctrl+1`…`Ctrl+9`** (R37).
`Ctrl+1`/`2`/`3` are already pane focus (`commands/keybindings.ts`), which is a better use of them
in a three-pane tool; `Alt+<digit>` is free precisely because NodePad draws its own frameless title
bar and has no menu bar for Alt to activate. **Rejected — reported, not worked around: a searchable
"Go to Open Document…" palette entry.** `registerCommand` has no unregister, so one command per
open tab would leave a dead entry for every tab ever closed. Building it needs either a registry
unregister API or a picker mode in the palette; both are real design work past this round, and nine
fixed bindings cover the case people actually hit.

### D-068 — The grid's export distinguishes absent from present-but-empty, and classifies boolean columns exactly · `settled`

Reported from using the table: the `sunroof` column draws as a tick-mark column in the grid and
exports as entirely empty. Plan: `docs/plans/R39-grid-followups.md`.

`gridExport.ts`'s `cellText` is `cell.text ?? ''`, which maps both `CellKind.Absent` (drawn `—`) and
a presence-marker cell (drawn `✓`, an empty element with no value) onto the same blank field. The
file's own comment already recorded this as a v1 imperfection — *"absent and empty-but-present both
export blank, indistinguishably"*. What the report adds is that on a column where every present cell
is a marker, the imperfection is the whole column: the export carries no information at all. It
affects Copy CSV, Copy TSV and Copy Markdown alike, since all three go through `exportGrid`.

Two layers. Per cell, a presence marker exports a token rather than blank — that alone fixes the
report. Per column, if every present cell is a marker the column is boolean-shaped and `Absent`
exports as `false` rather than blank, which is what makes the result useful in a spreadsheet.

**The column classification is exact, not sampled — deliberately unlike `isNumericColumn`.** The
report asked whether the existing tick-mark detection could be reused; it cannot, because that is a
per-cell test (`text === null`), and the nearest column-level classifier, `isNumericColumn`, samples
(200 values, 5000 rows) because it must answer before the grid paints. Sampling is right there — a
wrong answer moves text alignment. It would be wrong here: a mis-sampled column puts `false` in the
output for a row that has no such field, which is wrong *data*, not wrong presentation. Export
already walks every row it emits, so it can afford certainty. **It must do so in a single pass** —
classify-then-serialize doubles the `cellOf` calls, and R34 measured `cellOf` as O(row fan-out) and
the dominant cost of a wide export; decoding once into a buffer with two flags per column costs
nothing extra.

Tokens diverge per format, as the file already does (`delimitedField` vs `markdownField`): CSV/TSV
get `true`/`false`, which spreadsheets parse natively and which that file's own comment names as the
target ("a spreadsheet or another program"); Markdown keeps `✓` and blank, being read by a person,
where reproducing what was on screen is the more faithful answer.

**Rejected: exporting the grid's own `—`/`✓` glyphs into CSV.** That is what the original comment
rejected and it was right — placeholder characters are worse than useless to a consuming program.
**Rejected: leaving it as a documented v1 imperfection.** Defensible while it cost a distinction;
not once it empties an entire column. **Not changed:** export stays scoped to visible columns
(`docs/plans/R34-wide-grids.md` §5 — that is about which columns, this is about what a cell contains), and
the literal/derived distinction stays unexported, being the same comment's other imperfection and
one that empties nothing.

### D-069 — The Raw view gets no "edit mode"; the `EditorView` stops being rebuilt instead · `settled`

Reported: typing in Raw makes the pane jump and loses the caret, so typing cannot continue. Plan:
`docs/plans/R41-raw-editing.md`.

Measured in real Electron with the `.cm-content` element tagged beforehand: at +75 ms the pane's
`scrollTop` moves from 0 to 96 with the editor still alive, focused and holding its selection; at
+358 ms the element is **replaced**. The debounced reparse (~200 ms) produces a new `NodeStore`, and
`Raw.tsx`'s mount effect is keyed on `[store]` — so every reparse of the same document destroys and
rebuilds the editor, taking focus, selection, scroll and CodeMirror's internal state with it.

This is `M5g-PLAN.md`'s O4 Raw half, already deferred once with its fix shape fully specified in
`M5g-RESULTS.md` (four extension modules converted from closed-over values to live getters, plus a
second effect that re-slices the window without destroying the view). It was deferred because it is
surgery on the most hardened part of the codebase **and** because that session had no live GUI to
drive the result. The second reason no longer holds. It now carries three independent motivations
rather than one: the caret loss, the ~2.5 s minified tab switch (`docs/FINDINGS.md`), and M5g's
original point that the rebuild is wasted work.

**Scoped to same-document reparse.** Keeping a live `EditorView` per *tab* — which is what would fix
the tab-switch cost — multiplies CodeMirror's ~1 MB UTF-16 window (invariant 1's bounded exception)
by the tab count, into R28's cross-tab budget. A separate, larger decision, deliberately not taken
here.

**Rejected: a Raw "edit mode" that handles updates differently while typing.** The debounce already
is that mode; the defect is that its end is destructive, not that it is absent. A longer or
manually-ended mode keeps every other view stale for as long as the user keeps typing, still
destroys the caret when it ends, adds a state to the project's most bug-fixed state machine, and
does nothing for the other two motivations.

**Rejected as the primary fix, kept as an interim: capturing and restoring selection + scroll around
the teardown.** It restores a position rather than the editor, so an in-progress IME composition, a
selection drag and CodeMirror's own undo entries are still lost; it flashes at every debounce
boundary, which is most of what "feels jumping" is; and it leaves the +75 ms scroll jump — which
fires first — untouched. Reach for it only if the real fix turns out to be blocked.

### D-070 — The pending-delta list is wired into the UI read paths · `settled`

Reported from typing in Raw: a value edited at its start renders truncated in the other views until
the reparse lands ("`abcdef` … I'll see `axxxbc`"). Plan: `docs/plans/R42-stale-spans.md`.

**This decision reverses a standing one, and the reversal is the whole content.** `applyEdit`'s own
comment has recorded the gap accurately since F3: `core/deltaList.ts` "is not wired into any UI read
path," so between an edit and the debounced reparse the store, row index and line index are the
previous parse's while the buffer is current. It was parked with a stated premise — "the debounce
window this describes is short (~200 ms) **and this has not been reported as a visible problem in
practice**." The analysis was right and the scoping was right; the premise has now failed. Nothing
needs re-deriving, only re-deciding.

Measured before deciding (`docs/plans/R42-stale-spans.md` §2), and there are two symptoms, not one. The
edited node is truncated to its **old byte length**, which is the reported one. Every *following*
node's preview is also short by the inserted length, so it slices from inside the previous closing
tag: `<year>2016</year>` renders as `ar>2`, `<owner>Weber</owner>` as `er>We`. The second is worse —
truncation shows less of the right answer, this shows markup fragments presented as a node's value —
and it was not in the report.

The fix is plumbing, not new machinery: `shiftedOffset` already does the translation in O(log n) and
its coordinate space is pinned down in its own header. **It must go in at one seam rather than at
every `spanOf` call site** — a per-call-site fix rots by omission, and the failure mode is silently
plausible offsets, which is what that module's header says it exists to make rare.

Two boundaries recorded so they are decided rather than discovered. `shiftedOffset` is undefined for
an offset *inside* a replaced region, so a replacement (paste, type-over-selection) has spans with no
correct answer until the reparse — those must degrade to briefly *stale*, never briefly *wrong*.
And `fold` cannot add or remove row-index entries, so an edit that inserts or deletes a newline
changes the row count and `fold` alone silently produces the wrong number of rows (already pinned by
a regression test) — R42 either restricts itself to the row-count-preserving case or routes through
`subtreeSplice`, which owns that case.

**Rejected: shortening the debounce** — moves the window instead of closing it, and trades the glitch
for a reparse per keystroke, which is what F3 exists to prevent. **Rejected: reparsing synchronously**
— the same trade at its worst. **Rejected: blanking or freezing the affected fields during the
window** — honest and much cheaper, but it flickers every view on every keystroke, a worse version of
the "jumping" already complained about, and it discards content that is already correct for every
node the edit didn't shift. **Rejected: continuing to do nothing** — the standing decision, on a
premise that no longer holds.

**Addendum — the one-seam rule, tested against a real alternative.** R42 shipped with Raw's
decoration rebuild reading `pendingSpanDeltas` one keystroke stale (CodeMirror runs view plugins
before update listeners, and `rawEdit`'s listener is what records the delta), which R42's own review
found and deferred, and which the project lead subsequently reported as a visible one-character
highlight shift while typing. The fix is a second `bumpDecorationsEffect` trigger.

**The alternative worth recording is composing the shift from CodeMirror's own `update.changes`
inside the decoration plugin** — exact, single-pass, and right the first time rather than the
second. **Rejected**, and this is what §3a's "one seam" is actually for: it would give one read path
its own way of computing the translation, which is the failure mode `deltaList.ts`'s own header
names and the reason `spanTranslation.ts` exists as a single function. A seam that a caller may
bypass when it has better local information is not a seam. Detail:
`docs/plans/R42-stale-spans.md`'s addendum.

### D-071 — The grid derives its column widths and its height instead of hard-coding them · `settled`

Two reports about the table wasting space, decided together because they are the same shape: a fixed
constant where a measurement belongs. Plan: `docs/plans/R43-grid-sizing-and-scroll.md`.

**Columns.** `CELL_WIDTH = 160` is every column's width, so a four-character `year` occupies as much
room as a composite `engine` summary. Widths become content-derived, sampled per column and cached
per `nameId` — reusing the bounded sample `isNumericColumn` already takes rather than adding a second
scan over the same rows, which is the shape R34 spent a round removing. The header's own name is part
of the input, since a short column with a long header is what a naive content-fit gets wrong.

**The estimate is acknowledged to be an estimate.** The grid's font is proportional, so a character
count is not a measurement, and some column will be visibly wrong. That is the case for building
drag-resize alongside it: a heuristic that is wrong occasionally is fine when the user can drag, and
a permanent annoyance when they cannot. Derived widths land first — resize without them still starts
every column at the wrong size. Double-click resets to derived, which also supplies "fit to content"
for free.

**Height.** `.detail-grid-container`'s fixed `height: 480px` neither grows into a tall pane nor
shrinks into a short one; on a small window it forces `.detail` itself to scroll, so there are two
nested vertical scrollbars and the one you grab first is usually the wrong one. It becomes `flex: 1`
with a `min-height` floor of roughly eight rows plus the header. The floor is what keeps this honest
— without one, a short window with a long Attributes section leaves a two-row table, which is worse
than today.

**Rejected: a taller fixed height.** It is the same decision made again with a different number, and
it fixes neither direction. **Rejected: sizing columns by measuring every cell.** Exact and
unaffordable — `cellOf` is O(row fan-out) and the table can be a million rows; bounded sampling is
the established answer in this file for exactly this question. **Consequence recorded rather than
discovered:** a variable height means the row virtualizer's viewport changes on every pane resize, so
that path gets exercised far more than today — a correctness question, and one that deserves a test
at more than one pane height.

### D-072 — The lint gate ratchets on a stated warning count, rather than zero or an error severity · `settled`

From reviewing R47–R50. Plan: `docs/plans/R54-signal-followups.md`.

R47 removed 5,363 CRLF warnings that had made `npm run lint` unreadable, and fixed the four real
errors they were hiding. It did not change what the command *gates* on: `eslint --cache .` has no
`--max-warnings`, and `prettier/prettier` arrives as `warn` from the shared config, so the command
exits 0 at 37 warnings and would exit 0 at 370. R49's CI gates on that command. **The mechanism R47
diagnosed — a signal accumulating noise until nobody reads it — is intact; only its current
contents were cleared.**

Chosen: clear the 34 auto-fixable Prettier warnings, then `--max-warnings 3`, with the three
survivors named. They are `react-hooks/incompatible-library` from `useVirtualizer` — the React
Compiler declining to compile a hook it cannot analyse, which is TanStack's code behaving normally
and nothing this repository can fix.

**Rejected: raising `prettier/prettier` to `error`.** It reads stricter and is worse: a formatting
nit and a genuine hooks or type violation become indistinguishable in the output, which is the
readability problem this round exists to prevent, inverted.

**Rejected: `--max-warnings 0`.** It buys a rounder number for either inline disables in production
files — noise added to satisfy a counter — or a wait on an upstream change nobody here controls. A
number with a written reason next to it is more honest than a zero achieved by suppression.

**The obligation this creates, recorded because it is the whole point:** `3` is a claim that exactly
three warnings are known and explained. A later round that legitimately adds a fourth moves the
number *and* records why beside it. A silently-bumped number is D-072 failing in the same way R47's
"existing baseline" did.

---

### D-073 — R26's `close`-interception is unit-tested against extracted logic, not through Playwright's `_electron` · `settled`

From R51. Plan: `docs/plans/R51-main-process.md`.

R51's own plan recommended Playwright's `_electron` for "the few behaviours that are genuinely about
Electron itself — the `close` interception in particular." Measured directly: a `BrowserWindow
.close()` call issued through `_electron`'s automation tears the window down regardless of
`event.preventDefault()` in the `close` handler. Isolated with a standalone, non-Playwright Electron
script running the identical prevent-default logic against a `data:` URL window — outside
Playwright's automation, the window correctly stays open, confirming this is `_electron`'s own
limitation and not a bug in `main/index.ts`.

Chosen: extract the guard (`handleWindowClose`/`confirmQuit`) into `src/core/mainQuitFlow.ts`, no
Electron import, and unit-test it directly against plain objects —
`test/mainQuitFlow.test.ts` covers the intercept → `confirmQuit` → proceed sequence and the
`WeakSet`'s per-window isolation, none of which `_electron` could exercise at all.

**Rejected: testing it through `_electron` anyway, accepting the false failure.** A test that cannot
pass for a reason unrelated to the code under test is worse than no test — it either gets skipped
(silent, drifts unnoticed) or gets "fixed" by someone weakening the very assertion it exists to make.

**Rejected: leaving the `close` handler untested.** It is the one behaviour R51 names by name as
needing coverage — the plan's own reasoning for why still holds, only the *route* was wrong.

Recorded in `docs/FINDINGS.md` too, since this is exactly the kind of trap that bites someone
reaching for `_electron` on unrelated future work.

---

### D-074 — `Interner.lookup` encodes a query by probing and inverting `TextDecoder`, not a new transcoding dependency · `settled`

From R53. Plan: `docs/plans/R53-interner-encoding.md`.

`TextEncoder` is UTF-8 only, by spec — there is no built-in "encode to windows-1252" in the platform,
and a document's own name bytes must be compared in its actual encoding (invariant 7: never
transcoded to UTF-8). The obvious fix reaches for a general transcoding library (`iconv-lite` and
similar), but `CLAUDE.md`'s own "no new dependencies without asking" applies, and the project has
never needed one for anything else.

Chosen: `core/textEncode.ts`'s `encodeText` handles UTF-8 (`TextEncoder`) and UTF-16LE/BE (a direct
code-unit write — a JS string already *is* UTF-16) natively, and every other declared encoding by
probing `TextDecoder` once per label — decode all 256 byte values, invert the resulting map. A
genuine single-byte code page (`windows-1252`, `iso-8859-1`, every encoding this project's own
`detectEncoding`/XML-prolog declaration path actually produces) round-trips through that inversion
exactly. `TextDecoder` already ships with the runtime and already knows dozens of encoding labels;
this reuses that knowledge instead of duplicating it in a lookup table this project would have to
maintain.

**Rejected: a new dependency (`iconv-lite` or similar).** Would handle genuinely multi-byte,
non-UTF encodings (Shift-JIS, GBK) that the probe-and-invert approach cannot — but no fixture, no
`detectEncoding` path and no XML-prolog declaration this project has ever produced needs one, and
the working agreement requires asking before adding a dependency for a need that hasn't materialized.

**Rejected: decode stored names and compare as strings.** `interner.ts`'s own header states the
reason first: "comparison on hash collision is done on raw bytes, never on decoded text — decoding
is reserved for `text()`, called lazily and cached." Comparing as strings would decode on every
lookup, against a class whose whole design avoids exactly that.

**What this doesn't cover, stated rather than discovered later:** a real multi-byte non-UTF encoding
correctly produces `'unrepresentable'` for *any* character (even ASCII-adjacent ones the encoding
could in principle carry), since the 256-byte probe's shape check (`decoded.length !== 256`) rejects
the whole encoding, not just the specific unrepresentable character. No such encoding has ever been
declared in a fixture or reachable through this project's own encoding-detection path; if one is
needed later, that is the point to reconsider a real transcoding dependency, not before.

---

### D-075 — R59's zoom replaces R58's `did-finish-load` reset outright, rather than keeping both · `settled`

From R59. Plan: `docs/plans/R58-zoom.md` §3/§4.

R58 fixed the built app's unexplained 1.25 startup zoom with `mainWindow.webContents.once
('did-finish-load', () => mainWindow.webContents.setZoomLevel(0))` — a main-process, event-driven
reset to a hardcoded value. R59 needed the renderer's own persisted zoom applied on every boot
instead, and R58's own plan named the constraint this decision resolves: "it must be written so that
R59 can replace the constant with a restored setting rather than fight it."

**Keeping both was considered and rejected as a genuine race, not just redundant work.** The
renderer's own `zoom.ts` applies its persisted value eagerly at module load, via an `ipcRenderer
.invoke` round trip — asynchronous, and not ordered against main's `did-finish-load` event in any way
this project controls. If a persisted 150% zoom were applied by the renderer *before* `did-finish
-load` fires, the old handler's unconditional `setZoomLevel(0)` would silently stomp it back to 100%
immediately after. The two mechanisms disagreeing about who owns the final value is exactly the kind
of bug that would reproduce rarely, depend on IPC scheduling, and be maddening to reproduce on demand.

Chosen: delete the `did-finish-load` handler. `zoom.ts`'s own eager `apply(current)` call — defaulting
to `1` when nothing is persisted, exactly the value the old handler hardcoded — is a strict superset
of what R58 built, reached a different way. `test/mainElectron.test.ts`'s R58 acceptance test
(`getZoomFactor() === 1` after a fresh `file://` load) still passes against the built app; it now
polls briefly rather than asserting immediately, since `waitForLoadState('load')` only guarantees the
renderer's IPC call was *dispatched*, not that main has finished handling it — the same async-ordering
fact that motivated removing the old handler in the first place.

**Rejected: keeping the `did-finish-load` handler as a "belt and suspenders" first coat, overwritten
by the renderer's own call whenever it lands.** This only works if the renderer's call is guaranteed
to run *after* `did-finish-load` — which is exactly the ordering this decision's own analysis found
isn't guaranteed either way. A "defensive" fallback that can silently overwrite the real value instead
of merely preceding it is worse than no fallback.

---

### D-076 — R57's `info` severity keeps a sub-3:1 hairline, and the plan's "background differs from
the pane" test is scoped down · `settled`

From R57. Plan: `docs/plans/R57-notification-emphasis.md` §4.

The plan's own acceptance section asked for two things that, measured rather than assumed, turned
out not to hold given the actual token values — both found while writing the tests §4 itself called
for, not invented as a reason to skip them.

**`info`'s contrast.** §4's acceptance point 3 says "edge-vs-surface contrast ≥ 3:1 for every
severity," but the plan's own worked table (§4's "Contrast, to be asserted rather than assumed")
only ever computed *warning's* number. `info` has no severity colour at all — its edge is the plain
`--surface-border` hairline — and measuring it found 1.31:1 in light and **exactly 1:1 in dark**,
where `--surface-border` and `--elev-2-bg` resolve to the identical token (`--gray-700`). Not a
regression: `info` never had a colour to draw a border from, and depended on the shadow alone before
R57 too (§2's own "separated by a soft shadow and nothing else"). Fixing it means raising
`--surface-border`'s own contrast against `--elev-2-bg`, which is not a notification-local change —
every other bordered surface in the app shares that token, the same "correct blast radius" argument
§4's own "What R57 does not do" section already uses to decline touching `--elev-2-shadow`.

**The background-vs-pane test.** §4's acceptance point 4 asks for the notification's
`background-color` to differ from the pane behind it "in both themes." §2's own measurement is that
light theme's `--elev-2-bg` *is* `--surface-bg` (`--gray-0`), and nothing in §4's CSS diff touches
either token — confirmed directly with `getComputedStyle` (`rgb(255, 255, 255)` both sides) rather
than reasoned about. The two cannot differ without a token change this round doesn't make.

**Chosen: disclose both, test what is actually true instead of what the plan assumed.** The
`≥ 3:1` assertion is scoped to warning/error (the two severities with a real colour); a separate test
pins `info`'s sub-3:1 ratio down in both themes, including dark's exact 1:1, as a known case rather
than one nobody checked. The background-equality test asserts equality in light and inequality in
dark explicitly, plus a real border-presence check in both — the actual boundary the round delivers,
independent of whether the two backgrounds happen to coincide.

**Rejected: quietly narrowing the acceptance criteria without recording why, or weakening the
assertions until they passed.** Either would have looked identical to a clean pass from outside the
diff, and the next person to touch `--surface-border` or `--elev-2-bg` would have no record that
`info`'s boundary and the background-equality question were ever real, measured findings rather than
untested assumptions.

**Rejected: fixing `--surface-border` locally, inside `Notifications.css`, to clear 3:1 against dark's
`--elev-2-bg`.** Would desynchronise one component's hairline from the token every other bordered
surface uses, the same failure mode invariant 9 exists to prevent for elevation pairs. A real fix is
a `themes/dark.css` token decision, not a local override — recorded as future work, not attempted
here.

### D-077 — Dark elevation is carried by a border plus a small background step, not a large
background step alone · `settled`

From R60. Plan: `docs/plans/R60-dark-elevation.md`.

D-076 recorded `--surface-border` and dark's `--elev-2-bg` as the identical token (`--gray-700`,
exactly 1:1) and declined to fix it locally, naming the real fix as a `themes/dark.css` token
decision. R60 is that decision. `CONCEPT.md` §9.3 gave elevation exactly two mechanisms — light
steps the background near-white and leans on shadow, dark drops shadow and steps the background
progressively lighter — and never considered a border, because R57's border predates §9.3's last
edit and nobody had connected the two. A border reads equally well on both themes, which is exactly
what neither shadow nor a background step manages alone; once it's available, dark's background step
doesn't have to carry elevation by itself.

**Chosen: give the whole `--elev-2-bg` tier the hairline first (six files had none — Find, the
palette, the statistics panel, the tab-strip overflow menu, both grid dropdowns — R57 had fixed only
`.notification`), then drop dark's `--elev-2-bg` from `--gray-700` to `--gray-850`.** Order matters:
darkening the background before the border exists everywhere would have turned six invisible-in-light
surfaces (white-on-white, `--elev-2-bg` == `--surface-bg` there) into six invisible-in-*both*
surfaces. `--gray-850` was chosen over the lighter `--gray-800` candidate for a measured reason, not
a taste one: `--elev-1-bg` **is** `--gray-800`, so `.notification-action`'s pills would become the
same colour as the panel they sit on and lose their fill entirely. `--gray-850` is the lightest value
that keeps the panel below `--elev-1-bg`, and it adds no new ramp entry — dark's `--row-alt-bg`
already uses it.

**Rejected: raising `--surface-border` instead of lowering `--elev-2-bg`.** Would have fixed the
invisible-hairline half of the complaint while leaving the four-step "very gray" fill exactly as
loud — that fill, not the missing frame alone, is what the original report actually named ("very
gray next to VS Code's").

**Rejected: `--gray-800` for `--elev-2-bg`.** Measured and rendered; fails because `--elev-1-bg` is
already `--gray-800`, collapsing the panel and its own action buttons into the same colour.

**`CONCEPT.md` §9.3 amended**, not replaced — its premise (elevation is a token pair; shadow alone
fails on dark) survives; only its enumeration of *which* tokens carry the pair gains a border as a
third mechanism, recorded as belonging to the tier rather than to any one component.

### D-078 — R62's grid header keeps F6/Ctrl+1/2/3 as the pane-focus model, and adds a header
"row" to the grid's own arrow navigation rather than a second focus scheme · `settled`

From R61–R64. Plan: `docs/plans/R61-keyboard-workflow.md`.

Four small decisions worth recording together, since they're one implementation pass:

**F6/Ctrl+1/2/3 are kept as-is; nothing new is added beside them (§3's own "Refinement").** The
report's proposed `Ctrl+←/↑/↓` spatial rebinding was rejected: `Ctrl+←/→` is word-jump caret motion
in every text field, `Ctrl+↑/↓` is already `nodepad.navigate.drillUp`/`drillDown` and a better use of
that combo in a tree tool than pane focus, `Alt+←/→` is already history back/forward. The actual fix
is discoverability, not a new binding — R63 puts `Ctrl+1/2/3` in each pane's tooltip instead.

**The grid header's Pin/sort-label controls get `tabIndex={-1}` and become reachable through the
grid's own `onKeyDown` via a header "row"** (`active.row === -1`, reached by ArrowUp from row 0),
not a second, separate focus/roving-tabindex system layered next to the body's. `Enter` toggles sort
on the header row (mirroring what it already does in the body — activate whatever's under the
cursor); a bare `P` toggles pin, chosen over `Shift+Enter`/`Ctrl+Enter` (which read as "insert a
line"/"submit" everywhere else) — safe as a bare key here because focus lives on a non-text-input
`div` where a printable key means nothing else, the same reasoning `keybindings.ts`'s own capture-
phase rule gives for why *global* bindings must carry a modifier but a widget-local one need not.

**Detail's breadcrumb segments and the grid toolbar's filter/CSV/TSV/MD buttons are roving-tabindex
groups** (`src/renderer/rovingTabIndex.ts`, new, shared by both) — ArrowLeft/Right/Home/End move
which member carries `tabIndex 0`. `Copy path` and the column-picker button stay their own ordinary
stops, matching §3's own text ("filter, the three copy commands") rather than folding every button
in the toolbar into one group.

**Rejected: teaching `Tab` itself to move between panes.** Considered and dropped for three reasons
recorded in the plan: it's the platform's own focus-traversal key and every assistive technology
assumes it; R61 needs Tab *inside* Raw for indentation, so a global Tab-switches-panes binding would
directly conflict with the other half of this same round; F6 already is the convention (Explorer,
Firefox, Chrome, GTK/GNOME, KDE alike) and has existed in this app since M1.

**Detail's non-grid (list) mode gets no arrow-key row navigation in this round** — named in the plan
as "the lowest-value part of this task," and left open rather than built, since the grid (the actual
reported use — "navigating the table") already has full arrow/Home/End/PageUp/PageDown coverage.

### D-079 — R65's shortcuts panel reads `getAllCommands()` filtered by surface, not
`commandsForSurface`'s live-`when` view · `settled`

From R65. Plan: `docs/plans/R65-shortcuts-help.md` §3.

§3a's own requirement is that the derived (command) half of the panel "cannot drift from what the app
actually does." The first draft satisfied that literally — `commandsForSurface('palette', context)`,
the same call the palette itself makes — and it was wrong anyway: `commandsForSurface` filters by
`when` against the *live* context, so a command that's momentarily unavailable (no document open,
wrong pane focused) drops out of the list entirely. A reference panel behaving that way means the
chord for "Save" disappears from the shortcuts help exactly while nothing is open to save — the
opposite of what "cannot drift from what the app does" is asking for, since the app still *has* that
binding, it just can't fire right now.

**Chosen: `getAllCommands()` filtered to `surfaces.includes('palette')`, unfiltered by `when`.** Every
command that could ever appear on the palette gets a permanent row in the panel, exactly mirroring
D-055's "disabled, not hidden" rule for the title bar — a button that disappears when momentarily
unusable destroys the user's spatial memory of where it is; a shortcuts entry that disappears the same
way destroys their memory of what the chord even was.

**Rejected: keeping `commandsForSurface` and accepting the flicker.** Would have technically passed
§6 acceptance 1 (every `DEFAULT_KEYBINDINGS` entry resolves to a *registered* command) while still
failing the actual spirit of §3a, and a test asserting "the panel's contents don't depend on which
document happens to be open" would have caught it anyway — better to fix it before writing that test
than to write a weaker one that avoided the question.

### D-080 — R70's Find bar anchors to `.layout`, not the viewport `App.tsx` shell the plan named ·
`settled`

From R70. Plan: `docs/plans/R69-focus-and-find.md` §2.

§2 says to hoist `<FindBar />` "to the app shell, beside `<Palette />` in `App.tsx`." Built one layer
lower instead: a direct child of `Layout.tsx`'s `.layout`, which now carries `position: relative` as
`.find-bar`'s own `position: absolute` anchor.

The plan's own text already flagged the real risk — "this is not just a move... Hoisted, it needs an
answer for 'Raw is not there.'" What it didn't separately flag is a second risk in the *literal*
instruction: `Palette`'s own overlay is `position: fixed` to the viewport and gets away with it
because it centers via `padding-top: 12vh` — a unit that doesn't care where the title bar's actual
pixel height is. A persistent, top-right-anchored bar doesn't have that luxury: R8e's whole reason for
existing was that a viewport-`fixed`, top-right `.find-bar` landed under Windows' caption-button
overlay once the drawn title bar shipped, and nothing in this app's CSS exposes the title bar's actual
height as a token to offset against safely.

**Chosen: `.layout` as the `position: relative` ancestor instead of the viewport.** `.layout` already
sits entirely below the title bar and tab strip (`Layout.css`'s own `flex: 1`, M5d-PLAN.md R1) for
structural reasons unrelated to Find, so anchoring there inherits R8e's fix for free — no pixel offset
has to guess the title bar's height, the same property `.raw-container` (the pre-R70 anchor) had by
being nested even deeper. The functional goal §2 actually cares about — Find visible and working
regardless of Raw's own visibility — is achieved exactly the same either way, since `.layout` renders
whenever the app shell does, independent of `layoutStore`'s pane-visibility flags.

**Rejected: `App.tsx`, `position: fixed`, literally as written.** Would reintroduce the caption-button
collision R8e fixed once already — this environment has no display to confirm that empirically (`docs/FINDINGS.md`'s
own "GUI behaviour is largely unverified"), which is exactly why it wasn't risked: the failure mode is
silent (nothing throws; the bar just renders under opaque OS-painted pixels) and the fix already has a
proven, structurally justified alternative one layer down.

### D-081 — R75: `copyPathFor` always emits the NodePad query grammar, replacing the XPath/JSON
Pointer choice keyed on `hasAttributes` · `settled`

From R75. Plan: `docs/plans/R72-path-query.md` §4.

`copyPathFor` picked `toXPath` or `toJsonPointer` from `capabilities.hasAttributes` — plausible-
looking (every format M1 ships happens to have `hasAttributes` true exactly when its shape is
element/attribute-based), but `hasAttributes` was never actually a statement about path *syntax*.
Measured end to end: XML's Copy Path round-trips into the palette's `/` mode (`toXPath`'s single
leading `/` is consumed as the mode prefix, the rest is already valid grammar); JSON's silently
doesn't, because JSON Pointer addresses an array element with a bare numeric segment (`/list/1`) and
the query grammar reads every segment as a *name* — `1` resolves to `nameId: null`, and the query is
answerable as empty without the evaluator ever touching the store. `detailModel.ts`'s own comment on
`copyPathFor` already named the real trigger for revisiting this: "a third format whose path syntax
doesn't line up with its attribute-having-ness … is a real reason to add [a capability], not to keep
stretching this." R75 is that reason arriving, one milestone early — JSON already doesn't line up.

**Chosen: a new `toNodePadPath`, and `copyPathFor` calls only that, for every format.** Not a small
edit to `toXPath` — `toXPath` has its own real defect this surfaced: `pathSegmentsOf` only computes
`sameNamePosition` by comparing siblings' *names* (`store.nameOf(sibling) === name`), so a JSON array
element (`name === null`) always gets `sameNameCount === 0` and prints as a bare `*`, indistinguishable
from every other element in the same array — position was simply never captured for the null-name
case. `toNodePadPath` uses `siblingIndex` (already computed, "position among ALL of the parent's
children") for exactly that case instead: `*[3]`, which the grammar already parses natively (a
wildcard step with a positional predicate needs no name). `toXPath`/`toJsonPointer` themselves are
untouched and still independently tested — this is a new function, not a rewrite of the old ones,
since nothing here needed either to change and other code may still want XPath or JSON Pointer's own
shape specifically.

**`copyPathFor` drops its `capabilities: FormatCapabilities` parameter.** Once the choice is gone,
the parameter has no remaining use — kept it would be exactly the kind of dead parameter the project's
own conventions say to delete rather than leave as a vestige of a decision that no longer holds.

**Rejected: offering both (`Copy Path` / `Copy JSON Pointer` as two commands), with the grammar-
compatible one as default.** The plan's own second option, and reasonable — but adds a second
palette/title-bar command for a shape (JSON Pointer) nothing in this codebase currently consumes,
against a first option that costs nothing beyond the one function and closes the actual reported gap.
Worth building if a real JSON Pointer consumer shows up; not speculatively.

### D-082 — Find's byte/decoded case-fold divergence is accepted as-is; only the footnote's
condition and wording change (R72 §6, R76) · `settled`

From R72 §6 (which folds R76 into the same decision — see below). Plan: `docs/plans/R72-path-query.md` §6.

Measured (`core/textFind.ts`'s own module comment, `test/textFindConfusables.test.ts`): the byte
path's case-insensitive compare is ASCII-only folding (`A-Z` ↔ `a-z`); the decoded path uses JS
`String.prototype.toLowerCase()`. Across U+0020–U+2FFF, brute-forced pairwise, **154 pairs disagree**
— and neither path is a superset (84 the regex/decoded path finds and plain misses; 70 the reverse).
Every one of the 154 involves a non-ASCII needle; **zero divergences for any ASCII needle across the
whole range**, confirmed against the real `findAll` on realistic text via the checked-in
`test/fixtures/confusables.xml` (a tracked, hand-sized fixture — `spike/fixtures/` is untracked and
regenerable, wrong for a test whose only value is an exact count, and the existing
`nonascii-10mb.xml` has half of each divergent pair but not both, so it cannot show this at all).

**Chosen: accept the divergence in the fold itself; fix only the UI note that describes it.** A real
fix means one shared case-folding implementation across both paths — genuinely more work than it
looks (see the round-trip-fold measurement below) — for input this project's own documents are
unlikely to be searching (tag/attribute/property names and English content are ASCII, where the two
paths already agree completely). The footnote's own condition was close to backwards before this
round: it rendered on *every* plain case-insensitive search (including every ASCII one, where
disagreement is structurally impossible) and was hidden exactly when regex was on, one of the two
modes it describes. Reworded to two symmetric messages, keyed on `!caseSensitive &&
!isAsciiOnly(needle)` (`textFind.ts`'s own exported predicate, so the note and the behaviour can't
drift) — the only region where a divergence can occur at all, so the note now appears for almost no
search instead of almost every one, which is what makes it credible when it does appear.

**R76 folded into the same decision, not treated as independent**: `indexOfCaseInsensitive` compares
a fixed-`needle.length` slice, so a character whose lowercase mapping changes length (`İ` U+0130 → two
code units) can never match on the decoded path regardless of needle — a case *neither* path
expresses, not a disagreement between them. Documented as the module's own third limit
(`core/textFind.ts`), not fixed, because the natural-looking fix (`toUpperCase().toLowerCase()`
instead of plain `toLowerCase()`) turns out to need this fixed first: round-trip folding cuts the 154
divergent pairs' underlying wrong-fold count from 94 to 6 against Unicode simple case folding as the
reference, but 91 single characters in this range change length under that fold — against a handful
under the current one — so adopting it would make R76 the *dominant* failure mode instead of an edge
case. The two have to move together; fixing R76 first is the prerequisite, not an independent tidy-up.

**Rejected: the regex `u` flag as a quick partial fix.** Fixes 58 of 154 by switching JS from
`Canonicalize` to real Unicode case folding, but leaves 96, and — worse — rejects Annex B loose regex
syntax (`\-`, `a{`, `[a-\d]`) that parses fine without it; `decodedTextMatches` catches that throw and
returns `[]`, so a user's own working regex would silently start reporting zero matches. A worse
failure than the one it fixes.

**Rejected: NFKC normalization.** Gets all five example pairs right (including `ß`/`ẞ`, which the
round-trip fold breaks) but disagrees with case folding on 2112 pairs in the same range, because it
deliberately equates *compatibility* variants (`²` with `2`, fullwidth `Ａ` with `A`) — a real behaviour
change for a tool whose premise is byte-faithful inspection, not a narrower fix.

**Rejected (for this round): flagging confusable characters in the document itself** (the VS Code
approach, UTS #39). The better long-term framing — ambiguity is a property of the *content*, not of
the search, and every attempt to fix it in the fold either misses cases or over-matches because the
fold cannot know which look-alikes were *meant* to be the same — but it's real, scoped work (a
decoration pass plus, eventually, a confusables data table) belonging to its own round if reopened,
not bundled into a footnote-wording fix.

### D-083 — the current-match highlight is a ring, not a fill; `--find-match-current-bg` splits
three ways (R80) · `settled`

Plan: `docs/plans/R78-find-affordances.md` §3.

Measured: every `--syntax-*` foreground and `--surface-fg` against `--find-match-current-bg`
(`--amber-400` light, `--amber-600` dark) — worst case 1.04:1 (a comment, dark), nothing in the
column clears 3:1. Interpolating the fill back toward the already-passing dim fill (`--find-match-bg`)
shows the dim fill has 0.14 of headroom above 3:1 at its own value — ten percent of the way toward
the old current-match value is already below the bar. No fill value is both legible and visibly
distinct from the dim one.

**Chosen: the current match is drawn as a 1px `inset` ring** (`--find-match-current-border`,
`Raw.css`'s `.cm-np-match-current`) **over the same `--find-match-bg` fill every match gets** — the
same move R60 made for dark elevation when a bigger background step couldn't carry "elevated" either
(`docs/plans/R60-dark-elevation.md`, CONCEPT.md §9.3). `inset`, not `outline`/`border`: Raw is a
virtualized CodeMirror window and the current match must not change line height. Light gets
`--amber-600` (3.41:1 against the fill); dark gets `--amber-400` (7.61:1) — the ring becomes the
strongest thing on screen and costs the surrounding text nothing.

**The token also meant three different things before this round**, found while tracing its four
uses: a background under text in Raw, and a marker-bar colour that never touches text in
Tree/Grid/Scrubber — where it marked *any* matched row, not the current one. Split into three:
`--find-match-bg` (unchanged, the fill for every match), `--find-match-current-border` (new, Raw
only), and `--find-match-marker` (new, Tree/Grid/Scrubber — keeps the exact prior values, a pure
rename with no visual change). `--find-match-current-bg` is retired. `test/themeTokens.test.ts`
enforces both themes define the same token names; `test/findMatchContrast.test.tsx` (R81) is the
contrast guard.

### D-084 — a marker glyph's font is chosen per glyph string, not per surface or per format (R98) ·
`settled`

Plan: `docs/plans/R98-glyph-font-per-glyph.md` §2.

Supersedes the generalisation both of its predecessors made from one marker to all of them, neither
of which was wrong about what it measured: R71 (`docs/plans/R71-text-as-icons.md`) removed
`--font-mono` from every marker on the theory that a fixed advance width couldn't equalise
differently-sized markers anyway — true when written, false once its own §5a changed TOML's `[ ]`
to `[]`. R83 (`docs/plans/R82-hover-and-glyphs.md`) restored `--font-mono` everywhere, measured
correctly against R71's own width complaint — and still shipped a defect, because width was never
the problem: Cascadia (`--font-mono`'s installed second entry) draws `<>`'s two chevrons meeting at
a point, closing the mark into a diamond, a letterform property no amount of width measurement
would surface.

**Chosen: the font is a property of the individual glyph, keyed on the glyph string itself** —
`glyphFont.ts`'s `glyphFontClass('<>') === 'glyph-ui'`, every other glyph `'glyph-mono'`. Not keyed
on `NodeKind` or a format id, even though both `KIND_GLYPHS` and `FORMAT_GLYPHS` independently
produce `'<>'`: a string-keyed rule serves both call sites with one function, and adds no second
format-id switch to the renderer (invariant 8's own concern; `formatGlyphOf`'s existing switch
predates this round and is untouched). Two CSS classes in `base.css` (`.glyph-ui`/`.glyph-mono`,
cross-component) rather than per-component overrides, applied at `.tab-icon`/`.tree-row-glyph`
(R98) and `.detail-node-glyph`/`.detail-child-glyph` (R99, scoped separately since Detail already
rendered `<>` correctly and only `{}`/`[]` change there).

Four alternatives were rendered side by side before choosing, not reasoned about from description
— shape cannot be judged from an advance measurement, which is the exact mistake R83 made.
`</>` as literal text stayed ASCII (R71's codepoint rule) but measured 19.34px in an 11px/20px box,
visibly wider than `{}` beside it. The Fluent `code` icon looked best alone but Fluent has no `[]`
icon, so the column would stay permanently mixed. `letter-spacing` on the monospace glyph pried the
mark apart rather than fixing its shape. Naming `Consolas` first fixed Windows and silently
reverted to the diamond on platforms without it — the exact "shape chosen by a chain the app
neither names nor controls" failure R71's codepoint rule exists to prevent, applied here to font
selection instead of character selection.

### D-085 — `gridSort.ts`'s `isNumericColumn` keeps JS `Number()`; the path query engine does not
(R129) · `settled`

Plan: `docs/plans/R129-query-predicates.md` §8.

R129 adopted XPath 1.0's `number()` grammar for comparison predicates (`car[price>100]`), which
diverges from JavaScript's `Number()` in five documented cases — `1e3`, `0x10`, `""`, `+5` and
`Infinity` are all `NaN` under XPath, not their JS values. `gridSort.ts`'s own numeric-column
detection already used `Number()` and was left untouched rather than unified with the new grammar.

**Chosen: two functions, deliberately.** The grid's question is "should this column right-align" —
cosmetic, already sampled and therefore already approximate, and `Number()`'s leniency costs
nothing there. The query engine's question is "does this row match," where XPath conformance is
the whole point and a wrong answer is a correctness bug, not a display nit. Recorded because the
two look like one function and the next person will try to share them: the user-visible edge is a
column that sorts numerically containing a value (`1e3`) that a `>` query on the same column will
not treat as numeric — real, and accepted, per the divergence above.

### D-086 — the application is renamed `Klados`; `NodePad` is retired before the first push (R144) · `settled`

Plan: `docs/plans/R140-publication.md` §6–§7.

`CONCEPT.md` §13's **first** open question — *"check GitHub, npm and trademark registers for
'NodePad' before committing"* — went unanswered from the design document through M0–M7. It was
finally checked while planning publication, at the last moment where the answer is still cheap.

**NodePad fails on three independent counts.** Google **corrects the query to "Notepad"**, so the
name can never be won in a search — not an SEO problem with a fix. `mskayyali/nodepad` is an
active **1.1k-star** MIT project (a spatial AI research canvas) with a commercial product behind it
at node-pad.com, paid plans from $5/month, operated by The Palaz Company — same word, same channel,
overlapping audience, growing. And the npm name has been taken since 2011.

**Chosen: `Klados`** — Greek κλάδος, *branch*, the root that English *clade* derives from. A clade
is an ancestor together with all of its descendants, which is exactly the object this application
manipulates: contiguous document-order refs plus O(depth) `subtreeEndRef` mean a subtree *is* a
ref range, and "a complete, unbroken descent" is what the word means. GitHub is effectively empty
(top three hits at 2★) and `klados.io` and `klados.app` are both unregistered.

**Rejected, and why each lost — the alternatives are the reason this is reversible on purpose:**

- **Keeping `NodePad`.** Defensible only if the project accepts being found by direct link and
  never by search. Rejected because the round exists to produce a tagged release and a user-facing
  README, which are exactly the artifacts that assume discoverability.
- **`Nodesmith`, `Nodus`, `Nodetree`, `Nodis`/`Nodos`/`Nodas`.** Every `node`-formative
  candidate was checked and every one landed on a **different** established meaning: Node.js
  (`nodist` 1.7k★, `nodish`, `nodash`, `nodos`), blockchain nodes (Nodesmith, a Seattle
  company owning nodesmith.io and the GitHub org), Blender/DCC node graphs (147 `nodetree` repos),
  and network nodes (Nodus, a payments company owning nodus.com, plus four more businesses).
  **In software, "node" reliably means something other than a node in a document tree** — and the
  maintainer's own objection was independent and decisive: *node* appears nowhere in the UI, so the
  meaning never reaches the user. `Nodus` additionally carries an English dictionary sense of
  **"complication, difficulty"** (Merriam-Webster), which is backwards for a tool that exists to
  make complicated files legible.
- **`Clade` itself**, rather than its root. Rejected on pronunciation: one syllable in English
  (*klayd*), two in German (*KLAH-de*). `Klados` is KLAH-dos in both, which matters for a
  maintainer who will say it more often than anyone.
- **`Leafsmith`** — the strongest runner-up, and the only candidate across every check that
  returned **zero** GitHub results. Lost on being English-only compound wordplay with a terminal
  *th*, where `Klados` is pronounceable unchanged across German, English and the Romance
  languages.
- **A coined word.** Rejected by the same standard that rejected *node*: if the objection is that a
  name's meaning fails to reach the user, a coinage has no meaning to fail with, and must be taught
  — which costs marketing effort this project does not have.
- **Format-derived names** (`Tagsmith` and the rest). Rejected on **invariant 8**: nothing above
  `src/formats/` may know which format produced a document, and a name built on XML's vocabulary
  contradicts that in the one place every reader sees. "Tag" is also already three other things in
  software — Git tags, analytics tags, file tagging — and none of them is markup.

**Trademark registers are still unchecked**, and this entry does not claim otherwise: TMview, EUIPO,
WIPO and USPTO all refuse programmatic queries and DPMAregister is a session-bound form. R144's
acceptance criteria carry it as a **manual** step in classes 9 and 42.

### D-087 — the mark is a branching figure that reads as a logo, not a letterform with node dots (R144) · `settled`

Plan: `docs/plans/R140-publication.md` §7a. Supersedes the mark half of D-054/D-054b, which stand
otherwise — everything they settled about `.ico` frame selection, resampling and the tile is
unaffected.

The retired mark was an **N whose two vertices were filled dots**: a letterform with the node idea
attached to it. The obvious move under D-086 was the same construction with a K, and a K is the
better letter for it — three strokes meeting at one junction is a branch point, which an N never
had.

**That is not what was chosen.** Three directions were explored and rendered at actual pixel size
(`Klados icon dot placement exploration/`): dot placements on a K (junction + tips, tips only,
stem top + tips), then dotless curved letterforms, then two survivors tuned further.

**Chosen: `3b-ii`** — a straight stem, an arm curving into it, and a leg branching off **the arm**
rather than off the stem, giving **two** branch points. Geometry, because the exploration folder
does not contain this variant and is untracked:

| | 64 grid (`stroke-width="5"`) | 16 grid (`stroke-width="2"`) |
|---|---|---|
| `3b-ii` | `M20 18V48M46 17Q33 22 20 33M37.08 21.14Q44 34 49 48` | `M5 4V12M11 4L5 9M9.21 5.49L12 12` |

**The leg's start point is fractional on purpose, and the reason is a trap worth naming.** The
canvas drew the leg from `(37,21)` at the 64 grid and `(9,5)` at 16 — neither of which is quite
*on* the arm's centreline, and `stroke-linecap="round"` puts a semicircle of radius ½·stroke-width
at that start. A cap centred exactly on the centreline is inscribed in the arm's stroke (every
point of it is within ½-width of the centre, and the arm covers everything within ½-width of its
centreline); offset the centre by `d` and **the cap pokes out by exactly `d` on the far side**.
Measured: 0.512 off at the 16 grid — **25.6% of the stroke width**, half a pixel at render size —
and 0.159 off at 64, 3.2%, which is why the artifact was obvious in `mark-16.svg` and barely
visible in `mark.svg`. Painting order cannot fix it: the bump is *outside* the arm's outline.

The fix slides the start along the **leg's own direction** until it meets the centreline, so the
visible line is unchanged and only a point buried inside the arm moves; residual offset is 0.05%
of stroke width in both. So the 16-grid mark carries one non-integer coordinate against
`assets/README.md`'s "2px strokes on integer coordinates" rule — permitted **because that point is
never visible**. The rule exists so strokes land on whole pixels, which is a property of the line,
not of which point is nominated as its start; the stem, the arm and both outer terminals stay on
the grid.

**Why it beat the cleaner options, stated plainly because it is a trade and not a free win.** The
`3a` variants are unambiguously better *letters* — a single continuous curve through one junction,
crisper at 16px, immediately readable as a K. `3b-ii` is chosen **because it stops being a letter**:
a second split reads as structure rather than typography, so the icon is a mark rather than a
monogram, and it is visually distinct from every other amber glyph in a taskbar. The cost is
accepted knowingly: **it may not read as a K at first sight**, and it puts four strokes and two
junctions inside a 16px box, which is the hardest constraint in the icon brief.

Rejected: **`3a-i`** (short arm, long leg — the safest, and the one that survived every
head-to-head), **`3a-ii`** (whose 16px cut differs from `3a-i` by a single pixel on the arm tip,
so it buys nothing at the size that matters), and **the dotted K directions entirely** — three dots
plus three strokes is noise at 16px, and the dots were inherited logic rather than a decision.

**Not changed, and not to be revisited as part of this:** the tile gradient, radius, border and
bevel, and the two mark ambers `#E9A33C` (in-app, dark surfaces) and `#A9701E` (where the
surrounding theme is unknown). Those ambers are **measurements** — 3.77 and 3.90 against light and
dark, against `#E9A33C`'s 1.94 failure on light — and a new mark shape does not disturb them.

### D-088 — grid detection's eligibility test widens from "has children" to "has children or attributes" (R149, CSV) · `settled`

Plan: `docs/plans/R145-csv.md` §6. `detectGrid` (`gridDetection.ts`) decided which children were
grid-record candidates with `hasChildren` alone — CONCEPT.md §3.2's "composite = has children, full
stop" — since D-030's scalar folding made that the correct, decidable test for every format up to
this round. R145 §2 gives CSV a node model that breaks the assumption underneath it: a CSV row is
an `Object` with *only* attributes (fields are 16-byte facets, never 76-byte Property+Scalar
child pairs — the reason CSV's memory footprint works at all). Under the old test every row failed
`hasChildren`, so `detectGrid` found zero composite children for *any* CSV file — not a rare case,
the universal one. Confirmed by running the real parser through `detectGrid` before this decision
was made: `compositeChildCount` was `0` and `grid` was `null` unconditionally, contradicting R145
§2's own claim that CSV would need "no new code."

**Decided:** a new `isGridEligible` (`nodeDisplay.ts`) — `hasChildren(node) || hasAttributes(node)`
— replaces `hasChildren` at exactly the one call site inside `detectGrid`. `hasChildren` itself is
untouched, and so is every other caller of it (wrapper descent, tree icons, the child-count badge)
— this does not redefine "composite" project-wide, only grid detection's own record-eligibility
test, which CONCEPT.md §4.3 already names as a distinct step ("group composite children") from the
general term §3.2 defines.

**Side effect, not a regression:** an XML element with attributes but no children
(`<car color="red" make="Toyota"/>`, repeated) now also qualifies for grid detection, where it
previously did not. Untested before this decision — `test/gridDetection.test.ts`'s existing "never
groups scalar children" case covers only attribute-less leaves (`<owner>`, `<sunroof/>`), which
D-088 leaves excluded exactly as before. Read as a latent gap the old test never exercised, not a
new one: a repeating self-closing element whose fields are all attributes is a record by any
reasonable definition CONCEPT.md §4.3 gives, in the same way a CSV row is.

**Rejected: redefining `hasChildren`/"composite" itself.** Global — every consumer (wrapper
descent's `wrapperCompositeChild`, in particular) would need re-auditing for whether "composite"
suddenly including attribute-only nodes changes *its* behaviour too, for no benefit grid detection
needs. `wrapperCompositeChild` stays exactly as written: a wrapper's one child must still have
actual child *nodes*, since a facet-only node has nothing to descend into.

### D-089 — a failed file watcher is released and logged, not surfaced to the renderer or retried (R171) · `settled`

`fs.FSWatcher` is an `EventEmitter`, and until R171 nothing anywhere in `src/` listened for its
`'error'` event. An `'error'` with no listener *throws*, so in the main process every watcher
failure was an uncaught exception and Electron's own "A JavaScript error occurred in the main
process" dialog — which is how a user found it, by hand, while doing something else.

**Reproduced before deciding what to do about it.** Deleting the watched *file* is quiet; deleting
its parent **directory** raises `EPERM: operation not permitted, watch`, matching the report by code
and message. `test/fsWatcherDeps.test.ts` induces it against a real filesystem, and removing the
listener again turns that test red with the identical unhandled error — so the fix is load-bearing
rather than defensive.

**Decided:** the watcher is released — its path entry dropped, every key that was watching it
forgotten, the handle closed — and the failure is written to the main-process log. External-change
detection stops for that document and nothing else changes.

**Rejected: telling the renderer.** The most honest answer, and the most work: a new IPC signal, a
preload surface, a session hook, and a decision about what the UI says, which `PLANNING.md` §1 would
require rendering before settling. Deferred rather than dismissed — the argument for it is that a
silently-dead watcher means the "changed on disk" banner never appears again for that document, and
this project's culture is hostile to buried signals (R47's lint, R155's Dependabot alerts). What
makes deferral defensible is that the confirmed trigger is the file's directory being deleted: the
document is gone, the user will discover that at save, and the watcher is reporting a fact about the
world rather than a fault in the app.

**Rejected: retry with backoff.** Right for a transient lock, wrong for the failure that actually
occurs. There is nothing to retry against when the directory has been removed, and R171 §6 is
explicit that a failing watcher must not spin.

**Rejected: a global `process.on('uncaughtException')` handler in main.** Considered because
Electron's default — a modal dialog blaming the application — is the worst outcome for a file
viewer, and a last-resort handler that logs and survives would be kinder.

**The argument against it is this defect itself.** The crash is *how this bug was found*. Nothing in
the suite covered watcher failure modes, no test would have caught it, and a catch-all installed
earlier would have converted a loud, dated, screenshotted report into a watcher that silently stopped
working forever. That is R47's buried lint signal and R155's buried Dependabot alerts in a third
place, and it is the pattern this project exists to avoid.

The position is therefore: **handle failures where they arise, at the seam that knows what they
mean**, and leave the process's own error behaviour alone. If a global handler is ever added it
should log loudly and still fail the process in development, never suppress silently — but no such
handler is added here, and none is needed for R171's own defect.
