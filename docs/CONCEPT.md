# Klados — Concept

**A viewer and source-level editor for node-based (hierarchical) data formats.**

Status: draft v0.1 — design concept, pre-implementation.

---

## 1. Vision

Klados displays and edits any hierarchical data format through three synchronized
views: a structural **Tree**, a tabular **Detail** view, and the **Raw** source text.

Its signature feature is the Detail view's automatic table mode: when a node contains
repeating children of the same shape, their first-level contents are collected into
columns and rendered as a spreadsheet-like grid. This is what makes large, repetitive
documents readable — the same insight behind XML Marker, generalized to JSON, YAML
and TOML.

The name emphasizes editing *node-based* file formats, not any one syntax.

### Design priorities (in order)

1. **Polished UX** — keyboard-first, fast, uncluttered
2. **Large-file performance** — 100–200 MB as the working target, 500 MB as the ceiling
3. **Format breadth** — XML, JSON, YAML, TOML, extensible beyond
4. **Editing fidelity** — achieved structurally rather than through effort (see §5)

Note that fidelity ranks last only because it costs nothing. Raw-view-only editing makes
it a *property* of the architecture rather than a goal to trade against the others — it
is a constraint the design already satisfies, not a priority competing for effort.

### Non-goals (v1)

- Schema-aware editing, XSD/JSON-Schema validation, autocomplete
- Diff / merge
- Transformation (XSLT, jq-style pipelines)
- Multi-document projects or workspaces

---

## 2. Supported formats

| Format | Composite nodes | Scalar facets | Notes |
|---|---|---|---|
| XML | elements | attributes | text on the element; distinct Text nodes only in mixed content (§3.2) |
| JSON | objects, arrays | scalar-valued properties | a property carries its scalar directly (§3.2); array children keyed by index |
| YAML | maps, sequences | scalar entries | anchors/aliases, tags, comments |
| TOML | tables, arrays of tables | key-value pairs | dotted keys nested, not flattened |

**XML and JSON are v1.** TOML and YAML follow (§12) — the application requires no
changes to accept them, only a parser, which is precisely what the unified model buys.
Note that this does *not* make them equal work: TOML is cheap, YAML is not.

Later candidates: HTML, INI, CSV (as an array of records), plist, protobuf text format.

### The "facet" generalization

XML distinguishes attributes from child elements; the other formats do not. Rather than
special-casing XML throughout the UI, every node is described as having:

- **Scalar facets** — XML attributes, or scalar-valued properties in JSON/YAML/TOML
- **Composite facets** — XML child elements, or object/array-valued properties

The Detail view then renders one table per facet kind, identically for every format.
No branching on format anywhere above the parser layer.

### XML namespaces

Namespaces are stored, not flattened away:

- The interned name (§6.5) is the **qualified name as written** (`inv:price`); the
  prefix/local split is recorded on the intern table entry, not as an offset into the
  buffer
- Namespace declarations build a scope table keyed by node range; URI resolution is lazy,
  computed only when asked for
- **Grid grouping keys on the resolved `(URI, localName)` pair**, not the prefix. Two
  sections of a document using different prefixes for the same namespace must group into
  one table, or the feature fails on exactly the documents that need it most
- Column headers display the prefix **as written in the source**, so what the user sees
  matches what is in the file; the resolved URI appears in the header tooltip

`xmlns` declarations are attributes and appear in the scalar facets table like any other,
rather than being hidden.

---

## 3. Architecture

```
┌──────────────────────────────────────────────┐
│ UI layer (React)                             │
│  Tree View │ Detail View │ Raw View          │
├──────────────────────────────────────────────┤
│ Command registry · keybindings · palette     │
├──────────────────────────────────────────────┤
│ Selection & navigation state                 │
├──────────────────────────────────────────────┤
│ Unified Node Model (flat typed arrays)       │
├──────────────────────────────────────────────┤
│ Format parsers (XML │ JSON │ YAML │ TOML)    │  ← Web Worker
├──────────────────────────────────────────────┤
│ Source buffer (Uint8Array) + row index       │
└──────────────────────────────────────────────┘
```

Everything above the parser layer is format-agnostic.

### 3.1 Source buffer

The file is held as a **`Uint8Array` of raw bytes** and never converted to a JavaScript
string in full. A JS string is UTF-16 internally, so materializing a 200 MB file doubles
it to 400 MB before anything else happens.

All spans throughout the system are **byte offsets** into this buffer. Text is decoded
on demand, for visible content only, via `TextDecoder` over a subarray.

**Scope of this rule.** It governs the *model* — parsing, the node store, and every
format-agnostic layer above them. The Raw View is **not** an exception. CodeMirror's
document is a rope of JS strings and does keep its own UTF-16 copy, but it is only ever
given a **window** of the buffer — about 1 MB around the current position — never the whole
document (§8). The duplication is therefore bounded by the window, not by the file.

M0a measured this: a 1 MB window over a 500 MB file cost a renderer memory delta of
**−3.1 MB** (GC noise, i.e. nothing), against **+1116 MB** for the same file loaded whole.

A **row index** (`Int32Array` of row-start offsets) is built once during parsing. It
gives O(1) row→offset and O(log n) offset→row, which the Raw View needs for
virtualized rendering and jump-to-position.

**A row is not a line.** A row ends at the next newline *or* after N bytes, whichever
comes first. That gives the scrubber (§4.5) and jump-to-position a uniform unit on any
document, including a 200 MB single-line JSON file. It also fixes the more common case of
one pathologically long line inside an otherwise normal file, which line-based indexing
handles badly.

It does **not** make minified documents a non-issue for the editor itself. CodeMirror
works in lines, not rows, so a single-line window has no vertical scroll surface until
soft wrap gives it one — measured in M0a, not assumed. The row index solves position
mapping; wrap solves scrolling.

**The unit is bytes, not characters.** The row index serves virtualization only —
mapping scroll position to a byte offset — and therefore needs to be deterministic and
roughly uniform, not visually exact. Counting characters instead would cost a decode pass
and still not give uniform width, since CJK and emoji render double-width regardless.
Actual visual wrapping is left to the browser's text layout, which already handles
grapheme clusters and East Asian width correctly.

Two refinements:

- **Prefer a nearby break character.** Scan backward up to ~16 bytes from the N mark for
  `,` `}` `]` `>` or whitespace and break there if found, else break at N. Near-zero cost,
  and it avoids splitting `"name"` into `"na` + `me"`. The separator set may vary by
  format.
- **Soft wrap is affordable because the Raw View is windowed** (§8). Variable heights and
  measured virtualization cost little over ~1 MB of text where they would be ruinous over
  200 MB. Wrap is therefore off by default — one row is one visual line, heights are
  uniform, long rows scroll horizontally — and **on when the window has no vertical scroll
  surface of its own.**

  That condition is tested directly on the window (`scrollHeight <= clientHeight`), not
  inferred from a document-wide statistic like mean row length. A file of otherwise normal
  lines can still produce a single-line *window* over one pathological region, so the
  decision belongs at the window. The check is free and needs no full-document analysis.

  It is not a preference either: a single-line window cannot scroll, and the window
  advances on scroll, so without wrap it can never move. M0a measured wrap turning 1 MB of
  unbroken text into ~5,800 visual rows, after which typing, scrolling and window crossing
  all sit at the vsync floor. The cost is **first paint — ~400 ms** while wrap points are
  computed across the window, which the UI shows as a brief loading state rather than
  assumes away.

Format-aware structural breaking was considered and rejected. The row index exists so that
nothing crashes and so the scrubber and jump-to-position stay honest — not to make an
unreadable view readable. Soft wrap does that, and the Format command (§5.7) is the
permanent fix.

**Row starts must snap to character boundaries.** A row that ends after exactly N bytes
can land in the middle of a multi-byte UTF-8 sequence; decoding that subarray yields
replacement characters. The row builder advances to the next lead byte before recording
an offset. The same constraint applies to any span used for display.

**N does not depend on the viewport.** The row index is a byte-granular structure built
once during parsing; visual wrapping is the browser's business and never feeds back into
it, so there is no rebuild on resize. An earlier draft said otherwise — that followed from
a character-based index, which this section rejects above. With wrap on, one row may occupy
several visual lines and the scrubber's ratio is correspondingly approximate, which is what
a scrubber is for (§4.5).

Note that the node model itself is indexed purely by byte offset and has no concept of
rows or lines. Minified input is therefore *only* a Raw View concern; parsing, tree
construction and the Detail view are entirely unaffected.

### 3.2 Unified Node Model

The tree is stored as **parallel typed arrays**, not as one object per node:

```ts
interface NodeStore {
  kind:        Uint8Array;   // Document | Element | Object | Array | Property | Scalar
                             // | Text | CData | Comment | ProcessingInstruction | DocType
  nameId:      Int32Array;   // index into the interned name table — see §6.5
  valueStart:  Int32Array;   // byte offsets into the source buffer
  valueEnd:    Int32Array;
  spanStart:   Int32Array;   // full extent of the node in the source
  spanEnd:     Int32Array;
  parent:      Int32Array;
  firstChild:  Int32Array;
  nextSibling: Int32Array;
  prevSibling: Int32Array;   // required — see below
  flags:       Uint8Array;   // hasAttributes, isAlias, isCData, isMixed,
                             // droppedWhitespace, subtreeComplete (§3.4), …
}
```

A node is an **index**, not an object: 9 × Int32 + 2 × Uint8 = **38 bytes per node**,
with zero GC pressure.

Names are not stored as spans but as ids into an interned name table (§6.5). Names repeat
massively — millions of `<car>` elements share one name — so interning both shrinks the
store and turns name comparison, the inner loop of query evaluation and grid grouping,
into an integer compare.

