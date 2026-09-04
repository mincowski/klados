# M6 — Results

Tasks **R14–R17**. Plan: `docs/plans/M6-PLAN.md`. `npm test` (1022 tests, node project) and
`npm run typecheck`/`npm run lint` all pass after every task below. No display was available in
any session that built this milestone — the same gap `M5c-RESULTS.md`'s J9 and `M5d-RESULTS.md`
flagged rather than smoothed over — so the architecture-validation check (§4) runs through
`npm run inspect` and two small standalone scripts driving the real production modules directly,
not through a live Electron window. `Tree`/`Detail`/grid mode/Find/undo/Save are visual and
interaction surfaces this milestone did not get to exercise through a real GUI session; §4 records
exactly what *was* and was not checked, rather than assuming the untested paths behave.

---

## R14 — The parser

Done. `src/formats/toml/index.ts`, ~1350 lines, no new `NodeKind`: tables and array-of-tables
elements map to `NodeKind.Object`, arrays-of-tables to `NodeKind.Array`, key-value pairs to
`NodeKind.Property` folding their own scalar directly (D-030's rule, already true for JSON).

Full grammar coverage per the plan's own list: bare/quoted/literal keys and dotted key paths;
`[table]`/`[[array of tables]]` headers including dotted names; inline tables and inline arrays,
iterative (see below); basic/literal/multi-line strings (escapes not decoded — spans only, the
same simplification `json/index.ts`'s `scanString` already uses); integers (decimal, hex, octal,
binary, `_` separators), floats (`_` separators, `inf`/`nan`, signed), booleans, and all four
date/time forms — every scalar an opaque byte span, no type discrimination in the model, matching
JSON's own precedent; comments (`NodeKind.Comment`, the same kind XML already has, so
`detailModel.ts`'s existing `adjacentCommentOf` needed no format-specific branch).

**Two real bugs found building this, both fixed and regression-tested before commit** (see
`test/tomlParse.test.ts`):

- Inline table/array parsing was initially recursive (`parseInlineTable`/`parseInlineArray`
  calling each other) — hard rule 4 violation, caught by a 5,000-deep inline-array test
  overflowing the call stack. Rewritten as one iterative `InlineFrame[]`-stack loop, mirroring
  `json/index.ts`'s own `Frame`/`stepObject`/`stepArray` shape exactly.
- `[[name]]` redefining a name already opened as a plain `[table]` (a spec violation) crashed via
  an unchecked cast (`top as Extract<StackFrame, {kind:'array'}>` when `top.kind === 'table'`).
  Fixed with an explicit kind check and best-effort recovery (invariant 5), not a crash.

**Registration** (the two points the plan named in advance, so they wouldn't be mistaken for
scope creep found along the way): `tomlFormatModule` added to `REGISTERED_FORMATS`
(`src/formats/registry.ts`), and `'toml'` added to the open-dialog filter's extensions
(`src/main/documents.ts`). Nothing else needed touching — `Tree`/`Detail`/grid mode/Find/the path
query engine/undo/edit all read `FormatCapabilities` or work off `NodeKind`/`NodeStore`, never a
format id, confirmed by the same registry read the plan's own research pass did.

**A disclosed, deliberate limitation, not a bug**: TOML legally permits non-contiguous table
extension (`[x.y.z]` then later, after unrelated content, `[x]`) — incompatible with this
project's contiguous-span tree model (every other parser here relies on it: Raw view windowing,
subtree splicing, no overlapping spans between non-ancestor nodes). The parser does not attempt to
merge; a later `[x]` opens a second, separate `Object` also named `x`, never corrupting spans.
Real-world TOML defines parents before children, contiguously, essentially always — this is
believed unreachable in practice and is called out here rather than left to be rediscovered.

## R15 — Incremental reparse

Done. `resumeContextFor` classifies purely from the ancestor chain (`AncestorView` has no name
accessor and excludes the node itself) into four shapes — `document`, `inlineValue` (any ancestor
is a `Property`, not just the immediate parent — catches an inline value at any nesting depth),
`arrayElement` (immediate parent is `Array`), `headerTable` (everything else). `parseRange`
dispatches on that shape and reproduces exactly the node `subtreeSplice.ts` selected, as fresh
index 0, without reading anything outside `[start, end)`.

**Three real bugs found and fixed while building this**, each caught by
`test/subtreeSplice.test.ts` running the *real* `spliceSubtree`/`beginSpliceSubtree` production
path, not the parser in isolation:

- A table's close offset used the next header's own *name* span (past its `[`), leaving the
  previous table's span reaching into the next header's own bracket syntax — a genuine
  sibling-span overlap, not just imprecision. Fixed by making the header's own `[` position
  (`originOverride`) serve as both the open-span-start *and* the close offset for whatever it
  closes.
