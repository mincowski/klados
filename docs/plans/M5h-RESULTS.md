# M5h — Results

Task **R18**. Plan: `docs/plans/M5h-PLAN.md`. `npm test` (1039 tests, node project), `npm run typecheck`,
and `npm run lint` all pass after every fix below.

---

## 2a — pass 2 made iterative

Done. `xml/index.ts`'s `emitChild`/`formatElement` were mutually recursive over user input with no
depth bound of their own — invariant 4's own predicted failure, confirmed at nesting depth 5 000
(a `RangeError`, well inside `DEFAULT_MAX_DEPTH = 10_000`). Rewritten as one explicit `ElementFrame`
stack (`stepOneChild`/`stepChildren`), the same shape `runParser` already uses for pass 1's own
tree-building walk — the plan's own suggested model, not a new pattern. The awkward part the plan
named in advance (`formatElement` does work *after* its children — the closing indent and end tag)
is handled by giving each frame two implicit phases: `stepChildren` either emits one more indented
child (which may itself push a *deeper* frame) or, once whitespace-skipping finds the end tag or
EOF, emits the closing indent (only if at least one child was actually written) and the end tag,
then pops. `test/xmlFormat.test.ts`'s existing 300-sample generated-corpus invariant suite (18
tests) passes **unmodified** — the plan's own safety net for a control-flow rewrite of working
code.

Verified directly against the plan's own §1 table:

| Nesting depth | before | after |
|---|---|---|
| 100–1 000 | ok | ok |
| 5 000 | `RangeError` | reformats correctly |
| 9 000 | `RangeError` | reformats correctly |
| 10 000+ | `RangeError` | degrades to input unchanged (§2c, below) |

A structural round-trip check at depth 9 000 (the deepest depth that still fully reformats before
hitting the real parse's own `DEFAULT_MAX_DEPTH` boundary) confirms pass 1 and pass 2 agree on
element count — 9 001 nodes both before and after — the exact thing the plan flagged as "most
likely to break silently in a recursion-to-iteration rewrite."

## 2b — pass 1's depth limit aligned with the real parse

Done. `collectFormatInfo`'s own `ParseOptions` now uses `DEFAULT_MAX_DEPTH` (imported from
`core/parseDefaults.ts`, not `core/types.ts` — no contract change), not the old `100_000` (ten
times the real limit). `FormatInfoTable` gained a `complete: boolean` field (`parse()`'s own
`!state.fatal`), so `format()` can tell whether pass 1 actually walked the whole document or
stopped at the depth limit.

## 2c — degrade instead of throwing

Done, and applied more broadly than the plan's own minimum ask: `format()` checks `table.complete`
*before* running pass 2 at all, and returns the input **completely unformatted** (the plan's own
"formatting is optional; the document is not") for **any** fatal from pass 1 — not only the depth
case named in §1, since a document pass 1 could only partially walk for *any* reason leaves pass 2
with no safe way to re-render it either. This is indistinguishable from a no-op `format()` call to
everything downstream (`M5g-PLAN.md` O1 already handles that end to end, worker through renderer),
so nothing further needed special-casing.

**A defensive boundary was added regardless of the fix above**, per the plan's own instruction:
`runTransformJob` (`src/worker/parse.worker.ts`) now wraps `format.format(...)` in a `try`/`catch`
and returns an ordinary `transformError` (with the real error's message) rather than letting any
formatter exception escape as an uncaught `RangeError` that `worker.onerror` would turn into
`transformClient.ts`'s generic, requestId-less rejection. Regression test: a UTF-16 document (XML's
own, pre-existing, unrelated `format()` refusal) now surfaces as `transformError`, not an escaped
throw — proving the boundary works for *any* formatter exception, not just the one this milestone
fixed.

## 3 — Tests

- The plan's own §1 table, parametrised: `test/xmlFormat.test.ts` now has depths 100/1 000/5 000/
  9 000 (does not throw, re-parses to the same node count), the degenerate `<a></a>` case, a depth
  past `DEFAULT_MAX_DEPTH` (degrades to unchanged, asserted byte-for-byte), and depth 20 000 (the
  plan's own first-observed failure point, does not throw).
- **`deep-10mb.xml` does not reach the failing depth** — checked, not assumed: it generates *many
  shallow* `<c{i}>` chains (`chainDepth: 40`) repeated to reach 10 MB, never one deeply-*nested*
  element. `spike/generate-fixtures.ts` gained `generateDeepNestingXml`/`deep-nesting-20k.xml`
  (~140 KB, depth 20 000, mirroring `generateDeepJson`'s own "one element deep instead of one array
  deep" shape) so a genuinely deep fixture actually exists on demand — gitignored like every other
  generated fixture, regenerated via `npm run fixtures:generate -- deep-nesting-20k.xml`.
- Pass 1/pass 2 element-count agreement: covered by the depth-parametrised test's own
  `store.nodeCount` comparison (before/after a format round trip), not a separate check — the plan
  flagged this as the thing most likely to break silently, and it is exercised at every depth the
  parametrised test runs, not just once.

## 4 — TOML and JSON checked, one shared the defect

**TOML does not share it.** R16's own formatter (`toml/index.ts`) was already built iteratively (a
`FormatFrame` stack for single-line inline tables/arrays) — confirmed directly: depths up to
20 000 (an inline-table chain, `x = {a={a={a=...}}}`) format without error.

**JSON shares the exact same defect, fixed here as part of R18 per the plan's own §4 instruction**
("if either shares the defect, it belongs in R18 rather than a follow-up"). `json/index.ts`'s
`formatValue`/`formatContainer`/`formatObjectBody`/`formatArrayBody` were mutually recursive over
document structure with no depth bound — confirmed to throw at the same depth 5 000 via the same
`{"a":` × depth check the plan used for XML. Rewritten as one explicit `FormatFrame` stack
(`stepValue`/`stepObjectFrame`/`stepArrayFrame`), mirroring `stepObject`/`stepArray`'s own shape —
this file's *parsing* side had already solved the identical problem for tree-building, so the
formatter's rewrite reuses the parser's own `ObjectState`/`ArrayState` enums rather than
redeclaring an equivalent pair, since the state machine really is the same shape.

Unlike XML, JSON's formatter is single-pass (no `collectFormatInfo` to align a depth limit for —
§2b does not apply), and once iterative there is no remaining throw for a §2c-style degrade path
to guard against either: nothing here can overflow the call stack at any depth, so a document past
`DEFAULT_MAX_DEPTH` simply formats correctly rather than needing to be refused. Verified at depth
100/1 000/5 000/9 000 (full structural round trip, `test/jsonParser.test.ts`) and depth 20 000
(throw check only — at that depth, pretty-printed indentation makes the *output* itself hundreds of
MB, since indentation grows with depth at every one of 20 000 levels, too slow for a full
structural comparison to be worth its own assertion in a unit test; the existing 23 exact-byte
format tests, including the minify round-trip and BOM-preservation cases, pass **unmodified**).

## 5 — Not in scope, and the one convenience fix

The two-pass design itself and a diagnostic channel for `format()` are both untouched, as directed.
`src/cli/bench-format.ts`'s `computed memory NaN B` (line 116's `as never` cast hiding a missing
`undoBytes`/`undoEntryCount` on the literal passed to `computeMemoryBudget`) was fixed — two fields
added to the literal, two lines, exactly as the plan estimated. The app itself was never affected
(`documentSession.ts` always initialises `undoBytes: 0`); only this CLI's own report was wrong.
