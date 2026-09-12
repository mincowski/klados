# R200 — diagnostics are unbounded in every format, and the scrubber renders one DOM node per diagnostic

<!-- status: open -->

**Open.** Found while answering a question about R199's per-row warnings, then widened by a second
question — *does this affect the other formats too?* It does, and checking that reversed this plan's
original framing (§ 2).

## 1. What is there

`NodeStore.diagnostic` is an unbounded `push` (`src/core/nodeStore.ts:449`). Nothing in the parsers,
the sink or the worker caps it. A 2,000,000-row CSV exported with a stray trailing delimiter on data
rows emits one Warning per row: 2 M `Diagnostic` objects, each with a template-built message string.

Four consumers then read the whole array:

| Consumer | Cost |
|---|---|
| `StatusBar.tsx:80,83` | two `.filter().length` passes, per render |
| `StatisticsPanel.tsx:84,87` | two more |
| `diagnosticNav.ts:16` | `[...diagnostics].sort(…)` — a **full copy and sort per next/prev keypress** |
| `Scrubber.tsx:243` | **one `<div>` per diagnostic** |

The scrubber is where this stops being a slowdown: `diagnosticMarkers` maps one marker per
diagnostic (`scrubberModel.ts:65`) and the component renders each as an element, in a strip a few
hundred pixels tall.

**The notification layer is not affected, and this is worth stating because it is the natural
worry.** `Notifications.tsx` fires once per *event*; `notifyPartialParse` takes a single primary via
`.find(…)` over Error/Fatal severities and carries a `dedupeKey`. Ragged rows are Warnings, so they
produce **no notifications at all**. There is no flood of toasts — the cost is memory, render passes
and DOM nodes, none of which announce themselves.

## 2. This is not a CSV defect, and it was never actually safe

The first draft of this plan said the unbounded list was safe until CSV arrived, because
`CONCEPT.md` § 11.1 describes opening an invalid document as *"parse to the point of failure,
present the partial tree with the error node marked"* — one failure, one position — and
`scrubberModel.ts:55` cites exactly that model when it says diagnostics are *"rare enough … not to
warrant the complexity of merging"*.

**Checking the parsers instead of the design document reverses that.** Every format emits
recoverable `Severity.Error` diagnostics from inside its per-item loop and keeps going:

| Format | Codes emitted per item, parse continues |
|---|---|
| XML | `xml.unmatched-end-tag`, `xml.mismatched-end-tag`, `xml.expected-attribute`, `xml.expected-equals`, `xml.unknown-markup` |
| JSON | `json.expected-comma-or-close`, `json.expected-key`, `json.expected-colon`, `json.expected-value`, `json.bad-literal` |
| TOML | `toml.expected-comma-or-close`, `toml.expected-key`, `toml.expected-equals` |
| CSV | `csv.long-row`, `csv.short-row` |

**And a Fatal does not stop a parse either.** `ParserState.fatal` is a *flag*, not a halt
(`src/formats/xml/index.ts:146`): the main loop breaks only on `maxDepth` and on an abort signal,
and `fatal` is read once at the end to set `complete: !state.fatal` (`:624`). A file that trips a
Fatal keeps being walked to EOF.

So § 11.1 describes an intent **no parser implements**, and the comment that inherited it was
resting on a property the code never had. The real distinction is not XML-versus-CSV, it is how
*ordinary* the triggering input is:

- **CSV reaches it with input people actually have** — an export with a stray trailing delimiter on
  data rows is one Warning per row for the whole file.
- **XML, JSON and TOML need genuinely broken input**, which is also entirely ordinary: a truncated
  export, an encoder that never escapes `&`, a generator emitting one malformed attribute per
  record. A defect that repeats per node produces a diagnostic per node.

**This is `FINDINGS.md`'s recurring line again** — measured in one condition, concluded about
another — with the twist that the condition was never measured at all, only read off a design
document that the code had diverged from.

## 3. One fault or many? Both, and that is the point

It is reasonable to argue that 1,240 ragged rows are **one fault in the file** and deserve one
diagnostic. It is equally reasonable to argue they are 1,240 places and deserve one each. The
disagreement dissolves once you look at what a `Diagnostic` actually is:

```ts
{ severity, code, offset, length, message }
```

**It carries an `offset`.** A diagnostic is not a statement about the file, it is a statement about
a *position* — which is why the scrubber can mark it on the strip and why next/prev diagnostic can
navigate to it. Per-item diagnostics answer *"where?"*; a per-file summary answers *"what?"*. They
are different questions and both are worth answering.

A single export glitch that adds a column to rows 40,000–41,240 is **one cause in 1,240 places**,
and someone opening that file wants both facts: what went wrong, and where it starts and stops.

**So the cap is not a compromise between the two views — it is what makes both available.** A
summary entry states the fault; a bounded set of located entries stays navigable. Collapsing to a
single diagnostic would throw away the locations, which is the half the scrubber and the navigation
commands exist to serve.

## 4. The neighbour that already solved it

`matchMarkers`, in the same file and feeding the same strip, buckets into a fixed 256 slots
(`scrubberModel.ts:82`) explicitly because search hits can be millions — its own comment says *"not
a scan of however many million matches"*. The mechanism, the file and the rendering path are already
there. `diagnosticMarkers` never got it, because § 2's assumption said it never needed it.

