# M5h — the XML formatter overflows the stack on deep input

<!-- status: built -->

**Status: built.** Task **R18**. Register: `docs/TASKS.md`. Results: `docs/plans/M5h-RESULTS.md`. Found
reviewing `docs/plans/M5g-RESULTS.md`; that document now carries the correction (§3.1–3.3's addendum).

This is an invariant violation in shipped code, not a polish item.

---

## 1. The defect

`emitChild` and `formatElement` (`src/formats/xml/index.ts`) are **mutually recursive over user
input, with no depth bound of their own**. Measured on `<a>`-nesting, parser against formatter:

| Nesting depth | `parse()` | `format()` |
|---|---|---|
| 100 | complete | ok |
| 1 000 | complete | ok |
| **5 000** | **complete** | **`RangeError: Maximum call stack size exceeded`** |
| 9 000 | complete | `RangeError` |
| 20 000 | diagnostic, bounded (correct) | `RangeError` |
| 50 000 | diagnostic, bounded (correct) | `RangeError` |

**A document NodePad opens, parses completely and displays fine cannot be formatted.** 5 000 is
well inside `DEFAULT_MAX_DEPTH = 10_000`, so this is not an exotic input — the parser is doing
exactly what it promises and the formatter is not.

Two invariants:

- **Invariant 4** — *"Parsers are iterative, never recursive descent. Deeply nested input is real
  input and will overflow the stack."* The formatter is parser-adjacent code doing precisely
  this. The invariant's own wording predicts the failure.
- **Invariant 5** — *"Parsers never throw on malformed input. Emit a diagnostic and continue
  where the grammar allows. A partial tree beats an error screen."* At depth 20 000 the parser
  emits a bounded diagnostic, as designed; the formatter throws instead.

**Contributing: pass 1 is more permissive than the real parse.** `xml/index.ts:1132` runs
`collectFormatInfo` with `maxDepth: 100_000` — ten times `DEFAULT_MAX_DEPTH`. So pass 1 will
build a `FormatInfoTable` for depths pass 2 can never walk, and depths the document's own parse
already rejected.

**How it surfaces.** There is no `try`/`catch` around `runTransformJob` in
`src/worker/parse.worker.ts`, so the `RangeError` escapes `handleMessage`, reaches
`worker.onerror`, and `transformClient.ts` rejects with a generic message. The user gets an
opaque error, not a formatted document and not an explanation.

### Why this was missed

It wasn't — the symptom was *observed* during R13, in the session that built the fixtures, and
attributed entirely to a genuinely broken fixture generator that happened to be producing garbage
bytes at the time. The generator bug was real and was fixed. The overflow was a second,
independent defect standing behind it.

Worth stating as a rule rather than an anecdote: **a stack overflow is a statement about the
code's own shape, not about its input.** "The input was malformed" explains why a parse fails; it
never explains why a stack ran out. Invariant 4 exists because that distinction is easy to lose
when there is a known-bad input in front of you.

---

## 2. What to build

### 2a. Make pass 2 iterative

The fix invariant 4 actually asks for. `formatElement`/`emitChild`'s mutual recursion becomes an
explicit work stack — the same shape `runParser` already uses in this very file (`stack.length >
state.options.maxDepth` at line 481), so there is a local model to follow rather than a pattern
to invent.

The awkward part is that `formatElement` does work *after* its children are emitted (the closing
indent and the end tag), so a naive "push children, pop" loop loses it. The standard answer is a
frame carrying a phase — `enter` emits the open tag and pushes children, `exit` emits the closing
indent and end tag — with both pushed at once in reverse order. Keep `FormatCursor`'s ascending
walk exactly as it is; the iteration order over elements does not change, which is what makes
this safe against O2's cursor contract.

### 2b. Align pass 1's depth limit with the real parse

Pass 1's `maxDepth: 100_000` should be the same limit the document was parsed under. There is no
reason for the formatter to accept nesting the parser rejects, and once 2a lands the 100 000 is
not protecting anything either.

**Report rather than guess** if the two cannot be made to agree — `format()` receives bytes and
`FormatOptions`, not the `ParseOptions` the document was actually parsed with, so "the same
limit" may mean "`DEFAULT_MAX_DEPTH`, imported" rather than "whatever this document used".
`DEFAULT_MAX_DEPTH` is the right default; a plumbing change to pass the real value is **not**
in scope and would touch `core/types.ts`, which is off limits.

### 2c. Degrade instead of throwing

Even iterative, the formatter can meet input past the depth limit. Invariant 5's rule applies:
return the input unchanged (formatting is optional; the document is not) rather than throwing.
`format()`'s contract returns `Uint8Array` with no diagnostic channel — which is the same
constraint R11 hit when it wanted to report a skip count, and `docs/plans/M5e-PLAN.md`'s "Open
question" section already sketches the routes. **Do not widen the contract for this.** Returning
the input unchanged is indistinguishable from a no-op format, which O1 already handles gracefully
end to end.

Wrap `runTransformJob`'s `format.format(...)` call in a `try`/`catch` regardless, returning a
`transformError` with a real message. A defensive catch at the worker boundary is right even once
the known overflow is gone — a formatter bug should not surface as `worker.onerror`.

---

## 3. Tests

- **The table in §1 is the test.** Parametrised over depth, asserting `format()` does not throw
  and that its output re-parses to the same tree. Include 5 000 (the first failing depth
  measured), a depth past `DEFAULT_MAX_DEPTH`, and the degenerate `<a></a>` case.
- **A `deep-*.xml` fixture already exists** (`deep-10mb.xml`, R13 §3.2) but evidently does not
  reach the failing depth — check what nesting it actually generates and add a genuinely deep
  one if not. A fixture that passes while the defect is live is worth knowing about.
- `test/xmlFormat.test.ts`'s 300-sample generated-corpus invariant suite must pass **unmodified**.
  This is a control-flow rewrite of working code; the existing invariants are the safety net, the
  same role they played for O2.
- Assert pass 1 and pass 2 agree on element count at depths near the limit — the cursor contract
  O2 introduced is the thing most likely to break silently in a recursion-to-iteration rewrite.

---

## 4. Also check TOML and JSON

`json/index.ts` has its own `format`, and R16 added a TOML formatter. **Neither was examined for
this.** Same question for both: is the emitter recursive over document structure, and what
happens at depth 5 000?

JSON is the more likely to be affected — `deep-1m.json` and `deep-10k.json` already exist as
fixtures, so the check is cheap. If either shares the defect, it belongs in R18 rather than a
follow-up; if neither does, record that they were checked, so the next reader does not re-derive
it.

---

## 5. Not in scope

- **The two-pass design itself** (`M5g-PLAN.md` O5) — unchanged, and 2a does not touch it.
- **A diagnostic channel for `format()`** — see 2c.
- **`src/cli/bench-format.ts`'s `computed memory NaN B`** — a separate, trivial defect found in
  the same review: line 116 builds a partial document with `as never`, so `undoBytes` is
  `undefined` and `totalBytes` is `NaN`. The app is unaffected (`documentSession.ts:583`
  initialises `undoBytes: 0`), but the cast is what stopped the compiler catching it when R12
  added the field. Fix it here if convenient — it is two lines — but it is not what R18 is for,
  and it should not be what R18 is judged on.
