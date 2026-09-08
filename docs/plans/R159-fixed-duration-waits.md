# R159–R163 — waits that measure a duration instead of a condition

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. A codebase-wide review of the failure mode R140, R152, R154
and R158 each found once, after the fourth instance made "four times is not a coincidence" the
obvious reading.

The review is §1–§3 and is finished; §4–§8 are the five tasks it produced. **The headline is not
the population — it is that this defect has a second harm nobody has been looking for, and one
confirmed instance of it: a shipped feature with no test coverage, hidden behind a wait that looks
like coverage.**

---

## 1. The failure mode, as previously stated

From `R157-package-check.md` §8, after the fourth instance:

> A helper whose comment describes something asynchronous while its body waits a fixed amount of
> time.

Four instances, one per round, each found because it went red:

| | site | how it surfaced |
|---|---|---|
| R140 | `documentSession.test.ts`'s `flushReparse`, 40 ms | failed the v1.0.0 release build |
| R152 | `tabStrip.test.tsx:327`, a missing `waitForOverflowButtons()` | 2 of the last 4 CI runs |
| R154 | `searchStore.test.ts` ×17 sites, `documentSession.test.ts` ×5 more helpers | Windows CI, then full-suite load |
| R158 | `documentPropsRenderCost.test.tsx`'s `mountAndDrain`, two rAFs | macOS CI, `expected 11 to be 10` |

## 2. What the review measured

Three experiments, all reverted; the working tree was clean before and after.

### 2a. The population

| | count |
|---|---|
| Fixed-duration sleeps in `test/` | **58**, across **24 files** |
| Files defining a two-`requestAnimationFrame` `paint()` | **41** |
| `setTimeout(…, 0)` used as a deliberate macrotask hop | 5 |
| `vi.waitFor` calls (condition-based, correct) | 7, in 3 files |
| Hand-rolled predicate loop (`waitForOverflowButtons`, R152) | 1 |
| Hand-rolled quiescence loops (R140, R154 ×2, R158) | 4 |

**`src/` is clean.** There are **13 timer call sites** in production code, across 11 files, and
every one is deliberate and correctly shaped: the debounces (`FILTER_DEBOUNCE_MS`,
`REPARSE_DEBOUNCE_MS`, `rawCaretSync`'s, FindBar's, Palette's), `CHORD_TIMEOUT_MS`,
`TYPE_AHEAD_TIMEOUT_MS`, `HOLD_DELAY_MS` and its repeat `setInterval`, `AUTO_DISMISS_MS`, a
clipboard "Copied" reset, and `searchJob.ts`'s two `setTimeout(0)` yields between slices.
**`src/main`, `src/core` and `src/preload` contain no timers at all.** Nothing in the product waits a fixed duration for an
unbounded operation. This round changes one thing in `src/` (§7) and it is a constant becoming
named and exported, not a behaviour.

### 2b. Halving every sleep — which waits are load-bearing

All 58 scaled by 0.5, full suite:

```
Test Files  4 failed | 148 passed | 1 skipped (153)
     Tests  7 failed | 1827 passed | 5 skipped (1839)
```

| file | failures |
|---|---|
| `findReplace.test.tsx` | 3 |
| `palettePathQuery.test.tsx` | 2 |
| `grid.test.tsx` | 1 |
| `documentSession.test.ts` | 1 |

Seven tests have **under 2× headroom** — the margin R153 rejected at 2.024×, on the grounds that a
real regression costs a multiple rather than a few percent.

### 2c. Zeroing every sleep — which waits do anything at all

All 58 set to 0, full suite:

```
Test Files  5 failed | 147 passed | 1 skipped (153)
     Tests  17 failed | 1817 passed | 5 skipped (1839)
```

**1,817 of 1,834 tests pass with every fixed sleep removed** — including waits whose own comments
say they exist to clear a 150–200 ms product debounce. Those sleeps are not holding anything up.

The 17 that do fail are the honest ones: `findAutoSelect` ×3, `findReplace` ×10,
`palettePathQuery` ×2, `grid` ×1, `documentSession` ×1.

### 2d. The mutation test — what a passing test is actually worth

`focusIntoContent.test.tsx:250` waits 250 ms with the comment `// past rawCaretSync's debounce`. It
passes at 125 ms, which is *below* the 200 ms debounce. It passes at 0 ms. So the question is
whether it tests the mechanism it names at all.

`rawCaretSync.ts`'s `DEBOUNCE_MS` was raised from `200` to `200_000` — the caret sync provably
cannot fire during any test — and the browser project was run in full:

```
Test Files  43 passed (43)
     Tests  239 passed (239)
```

**The suite has no coverage of `rawCaretSync` at all.** The one test whose comment names it would
pass if the extension were deleted.

### 2e. One settle time, measured rather than assumed

`findReplace.test.tsx`'s R126 case searches a 65,432-match document behind a 250 ms wait in
`search()` plus a 300 ms wait inline. Instrumented, `.find-count` reaches its final value at
**186 ms** against that 550 ms budget — a ~3× margin, which is *why* it is not among the sub-2×
failures. Recorded because it is the counter-example: the population is not uniformly thin, and a
round that treated all 58 sites the same would be wrong.

## 3. The two harms — and why only one of them has ever been found

**Harm 1 — the sleep is too short and the test goes red.** All four known instances. Expensive,
noisy, and *self-reporting*: it costs a release build or a CI run, and then someone fixes it.

**Harm 2 — the sleep is too short and the test goes green anyway.** Where the assertion is
negative, or the state under test is unchanged either way, the awaited thing never happening
produces exactly the expected result. §2d is a confirmed instance.

Harm 2 never turns red, so nothing in this project has ever found one. Every round that found
Harm 1 was looking at a failure. **This is the reason the round is worth taking beyond tidying: the
population is mostly harmless, and the exception is invisible by construction.**

The tell for Harm 2 is the same as for Harm 1 — a comment naming an asynchronous mechanism above a
body that waits a duration — which is why one review finds both.

## 4. R159 — one wait vocabulary, four copies collapsed into it

**`vi.waitFor` already exists and is already used here** (7 calls in `documentSession.test.ts`,
`sessionRestore.test.ts`, `tabs.test.ts`). Nothing needs installing, and **this round must not
reinvent it**: a predicate wait is `vi.waitFor`, full stop.

What `vi.waitFor` cannot express is *quiescence* — "wait until nothing changes any more" — which is
what a mount drain and a reparse settle actually want, and which R140, R154 and R158 each
hand-rolled separately. So the new module is small and covers only that gap:

`test/support/wait.ts`:

- `waitForQuiet(sample, options)` — polls `sample()` until its result is `Object.is`-identical for a
  quiet window, then returns. Throws on timeout. Generalises R140/R154's `flushReparse` (samples
  `session.getSnapshot()`) and R158's `mountAndDrain` (samples a render-count total).