Node density is measured, not assumed. Under the text rules below, pretty-printed XML
yields **~32 bytes of source per node**, so a 500 MB document is **~16.5 M nodes → ~627 MB
of store** alongside the 500 MB buffer. Retaining a node for every text run instead gives
10.7 bytes per node — 48.9 M nodes and ~1.86 GB — which is why the rules exist. The
equivalent object-per-node model does not fit at either density, in any language.

**`prevSibling` is not optional.** With only `firstChild` and `nextSibling`, moving up
one row in a tree with 100 k siblings is O(n) per keypress, and computing a node's
sibling index for a structural path (`book[3]`) requires a scan from the first child.
Four bytes per node buys O(1) for both.

Names and values are resolved lazily by slicing the buffer. Only what is on screen is
ever decoded.

Attributes live in a parallel side table (`attrOwner`, `attrNameId`, `attrValueStart/End`),
sorted by owner so a node's attributes are a contiguous range. **Attribute names are
interned in the same table as node names** (§6.5): `id` recurs across millions of
elements exactly as element names do, and building grid columns means comparing attribute
names across thousands of rows — the same hot loop, and the same saving.

**A node carries its own scalar value; wrappers around a value are not modelled.** Three
rules, all forced by measurement rather than chosen for elegance:

- **XML — insignificant whitespace produces no node.** A whitespace-only text run between
  elements is not modelled; a `droppedWhitespace` flag on the parent records that one was
  elided. Inside `xml:space="preserve"` it is retained, so the scope must be tracked during
  parsing and carried in the resume context (§3.3) alongside namespace scope.
- **XML — a leaf element holds its own text.** An element with exactly one text run and no
  child nodes writes that run into its own `valueStart`/`valueEnd`. An element that *has*
  child nodes keeps its text runs as ordered `Text` nodes, so **mixed content is
  unaffected**: `<desc>a <b>x</b></desc>` still produces a `Text` node, in order, with
  `isMixed` set on the parent.
- **JSON — a property holds its own scalar.** A `Property` whose value is a scalar token
  carries that token in its own value span; no `Scalar` child. A `Property` whose value is
  an object or array keeps the composite child, as it must. Array elements cannot fold —
  there is no property to fold into — so a scalar array element stays an unnamed `Scalar`
  node. YAML and TOML follow the same rule when they arrive.

Without the XML rules, 40% of all nodes in pretty-printed XML are whitespace and a further
26% are wrappers around a single value. The `<car>` record in Appendix A costs 19 nodes
without them and 7 with them. The JSON rule is the same saving on the same shape of
document, and was adopted for consistency as much as for size.

All three are decidable in one streaming pass with a single held span and one boolean per
stack frame — O(depth), not O(children).

Nothing is lost from the file. Save writes the byte buffer (§5.1), the Raw View shows
bytes, and the formatter (§5.7) rescans bytes rather than reading the store, so the one
component that would corrupt a document by getting whitespace wrong never consults the
model.

**This is also what keeps the model genuinely unified.** `<name>Golf</name>` and
`"name": "Golf"` are each one node with a name and a value span. Fold one format and not
the other and they stop matching, which would undercut §2's claim in the one place a user
would actually notice it — the grid, where an XML column and a JSON column must build
identically.

`NodeKind.Scalar` and `NodeKind.Text` therefore become uncommon: `Text` appears only in
mixed content, `Scalar` only as an array element. That is the intended outcome, not an
accident of the rules.

It also makes **composite** — the term §2 and §4.3 lean on — directly computable: a node is
composite when it has children, full stop. Without folding, `<name>Golf</name>` and
`"name": "Golf"` both have a child, and every consumer would have to ask "children other
than `Text`/`Scalar`" instead. Grid detection runs that test over every child of the
selected node, so it is a hot path as well as a conceptual one.

The cost is real and worth stating: the model no longer records *where* inter-element
whitespace was, only that it existed. And a consumer walking children must handle both
"value on the element" and "value in a `Text` child," which a single accessor should
absorb. XPath's `text()` axis (§12, Later) must synthesize a text node for folded
elements — the element's value span *is* that node's span.

### 3.3 The format module contract

The claim that "a format is only a parser" is the document's load-bearing assumption:
§2 asserts it, §6 relies on it for unified queries, §4.3 relies on it for the grid, and
§12 makes TOML the test of it. It is therefore specified as **code rather than prose**,
in `src/core/types.ts`, so it cannot drift from the implementation.

Three decisions in that contract are worth stating here:

- **Parsers push into a `NodeSink`; they never decode text.** A pull-based iterator would
  allocate one event object per node — ten million allocations on a large document, the
  exact cost the flat store exists to avoid. Parsers emit byte offsets; interning,
  hashing and namespace resolution belong to the sink, which owns the buffer and the
  intern table.
- **Incremental reparse needs a resume context** — namespace scope for XML, indentation
  and anchors for YAML. It is recomputed by walking ancestors rather than stored per
  node, which would cost more than the node store itself.
- **It is a format *module*, not a parser.** Formatting, encoding detection, row-break
  characters and capability flags all vary per format; "parser" understates what each
  format must supply.

Capability flags are also how format-specific UI stays out of the UI layer: XPath appears
only for XML, and the attributes table hides for JSON, because both read
`FormatCapabilities` rather than testing a format id.

### 3.4 Parsing pipeline

- Runs in a **Web Worker**; the UI thread never blocks
- **Streaming**: emits nodes as it goes, with progress reporting
- The tree becomes browsable before parsing completes, for very large files
- Comments are parsed and retained (see §5.3)
- On a syntax error: report the location, and **keep the last known-good tree** so the
  UI stays usable while the user is mid-edit

Transferring the result to the main thread is a zero-copy `ArrayBuffer` transfer.

**Parsers must be iterative, never recursive descent.** Deeply nested input
(`[[[[…]]]]` thousands of levels deep) occurs in generated data and will overflow the
call stack. Each parser maintains an explicit operand stack with a configurable depth
limit that produces a diagnostic rather than a crash.

**Streaming and grid detection interact.** Grid mode needs a node's *complete* child set
to compute coverage and the column union; a node selected mid-parse would otherwise show
a grid that mutates under the user. A node's subtree carries a `complete` flag, and the
Detail view shows a pending state rather than a provisional grid until it is set.

---

## 4. The three views

Single source of truth: `{ selectedNode: NodeId, caretOffset: number }`. Every view is
both a producer and a consumer of that state.

### 4.1 Window layout

The Detail view is the primary working surface; Tree and Detail are the default pair.
Raw is toggled in.

**Two independent toggles**, one keystroke each: show/hide Tree, show/hide Raw. This is
preferred over cycling a single key through fixed modes, where reaching a given layout
sometimes takes two presses and the next state is not predictable from the current one.

Reachable layouts: Tree + Detail (default), Tree + Detail + Raw, Tree + Raw,
Detail + Raw, Detail alone.

**Raw stacks below Detail, never beside it.** Both panes are width-hungry for the same
reason — the grid needs columns, raw text needs long rows — so placing them side by side
starves both. A horizontal divider with each pane at full width serves both.

Raw is shown alongside Detail rather than replacing it, because Detail↔Raw
synchronization is one of the tool's selling points and cannot be perceived when only
one of the two is visible.

The Tree occupies a narrow left column and is itself collapsible: a 40-column grid wants
the entire window width.

**Command surfaces:**

- One global elevated command bar at the top (see §9.4)
- Thin, *flat* header strips per pane for pane-scoped actions

This keeps the elevation budget intact while still giving each pane its own controls.

### 4.2 Tree View

- Virtualized (only visible rows rendered), lazy child expansion
- Icon per node kind; inline value preview on leaves
- Full keyboard navigation: arrows, `Home`/`End`, type-ahead jump, expand/collapse all
- YAML alias nodes render as references and jump to their anchor on activation

### 4.3 Detail View

Sections, stacked top to bottom:

1. **Breadcrumb path** — clickable segments, copyable as XPath or JSON Pointer
2. **Node header** — kind, name, child count, source range (line numbers where the
   document has meaningful lines, byte offsets otherwise — see §3.1)
3. **Comment block** — the doc comment attached to this node, if any (§5.3)
4. **Value block** — text/scalar content, if any
5. **Scalar facets table** — `Name | Value`
6. **Children section** — in one of two modes

#### List mode (heterogeneous children)

`Name | Kind | Preview | # Children`, one row per child.

#### Grid mode (homogeneous children)

The signature feature. One row per child; columns collected from the union of the
children's first-level field names.

**Detection algorithm:**

1. Group composite children by **resolved name id** — the interned id (§6.5), and for
   XML the id of the resolved `(URI, localName)` pair rather than the prefix (§2), so that
   two sections using different prefixes for one namespace group into a single table.
   "Composite" here means grid-eligible (D-088): has children, **or** has scalar facets —
   not just §3.2's plain "has children," since a CSV row (§2's array-of-records) is
   attributes-only by design and would otherwise never qualify
2. A group qualifies for grid mode if it has ≥ 2 members and covers ≥ 5% of the
   composite children (a floor, not a majority — both thresholds configurable)
3. The largest qualifying group renders as a grid; any remaining children render in
   list mode beneath it
4. Columns = union of the group's first-level field names, ordered by first appearance,
   then by frequency
5. Missing values render visually distinct from present-but-empty values

**Grouping keys on name alone, deliberately.** An earlier draft also folded attribute
and child names into a shape signature, but that splits `<car>` elements into separate
groups whenever one carries an optional field — the opposite of what the feature is for.
Optional fields should widen the column set, not fragment the table.

**Coverage is a floor, not a majority.** An 80% threshold makes a second qualifying
group arithmetically impossible, since two groups cannot both exceed 80%. The floor
exists only to suppress noise from one-off children.

*Post-v1:* multiple qualifying groups could each render as their own stacked grid
(`<book>`×40 and `<magazine>`×3 side by side). Deferred — it complicates the layout for
a case that is uncommon in practice, and list mode covers it adequately.

**Refinements:**