## 5. R200

**(a) Cap what is stored.** Keep the first N per diagnostic code, then one summary entry naming the
total. The compiler convention, and § 3's reason for preferring it to a single collapsed diagnostic.

**(b) Bucket the scrubber's diagnostic markers** through the same path `matchMarkers` uses.

## 6. Non-functional expectations (`PLANNING.md` § 3)

These are part of the specification, because the natural implementation of (a) gets them wrong:

- **The cap applies at emit, not at render.** A cap enforced by a consumer leaves the multi-million
  object array already allocated, which is the cost this round exists to remove.
- **It belongs in one shared place, not four.** Each format has its own `ParserState.emit`
  (`xml:142`, `json:114`, `toml:136`, `csv:92`), all four identical but for the `fatal` flag. Four
  copies of a budget check is how three of them later drift; the budget is one small shared module
  the four `emit` bodies consult.
- **Bounded *retention* is the requirement; the transient message build is not.** The first draft of
  this plan said a capped diagnostic "must not build its message", on the grounds that `emit` is
  called with an already-interpolated template string so the string is constructed before the sink
  can reject it. That overstated it: those strings are **immediately unreachable garbage**, which
  the collector handles, whereas the retained objects are what exhausts memory. Avoiding the build
  is worth having where it is free — the check inside `emit` already wastes only the string and not
  the `Diagnostic` — and **not** worth contorting twenty call sites into `if (shouldEmit(code))`
  guards or message thunks. Stated explicitly so a later round does not "finish the job" by doing
  exactly that.
- **The displayed counts must stay truthful.** `StatusBar` and `StatisticsPanel` derive their error
  and warning counts by filtering the list. Once the list is capped, filtering it **understates the
  real total** — the counters need a separate running count the cap does not touch. A status bar
  reading "100 warnings" for a file with two million is a worse defect than the one being fixed.

## 7. The visual decision is not settled here (`PLANNING.md` § 1)

`matchMarkers` conveys bucket occupancy through `density` as opacity. Whether diagnostic markers
should do the same — or stay solid, since a warning is not a search hit and a faded one may read as
dismissed — is a question about how the strip *looks*, and § 1 of `PLANNING.md` is explicit that
this is exactly the kind of decision that comes back as a follow-up round when it is argued rather
than rendered.

**Render both against a real ragged CSV in the browser project and put them in front of the project
lead before adopting either.** No preference is recorded here on purpose.

## 8. Rejected

**Collapsing to one diagnostic per fault.** § 3 — it answers *what* and discards *where*, which is
the half the scrubber and the diagnostic-navigation commands exist to serve.

**Capping only at the render sites.** Fixes the DOM and leaves the allocation. § 6.

**Deduplicating diagnostics by offset.** Different from bucketing, and the existing comment argues
against it correctly: diagnostics clustered at one offset are meaningful. Bucketing changes how many
*markers* are drawn, not which diagnostics exist.

**Virtualizing the scrubber strip.** More machinery than bucketing, for a strip whose whole height
is a few hundred pixels — and bucketing is already built and already proven on the sibling source.

**Raising the cap high enough that nobody hits it.** The failure is unbounded input, not a
badly-chosen bound; a 10 M-row file exists.

**Making a Fatal halt the parse, so § 11.1's model becomes true.** Out of scope, and a bigger change
than it looks: invariant 5 wants a partial tree, and `state.fatal` is load-bearing elsewhere — the
XML formatter reads it through `complete` to decide whether pass 2 may run at all (`M5h-PLAN.md` R18
§ 2c), degrading to "return the input unchanged" for a partial tree. That use survives either way,
but halting changes how much tree exists, which is not a question this round is scoped to reopen.
What R200 does correct is **`CONCEPT.md` § 11.1's wording**, which describes behaviour no parser
implements — a documentation fix, not a parser change.

## 9. Acceptance

1. A CSV with 500,000 long rows produces a diagnostic count **bounded by the cap** — asserted on
   `store.diagnosticCount`.
2. **The same holds for a non-CSV format** — an XML fixture with a malformed attribute on every one
   of 100,000 elements is bounded identically, asserted the same way. This is what pins § 2's
   finding that the defect is general, and stops the cap being quietly implemented as a CSV feature.
3. The scrubber renders **at most bucket-count** diagnostic markers, asserted by counting DOM nodes
   in the browser project.
4. `StatusBar`'s warning count shows the **true** total for that file, not the capped list's length.
5. `diagnosticNav` still reaches every diagnostic that was stored.
6. The budget lives in **one** module, consulted by all four `ParserState.emit` bodies — asserted by
   there being no fifth copy, and by acceptance 2 passing without a CSV-specific branch.
7. `CONCEPT.md` § 11.1 no longer claims parsing stops at the first failure.
8. Existing `scrubberModel.test.ts`, `diagnosticNav.test.ts` and `csvParse.test.ts` stay green, or
   their changed expectations are named in the results.
9. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 10. Version

**Ask on landing.** Candidate: patch — a defect fix with no new capability.