- `settleFrames(isSettled)` — the browser-project variant that advances by `requestAnimationFrame`
  rather than by timer, for waits that genuinely track paints.

**Defaults are part of the specification, because `vi.waitFor`'s are wrong for this suite**: its
1,000 ms timeout is a fifth of the 5,000 ms the existing hand-rolled loops use, and its 50 ms poll
interval is longer than most of the sleeps being replaced. Call sites pass
`{ interval: 5, timeout: 5000 }`, or the module exports a wrapper that does.

**The module must not import or reference `requestAnimationFrame` at module scope.** The node
project (`*.test.ts`) runs in the node environment, where it does not exist; the browser project
(`*.test.tsx`) runs in real Chromium. `waitForQuiet` is timer-based and usable from both;
`settleFrames` is browser-only and must be a separate entry point or lazily referenced.

**Then the copies collapse.** The four correct loops become calls. And so do these, which are the
same helper written five times:

| file | helper | body |
|---|---|---|
| `rawEditCaretSurvival.test.tsx` | `flushReparse`, `openTab` | 60 ms |
| `rawExternalRewrite.test.tsx` | `settle`, `openTab` | 60 ms |
| `rawZoomRemeasure.test.tsx` | `openTab` | 60 ms |
| `rawDecorationTiming.test.tsx` | `openTab` | 60 ms |
| `inactiveSelection.test.tsx` | `openTab` | 60 ms |

`openTab` is `paint()` → 60 ms → `paint()` in all five, character for character, and four of the
five carry no comment explaining the number.

**Two of them justify the number by citing a helper that no longer works that way.**
`rawEditCaretSurvival.test.tsx`:

> `documentSession.test.ts`'s own `flushReparse` uses the same 40ms figure for the same reason.

R154 replaced that helper with a quiescence loop. The citation now points at the counter-example,
and `rawExternalRewrite.test.tsx` cites *both* of them in turn. **R154 fixed two files; the
rationale had already propagated to five.** That is the specific mechanism by which this defect
survives being fixed, and it is worth naming in the results.

## 5. R160 — the sites that assert something

Convert the waits that gate a real assertion. Ordered by the evidence, not by file:

1. **The 7 sub-2× failures from §2b** — `findReplace` ×3, `palettePathQuery` ×2, `grid` ×1,
   `documentSession` ×1.
2. **`documentSession.test.ts:769`** — *"resets to empty once the debounced reparse lands"*, a
   positive assertion on a bare 60 ms sleep, **in the file whose helper R154 rewrote**. Found by
   reading before the experiment ran, and confirmed by it as the one node-project failure at half
   margin. R154's own generalisation, one level up: fixing "the" helper in a file fixes one of
   however many copies it has, and leaves the inline sites entirely.
3. **Two name/body mismatches**, cheap and unambiguous:
   - `documentWatchers.test.ts`'s `flushMicrotasks()` contains two *macrotask* hops.
   - `tabCloseNotification.test.tsx:197` — *"wait for it to actually land rather than racing"* above
     a `setTimeout(0)`.

**Not in scope: the 25 `paint()` tails.** A 50 ms sleep at the end of a mount helper is a safety
margin, it asserts nothing on its own, and §2c shows none of them is load-bearing. Converting 41
files' `paint()` to a quiescence drain would add three quiet frames to every call in the suite for
no measured benefit — see §9.

## 6. R161 — `tabSwitchMeasurement.test.tsx`, the twin R158 did not look at

`documentPropsRenderCost.test.tsx` and `tabSwitchMeasurement.test.tsx` are the same harness: five
`React.Profiler` panes including `RawContent`, mount, reset the counters, then measure. R158 fixed
the first. The second still resets after two rAFs, under a comment that names the same cause:

> First mount's cost (CodeMirror's own setup included) isn't the number under test — only the
> *switch* is.

**It will not flake** — the assertion is `expect(wallMs).toBeLessThan(500)`, deliberately generous.
It is worse than a flake: the R30 tab-switch figure this test **prints to the log as its actual
deliverable** can silently include part of the mount it claims to exclude. That is `CLAUDE.md`'s "a
component measured cleanly while the pipeline around it was not", which the file already lists four
instances of; this is the fifth.

Fix is R158's, applied to a stats shape that accumulates milliseconds rather than counts: drain on
render-count quiescence before zeroing.

## 7. R162 — the coverage hole, and the constants that hid it

**This is the only task that touches `src/`, and the product change is that two literals get
names.**

`FindBar.tsx:256` and `Palette.tsx:251` each end a debounce with a bare `}, 150)`. Twelve test
sleeps across four files are coupled to those two literals by nothing but a comment. Raising either
one breaks tests in files that never mention it — or, worse per §3, quietly makes them vacuous.

| test wait | product constant | margin |
|---|---|---|
| `focusIntoContent` 250 ms | `rawCaretSync.ts:29` `DEBOUNCE_MS = 200` | **1.25×** |
| `palettePathQuery` 200 ms ×3 | `Palette.tsx:251`, bare `150` | **1.33×** |
| `grid` 300 ms | `Grid.tsx:86` `FILTER_DEBOUNCE_MS = 200` | 1.5× |
| `findReplace`/`findAutoSelect` 250 ms | `FindBar.tsx:256`, bare `150` | 1.67× |

Two parts:

- **Name and export** the FindBar and Palette debounces, and export `rawCaretSync`'s `DEBOUNCE_MS`.
  Tests then wait on the constant, or better, on the condition — but a test that must express a
  duration should import the number rather than copy it.
- **Close the hole §2d found.** Add a test that fails when `rawCaretSync` does not fire.
  **Acceptance is the mutation, not the assertion**: with `DEBOUNCE_MS` raised to `200_000` the new
  test must go red, and this must be demonstrated, not asserted. A test that passes under the
  mutation is exactly the thing this round exists to find, and writing one while fixing this class
  would be the round defeating itself.

**Per `CLAUDE.md`'s "never ship code you have already discovered is inert":** if closing the hole
turns out to need a product change rather than a test, stop and report. It should not — the
extension is real and its effect (`selectNode` on the containing node) is observable — but that is a
claim to verify with a probe before writing the test, per `PLANNING.md` §2, which is the rule this
whole round is an instance of.

## 8. R163 — the gate, last

An eslint `no-restricted-syntax` rule scoped to `test/**`, rejecting `setTimeout(<fn>, <non-zero
literal>)`. `setTimeout(…, 0)` stays legal — it is a macrotask hop, and §2a counts 5 legitimate uses
of it.

This is how invariants 9 and 10 are already enforced (stylelint for literal colours, a test for
palette reachability), and it goes last because it cannot pass until §5–§7 land. `eslint.config.mjs`
is 47 lines with one `rules` block; the rule needs a second config entry with a `files` scope and a
message pointing at `test/support/wait.ts`.