- Cells containing nested structure show a drill-in affordance, not truncated text
- **Per-column expansion** *(post-M2)*: a chevron in a composite column's header expands
  it in place into sub-columns (`engine` → `engine.type`, `engine.kw`) under a spanning
  group header, recursively. Preferred over a global "flatten one level" toggle, which
  explodes every composite column at once and turns a 12-column table into 60. Ship flat
  summaries first; this is a refinement, not a prerequisite.
- Manual grid/list override, remembered per node name for the session
- Column cap (~60) with a column picker beyond that
- Both rows and columns virtualized

#### Cell rendering

**Governing rule: literal vs. derived.** A cell either shows text that appears verbatim
in the document, or text Klados generated to summarize something. These must never look
alike — a user who mistakes a generated summary for a stored value has been told
something false about their data.

- **Literal** — normal text styling
- **Derived** — dimmed, slightly italic, with a multiplicity badge or drill-in chevron
- **Absent** — a distinct "missing" treatment, not an empty string

| Field | Example | Cell renders | Style |
|---|---|---|---|
| Attribute | `color="red"` | `red` | literal |
| Scalar child | `<name>Golf</name>` | `Golf` | literal |
| Empty element | `<sunroof/>` | ✓ presence marker | derived |
| Composite child | `<engine>…</engine>` | `diesel · 110` ▸ | derived |
| Repeated scalar | 3× `<owner>` | `Smith, Jones` ×3 | derived |
| Repeated composite | 3× `<part>` | `3 items` ▸ | derived |
| Mixed content | `<desc>a <b>x</b></desc>` | text, marked as mixed | derived |
| Absent | — | `—` | absent |

Repeated scalars are dimmed for a specific reason: an undimmed `Smith, Jones` is
indistinguishable from a single field whose literal value is the string
`"Smith, Jones"`. The multiplicity badge (`×3`) carries the fact that there are several
nodes; the dimming carries the fact that the joined text is Klados's construction.

**Kind is per cell, not per column.** A column can be composite in some rows and scalar
in others — `<engine><type>diesel</type></engine>` in one row and `<engine>petrol</engine>`
in the next. Each cell is styled by its own kind, so the scalar row shows `petrol`
undimmed.

#### Column header icons

The header carries a 16px icon indicating the column's kind, drawn from the Fluent set
(§9.5):

| Icon concept | Meaning |
|---|---|
| `@` glyph | XML attribute |
| text glyph | scalar element / property |
| braces or tree glyph | composite — expandable via chevron |
| stacked-layers glyph | can repeat on some rows |

Where a column's kind varies across rows, the header shows the *widest* kind present —
composite over scalar, repeating over single — so the header signals the maximum
complexity the column contains. A tooltip gives the breakdown
("engine — composite in 12 of 40 rows").

#### Column typing and ordering

- Column type detected from values: numeric columns right-align with tabular figures,
  everything else left-aligns. Cheap, and most of what separates a professional-looking
  table from an amateur one.
- A **leading row-header column** shows the row's index **in document order**, which does
  not change when a view-only sort is applied. This is what makes it a usable anchor: a
  number that reshuffles with the sort tells the user nothing.
  No key-attribute detection — guessing that `id`/`name`/`key` is the row's identity is
  magic that will be wrong on real documents. Instead, any column can be **pinned** to
  the left by the user, which is explicit and works regardless of naming.
- Sorting: scalar columns sort by value. Composite columns are **not sortable** — a sort
  that silently means something other than what it appears to mean is worse than no sort.
  The header tooltip says so.

#### Transparent wrappers

Hierarchical documents routinely wrap collections in an extra level:
`<cars><elements><car/><car/></elements></cars>`, or `{"cars": {"items": [...]}}`.
Selecting `cars` naively yields a one-row table containing the word "elements" — useless,
and among the first things a user encounters.

A node is a **transparent wrapper** when *all* of the following hold:

- it has exactly one composite child, **and**
- it has no scalar facets (no attributes), **and**
- it has no text content of its own

The third condition used to read "no *non-whitespace* text content." The qualifier is no
longer needed: insignificant whitespace is not in the model at all (§3.2), so the test is
simply whether the node has a value or a `Text` child.

When the selected node is a transparent wrapper, the Detail view descends through it —
recursively, to a depth limit of ~3 — and renders the grid for the first node that has
repeating children. The header shows the skipped path as a breadcrumb chip,
`cars › elements`, with every segment clickable.

**Reversed in M2b (D-034a):** the Tree used to apply the same rule, compacting chains of
single-child nodes into one row (`cars › elements`), as a setting on by default — see
`DECISIONS.md` D-034a for why real use reversed this. Instead, expanding a node also
auto-expands every descendant reached through a chain of single-child nodes, down to the
first node with zero or more than one child: every level stays its own row and individually
selectable, and the pair of actions (expand/collapse) treats the whole chain as one unit.

The rule is deliberately narrow. A node carrying attributes *and* a single child holds
real information and is therefore not transparent.

