# R200 — diagnostics are unbounded, and the scrubber renders one DOM node per diagnostic

<!-- status: open -->

**Open.** Found while answering a question about R199's per-row warnings: the CSV parser's volume is
the trigger, but nothing anywhere bounds a diagnostic list, and four consumers walk it whole.

## 1. What is there

`NodeStore.diagnostic` is an unbounded `push` (`src/core/nodeStore.ts:449`). Nothing in the parsers,
the sink, or the worker caps it. A 2,000,000-row CSV exported with a stray trailing delimiter on
data rows emits one Warning per row: 2 M `Diagnostic` objects, each with a template-built message
string.

Four consumers then read the whole array:

| Consumer | Cost |
|---|---|
| `StatusBar.tsx:80,83` | two `.filter().length` passes, per render |
| `StatisticsPanel.tsx:84,87` | two more |
| `diagnosticNav.ts:16` | `[...diagnostics].sort(…)` — a **full copy and sort per next/prev keypress** |
| `Scrubber.tsx:243` | **one `<div>` per diagnostic** |

The scrubber is the one that stops being a slowdown and becomes a hang: `diagnosticMarkers` maps
one marker per diagnostic (`scrubberModel.ts:65`) and the component renders each as an element.

**The notification layer is not affected, and this is worth stating because it is the natural
worry.** `Notifications.tsx` fires once per *event*; `notifyPartialParse` takes a single primary via
`.find(…)` over Error/Fatal severities and carries a `dedupeKey`. Ragged rows are Warnings, so they
produce **no notifications at all**. There is no flood of toasts — the cost is memory, render passes
and DOM nodes.

## 2. Why this was safe until CSV

`CONCEPT.md` § 11.1 describes opening an invalid document as *"parse to the point of failure, present
the partial tree with the error node marked"* — **one** failure position. `scrubberModel.ts:55`
inherited exactly that assumption and wrote it down:

> One marker per diagnostic. Not deduplicated by position … and rare enough, per § 11.1's
> partial-tree model, not to warrant the complexity of merging.

True for XML and JSON, where a fatal stops the parse. **False for CSV**, which reports and continues
per row to EOF under invariant 5, so warnings scale with row count. This is `FINDINGS.md`'s
recurring line again — measured in one condition, concluded about another — and the conclusion is
sitting in a comment that reads as settled.

## 3. The neighbour that already solved it

`matchMarkers`, in the same file and feeding the same strip, buckets into a fixed 256 slots
(`scrubberModel.ts:82`) explicitly because search hits can be millions — its own comment says *"not
a scan of however many million matches"*. The mechanism, the file and the rendering path are already
there. `diagnosticMarkers` never got it, because § 2's assumption said it never needed it.

## 4. R200

**(a) Cap what is stored.** Keep the first N per diagnostic code, then one summary entry naming the
total. The compiler convention, and it preserves navigation over a tractable set instead of either
2 M entries or none.

**(b) Bucket the scrubber's diagnostic markers** through the same path `matchMarkers` uses.

## 5. Non-functional expectations (`PLANNING.md` § 3)

These are part of the specification, because the natural implementation of (a) gets each one wrong:

- **The cap applies at emit, not at render.** A cap enforced by a consumer leaves the 2 M-object
  array already allocated, which is the cost this round exists to remove.
- **A capped diagnostic must not build its message.** `ParserState.emit` is called with an
  already-interpolated template string (`src/formats/csv/index.ts:214`), so the string is
  constructed *before* any sink can reject it. Capping downstream of that still allocates 2 M
  strings. Either the cap is visible where the message is built, or the message becomes lazy.
- **The displayed counts must stay truthful.** `StatusBar` and `StatisticsPanel` derive their error
  and warning counts by filtering the list. Once the list is capped, filtering it **understates the
  real total** — the counters need a separate running count that the cap does not touch. A status
  bar reading "100 warnings" for a file with 2 M is a worse defect than the one being fixed.

## 6. The visual decision is not settled here (`PLANNING.md` § 1)

`matchMarkers` conveys bucket occupancy through `density` as opacity. Whether diagnostic markers
should do the same — or stay solid, since a warning is not a search hit and a faded one may read as
dismissed — is a question about how the strip *looks*, and § 1 of `PLANNING.md` is explicit that
this is exactly the kind of decision that comes back as a follow-up round when it is argued rather
than rendered.

**Render both against a real ragged CSV in the browser project and put them in front of the project
lead before adopting either.** No preference is recorded here on purpose.

## 7. Rejected

**Capping only at the render sites.** Fixes the DOM and leaves the allocation. § 5.

**Deduplicating diagnostics by offset.** Different from bucketing, and the existing comment argues
against it correctly: diagnostics clustered at one offset are meaningful. Bucketing changes how many
*markers* are drawn, not which diagnostics exist.

**Virtualizing the scrubber strip.** More machinery than bucketing, for a strip whose whole height
is a few hundred pixels — and bucketing is already built and already proven on the sibling source.

**Raising the cap high enough that nobody hits it.** The failure is unbounded input, not a
badly-chosen bound; a 10 M-row file exists.

## 8. Acceptance

1. A CSV with 500,000 long rows produces a diagnostic count **bounded by the cap** — asserted on
   `store.diagnosticCount`.
2. Peak allocation during that parse does not scale with row count — no per-dropped-diagnostic
   message string, asserted by the cap being visible at the emit site rather than by a measurement
   this suite cannot take.
3. The scrubber renders **at most bucket-count** diagnostic markers, asserted by counting DOM nodes
   in the browser project.
4. `StatusBar`'s warning count shows the **true** total for that file, not the capped list's length.
5. `diagnosticNav` still reaches every diagnostic that was stored.
6. Existing `scrubberModel.test.ts`, `diagnosticNav.test.ts` and `csvParse.test.ts` stay green, or
   their changed expectations are named in the results.
7. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 9. Version

**Ask on landing.** Candidate: patch — a defect fix with no new capability.
