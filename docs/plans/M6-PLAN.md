# M6 — TOML

<!-- status: built -->

**Status: built.** Tasks **R14–R17**. Register: `docs/TASKS.md`. Results: `docs/plans/M6-RESULTS.md`.

CONCEPT.md §12 names this milestone's purpose plainly, and it is worth quoting rather than
paraphrasing, because it sets the bar for what "done" means here:

> **M6 — TOML.** The cheapest additional format, and the one that proves the parser interface is
> genuinely format-agnostic before the expensive one is attempted.

And `core/types.ts`'s own header, unprompted, names TOML specifically as the test:

> The claim this contract has to earn: "adding a format is only writing a parser." If TOML (M6)
> requires changing anything outside its own module, the abstraction has leaked — that is
> precisely why TOML is scheduled before YAML.

So this plan's real deliverable is not just a working TOML parser — it's a **verdict**: does
`src/formats/toml/index.ts` alone (plus the handful of named, deliberate registration points
below) make TOML documents work everywhere XML/JSON already do — Tree, Detail, grid mode, Find,
path queries, undo/edit, Save/Transform — with zero changes to anything above the parser layer? If
something outside `toml/index.ts` turns out to need touching, that is the milestone's most
important finding, not a bug to quietly work around. Report it, per `CLAUDE.md`'s own working
agreement, the same way R11 reported (and then resolved) that its two supposed hard blockers were
already built.