**Comments on skipped nodes are not lost.** A wrapper that is descended through may
carry an attached comment (§5.3). Any such comments are surfaced in the destination
node's comment block, each labelled with the segment it came from (`cars: Fleet
inventory…`), so compaction never hides documentation.

**Single-occurrence ambiguity:** `<cars><car/></cars>` with exactly one `car` is
genuinely ambiguous — a table of one, or a single object? The manual grid/list override
resolves it. A document-wide shape catalog could later detect that `car` under `cars`
repeats elsewhere and render single occurrences as one-row grids for consistency;
deferred.

**Interactions:**

- Activating a cell selects the corresponding node in every view
- Selecting a node always shows **that node's own contents**, never the parent's grid
  with the row highlighted. Row-highlighting would couple table navigation to tree
  navigation, but at the cost of making it harder to drill into an individual child.
- Column sort is **view-only** and must be visibly distinct from reordering the document
- Quick filter box; per-column filters
- Copy selection as CSV / TSV / Markdown. **v1 rule: copy the cell text as displayed**,
  including derived summaries. This is knowingly imperfect — CSV has no styling, so the
  literal/derived distinction is lost on export, and a summary can be mistaken for a
  stored value. Accepted for now because export is a convenience feature; revisit once
  real usage shows whether users expect expansion, a marker, or an empty cell.

### 4.4 Raw View

**The editor is given a window of the buffer, never the whole document** (§8): about 1 MB
around the current position, sliced at row boundaries and snapped to character boundaries.
Every offset the editor reports is `origin + localOffset`. Nothing above the Raw View
learns that a window exists — the rest of the application works in absolute byte offsets
throughout.

Three properties the implementation must honour:

- **The window boundary is never user-visible.** Crossing it must not move the caret, jump
  the viewport, or drop a frame.

  The mechanism, measured rather than assumed: re-windowing dispatches exactly **two edge
  changes** — drop `[oldStart, newStart)` from the front, append `[oldEnd, newEnd)` at the
  back — leaving the shared middle untouched, with **no** accompanying selection or
  scroll-into-view effect. CodeMirror then maps scroll position and selection through the
  change set itself, and its scroll anchor compensates for edits above the viewport. M0a
  measured 0 bytes of caret drift and 0 bytes of viewport drift across 60 crossings, at
  16.8 ms median. Repositioning by hand is not merely unnecessary, it is what produced
  drift in the first place.

  A full-document replacement remains the correct fallback for the **no-overlap** case — a
  large jump via `Locate in source`, where old and new windows share nothing — but must not
  be the steady-state mechanism for scrolling.
- **Highlight and selection are different things.** The selected node's span is a
  *decoration* over an absolute byte range, clipped to the window and simply absent when
  the node lies outside it; the document layer holds it regardless. The caret and any text
  selection live in the editor and therefore exist only inside the window. A text selection
  larger than a window is a document-layer operation expressed as a patch (§5.6), never as
  a visible editor selection — `Select all` then delete is a buffer operation.
- **Any byte offset derived by arithmetic is floored before use.** A fractional offset
  defeats UTF-8 boundary snapping silently — `bytes[12.5]` is `undefined`, and
  `undefined & 0xc0` is `0`, so the check passes — then surfaces much later as an
  asynchronous throw inside the editor, nowhere near its cause. `noUncheckedIndexedAccess`
  makes this a type error, and the guard is still worth writing explicitly.

Beyond that:

- Syntax-highlighted source, driven by Klados's own parse tree rather than a separate
  tokenizer. **Decorations are built for the viewport only** — a binary search on
  `spanStart` finds the first visible node and the walk proceeds forward from there,
  because spans are stored in document order. Windowing bounds the worst case, but the
  viewport-driven provider is still the right shape and still has to be built this way from
  the start.
- The selected node's span is highlighted
- Moving the caret resolves offset → node → selection (debounced). **Scrolling does not** —
  see §4.5
- The only place where editing happens (§5)

### 4.5 Synchronization

Selection changes propagate to all three views. Additional navigation:

- Back / forward history
- "Locate in tree" / "Locate in source" commands
- Drill up / drill down: move selection to parent or nearest child, keeping the other
  views anchored on the same source position

**A scrubber, not a scrollbar.** The Raw View's position indicator is a fixed-height strip:
position is a ratio resolved through the row index (§3.1), `y → row → byte offset`, so it
never asks the editor how tall the document is. That is what keeps a 500 MB file off
Chromium's maximum element height. It also carries markers — the selected node's span,
later search hits (§6) and diagnostics — which is how a selection outside the current
window stays visible.

**Navigating is not selecting.** Dragging the scrubber moves the window; it does not change
the selected node, the breadcrumb, or the Tree. The §5.1 cascade fires on caret movement,
never on scroll position — otherwise scrubbing a 200 MB file would fire millions of tree
updates. The caret is released when the window moves away from it, and the first click in
the new location establishes a new one; `Locate in source` returns to the selection. This
also means your place is kept: you can go and look at bytes elsewhere without losing the
node you were working on.

---

## 5. Editing model

### 5.1 Raw-view-only editing

**Editing happens only in the Raw View. The text is the single source of truth; the
model is a derived projection.**

This is the central architectural decision, and it is what makes editing fidelity free:

- No serialization path from model back to text exists, so nothing can be lost
- Comments, key order, quoting style, indentation and whitespace survive by definition
- The entire lossless-CST subsystem — otherwise the hardest part of the project —
  is unnecessary. A plain AST with spans suffices.

Formatting choices are left to the user, which is the correct default for a tool that
touches other people's config files.

**Two requirements this creates:**

- **Debounced reparse** (~200 ms idle, never per keystroke), with the last known-good
  tree retained while the document is temporarily invalid
- **Selection re-resolution after reparse.** Node indices are invalidated by a reparse.
  Resolution is a three-step cascade, because the selected node may no longer exist:
  1. Structural path (`/root/books/book[3]/title`) — exact match
  2. Caret offset — the innermost node whose span contains the caret
  3. Nearest surviving ancestor of the old path, falling back to the document root

  Steps 2 and 3 change the selection, so the Tree scrolls to the new node and the
  breadcrumb updates; the change is never silent.

  All three steps work in absolute byte offsets and are therefore independent of the Raw
  View's window (§4.4). Restoring a selection may move the window; it is never constrained
  by where the window happens to be.

### 5.2 Incremental reparse

A full reparse per edit does not scale to the target file sizes. At the throughput assumed
in §10, a 200 MB document reparses in 1–2 s; debounced at 200 ms idle (§5.1), that leaves
the Tree, grid, breadcrumb and span highlight trailing the text by a second or more after
every pause, with reparses queueing behind continued typing.

There are two problems, and the second is the harder one:

1. Reparsing the entire document when one element changed
2. **Every span after the edit is invalidated by the length delta** — so even a perfect
   subtree reparse leaves millions of stale offsets behind it

**Subtree splicing** handles the first. Reparse only the innermost node whose span fully
contains the edit and splice the resulting nodes into the store. Fall back to a full
reparse when the edit crosses that node's boundaries or breaks well-formedness, retaining
the last known-good tree (§5.1) until it completes.

**A pending-delta list** handles the second. Rather than rewriting every offset:

```ts
interface Delta { position: number; delta: number; }   // few entries, ascending order
```

- Span reads binary-search the list and apply the accumulated shift
- The list folds into the arrays on the next full reparse, and always before save (§5.5)
- The **row index (§3.1) shifts by the same mechanism**, since it suffers identical
  invalidation
- When the list grows past a threshold (~64 entries), a background full reparse folds it
  back to empty

Per-edit cost becomes O(edited subtree) instead of O(nodes), and reads cost a binary
search over a list that is normally a handful of entries.

**The delta list is mandatory, and measured.** M0a timed a naive bulk shift at 51.4 ms
against the node count this document originally assumed, and **231.5 ms** at the density
actually measured (§3.2) — far past the point where a per-edit fixup is viable. Cost is
linear in node count.

**What M0a did not measure, and should have:** subtree reparse latency and the read
overhead of delta application. Only the bulk shift was probed. Those two are what decide
whether editing a 200 MB file feels instant or laggy, and they remain an assumption until
M3 (§13).

### 5.3 Comments

Comments are parsed and retained in the model even though preservation is automatic.
The reason is presentation, not safety:

- A comment immediately preceding a node attaches to that node
- A trailing same-line comment attaches to the preceding node
- The Detail view surfaces the attached comment as documentation for the value

In YAML and TOML configuration files the comment *is* the documentation. Surfacing it
is a genuine differentiator over every generic JSON viewer.

### 5.4 Structural edits (post-v1)

When "insert node" / "delete node" commands are added later, they must be implemented
as **text edits at computed span offsets** — insert at a sibling boundary, copying the
adjacent sibling's indentation — not as model mutations followed by re-serialization.

This keeps fidelity free even for structural changes, and avoids reintroducing the
subsystem that §5.1 eliminated.

### 5.5 Two write paths

Transformations such as pretty-printing or format conversion genuinely require
generating new text from the model. That capability is legitimate, but it must not
contaminate the normal save path. Two clearly separated paths:

| Path | Source | Guarantee |
|---|---|---|
| **Save** | the byte buffer | byte-identical except where the user typed |
| **Transform** | generated from the model | explicit, undoable, visibly a rewrite |

**Encoding is preserved.** A document's encoding is detected on open (honouring the XML
prolog's declaration over any heuristic) and recorded; save writes back in the *original*
encoding, never silently converting to UTF-8. Since the editor works in decoded text while
the buffer holds bytes, edited regions round-trip through decode and re-encode — which is
lossless for UTF-8 and UTF-16, but may not be for legacy code pages containing characters
outside their repertoire. Where re-encoding would be lossy, the affected edit is refused
with an explanation rather than silently substituting characters.

**Pending deltas are folded before save** (§5.2), so the buffer written is always fully
materialized rather than a buffer plus an offset correction list.

Save never generates text. A Transform rewrites the buffer, triggers a reparse, and
enters the undo history as a single operation; afterwards Save behaves normally again.

**Transforms must be chunked.** M0a measured a naive full-document replacement holding the
old document, the new document and the source text at once: renderer RSS went from 1191 MB
to 5694 MB on a 500 MB file. A Transform therefore streams its output into a new buffer and
swaps, rather than materializing everything and dispatching a single replacement. This is
an implementation constraint on an operation the rest of this section describes as routine,
and it is the reason Transforms are scheduled with the scale work (§12) rather than earlier.

Planned Transforms: format (pretty-print), minify, sort keys, convert between formats.

### 5.6 Undo ownership

**The document layer owns the single undo stack. CodeMirror's own history extension is
disabled.**

Without this, there are two competing histories: CodeMirror's, covering typing in the
Raw View, and whatever tracks Transforms (§5.5), which rewrite the byte buffer directly.
They desynchronise the first time a user types, runs Format, and presses undo. Windowing
(§4.4) sharpens the point rather than softening it: CodeMirror only ever holds a slice of
the document, so its history could not cover an edit outside the current window even in
principle.

Every mutation — keystrokes, Transforms, and later structural edits — is expressed as a
patch against the byte buffer and pushed onto one stack:

```ts
interface Patch { start: number; end: number; replacement: Uint8Array; }
```

Typing coalesces into one undo entry per burst, on the same debounce as reparse. A
Transform is always exactly one entry, however much text it rewrote.

Each entry also records the selection and caret position at the time it was made, and
undo restores them via the §5.1 cascade. Undo that returns the text but not the user's
place in the document is disorienting in a large file.

### 5.7 Formatting policy

**The Raw View always shows the actual bytes of the file.** Its contract with the user
is "this is what is in the file" — the Tree and Detail views already provide the
normalized, format-agnostic representation, so a Raw View that displays anything other
than the real source has no distinct purpose.

Formatting on load is therefore offered, never imposed:

- On open, pathological formatting is detected heuristically (mean row length above a
  threshold). This drives the *offer* only. Soft wrap is decided separately and per window,
  by whether the window has a scroll surface at all (§3.1) — a document can need wrap
  locally without being pathological overall, and needs it whether or not the user accepts
  this offer
- A choice notification offers **[Format document]** / **[Keep as-is]** (D-062, R21-notifications.md —
  amended from "a non-intrusive banner")
- Format document runs the Transform path: rewrites the buffer, reparses, undoable
- A setting, **"Format minified files on open,"** makes this automatic for users who
  prefer always-formatted input

**Formatting is necessarily conservative and partial.** It cannot be applied uniformly:

- **XML** — whitespace in mixed content is significant data. `<p>Hello <b>x</b>!</p>`
  cannot be re-indented without altering `<p>`'s character content. The formatter
  reformats only elements with element-only content, leaves mixed content byte-identical,
  and honours `xml:space="preserve"`.
- **YAML** — block scalars (`|`, `>`) carry significant indentation and are never
  reflowed. Flow-vs-block style is preserved as authored.
- **TOML** — key order and table grouping preserved; only whitespace normalized.
- **JSON** — the only format where formatting is unconditionally safe and total.

Because of this, "always formatted, therefore visually consistent" is not deliverable in
general, which is a further reason not to make it the default.

**Formatting is a readability convenience, not a performance requirement.** M0a measured a
100 MB single-line JSON file at 179 ms p95 keystroke latency with the whole document loaded
— an editor that feels broken — but at the vsync floor, 16.8 ms, indistinguishable from any
other file, once the editor is windowed (§8). Windowing, not formatting, is what fixes the
latency cliff.

What remains is that a 100 MB single line is unpleasant to read, and that is a real reason
to offer the Format command. Soft wrap (§3.1) makes it navigable in the meantime; the row
index exists so that nothing crashes and the tree stays usable regardless.

---

## 6. Search and query

Search is the operation that most reliably makes tools of this kind feel slow — it was
XML Notepad's worst-reported bottleneck (§8) — so it is designed against the flat store
rather than bolted on.

### 6.1 Three tiers

| Tier | Scope | Availability |
|---|---|---|
| **Text find** | substring / regex over the byte buffer | all formats, always |
| **Klados path** | structural query over the unified model | all formats, always |
| **XPath 1.0** | native XML query | XML documents only, post-v1 |

### 6.2 Text find

Plain find is what most users reach for and must never feel slow.

- Operates on the **byte buffer**, not a tree walk — a substring search over `Uint8Array`
  with the needle encoded once
- Results are an `Int32Array` of byte offsets, resolved to nodes only when displayed
- Rendered as: match count, next/previous, highlight in Raw, matching nodes marked in the
  Tree, matching rows marked in the grid
- A **filter-to-matches** mode hides non-matching subtrees in the Tree

### 6.3 Klados path — the primary structural query

A deliberately small syntax evaluated against the unified node model, and therefore
identical on every format:

```
cars/car               children by name
cars//price            any descendant
car[@id="c-001"]       scalar facet predicate
car[3]                 positional
*                      any name
```

Comparison predicates (`car[price>100]`) are deferred to M7. They are where a small query
syntax starts growing a type system — what `>` means when values are strings, or absent on
some rows — and name, position and facet matching cover most real use without that.

`@` denotes a **scalar facet** — an attribute in XML, a scalar property in JSON, YAML or
TOML. Same syntax, same meaning, under the generalization in §2.

**Why this is primary rather than per-format query languages.** Klados's proposition is
one tool for every hierarchical format. A query language that changes depending on which
file happens to be open undercuts that directly, and forces users to hold several
syntaxes for what is structurally the same operation. Since the model is already unified,
a unified query costs nothing extra.

### 6.4 XPath (XML only, post-v1)

Offered *in addition to*, not instead of, the path syntax. The justification is workflow
rather than familiarity: XML users have existing XPath expressions in scripts, schemas
and documentation that they want to paste in and run.

- **XPath 1.0 subset only.** 2.0 and 3.0 add types, sequences and a function library that
  is wildly out of proportion to this tool
- The query-language selector appears only when the active document is XML

**JSONPath is deliberately not planned.** It was standardized only recently (RFC 9535)
after years of mutually incompatible implementations, so it does not name one agreed
thing the way XPath does — and §6.3 already covers the same ground across every format
rather than one.

### 6.5 Name interning

Names repeat massively: three million `<car>` elements share one name. The parser
therefore interns every name into a table and stores a `nameId` per node.

Consequences, all of which matter more than they first appear:

- **Name comparison is an integer compare**, not a byte-slice-and-decode. This is the
  inner loop of every structural query and of grid group detection (§4.3)
- **The intern table is the name index.** `name → node ids` answers "every node called
  `price`" in O(1) plus result size, which is the common case for `//name` queries
