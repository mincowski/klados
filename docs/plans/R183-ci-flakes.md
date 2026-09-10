# R183–R186 — CI on `main` is not reliably green

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. **Three of the last 21 completed `main` runs were red, and none
of the three was caused by the commit that triggered it.** A red run therefore no longer reliably
means "this branch broke something" — which is the one property the whole pull-request gate is built
on.

Found while reading CI output for R179–R181, after a failure on that branch turned out to belong to
a test the branch never touched.

---

## 1. What is actually failing, and how often

`gh run list --branch main --limit 24`, 2026-09-07 to 2026-09-10:

| Outcome | Runs |
|---|---|
| success | 18 |
| **failure** | **3** |
| cancelled | 2 |

All three failures are unrelated to their commit. Two more instances fired on pull-request branches
in the same window ([#24](https://github.com/mincowski/klados/pull/24),
[#25](https://github.com/mincowski/klados/pull/25)), giving **five observed failures across three
distinct tests**:

| Test | File | Platform | Assertion | Seen |
|---|---|---|---|---|
| `reserves a bottom gutter only while the horizontal track is showing` (R170) | `test/treeHorizontalScroll.test.tsx:246` | `macos-latest` | `expected false to be true` | 2× on `main` |
| `clicking the right chevron scrolls the strip without changing the active tab` (R35–R37) | `test/tabStrip.test.tsx:262` | `ubuntu-latest` | `expected 0 to be greater than 0` | 2× on PR branches |
| `a namespace-capable interner costs no more than a plain one…` (R134) | `test/namespaceResolution.test.ts:147` | `macos-latest` | `expected 800.239 to be less than 696.472002` | 1× on `main` |

**Every one of them passes locally.** The tab-strip test was run 3× on this machine and 3× green; the
suite as a whole has been green locally on every round in this window. That signature — green on
every local configuration, red intermittently on CI — is the same one R178 spent most of a round
chasing, and it is worth naming as a signature rather than re-diagnosed each time.

## 2. Two of the three are the same defect, and one of them admits it

**R159 (`docs/plans/R159-fixed-duration-waits.md`) is the round that already fixed this class**, in
four places, and built `test/support/wait.ts` to stop it recurring. Its rule is one sentence: *wait
for the condition, never for a duration.* Both browser failures are that rule being broken.

### 2a. The tab strip — a two-frame wait against a ~30-frame animation

`test/tabStrip.test.tsx:250` clicks the right chevron, calls `await paint()`, and asserts
`scrollEl.scrollLeft > 0`. `paint()` is exactly two `requestAnimationFrame` hops.

The chevron calls `scrollByOneTab`, which is:

```ts
scrollRef.current?.scrollBy({ left: direction * tabStepWidth(), behavior: scrollBehavior() })
```

and `scrollBehavior()` returns `'smooth'` unless the platform reports
`prefers-reduced-motion: reduce`. **`TabStrip.tsx`'s own comment states the cost**: *"`behavior:
'smooth'` turns one instant jump into ~30 frames of scroll events."*

So the test waits two frames for a thirty-frame animation and asserts that it has moved. On a runner
where the first two frames have not yet moved `scrollLeft` off zero, it fails with the exact message
observed. The mechanism is established from the source; **which platforms hit it depends on
reduced-motion reporting and on the animation's ramp, and that has not been measured per platform** —
the fix does not depend on knowing.

The same file already contains `waitForOverflowButtons`, a condition wait. The pattern was known and
this assertion did not get it.

### 2b. The tree — a fixed sleep whose own comment says it is unreliable

`test/treeHorizontalScroll.test.tsx`'s `paint()`:

```ts
await new Promise<void>((resolve) => {
  root.render(jsx)
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
})
// The virtualizer measures via `ResizeObserver`, and the scrollbar's own
// metrics read is rAF-coalesced on top of that — neither reliably settles
// inside two rAFs in headless Chromium.
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
```

**The comment is a correct diagnosis attached to the wrong fix.** Two rAFs do not settle it, so a
50 ms sleep was added — which does not settle it either, it only settles it *usually*. The condition
is observable: the assertion is about `tree-has-horizontal-track` being present, and waiting for that
class is available and exact.

**Not reproduced locally**, and the plan says so rather than claiming otherwise. The mechanism is
read from the code and the comment; what is established is that the wait is a duration where a
condition exists, which is sufficient grounds to fix it whether or not this is the whole story.

### 2c. How far the shape reaches — measured

```
44   fixed-duration sleeps across the test suite
26   test files containing at least one
18   browser test files ending `paint()` with `setTimeout(resolve, SETTLE_MS)`
```

`SETTLE_MS` is `50`, exported from `test/support/wait.ts` — where it is defined as the *quiet window*
for `waitForQuiet`, a condition wait. Eighteen files import it and use it as a bare sleep instead.

**R159 reported 58 such sleeps across 24 files and built the shared vocabulary; 44 across 26 files
remain.** Both numbers are counts of `setTimeout(resolve, …)` in `test/`, so they are comparable, and
the second is measured on the tree at the time of writing. How many R159 itself converted is not
established here and the claim is not made — what matters is that the vocabulary exists, is imported
by these very files, and is not being used by them.

## 3. The third is a different problem and must not be treated as the same one

`namespaceResolution.test.ts:147` asserts
`expect(namespaced).toBeLessThan(Math.max(plain * 3, plain + 20))` — a wall-clock ratio. It measured
**800.239 against a 696.472 ceiling**, i.e. `plain` was 232.157 ms and `namespaced` was **3.45×** it.

**This ceiling has already been raised once.** R153 took it from 2× to 3× after CI measured 2.024,
and the comment it left is the reason to be careful now:

> Raising a performance ceiling is exactly the move that hides a real regression, so the
> justification is what a regression looks like, not that the run was close.

That reasoning applies to R153's own raise as much as to another. **Raising it to 4× is not what this
round should do by default**, and the plan does not propose it. What R185 asks for is that the
question be answered rather than the number moved: is a 3.45× ratio on a contended shared runner
consistent with the fast path being clean, or is there per-node work leaking into it that a
generous ratio has been absorbing since R110?

That is answerable — the test already measures both shapes, and the ratio can be sampled repeatedly
on one machine to establish its distribution before anyone touches the constant.

## 4. R183 — fix the two demonstrated flakes, by waiting on the condition

- **`tabStrip.test.tsx`**: wait until `scrollEl.scrollLeft > 0` (`vi.waitFor` with `POLL_MS` /
  `TIMEOUT_MS`) instead of two frames, then assert the active tab is unchanged. The timeout turns a
  genuinely broken chevron into a failed assertion rather than a hang, which is what the wait
  vocabulary is for.
- **`treeHorizontalScroll.test.tsx`**: replace the trailing `SETTLE_MS` sleep with a wait on the
  condition each call site is about — the presence of `.scrollbar-track-horizontal`, or of the
  `tree-has-horizontal-track` class.

**Both must still fail when the behaviour they guard is broken.** The acceptance for this is a
mutation run, not a green suite: remove the horizontal axis from the tree's scrollbar, and the test
must go red rather than time out into a pass.

## 5. R184 — the shared `paint()` shape, in the eighteen files that carry it

The two above are the ones that have fired. The other sixteen have the same construction and differ
only in luck.

**Not a mechanical find-and-replace.** Each call site's condition is different, and R154's finding is
the reason to be careful: *stable and not-yet-started are indistinguishable from outside*, so a
quiescence wait can return before the work has begun. Where a call site has a nameable condition, use
`vi.waitFor` on it; where it genuinely has none, `waitForQuiet` is the honest tool and the sleep goes.

The deliverable is that **`setTimeout(resolve, SETTLE_MS)` no longer appears after `paint()` in the
browser project**, with each conversion justified at its call site.

R184 is separable from R183 and larger. If it is deferred, R183 still fixes the two failures that
have actually cost runs.

## 6. R185 — decide the performance ratio with a measurement, not a number

Sample `namespaced / plain` repeatedly (30+ runs) on one machine, and record the distribution in the
plan. Then either:

- the ratio is stably near 1 and the CI observation was runner contention — in which case the test's
  *shape* is wrong for CI, not its constant, and the fix is to stop asserting wall-clock ratios in a
  suite that runs on shared hardware; or
- the ratio is not near 1 — in which case there is per-node work in the declaration-free path and
  **the number must not be raised**, because that is the regression the assertion exists to catch.

**Raising the constant is not among the outcomes this round may choose without the measurement.**

## 7. R186 — a guard, so the class stops coming back

R159 established the vocabulary and eighteen files kept the sleep anyway, which is the argument for
enforcement over discipline — invariant 10's own wording, and the pattern `docsStatus.test.ts`
already follows.

A node test that reads the test sources and fails on `setTimeout(resolve, <duration>)` outside an
explicit allowlist. The allowlist is the point rather than a loophole: R163 names the one legitimate
use, *a negative assertion, where the expected outcome is that nothing ever happens*, and those call
sites should have to say so out loud.

Separable, and the last thing to do rather than the first — a guard written before the eighteen
conversions would be an allowlist of eighteen entries, which proves nothing.

## 8. What this round must not do

- **Not `retry`.** Vitest's retry option would green all three in one line. R153 already rejected it
  for exactly the right reason: *"it would have hidden R152's missing wait completely."* A retried
  flake is an unfixed flake with the evidence deleted.
- **Not raising the performance ceiling** without §6's measurement.
- **Not deleting or skipping any of the three tests.** Each one guards a real defect: R170's tree
  gutter, R35–R37's chevron scroll, R134's fast path.
- **Not a timing change to the application to suit a test.** `behavior: 'smooth'` is a deliberate
  R38 decision with reduced-motion handling; the test waits wrongly, the app scrolls correctly.

## 9. Acceptance

1. `tabStrip.test.tsx` and `treeHorizontalScroll.test.tsx` wait on conditions, and both still fail
   when the behaviour they guard is removed — asserted by mutation, not by the suite being green.
2. Twenty consecutive CI runs on `main` with no failure attributable to a test unrelated to its
   commit. **This is the only acceptance criterion that matters and it cannot be met inside the
   round**, so it is recorded as owed and checked later rather than claimed.
3. If R184 lands: no `setTimeout(resolve, SETTLE_MS)` after `paint()` in the browser project.
4. If R185 lands: the ratio's distribution is recorded, and any change to the constant cites it.
5. If R186 lands: the guard fails on a newly added fixed-duration wait, demonstrated by adding one.

## 10. Non-functional expectation

`PLANNING.md` §1 does not apply — nothing here is a visual decision. §3 does not apply: a condition
wait with a 5 s ceiling is *faster* than the 50 ms sleep it replaces in the common case, which R159
already established.

§2 is the substance of §2 above. The tab strip's mechanism is read from `TabStrip.tsx`'s own comment
and `scrollBehavior()`; the tree's is read from its test's comment; **neither has been reproduced
locally, and the round should try before it fixes** — a flake that cannot be reproduced is a flake
whose fix cannot be verified, which is how R178 lost most of a round.

## 11. Out of scope

Whether the browser project should run on CI at all (it must — R151's whole finding was that
platforms disagree). The `cancelled` runs in §1, which are concurrency-group cancellations and
correct behaviour. Dependabot branches whose failures are legitimate.

## 12. Version

No bump implied — test-suite reliability, nothing shipped changes.