**Nothing in the model needs to change.** Checked before writing this plan: TOML tables map to
`NodeKind.Object`, arrays-of-tables map to `NodeKind.Array` (of `Object`), key-value pairs map to
`NodeKind.Property` holding its own scalar directly (D-030's rule, already true for JSON), and
`@name` predicates already mean "scalar facet" generically (§6.3: *"an attribute in XML, a scalar
property in JSON, YAML or TOML"*). No new `NodeKind`, no new field on any shared type. That is a
good sign for the milestone's own thesis, not an assumption to re-verify — it falls out of reading
the existing contract, not from having built anything yet.

---

## 1. What "cheap" does not mean

CONCEPT.md's own format table already qualifies it: *"TOML is cheap, YAML is not"* — cheap
**relative to YAML**, not trivial. Two things make TOML more than "JSON with different
punctuation," and both are worth naming up front so they don't get discovered mid-implementation
the way R11's mixed-content detection was:

### 1.1 Dotted keys create implicit structure

CONCEPT.md §2's own format table already flags this: *"dotted keys nested, not flattened."*
`a.b.c = 1` is not a `Property` named `"a.b.c"` — it is `Object a` → `Object b` → `Property c`,
three real nodes, the same shape `[a.b]` followed by `c = 1` would produce. TOML's spec requires
these to unify: a document can introduce `a.b` implicitly via a dotted key, then later open it
explicitly with `[a.b]` (legal, once), or vice versa — and redefining a key or table that already
exists is an error the parser must diagnose, not silently overwrite. This is the one place TOML's
grammar does real structural work that XML/JSON's parsers don't: both of those are pure recursive
descent over explicit nesting syntax (`<tag>`, `{`), where TOML's dotted keys and bare `[table]`
headers make "which node is currently open" a name-based lookup against everything opened so far
in the document, not just a stack top.

### 1.2 `detect()` has no reliable single-byte signature

XML sniffs on `<`; JSON sniffs on `{`/`[`. TOML has no equivalent: a valid TOML document can begin
with a comment (`#`), a bare key (`title = "x"`), or a table header (`[package]`) — and that last
one is byte-identical at the front to how a JSON array's content might look after leading
whitespace, which is exactly the ambiguity `jsonCapabilities`'s own `detect()` (0.7 confidence on
a lone `{`/`[`) was written against. Filename extension (`.toml`, 0.9 confidence — same weight
XML/JSON already use) will carry almost all real detection; content-sniffing without a filename
needs a *shape* check on the first non-comment, non-blank line (does it look like `key = value` or
`[table]`/`[[table]]`), not a single leading byte, and must not fire on bare `[`/`{` alone or it
will misfire against JSON. Get this wrong and a `.json` file with no extension containing `[1, 2]`
could misdetect as TOML's `[table]` syntax, or vice versa — worth a few named test cases, not just
the happy path.

Neither of these is hard. Both are real, and both are where an implementation session is most
likely to lose an afternoon without a plan flagging them first.

---

## 2. Tasks

### R14 — The parser

`src/formats/toml/index.ts`, following `xml/index.ts`/`json/index.ts`'s own shape: an iterative
tokenizer (hard rule 4 — no recursive descent; TOML's own nesting is shallow in practice but inline
tables/arrays (§2.3) can nest arbitrarily and must be stack-driven the same as JSON's containers),
a `NodeSink`-emitting `parse()`, `detect()`/`detectEncoding()`, and `tomlCapabilities`.

**Grammar coverage** (TOML v1.0.0, the current stable spec):

- Bare, quoted (basic `"..."`) and literal (`'...'`) keys; dotted key paths (§1.1 above)
- `[table]` and `[[array of tables]]` headers, including dotted table names
- Inline tables `{ k = v, ... }` and inline arrays `[v, v, ...]`
- String values: basic (`"..."`, with `\n`/`\t`/`\uXXXX`/`\UXXXXXXXX`/etc. escapes), literal
  (`'...'`, no escapes), and both multi-line variants (`"""..."""`/`'''...'''`, including the
  "trim the first newline immediately after the opening delimiter" rule and line-ending
  backslashes in multi-line basic strings)
- Numbers: integers (decimal/hex `0x`/octal `0o`/binary `0b`, `_` digit separators, leading zeros
  forbidden except a bare `0`), floats (`_` separators, `inf`/`nan`, signed)
- Booleans, and all four date/time forms (offset date-time, local date-time, local date, local
  time) — stored the same way every other scalar is, as a byte span on a `Scalar`/`Property`
  node; **no new type discrimination in the model**, matching how JSON already leaves
  number-vs-string-vs-bool undistinguished at the `NodeSink` level (§5.7's own formatter proves
  this: JSON's `format()` re-emits every scalar via `pushBytes`, never decoding it to learn its
  type). Whether the Detail view should *render* a TOML date differently than a string is a
  presentation question, not a parser one — out of scope here, flagged in §5.
- Comments (`#` to end of line) — emitted as `NodeKind.Comment`, the same node kind XML already
  has, so `detailModel.ts`'s existing `adjacentCommentOf` heuristic (§5 below) needs no format-
  specific branch to pick them up.

**Diagnostics, not throws** (hard rule 5): a redefined key/table, a malformed date, an
unterminated string all emit a `Diagnostic` and continue where the grammar allows — the pattern
every existing parser already follows, not a new one to design.

`tomlCapabilities`: `hasAttributes: false`, `hasComments: true`, `hasNamespaces: false`,
`canFormat`/`canIncrementalReparse` land in R15/R16 below (`false` until those tasks land, exactly
how `xmlCapabilities.canFormat` stayed `false` until R11), `rowBreakBytes` — newline is TOML's own
statement separator (no trailing comma/brace convention to lean on the way JSON does), so this is
closer to a line-oriented row break than JSON's punctuation-based one; worth checking against a
real fixture rather than assumed.

**Registration**: add `tomlFormatModule` to `REGISTERED_FORMATS` in `src/formats/registry.ts` —
the one shared list every other format is already in. If anything besides this and the two
follow-on points below needs touching to make an open `.toml` document work, that's the finding
this milestone exists to surface.

**Two registration points outside `core`/`formats`, named so they're not mistaken for scope
creep:**

- `src/main/documents.ts`'s open-dialog filter (`{ name: 'XML/JSON documents', extensions:
  ['xml', 'json'] }`) is hand-maintained, not derived from `FormatCapabilities.extensions` —
  confirmed while writing this plan. Adding `'toml'` here is a one-line, filename-only change
  with no parsing logic, so it doesn't threaten the milestone's thesis, but it is a place a
  format currently has to register itself outside its own module. Minimal fix: add `'toml'`
  to the existing filter's `extensions` array (or its own `{ name: 'TOML documents', extensions:
  ['toml'] }` entry). Generalizing this to read `REGISTERED_FORMATS` instead is a legitimate
  follow-up but not required for M6 — noted in §6 as deliberately deferred, not forgotten.
- Nothing else was found. `Tree`/`Detail`/grid mode/Find/the path query engine/undo/edit all read
  `FormatCapabilities` or work purely off `NodeKind`/`NodeStore`, never a format id — confirmed by
  the same read of `registry.ts`'s `getFormatCapabilities`/`getFormatModule` this plan's own
  research pass did.

**Tests**: unit coverage per grammar feature (dotted keys producing real nested `Object`s,
array-of-tables appending correctly, each string/number/date form, redefinition diagnostics,
inline table/array nesting), plus `detect()`'s own edge cases from §1.2 (a filename-less `.toml`-
shaped snippet, a filename-less `[1, 2]` JSON array not misdetecting).

### R15 — Incremental reparse

`parseRange` + `resumeContextFor`, following the contract's own framing (`core/types.ts`:
*"recomputed on demand by walking ancestors... cheap because document depth is small"*). TOML's
resume state is simpler than XML's namespace-scope stack: what a parser needs to resume mid-
document is **which table is currently open** (the dotted path of the last `[table]`/`[[table]]`
header before the resume point) plus nothing else — TOML has no equivalent of XML's inherited
`xml:space` or namespace prefixes that accumulate down an arbitrary ancestor chain. Reconstructed
the same way XML's preserve-scope is: walk `AncestorView` from the resume point back to the
nearest table-shaped ancestor, read its name path.

Without this, `canIncrementalReparse` stays `false` and every edit to an open TOML document falls
back to a full reparse (`core/types.ts`'s own note: *"large-file editing will be correspondingly
slow"*) — a real, working degradation, not a blocker, but one this milestone should not settle for
by default given how directly the contract frames incremental reparse as part of "genuinely
format-agnostic."

**Tests**: the same subtree-splice/incremental-vs-full-reparse equivalence invariant
`test/invariants.test.ts` already runs for XML/JSON (§4's fuzz-based corpus), extended to a TOML
fixture.

### R16 — The formatter

`format()`, gated by `canFormat`. CONCEPT.md §5.7's own formatting-conservatism table already
states TOML's rule: *"key order and table grouping preserved; only whitespace normalized."*
Unlike XML (mixed content is a real semantic hazard) and like JSON (§5.7: *"the only format where
formatting is unconditionally safe and total"* — though TOML is a close second, not quite that
absolute): TOML's structure has no equivalent of significant inter-element whitespace, so a
formatter re-emitting every table/key/value in source order with consistent indentation and
spacing is safe by construction. The one real judgment call — worth its own line in the plan
rather than left implicit the way R11's mixed-content skip almost was — is **multi-line strings**:
their internal whitespace/newlines are part of the string's value and must be copied verbatim
(`GrowableBytes.pushBytes`, never decoded), the same "never decode a scalar, just re-emit its
span" rule JSON's own formatter already follows for exactly this reason (`json/index.ts`'s own
doc comment: *"no string is decoded then re-encoded"*).

**Tests**: idempotence and structural-equivalence invariants over a generated corpus, the same
shape `test/xmlFormat.test.ts`/JSON's own formatter tests already use — not a new testing
methodology, reuse of the one this project already committed to (M0-PLAN B12: *"invariant-tested,
not example-tested"*).

### R17 — Fixtures, full invariant suite, and the verdict

- **Fixtures**: at minimum one small hand-written TOML document exercising every grammar feature
  in R14's list, plus one or two real-world-shaped ones (a `Cargo.toml`/`pyproject.toml`-style
  document — deeply mixed table/array-of-tables/inline-table content is exactly what a synthetic
  generator tends to under-produce). A generated-corpus fixture (`spike/generate-fixtures.ts`'s
  own pattern) if large-file TOML performance turns out to matter — TOML documents are
  overwhelmingly config-sized in practice, so a large synthetic fixture is lower priority than it
  was for XML/JSON, but worth a explicit "not needed, here's why" note in the results doc rather
  than a silent gap.
- **The parity/architecture check**: open a TOML fixture through the real app (or the
  `npm run inspect` harness) and confirm Tree, Detail (including grid mode on an array of
  tables — TOML's own repeating-children case, the format's whole reason for existing per §1's
  "generalized to... TOML"), Find, a path query (`@key` against a TOML key-value pair), an edit
  + undo, and Save all work with zero format-specific code anywhere above `toml/index.ts` and the
  two named registration points in R14. This check *is* the milestone's deliverable — record the
  outcome in `docs/plans/M6-RESULTS.md` explicitly, the same "did the claim hold" framing R11's results
  gave XML's formatter.
- **Docs**: `CONCEPT.md` §2's format table already lists TOML — no amendment needed there unless
  something surprised this plan. `CLAUDE.md`'s document map and "Current state" narrative get the
  same treatment every other landed milestone has.

---

## 3. What this plan deliberately does not cover

- **Comment-as-documentation surfacing** (§5.3's full leading/trailing attachment rule) is **not**
  built here. `transparentWrapper.ts` already notes this is unbuilt (*"§5.3's real leading/
  trailing association is a later milestone"*) and reuses a simpler existing heuristic
  (`detailModel.ts`'s `adjacentCommentOf`) for its own narrower purpose. TOML's comments already
  parse as `NodeKind.Comment` nodes under R14, which is what `adjacentCommentOf` needs — so TOML
  gets whatever comment-adjacency behavior JSON/XML already have, for free, with no format-
  specific work. Building the *full* §5.3 rule (real leading/trailing association, Detail-view
  surfacing as documentation) is real, separate UI/model work that would benefit every format
  equally and does not belong inside "the cheapest additional format" — **recommend it as its own
  small milestone after M6**, motivated by TOML/YAML rather than gated on them, not folded in
  here. Flagging this now so it's a deliberate cut, not a rediscovered gap.
- **TOML-aware value-type rendering** in the Detail view (showing a date differently than a
  string) — a presentation nicety, not required for the architecture claim, not attempted.
- **Deriving the main-process open-dialog filter from `REGISTERED_FORMATS`** — noted in R14 as a
  legitimate generalization, not required to land M6.

---

## 4. Order

R14 first — the parser is the whole point, and §1's two real gotchas (dotted-key structure,
`detect()` ambiguity) live entirely inside it. R15 and R16 are independent of each other once R14
lands and could be reordered or parallelized; R15 (incremental reparse) is listed first because
`core/types.ts` frames it as closer to the architecture claim than formatting is. R17 last,
deliberately — it's where the milestone's actual question gets answered, not a wrap-up step.

**Gate, matching R13's own convention of stating one rather than assuming success:** if opening a
real-world TOML fixture through the full app surfaces even one place outside `toml/index.ts` (plus
the two named registration points) that needs a format-specific change, stop and report it as this
milestone's headline finding before continuing — that is a more valuable result than a clean pass,
and burying it under "also fixed in passing" would waste the one thing this milestone was built to
learn.