- **`nameStart` / `nameEnd` are no longer needed** in the node store, since the name text
  lives in the intern table. Net saving of 4 bytes per node

For XML, the interned key is the qualified name **as written**, with a second interned id
for the resolved `(URI, localName)` pair used by grouping and query matching (§2).

### 6.6 Evaluation over the flat store

- Node sets are `Int32Array` of node indices throughout — never materialized objects.
  A naive engine building object arrays would allocate hundreds of megabytes on a 200 MB
  document
- Evaluation is lazy and **cancellable**; anything exceeding ~50 ms reports progress (§8)
- Queries run in the worker, against the same store, so the UI never blocks
- **Results on a partially parsed document are partial.** As with grid detection (§3.4),
  search over a streaming parse can only cover what has been indexed. Match counts are
  shown as provisional until the document's root carries `subtreeComplete`.
- **Search is scoped to the active tab.** Results, match state and filter mode are per
  document (§11.4). Searching across all open tabs is not offered — it is the first step
  toward the workspace behaviour ruled out in §1, and tabs are independently opened files
  rather than a set.

---

## 7. Command system and keyboard control

Modeled on VS Code, because that is the interaction model being targeted.

### Command registry

Every user-facing action is registered as:

```ts
interface Command {
  id: string;               // "klados.tree.expandAll"
  title: string;
  category: string;
  icon?: IconRef;
  when?: ContextExpression; // "focus == tree && nodeHasChildren"
  surfaces: Surface[];      // palette | commandBar | paneHeader | contextMenu
  weight?: number;          // ordering within a surface
  run(ctx: AppContext): void;
}
```

Menus, keybindings, the top command bar and the per-pane header strips (§4.1) are all
**generated from the registry** by filtering on `surfaces` and `when`. Nothing is wired up
individually. This is cheap to establish at the start and painful to retrofit.

**Invariant, enforced by test rather than discipline:** every command appearing in any
surface must also be reachable from the palette. Keyboard parity decays within weeks
otherwise.

### Context keys

A small reactive key/value store (`focus`, `format`, `nodeKind`, `hasSelection`,
`isReadOnly`, `isWrapped`, …) that `when` clauses evaluate against. This is what allows the
same key to mean different things in the Tree, Detail and Raw views without conditional
logic scattered through the UI.

There is deliberately no `isLargeFile` key. An earlier draft had one, gating commands
behind the size-tiered Raw View that §8 no longer has; capability now varies with document
state and format, not with file size.

### Keybindings

- Chord support (`Ctrl+K Ctrl+S`)
- User-overridable, persisted as a keybindings file
- A defined focus model for moving between the three panes

### Command palette

- Fuzzy search over the registry, filtered by current `when` context
- Recently-used commands ranked first
- Secondary modes via prefix: `>` commands, `@` jump to node by name, `:` go to position
  (a line number, or a byte offset in documents without meaningful lines)

---

## 8. Performance strategy

Target: comfortable at 100–200 MB, functional at 500 MB.

### Windowed Raw View

**There is one Raw View implementation and no file-size threshold.** CodeMirror 6 is the
editor at every size, because it is never given more than ~1 MB of the document at a time
(§4.4).

This replaces an earlier design in which the Raw View sat behind an interface with two
implementations, switching to a custom byte-based viewer above ~50 MB. The M0a spike
measured that premise and found it wrong in both directions: CodeMirror holds a 500 MB
document with 17.5 ms p95 keystroke latency, so the 50 MB figure was low by an order of
magnitude — but it *scrolls* that document at a 266 ms median frame, so raising the
threshold to 500 MB would have shipped a file you can edit and cannot navigate.

Windowing dissolves both problems, because every cost that scaled with document size now
scales with window size instead. Measured at 500 MB:

| | Whole document | 1 MB window |
|---|---|---|
| Open | 2890 ms | **16.1 ms** |
| Renderer memory | +1116 MB | **−3.1 MB** |
| Keystroke p95 | 17.5 ms | 16.8 ms |
| Wheel scroll, median frame | 266 ms | one frame |
| Wheel scroll p95 | 635 ms | **25.0 ms** |
| Jump to position, p50 | 395 ms | **16.7 ms** |
| Minified 100 MB, keystroke p95 | 179 ms | **16.8 ms** |

The one cost windowing adds is re-centring the window when the viewport approaches its
edge, and with the two-edge-change mechanism of §4.4 that cost is **16.8 ms median, 20.8 ms
worst over 60 crossings — the vsync floor, with 0 bytes of drift.** A crude full-window
replacement costs 29/43 ms instead, which is what an earlier draft of this section quoted;
the mechanism matters more than the window size.

Set against a quarter of all frames stuttering at 200 MB whole-document, this is not a
trade so much as a strict improvement.

What this retires, all at once: the size threshold, the second Raw View implementation, the
large-file mode announcement, the minified-file typing cliff, the unbounded decoration set
(§4.4), and CodeMirror's status as an exception to the byte-buffer rule (§3.1). Soft wrap
becomes affordable rather than a luxury, which is what makes minified documents navigable
at all.

**What it costs.** A text selection cannot exceed a window, so operations that span more
must be expressed as document-layer patches (§4.4, §5.6). And the window must be invisible:
crossing it must not move the caret, jump the viewport or drop a frame, which makes
incremental re-windowing at the shared edge a requirement rather than an optimization.

### Other measures

- Virtualization everywhere: tree rows, grid rows, grid columns, raw rows
- Nothing decoded to a string except what is visible
- Parsing off-thread and streaming
- Incremental reparse where the format allows it; full reparse off-thread otherwise
- Memory budget tracked and surfaced in the status bar

### Operations, not just loading

Loading is the easy part — it is one linear pass. The failure mode of comparable tools
is everything that happens *after* loading.

XML Notepad is the reference point here: its maintainer has stated publicly that
performance is poor around 100 MB and that the application would need a redesign to
handle much larger files. Notably, a ~100 MB sample *loaded* in a few seconds; the
reported pain was the Find dialog and subtree insert/delete taking minutes, with the app
unresponsive at under 10% CPU on a single core. That is the signature of an object-graph
DOM manipulated on the UI thread.

Design consequences:

- Find, filter, sort and expand-all must be tight loops over the typed arrays, and
  chunked or moved off-thread so the UI never blocks
- Search needs an **index designed into the store from the start**, even though the
  search UI ships later (M4). Retrofitting an index onto a finished node store is a
  rewrite; leaving room for one is nearly free
- Any operation that could exceed ~50 ms is cancellable and reports progress

### Memory budget

Rule of thumb: **~2.5× the file size** — measured resident, **2.56×** at both 200 and 500 MB
(H9, `docs/plans/M5-RESULTS.md` §6). For a 200 MB XML file at the density measured in M0a —
~32 bytes of source per node under the §3.2 text rules, ~6.6 M nodes:

| Component | Size |
|---|---|
| Source buffer | 200 MB |
| Node store (38 B/node) | ~251 MB |
| Attribute table (1.2 M × 16 B) | ~19 MB |
| Row index | ~31 MB |
| Name index (M4 G1) | ~25 MB |
| Raw View window | ~2 MB |
| Line index (stride 1024) | negligible |
| Name intern table | negligible |
| **Total** | **~528 MB** |

**Two clarifications added after M5 measured this** (`docs/plans/M5-RESULTS.md` §2's reconciliation
note, §6):

- **The name index was missing**, and `M4-RESULTS.md` §1 had already said so — it measured
  **25.1 MB at 200 MB** (a fixed 9.8% of the node+attribute store at every size from 10 to 500 MB)
  and published a corrected ~528 MB total that never made it back into this table. Re-measured
  2026-08-20 at exactly 25.1 MB. The line index, by contrast, really is negligible: its
  `checkpoints` array is strided at 1024, so 7,796,094 lines cost **0.03 MB**, and the row index
  measures 29.7 MB against the ~31 MB budgeted here. The rule of thumb moves from ~2.5× to
  **~2.64×** as a prediction; H9's measured resident figure is 512.2 MB (**2.56×**), between the
  two.