- An `arrayElement` resume opened the element node directly without first consuming its own
  `[[name]]` header — the body loop's first byte was always `[`, which its own "don't handle a
  nested header" rule unconditionally bails on, so every array-element resume reported
  `complete: false`. Fixed by consuming the header on the real state before opening the element.
- A dotted-key implicit table's own name was consumed as a separate token before handing the rest
  to the body loop, orphaning the tail of its own first statement (`physical.color = …` split at
  the dot) and creating a spurious duplicate nested table on the next line. Fixed by peeking the
  name (not consuming it) and seeding the body loop's local stack with the already-open node.

**Two disclosed scope cuts**, not silently forced: `runSelfContainedBody` (an array-of-tables
element or dotted-key table resumed as its own root) does not attempt a nested `[table]`/
`[[array]]` header found inside its own body — that would need relative-path navigation against
an owner it doesn't otherwise need to know, real additional machinery for a pattern real-world
TOML rarely produces. It reports `complete: false` and `subtreeSplice.ts` falls back to a full
reparse, safely. `test/subtreeSplice.test.ts` has a dedicated test for exactly this shape.

## R16 — The formatter

Done. `format()`, `canFormat: true`. CONCEPT.md §5.7's rule for TOML — "key order and table
grouping preserved; only whitespace normalized" — reformats every top-level statement: single
space around `=`, normalized `[header]`/`[[header]]` bracket spacing, dotted-key spacing collapsed
(`a . b` → `a.b`), leading indentation stripped (canonical TOML has none), newline style
normalized, blank-line *count* between statements preserved exactly (collapsing it would be a
layout policy, not whitespace normalization). Multi-line strings are always copied verbatim
(`GrowableBytes.pushBytes`, never decoded) — the plan's own named judgment call.

A **single-line** inline table/array is reformatted with consistent internal spacing
(`{a=1,b=2}` → `{ a = 1, b = 2 }`, `[1,2,3]` → `[1, 2, 3]`) via a new iterative `FormatFrame`
stack mirroring `parseInlineValue`'s own shape (hard rule 4). A **multi-line** inline array is
copied verbatim instead: TOML legally lets one span lines and hold `#` comments between elements,
and collapsing that layout risks losing a comment or corrupting its placement. Whether a value's
span has a newline is checked once, by running the real `parseInlineValue` against a throwaway
`ParserState` — never a second, parallel scanner that could disagree with the parser about where a
string or nested container actually ends.

Tests: idempotence and structural-equivalence invariants over a 300-sample generated corpus
(`test/tomlFormat.test.ts`), the same shape `test/xmlFormat.test.ts`/JSON's own formatter tests
already use, plus named acceptance cases for every normalization rule and both verbatim
carve-outs (multi-line array with a comment, multi-line string).

## R17 — Fixtures, invariant suite, and the verdict