**Restricting the rule to a *literal* delay is what makes it implementable**, and it is not a
loophole. `test/support/wait.ts`'s own poll (`setTimeout(resolve, POLL_MS)`) and
`mainElectron.test.ts:94`'s `CLOSE_BUDGET_MS` both pass an identifier, and both are correct — a
named bound inside a predicate loop is the shape this round is converting *towards*. The defect
being banned is the anonymous number at the call site.

**The escape hatch is deliberate and narrow**: a site that genuinely needs a duration — waiting out
a product debounce to prove something does *not* happen — disables the rule inline with a reason.
`documentSession.test.ts:1010`'s *"past the original 30ms window"* is exactly that shape: a negative
assertion, where no condition exists to wait for and a generous duration is the correct tool. There
are a handful; they should be visible rather than indistinguishable from the rest.

## 9. Non-functional expectations (`PLANNING.md` §3)

Where the obvious implementation is wrong, stated as specification:

- **A quiescence wait always pays its full quiet window; a predicate wait usually returns
  immediately.** Prefer `vi.waitFor` wherever a condition can be named. Quiescence is for "the mount
  has finished committing", where no single condition exists.
- **Do not convert the 41 `paint()` helpers.** Three quiet frames × every call in a 153-file suite
  is a real cost against a benefit §2c measured as zero.
- **Poll interval 5 ms, timeout 5000 ms**, not `vi.waitFor`'s defaults of 50 ms and 1000 ms. The
  interval is the floor on every converted wait; the timeout must exceed the slowest CI runner, and
  1000 ms does not.
- **Suite wall clock must not regress.** Measure before and after and record both. The point of
  replacing a 250 ms sleep with a 5 ms poll is that it is also *faster*; if the conversion makes the
  suite slower, something is waiting for the wrong thing.

`PLANNING.md` §1 does not apply — this round renders nothing and changes no pixels. §2 is the rule
this round is an instance of, and §2b/§2c/§2d are it being followed: every claim above about what a
wait does was produced by running the suite with that wait changed, not by reading it.

## 10. What this deliberately does not do

- **Not all 58 sites.** The 25 `paint()` tails and the handful of correct negative-assertion
  durations stay, the latter with an explicit disable and a reason.
- **No `retry`.** R153 rejected it for the same reason: it would green everything in one line and
  hide exactly the class this round is chasing.
- **No new dependency.** `vi.waitFor` is already in use; the only new file is one test-support
  module.
- **No product behaviour change.** §7 renames and exports constants. If anything else in `src/`
  turns out to need changing, that is a report, not a fix.

## 11. Acceptance criteria

1. `test/support/wait.ts` exists, is used by both projects, and the four hand-rolled quiescence
   loops plus the five duplicated `openTab` helpers call it instead of sleeping.
2. Re-running §2b (all remaining fixed sleeps halved) leaves **0** failures, where it currently
   leaves 7.
3. `documentSession.test.ts:769`, the two name/body mismatches, and
   `tabSwitchMeasurement.test.tsx`'s drain are converted.
4. FindBar's and Palette's debounces are named, exported, and no test copies their value.
5. **A test exists that fails when `rawCaretSync`'s `DEBOUNCE_MS` is raised to `200_000`**,
   demonstrated by running it under that mutation — not argued.
6. The eslint rule is in `eslint.config.mjs`, `npm run lint` passes, and every remaining
   fixed-duration wait carries an inline disable with a stated reason.
7. Suite wall clock recorded before and after, in §13.
8. Full suite green on all three CI platforms.

## 12. Risks

- **Converting 20-odd waits touches tests nobody reruns in anger.** R154's conversion introduced ten
  wrong-arity calls that `tsc` caught, which is the precedent for doing this in typed steps rather
  than by global replace — the same mistake is available here and the same compiler will catch it.
- **A predicate can be wrong in the other direction.** R154's `searchStore` fix took three attempts
  because `stale` clears when the re-run *starts*, so the obvious condition was satisfied too early.
  Every converted site needs its condition chosen from what the code does, not from what the test's
  comment claims — the comments are, after all, the thing this round has established cannot be
  trusted.
- **§7 may find more holes.** If mutating one debounce reveals no coverage, mutating the other three
  is a five-minute check with a real chance of a second finding. Do it, and report what it says even
  if the answer expands the round.

## 13. Results

*(to be written when the work lands — measured suite wall clock, the §2b re-run, the §7 mutation
outcome, and whether the review pass found anything)*