- **This is a table of *resident* components, not a peak.** A peak-RSS walk through the open path
  additionally catches `exportBuffers`'s transfer transient (+49.5 MB at 200 MB), which holds one
  column twice for the moment it is sliced and models nothing resident. Comparing that peak to
  this total is comparing different quantities: **2.84× as a peak, 2.56× resident**. M5's own
  definition of done carried the difference as an unmet criterion for exactly that reason.

At 500 MB that projects to **~1.25 GB** — confirmed by measurement, H9's composed figure at
500 MB is 1280.5 MB. The rule of thumb survived the spike, but only
because of §3.2's text rules: retaining a node per text run gives 19.6 M nodes at 200 MB
and ~985 MB, which is ~5× rather than ~2.5×.

Note that the Raw View no longer contributes meaningfully at any size — that is what
windowing bought. An earlier version of this budget silently excluded the editor's own copy
of the document, which at 200 MB would have added a further ~490 MB.

An object-graph representation of the same file typically costs 5–10×, which is why
conventional viewers fail well below this target. The flat store is what makes the ceiling
reachable at all.

---

## 9. Theming and the style system

### 9.1 Scope

Light and dark themes are available from day one, switchable via a palette command.
User-authored or importable themes are explicitly **out of scope for v1** — the style
system is internal. The goal is two well-built themes, not an extensibility surface.

Dark mode is authored independently, not derived by inversion. Accent colors need
different saturation and lightness to hold contrast against dark surfaces, so the two
token sets are maintained as peers.

### 9.2 Two layers

| Layer | Contents | Referenced by |
|---|---|---|
| **Palette** | raw color ramp (`gray-100`, `blue-500`) | theme definitions only |
| **Semantic tokens** | `surface.bg`, `tree.selectedBg`, `syntax.tagName` | components only |

Components never reference the palette and never contain a literal color. This is
enforced by a stylelint rule banning hex literals outside the theme files — an
automated invariant rather than a convention.

Implementation: CSS custom properties on `:root`, switched by a `data-theme` attribute.
Instant, no runtime cost, no React re-render.

The CodeMirror theme is defined in terms of the same tokens, so syntax colors live in
the single token set rather than in a separate editor configuration.

### 9.3 Elevation must be a token pair

Elevation cannot be expressed as a shadow value, because shadow does not read on dark
surfaces. Each elevation level is therefore a **pair**:

```
--elev-1-bg / --elev-1-shadow
--elev-2-bg / --elev-2-shadow
```

- **Light theme** — background stays near-white; the shadow carries the elevation
- **Dark theme** — shadow drops to near-zero; **a border plus a small background step**
  carries the elevation (amended by R60, `docs/plans/R60-dark-elevation.md`; see below)

A border reads equally well on both themes, which shadow and a background step alone do
not — this was found in practice (R57 added a hairline to fix a white-on-white defect in
light, R60 found dark's own background step had grown to compensate for the border's
absence: four ramp steps, `--gray-700` on `--gray-900`, "very gray" rather than a tint).
Once the border is available as a mechanism, dark's background step does not have to
carry elevation alone, and drops to one step (`--gray-850`). **The border is a property
of the elevation tier**, not of any one component — every `--elev-2-bg` surface declares
`border: var(--border-width) solid var(--surface-border)`, not just the surface that
happened to need it first.

Components declare an elevation level and never set a shadow directly. Following
Fluent, each shadow combines a sharp directional *key* shadow defining the element's
edges with a soft diffused *ambient* shadow implying distance.

This is the specific requirement that makes a built-in style system necessary: a theme
layer that only swaps colors produces a dark mode in which every elevated surface
looks flat.

**The same "a background alone cannot carry the signal" shape recurred for Find's
current-match highlight** (R80, `docs/plans/R78-find-affordances.md` §3): a brighter fill
for the current match measured down to 1.04:1 for text over it, and no value between the
dim fill (already at its own contrast floor) and the old one is both legible and visibly
distinct — the current-match signal cannot be a fill at all. The fix is the same shape as
dark elevation's border: `--find-match-current-border`, drawn as an `inset` ring around
the current match rather than a background swap. `--find-match-bg` stays the one fill for
every match; `--find-match-marker` is the separate, unrelated "this row/bucket has a
match" bar Tree/Grid/Scrubber use (never "current" in those three places, despite having
shared a token name with it before R80).

### 9.4 Elevation budget

Klados is a data-dense inspection tool, and every elevated surface costs padding while
padding costs visible rows. Elevation is therefore spent deliberately:

- **Elevated** — the top command bar; transient surfaces (command palette, context
  menus, popovers, the notification layer — amended from "the minified-file banner" by
  D-062, R21-notifications.md, which replaced it)
- **Flat** — the three main panes, separated by 1px dividers and background tone

Row height for tree and grid is **22–24px**, not Fluent's 32–44px defaults, which are
touch-influenced and would cost roughly a third of the visible rows. Fluent's colors,
shadows and icons are adopted; its metrics are not.

### 9.5 Iconography

**Fluent UI System Icons** (MIT). Chosen for license compatibility and because the set
is drawn separately at each size (16/20/24/28/32/48) rather than scaled from one master
— at the 16px sizes a dense tool actually uses, hand-tuned glyphs stay crisp where
scaled-down ones do not.

The Regular/Filled theme pair maps onto Klados's states: Regular as default, Filled
for the selected node and active toggles.

Permissive alternatives if the visual direction changes: Lucide (ISC), Phosphor (MIT),
Tabler (MIT).

### 9.6 Theme rot

Because dark mode is not a user-facing feature in v1, it is at risk of decaying. Two
mitigations:

- A theme-toggle command in the palette from the first commit, used constantly during
  development
- Both themes checked whenever focus rings, alternating grid rows, or disabled states
  are touched — these are the three things that reliably break first

---

## 10. Technology stack

### 10.1 Stack

| Concern | Choice | Rationale |
|---|---|---|
| Shell | Electron | one language, no IPC boundary, no second toolchain |
| Language | TypeScript | by far the best-represented stack for this class of app |
| UI | React | ecosystem depth for virtualized trees and grids |
| Raw editor | CodeMirror 6 | better large-document behavior than Monaco, more modular |
| Palette | `cmdk` or equivalent | proven component, avoids rebuilding fuzzy-match UI |
| Parsers | hand-written, in TypeScript | must emit byte spans; off-the-shelf parsers discard them |

**On the parsers:** no general-purpose JSON/XML/YAML library will work here, because
they all discard source positions and materialize objects. These are streaming,
span-emitting parsers writing into the flat node store — the core intellectual work of
the project, and roughly one focused module per format.

**Escape hatch:** if a format's parser proves too slow in TypeScript, it can be replaced
with a WASM module behind the same interface without disturbing anything above it.

### 10.2 Licensing

**Klados is MIT licensed.** Chosen over Apache-2.0 because it is an application rather
than a library, patent exposure for a file viewer is largely theoretical, and brevity
lowers the barrier for contributors. It also matches every major dependency — Electron,
CodeMirror and Fluent UI System Icons are all MIT — and stays GPLv2-compatible, which
Apache-2.0 is not.

**Practical obligation:** MIT requires preserving copyright notices, which for an Electron
app means bundling the licence texts of every transitive dependency. Generate a
third-party notices file as part of the build rather than maintaining one by hand, and
verify the icon set's attribution requirements separately from the code's.

---

## 11. Document lifecycle and quality

### 11.1 Opening an invalid document

§3.4 covers documents that become invalid *during* editing — the last known-good tree is
retained. A file that is already invalid when opened has no such fallback.

Behaviour: parse to the point of failure, present the partial tree with the error node
marked, and open the Raw View at the error position with a diagnostic banner. A partial
tree is more useful than an error screen, since diagnosing the breakage is usually why
the file was opened.

### 11.2 Read-only and oversized files

**Read-only files** open normally, with editing commands disabled via a context key
(§7) and the state shown in the status bar rather than discovered on a failed save. If
permissions change while the document is open, the file watcher (§11.4) picks it up and
the state updates.

**Size limits are two-tiered**, because a single hard number is either arbitrary or
wrong:

| Limit | Value | Behaviour |
|---|---|---|
| Soft cap | 500 MB, configurable | confirmation showing the estimated cost — *"this file needs ~1.25 GB; continue?"* — never a refusal |
| Hard ceiling | ~2 GB | refused, with the reason stated |

The hard ceiling is not a policy choice: spans are `Int32Array`, so byte offsets cannot
address beyond ~2.1 GB. Raising it means moving every offset to Float64 or BigInt, which
is a different architecture rather than a tuning change.

The soft cap is a confirmation because the real constraint is available memory, not file
size — a machine with 64 GB should not be told no by a constant. The estimate shown is the
2.5× rule from §8, which is measured rather than assumed.

**Parse timeouts.** Beyond the nesting-depth cap (§3.4), a parse exceeding a wall-clock
budget reports progress and offers cancellation rather than running unbounded.

### 11.3 External modification

The file may change on disk while open. Klados watches the file and, on change:

- **No unsaved edits** — reload silently, restoring selection via the §5.1 cascade
- **Unsaved edits** — a non-blocking choice notification offering *Reload and discard* /
  *Keep mine* (D-062, R21-notifications.md R23 — amended from "a non-blocking banner"; built
  there, having had no caller anywhere until then). Never auto-reload over unsaved work, and
  never block on a modal

### 11.4 Multiple documents — tabs

v1 supports **tabs**: several documents open in one window.

**Tabs are not a workspace.** No folder tree, no cross-file search, no project
configuration — the §1 non-goal stands. A tab is one independently opened file.

Consequences:

- **Memory is the binding constraint.** Each document costs ~2.5× its file size (§8), so
  three 200 MB files is ~1.5 GB. The status bar reports total footprint, and opening a
  document that would exceed a configurable budget prompts rather than silently
  degrading. The Raw View adds ~1 MB per tab regardless of file size (§4.4), so it does
  not enter this calculation — which is only true because it is windowed.