**Fixtures**: `test/fixtures/toml/grammar-coverage.toml` (one small file exercising every R14
grammar feature — every key/string/number/date form, comments, dotted keys, both header kinds,
inline containers, a Comment inside a multi-line inline array, a dotted array-of-tables header)
and `test/fixtures/toml/cargo-style.toml` (a real-world-shaped document — nested inline tables,
a dependency table opened both inline and via a dotted header, multiple `[[bin]]` entries, dotted
array-of-tables metadata). No large generated-corpus fixture: TOML documents are overwhelmingly
config-sized in practice (the plan's own prediction), and nothing in this milestone's measurements
suggested otherwise — not needed, not a silent gap.

**The invariant suite** (`test/tomlFixtures.test.ts`): both fixtures parse cleanly (zero
diagnostics, a complete tree), `detect()` recognizes each by content alone, `format()` is
idempotent and structurally lossless, and — the check that mattered most — **every real node**
(except `Property`, which `findSpliceNode` always escalates past and so is never itself a real
splice target) round-trips through `resumeContextFor` + `parseRange`, the same production path
`subtreeSplice.ts` uses, not a synthetic re-derivation of it.

**That exhaustive round-trip caught two more real bugs**, both fixed and regression-tested before
this document was written (see `test/tomlParse.test.ts`, the *"an implicit table's span ends
before the next bare key's own text"* tests):

- The same close-offset class of bug R15's own review already found once, in a shape the
  generated corpus and the hand-written R14/R15 tests hadn't happened to produce:
  `navigateToTablePath`'s close-offset fallback used `state.pos` at the point it was called — but
  for a *plain* (non-dotted) key, `parseKeyValueStatement` calls `scanKeyPath` (consuming the new
  key's own text, `=`, and surrounding whitespace) *before* calling `navigateToTablePath`, so
  `state.pos` had already moved past the next key's own text. An implicit table closing for a
  subsequent plain key at the same level silently swallowed that key's leading bytes into its own
  span — invisible to every tree-shape assertion up to this point (parent/child/value all still
  resolved correctly; only the exact span boundary was wrong), which is exactly why fixture-level,
  exhaustive testing found it and hand-picked examples hadn't. The same bug, same fix, existed at
  two call sites (the top-level statement loop and the inline-table body loop); both now pass
  their own statement's start as a `closeOffsetOverride`, kept deliberately distinct from
  `originOverride` (which also drives newly-opened frames' own span starts, and must not be
  conflated with the close offset for a multi-segment dotted key opening several new tables in one
  statement).
- `resumeContextFor`'s ancestor-only vantage point cannot distinguish a standalone `Comment` node
  from an implicit dotted-key table — both can have the identical ancestor chain. An edit strictly
  inside a comment's own text (not replacing its whole span) really does make `findSpliceNode`
  select the Comment itself, and `parseRange` read its `#` as the start of an implicit table's
  first key statement. Fixed by checking for a leading `#` first, in both the `'headerTable'` and
  `'inlineValue'` branches, and delegating to `parseComment` directly.

Worth recording on its own terms, separate from `CLAUDE.md`'s existing pipeline/measurement
pattern (M2's `isNumericColumn`, M0's row-index pre-scan claim, M5c's `byteOffsetToLocalUnits`):
**a bug that is invisible to every tree-shape assertion** — parent, child, and value all still
resolve correctly, only the exact span boundary is wrong — is exactly the kind hand-written
examples and a generated corpus (which also only ever asserts shape, per
`test/tomlFormat.test.ts`'s own `structuralSnapshot`) are structurally unlikely to catch. It took
running a real, unremarkable file through the actual production round-trip and checking the one
thing nothing else had checked.

**The architecture check** (no live GUI available — see this document's own header): run through
`npm run inspect -- test/fixtures/toml/cargo-style.toml` (the CLI harness, driving the real
`selectFormat`/registry path) and two small standalone scripts built for this check, both deleted
after use, driving `detectGrid` (`gridDetection.ts`) and the row index directly against a parsed
TOML tree.

- `npm run inspect` recognized the file as TOML via the real registry, parsed it in 2.9 ms with
  zero diagnostics, built the row index (49 rows) with zero format-specific code, and printed a
  correct three-level tree (tables, dotted sub-tables, array-of-tables elements, inline containers
  folded into their properties) — all through code paths XML/JSON already exercise.
- `detectGrid` correctly identified both `[[bin]]` (2 elements) and the dotted
  `[[workspace.metadata.reviewers]]` (2 elements) as grid-eligible, using the exact same function
  XML/JSON's own repeating-children detection already uses — confirming TOML's own stated reason
  for existing in this project (§1's "generalized to... TOML") without a single TOML-specific line
  in `gridDetection.ts`.
- Save needs no verification beyond what already exists: invariant 6 makes it a straight byte
  write of whatever the live buffer holds, with no format code in the path at all — true by
  construction for every format, TOML included.

**Not checked, disclosed rather than assumed**: `Tree`/`Detail` rendering, Find (`Ctrl+F`), the
palette's `/` path-query mode, and an edit-then-undo cycle through a live Electron window — all of
these are visual/interaction surfaces `M5c-RESULTS.md`'s J9 and `M5d-RESULTS.md` already flagged
as unverified for the *same* reason (no display in any session that built this work), not a new
gap specific to TOML. The underlying modules these surfaces call (`nameIndex.ts`, `pathParse.ts`/
`evaluate.ts`, `documentEdits.ts`/`undoStack.ts`) are already exercised by their own extensive,
format-agnostic test suites against XML/JSON trees, and nothing about a TOML-produced
`NodeStore` differs from those in any way those modules could observe (same `NodeKind`s, same
typed-array layout, same `Interner`) — but that is an argument from the codebase's own invariant
8 ("nothing above `src/formats/` knows which format produced a document"), not a substitute for
having actually clicked through it.

## The verdict

**Holds, with two amendments recorded rather than smoothed over.** `core/types.ts`'s own claim —
adding a format is only writing a parser — was true for every module this milestone actually
exercised: zero lines changed anywhere except `toml/index.ts` and the two registration points the
plan named in advance. But "writing a parser" for TOML specifically needed more real design work
than XML's or JSON's did — the dotted-key/header unification stack, the four-way
`resumeContextFor` classification, and (found only by R17's own exhaustive check) getting a
node's own close offset right relative to exactly when the next token had already been consumed —
none of which has an XML or JSON equivalent to copy from. The thesis is about the *seam*
(`FormatModule`, `NodeSink`, the shared UI/edit/search machinery) needing no change, not about the
parser itself being simple; R14–R17 confirm the former without overstating the latter.
