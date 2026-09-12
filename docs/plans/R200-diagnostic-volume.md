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

## 5. R200 — cap the records, keep every position

**The naive cap loses the scrubber, and loses it in the worst way.** Parsers walk forward, so the
first N diagnostics are (very nearly) the first N *by offset*. Capping the list at 100 and drawing
the strip from it would put every mark in the top slice and leave the rest of the document looking
clean — **a strip that actively misreports where the problems are**, which is worse than today's
unreadable solid block. This section exists because that was this plan's first design.

The fix is to notice that **the scrubber never needed the diagnostics**. `matchMarkers` takes
`(rowIndex, starts: Int32Array, bucketCount)` — an array of *offsets* — and answers each bucket with
`countMatchesInRange`, a binary search, rather than a scan. The strip wants a **distribution**, not
records. So the two consumers split:

| | Kept | Cost per diagnostic |
|---|---|---|
| **(a) The navigable list** — `diagnostics`, read by the panel, the counters and next/prev | **capped**: first N per code, plus one summary entry | ~150 B (object + message string) |
| **(b) The position index** — a parallel `Int32Array` of offsets and `Uint8Array` of severities | **uncapped**: every diagnostic, always | **5 B**, no allocation per item |

**(c) The scrubber buckets (b)** through the path `matchMarkers` already uses.

**Nothing is lost from the strip.** 2 M diagnostics cost 10 MB as parallel typed arrays against
~300 MB as objects — a 30× reduction that still records *every* site — and `UI-FEEDBACK.md`:902 made
exactly this argument for search four milestones ago:

> **Do not emit one marker per match** — 1.2 M matches on a 200 MB document is 1.2 M DOM nodes, and
> the strip can only resolve a few hundred positions anyway.

A strip a few hundred pixels tall cannot render 2 M distinct positions under any design. Bucketing
discards nothing the display could have shown; the per-diagnostic DOM node was always spending
2 M allocations to draw a few hundred distinguishable heights.

The cap then applies only where a bound is genuinely needed: **a human cannot step through two
million entries**, and the message strings are what actually exhaust memory.

**This is also the shape invariant 2 asks for** — parallel typed arrays rather than an object per
item — which is why (b) is affordable enough to leave uncapped at all.

## 6. Non-functional expectations (`PLANNING.md` § 3)

These are part of the specification, because the natural implementation gets them wrong:

- **The cap applies at emit, not at render.** A cap enforced by a consumer leaves the multi-million
  object array already allocated, which is the cost this round exists to remove.
- **The position index is not sorted by construction.** `countMatchesInRange`'s binary search needs
  ascending offsets, and emission order is *nearly* but not strictly ascending: XML's unwind loop
  emits `xml.unclosed-element` at each open frame's `nameStart` after reaching EOF, which runs
  backwards. `diagnosticNav.ts:16` already sorts defensively for this reason and its comment says
  so. **Sort the index once, when the parse ends — not per render**, which is the trap
  `diagnosticNav` currently falls into with a full copy-and-sort per keypress.
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
  real total** — and the position index's `Uint8Array` of severities already holds the answer, so
  the counters read their totals from there rather than from a separate tally. A status bar reading
  "100 warnings" for a file with two million is a worse defect than the one being fixed.

## 7. The visual decision is not settled here (`PLANNING.md` § 1)

`matchMarkers` conveys bucket occupancy through `density` as opacity. Whether diagnostic markers
should do the same — or stay solid, since a warning is not a search hit and a faded one may read as
dismissed — is a question about how the strip *looks*, and § 1 of `PLANNING.md` is explicit that
this is exactly the kind of decision that comes back as a follow-up round when it is argued rather
than rendered.

**Render both against a real ragged CSV in the browser project and put them in front of the project
lead before adopting either.** No preference is recorded here on purpose.

## 8. Rejected

**Drawing the strip from the capped list.** § 5 — the first N diagnostics are the first N by offset,
so the strip would show a clean document below the cap. A scrubber that misreports where the
problems are is worse than one that is merely unreadable.

**Collapsing to one diagnostic per fault.** § 3 — it answers *what* and discards *where*, which is
the half the scrubber and the diagnostic-navigation commands exist to serve.

**Capping only at the render sites.** Fixes the DOM and leaves the allocation. § 6.

**Deduplicating diagnostics by offset.** Different from bucketing, and the existing comment argues
against it correctly: diagnostics clustered at one offset are meaningful. Bucketing changes how many
*markers* are drawn, not which positions are recorded.

**Virtualizing the scrubber strip.** More machinery than bucketing, for a strip whose whole height
is a few hundred pixels — and bucketing is already built and already proven on the sibling source.

**Raising the cap high enough that nobody hits it.** The failure is unbounded input, not a
badly-chosen bound; a 10 M-row file exists.

**Capping the position index too, "for symmetry".** It is 5 bytes per entry in typed arrays, it is
what makes § 5's guarantee true, and a bound on it would reintroduce exactly the defect this
section's first entry rejects.

**Making a Fatal halt the parse, so § 11.1's model becomes true.** Out of scope, and a bigger change
than it looks: invariant 5 wants a partial tree, and `state.fatal` is load-bearing elsewhere — the
XML formatter reads it through `complete` to decide whether pass 2 may run at all (`M5h-PLAN.md` R18
§ 2c), degrading to "return the input unchanged" for a partial tree. That use survives either way,
but halting changes how much tree exists, which is not a question this round is scoped to reopen.
What R200 does correct is **`CONCEPT.md` § 11.1's wording**, which describes behaviour no parser
implements — a documentation fix, not a parser change.

## 9. Acceptance

1. A CSV with 500,000 long rows produces a **capped** `diagnostics` length — asserted on
   `store.diagnosticCount`.
2. **The position index for that same file records all 500,000**, and the scrubber's markers are
   **distributed across the full height of the strip**, not clustered in its first N. Asserted on
   the bucket occupancy, since this is the claim § 5 exists to make and the one a naive cap breaks
   silently.
3. **The same holds for a non-CSV format** — an XML fixture with a malformed attribute on every one
   of 100,000 elements is bounded and indexed identically, asserted the same way. This pins § 2's
   finding that the defect is general and stops the cap being implemented as a CSV feature.
4. The scrubber renders **at most bucket-count** diagnostic markers, asserted by counting DOM nodes
   in the browser project.
5. `StatusBar`'s warning count shows the **true** total for that file, not the capped list's length.
6. `diagnosticNav` still reaches every diagnostic that was **retained**, and the summary entry names
   how many were not.
7. The budget and the index live in **one** module, consulted by all four `ParserState.emit` bodies
   — asserted by acceptance 3 passing without a CSV-specific branch.
8. The position index is sorted **once** per parse, not per render — asserted by `diagnosticNav` no
   longer copying and sorting on every keypress.
9. `CONCEPT.md` § 11.1 no longer claims parsing stops at the first failure.
10. Existing `scrubberModel.test.ts`, `diagnosticNav.test.ts` and `csvParse.test.ts` stay green, or
    their changed expectations are named in the results.
11. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 10. Version

**Ask on landing.** Candidate: patch — a defect fix with no new capability.