- **All document state is per tab**: selection, expansion, scroll, layout, undo stack,
  search results, grid/list overrides. Only preferences and theme are global.
- **A small fixed worker pool** (2–3) with a queue, not one worker per tab. Per-tab
  workers scale badly and sit idle most of the time.
- **Context keys resolve against the active tab** (§7) — `format`, `isReadOnly` and the
  rest describe the focused document, not the application.
- Session restore reopens the previous tab set on launch.

**Tab anatomy.** Left to right: a format icon, the filename, and a combined
dirty/close affordance.

- **Format icon**, 16px, drawn from each format's most characteristic punctuation —
  `<>` for XML, `{}` for JSON, `[ ]` for TOML, a dash-list for YAML. Each carries a muted
  per-format tint so a strip of six tabs is scannable before any text is read. The tints
  stay desaturated deliberately: the brand amber marks the *active* tab, and a rainbow of
  saturated icons would compete with it.
- The icon is chosen by a **UI-side map keyed on `capabilities.id`**, not supplied by the
  format module. Icons are presentation, and the parser layer stays free of it for the same
  reason it does not own syntax token classes (§3.3).
- **Middle truncation, never end truncation.** `fleet-export-2026-q3.xml` becomes
  `fleet-exp…q3.xml`, not `fleet-export-20…`. The end of a filename carries the extension
  and usually the version or date — the most distinguishing part, and the first thing lost
  by a naive `text-overflow: ellipsis`.
- **Same-name disambiguation.** Two tabs resolving to the same filename gain the smallest
  distinguishing path segment (`data/config.yaml` beside `test/config.yaml`). With tabs
  this is not an edge case; `config.yaml` open three times is ordinary.
- **Width:** tabs shrink to fit down to a minimum of ~120px, after which the strip scrolls
  rather than shrinking further. Below that width a name truncates to uselessness.
- **Tooltip** shows the full absolute path, which makes truncation lossless in practice.
- The **dirty indicator and close button share one slot** — a dot when the document is
  modified, becoming a close cross on hover. A tab is a narrow element and a separate
  indicator spends horizontal space that the filename needs.

**Dirty state and closing:**

- Each tab carries a dirty indicator; the window title reflects the active tab's state
- Closing a dirty tab prompts *Save* / *Discard* / *Cancel*; closing a clean tab is silent
- Quitting with several dirty tabs presents one consolidated list with per-file choices,
  not a sequence of modals
- **Save all** is a command; there is no autosave, which would conflict with the
  byte-identical guarantee in §5.5 by writing at moments the user did not choose

*Post-v1 if the memory budget proves tight:* evict background documents' node stores
while retaining their byte buffers, reparsing on activation (~1–2 s for 200 MB).

### 11.5 Accessibility

Keyboard-first design (§7) delivers much of this, but not the semantics. The Tree
implements the ARIA `tree` pattern and the grid the ARIA `grid` pattern, both of which
constrain how virtualization is implemented: `aria-setsize` and `aria-posinset` must
report *document* counts, not the count of rendered rows. This is far cheaper to build in
than to retrofit, since it touches the virtualizer directly.

Derived cells (§4.3) carry a screen-reader label distinguishing them from literal values,
because the dimmed styling that conveys this visually is invisible to assistive tech.

### 11.6 Testing strategy

Parser-heavy projects fail in spans, so testing is a named part of the design:

- **Round-trip invariant** — for every test document, parse then save with no edit must
  produce a byte-identical file. This is the single most valuable test in the project and
  it protects the §5 fidelity guarantee directly. It cannot run until there is a save path
  (M3); until then M0's subtree-reparse-equivalence test is the closest substitute
- **Span invariant** — every node's `[spanStart, spanEnd)` must contain its name, value
  and all descendants, and siblings must not overlap. Siblings may leave **gaps**, since
  insignificant whitespace is not modelled (§3.2) — non-overlap is the invariant, not
  contiguity. Checkable exhaustively on any parse
- **Fuzzing** — truncated, corrupted and adversarially nested inputs must produce
  diagnostics, never crashes or hangs. Deep nesting specifically, given §3.3
- **Golden files** — a corpus of real-world documents per format, including the awkward
  ones: mixed content, CDATA, namespace-heavy XML, minified JSON, YAML with anchors
- **Performance regression** — parse throughput and memory tracked per commit against
  fixed large files, so a regression is caught when introduced

---

## 12. Roadmap

**M0a — Spike (days, not weeks) — complete**
Benchmarked CodeMirror 6 at 10–500 MB and a throwaway byte-scanning XML parser on the same
files. Results in `spike/RESULTS.md`.

It changed the design in five places, which is what it was for: the Raw View is windowed
rather than tiered (§8), node density is 5× what §3.2 assumed and forced the text rules
there, the pending-delta list (§5.2) is mandatory rather than optional, Transforms need a
chunked implementation (§5.5), and soft wrap became load-bearing rather than a preference
(§3.1).

Parsers stay in TypeScript. A3 measured **200 MB/s** for the throwaway spike parser; the
production parser, carrying interning, the `NodeSink` contract and §3.2's text rules, runs
at **~65 MB/s** (200 MB in ~3.15 s). The conclusion survives — §10.1's WASM escape hatch
stays unused — but the spike figure is not the shipping one and should not be quoted as if
it were.

A follow-up task, A6b, confirmed the two things the windowing measurement had inferred:
that re-windowing by two edge changes is frame-perfect with zero drift, and that soft wrap
gives a single-line document a real scroll surface.

**M0b — Core — complete**
Source buffer, row index, flat node store, XML and JSON parsers with spans, worker
pipeline. Search index designed in, even though search ships at M4. Results in
`docs/plans/M0-RESULTS.md`; node count, store size and the density prediction in §3.2 all held.

**M0c — Core close-out — complete**
Five things no M0b task owned, found on review: BOM and encoding never reach the worker
(so BOM'd JSON mis-parsed), the resolved encoding never reached the main thread, the row
index was built by nothing, the store transfer allocated ~356 MB it discarded, and the
worker's forwarding sink cost 21% of parse time. All five closed; plan in
`docs/plans/M0c-PLAN.md`, results folded into `docs/plans/M0-RESULTS.md`.

Separate from M1 rather than folded into it because M1 builds on all five — the Raw View
cannot decode a window without an encoding, and the scrubber is defined in terms of a row
index that is never built.

Two defects in the same seam survived it, both unreachable until a real `Worker` runs: the
store arrays are cloned rather than transferred, and an unrecognised declared encoding
hangs the open promise. They are M1's D0, ahead of everything else.

**M1 — Views**
Tree, Detail (list mode), Raw with windowed CodeMirror and the scrubber (§4.4, §4.5).
Selection synchronization. Command registry, keybindings, palette. Both themes.

Windowing lands here rather than at M5 because it is how the Raw View works at every size,
not a scale feature bolted on later.

**M2 — The signature feature**
Grid mode: group detection, column collection, cell rendering rules, transparent
wrappers, sorting, filtering, copy-as-table.

**M2b — Fit and finish**
The first milestone about how the application looks and feels rather than what it can do.
Resolve `Command.icon` against the Fluent set (§9.5) — it is a bare string with no resolver
until here — wire the application and title-bar icons from `assets/README.md`, audit the
elevation budget (§9.4) against what was actually built, empty and loading states, density
and spacing across the three panes, and focus rings and disabled states in both themes.
Plus the accumulated observations in `docs/plans/UI-FEEDBACK.md`.

**Here rather than earlier** because M2 completes the read-only inspection story, which is
the first build worth showing anyone and the first point where testing feedback is about
the finished shape rather than about scaffolding. Polishing the Detail view before grid
mode exists means polishing the section M2 replaces.

**Here rather than later** because M3 adds chrome of its own — dirty indicators, save
affordances, undo feedback, `isReadOnly` becoming visible for the first time — and that is
much cheaper to build onto settled conventions than to retrofit into them.

**It is not the only polish.** §9.6 already requires checking both themes whenever focus
rings, alternating rows or disabled states are touched, and every UI milestone ends with
its own close-out. This one exists for the cross-cutting work, not to absorb a two-milestone
backlog — see D-034 on why it needs a bounded entry list rather than an open invitation.

**M3 — Editing**
Raw-view editing, debounced reparse, last-good-tree retention, selection re-resolution
cascade, unified undo stack.

**M4 — Search**
Text find, Klados path queries, filter-to-matches, name index. Promoted ahead of format
breadth because search is the operation that most reliably makes tools of this kind feel
slow (§8), and because the name index it depends on is load-bearing for grid detection
too. Plan in `docs/plans/M4-PLAN.md`.

Note that §6.5's "the intern table **is** the name index" describes an intention, not a
property: `Interner` maps id → bytes and nothing maps a name to its nodes. M4 builds it.

**M5 — Scale**
Streaming tree population. Format/minify Transforms with the chunked write path (§5.5),
and the minified-file banner. Plan in `docs/plans/M5-PLAN.md`.

Streaming is the milestone's open question rather than its given: the parse pipeline
transfers the source bytes *into* the worker and the store back out, so during a parse
neither side holds both. Making the tree browsable mid-parse means checkpointed appends,
shared memory, or a decision not to — settled in M5's first task, not assumed here.

Smaller than originally planned: the custom virtualized raw viewer and large-file mode are
no longer needed, because the Raw View is windowed from M1 onward (§8). Format-on-open is
here rather than earlier because M0a showed the minified typing cliff is fixed by
windowing, not by formatting — what remains is readability, which is a convenience.

**M6 — TOML**
The cheapest additional format, and the one that proves the parser interface is genuinely
format-agnostic before the expensive one is attempted.

**M7 — Query predicates**
Comparison predicates in the path syntax (`car[price>100]`), and the type-coercion rules
they require. Placed here deliberately: after TOML has proven the parser interface, and
before YAML, so the query layer is finished while the format layer is still simple.

**M8 — YAML**
Its own milestone, deliberately. Once XML and JSON are done the *application* needs no
work to accept a new format — that is what §2 bought — but YAML's **parser** is the
hardest of the four by a wide margin: anchors and aliases, tags, block scalars with
indentation indicators, flow style nested inside block style, multi-document streams,
implicit typing, merge keys. Budget it comparably to the XML parser, not alongside TOML.
Comment attachment and display land here, since YAML is where they matter most.

**Later**
XPath 1.0 for XML, schema validation, structural edit commands, per-column expansion,
multiple stacked grids, background-document eviction, plugin API for additional formats.

---

## 13. Open questions

- ~~**Name availability**~~ — **answered while planning publication, and the answer was no.**
  Google corrects "NodePad" to *Notepad*, so the name cannot be won in a search;
  `mskayyali/nodepad` is an active 1.1k-star MIT project with a commercial product behind it
  (node-pad.com); and the npm name has been taken since 2011. The application is renamed
  **Klados** — Greek κλάδος, *branch*, the root of *clade*: an ancestor together with all its
  descendants, which is what a subtree is here. Decision and rejected alternatives in
  `docs/DECISIONS.md` D-086; the new mark in D-087; the rename itself is R144
  (`docs/plans/R140-publication.md` §7). **The registers were checked and are clear** — DPMA and
  EUIPO, classes 9 (software) and 42 (SaaS/software development), searched by hand because every
  register refuses programmatic queries: **no conflicting mark**. Recorded either way, per the
  rule that a checked-and-clear is as much an answer as a collision.
- **Window size** — 1 MB measured best of {256 KB, 1 MB, 4 MB}; larger is worse because a
  full-replacement re-window scales with it. Incremental re-windowing (§4.4) largely removes
  that pressure, so the value may be freer than it looked. A tunable, like row size N, not a
  constant to trust.
- **Wrap's first-paint cost** — ~400 ms on a 1 MB window of unbroken text, from computing
  wrap points before first paint. Measured, and specific to the minified case where wrap is
  load-bearing. Is a loading state enough, or should the first window be smaller when wrap
  is about to be turned on?
- ~~**JSON node density**~~ — **answered at M0b.** `cars-100mb.json` (pretty) 5,085,254
  nodes; `cars-100mb.min.json` 8,866,489. The minified file holds ~1.7× the nodes at the
  same byte cap because more records fit, not because density differs — which is the
  design's claim that whitespace handling is orthogonal to the node model, confirmed. No
  bytes/node figure comparable to XML's ~32 B yet; worth computing if JSON becomes a
  large-file target.
- **Subtree reparse latency** — §5.2 says M0a must measure this and it did not. Only the
  bulk offset shift was probed (A4). Whether editing a 200 MB file *feels* instant is still
  an assumption, and M3 is where it gets tested.
- **Viewport decoration cost** — every M0a latency figure was measured with syntax
  highlighting off. Windowing bounds the worst case, so this is much less dangerous than it
  was, but the number is still unmeasured. M1.
- **Wrapper descent depth** — the limit is ~3, but Appendix A reaches it in a deliberately
  small example (root → `garage` → `cars` → `elements`). Is 3 too tight, or should descent
  be unbounded and simply stop at the first node with repeating children?
- **Grid coverage floor** — 5% is a guess for suppressing one-off children. Needs real
  documents.
- **Legacy encodings** — detection and preservation are settled (§5.5), but which code
  pages are worth supporting at all, given that lossy re-encoding means refusing edits?
- **Delta list threshold** — folding at ~64 pending deltas (§5.2) is a guess; the right
  value depends on the measured cost of a background full reparse at each file size.
- **Subtree splice granularity** — reparsing the innermost containing node is the obvious
  unit, but for a document whose root has one enormous child that degenerates to a full
  reparse. Is a size-bounded ancestor search worth it?
- **Formatter scope** — is a conservative XML formatter worth building for M5, or does the
  Format command ship JSON-only at first?
- **Streaming tree presentation** — how is a partially-parsed tree shown without implying
  the document ends where parsing has reached?
- **CSV export semantics** — v1 copies displayed text, losing the literal/derived
  distinction (§4.3). What do users actually expect: expansion, a marker, or empty cells?
- **Memory budget default** — what total footprint should prompt before opening another
  tab (§11.4)? The per-document cost is now measured at ~2.5×, so this is a policy choice
  rather than an unknown.
- **Row size N** — the *unit* is settled (bytes, §3.1); the value is not. 512 is the
  starting point; real documents should decide it. First data: at 512 bytes,
  `cars-200mb.xml` yields 7,796,094 rows and a 29.7 MB index — close to §8's budgeted
  31 MB, and a real enough line item that N is a memory trade, not just a resolution one.
  M1 D15 settles it.
- **Line-checkpoint stride** — 1024 rows between checkpoints costs 30 KB on a 200 MB
  document against the 29.7 MB a second line index would, and bounds the residual scan at
  1024 byte comparisons (measured: 0.9 ms for 60 queries, i.e. a gutter repaint). Like N,
  a tunable rather than a constant to trust — but the ratio is lopsided enough that it is
  unlikely to matter.

---

## Appendix A — Worked example

A deliberately small document that exercises every rule in §4.3.

### A.1 XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<garage>
  <!-- Fleet inventory, updated 2026-07 -->
  <cars>
    <elements>
      <car id="c-001" color="red">
        <name>Golf</name>
        <year>2019</year>
        <engine>
          <type>diesel</type>
          <kw>110</kw>
        </engine>
        <owner>Smith</owner>
        <owner>Jones</owner>
        <sunroof/>
      </car>
      <car id="c-002" color="blue">
        <name>Model 3</name>
        <year>2023</year>
        <engine>
          <type>electric</type>
          <kw>239</kw>
        </engine>
        <owner>Lee</owner>
      </car>
      <car id="c-003">
        <name>Panda</name>
        <year>2011</year>
        <engine>petrol</engine>
        <owner>Weber</owner>
      </car>
    </elements>
  </cars>
</garage>
```

### A.2 What the Detail view shows for `cars`

`cars` is a transparent wrapper — one composite child, no attributes, no text — so the
view descends to `elements` and renders its repeating `car` children as a grid.

Breadcrumb: `garage › cars › elements`

| # | @id | @color | name | year | engine ▸ | owner | sunroof |
|---|---|---|---|---|---|---|---|
| 1 | c-001 | red | Golf | 2019 | *diesel · 110* ▸ | *Smith, Jones* ×2 | ✓ |
| 2 | c-002 | blue | Model 3 | 2023 | *electric · 239* ▸ | Lee | — |
| 3 | c-003 | — | Panda | 2011 | petrol | Weber | — |

Every rule is visible in three rows:

- **Transparent wrapper** — `cars › elements` collapsed into the breadcrumb rather than
  producing a one-row table containing the word "elements"
- **Absent vs. empty** — `@color` on row 3 and `sunroof` on rows 2–3 show `—`
- **Derived vs. literal** — `engine` is a dimmed summary on rows 1–2 but the literal
  text `petrol` on row 3, because the kind is per cell, not per column
- **Multiplicity** — `owner` on row 1 is dimmed with a `×2` badge; on rows 2–3 it is a
  single literal value and is not dimmed
- **Header icons** — `engine` carries the composite icon and a chevron even though one
  row is scalar; `owner` carries the repeating icon
- **Typing** — `year` right-aligns; everything else left-aligns
- **Comment** — attached to `cars`; because `cars` is descended through, the comment is
  surfaced on the destination node labelled with its origin segment. Preserved
  byte-identically in the source regardless

**A note on wrapper depth.** `garage` is *also* a transparent wrapper — one composite
child, no attributes, no text — so the full chain is root → `garage` → `cars` →
`elements`, three hops, which is already the descent limit in a deliberately tiny
example. The consequence is that opening this file lands the user directly on the cars
table. That is almost certainly the desired behaviour, but it should be an intentional
decision rather than a side effect, and it suggests the limit is tighter than real
documents will need (§13).

### A.3 JSON equivalent

```json
{
  "garage": {
    "cars": {
      "items": [
        {
          "id": "c-001",
          "color": "red",
          "name": "Golf",
          "year": 2019,
          "engine": { "type": "diesel", "kw": 110 },
          "owners": ["Smith", "Jones"],
          "sunroof": true
        },
        {
          "id": "c-002",
          "color": "blue",
          "name": "Model 3",
          "year": 2023,
          "engine": { "type": "electric", "kw": 239 },
          "owners": ["Lee"]
        },
        {
          "id": "c-003",
          "name": "Panda",
          "year": 2011,
          "engine": "petrol",
          "owners": ["Weber"]
        }
      ]
    }
  }
}
```

Very nearly the same grid, via a different route — which is the point of the facet
generalization in §2:

- **No attributes.** `id` and `color` are ordinary scalar properties and carry the
  scalar icon rather than the `@` icon. The `@id` / `@color` distinction is XML-only.
- **Multiplicity arrives as an array.** XML expresses repetition as sibling `<owner>`
  elements; JSON expresses it as one array-valued property, `owners`. Structurally
  different in the model — multiplicity versus a single composite child — but both
  render as a dimmed, badged cell, because what the user needs to know is the same.
- **`cars` is still a transparent wrapper**, with `items` as its single composite child.
- **`engine` still varies in kind** across rows, object on two and string on the third.
- **One cell genuinely differs.** XML's `<sunroof/>` is an empty element and renders as a
  derived `✓`; JSON's `"sunroof": true` is a literal boolean and renders as `true`. The
  same real-world fact, but one document states a value and the other states only
  presence, so the cells honestly differ. This is the literal/derived rule (§4.3) working
  as intended rather than an inconsistency to paper over.
