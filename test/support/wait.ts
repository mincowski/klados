/**
 * R159 (`docs/plans/R159-fixed-duration-waits.md` §4) — the one wait vocabulary.
 *
 * **Wait for the condition, never for a duration.** Four rounds found the same
 * defect once each — R140's `flushReparse` (which failed the v1.0.0 release
 * build), R152's missing `waitForOverflowButtons`, R154's two, R158's
 * `mountAndDrain` — and each fixed it locally, by hand, in the file that had
 * gone red. The review that produced this module found **58 fixed-duration
 * sleeps across 24 files** and, more to the point, found that four separate
 * correct implementations already existed with no shared home. A per-file
 * private helper is where this defect hides: fixing "the" helper in a file
 * fixes one of however many copies it has, and R154 proved that twice over —
 * `documentSession.test.ts` held five more after its first was fixed, and two
 * *other* files justified their own magic number by **citing the helper R154
 * had already replaced**.
 *
 * **A predicate wait is `vi.waitFor`, and this module deliberately does not
 * reimplement it.** Vitest ships it, this suite already used it before R159,
 * and "wait until X is true" needs nothing more. Pass
 * `{ interval: POLL_MS, timeout: TIMEOUT_MS }` rather than accepting its
 * defaults, which are wrong here in both directions: a 1,000 ms timeout is a
 * fifth of what a loaded CI runner has needed, and a 50 ms poll interval is
 * longer than most of the sleeps being replaced.
 *
 * What `vi.waitFor` cannot express is **quiescence** — "wait until nothing
 * changes any more" — which is what a mount drain and a reparse settle actually
 * want, and which is the entire content of this module. The distinction is not
 * academic: R154 established that after an edit the search store goes stale
 * synchronously and then nothing moves until the debounce elapses, so a pure
 * quiescence wait can return *before the work has started* — **stable and
 * not-yet-started are indistinguishable from outside.** Where a condition names
 * the transition you are about to assert on, use `vi.waitFor` and say so; reach
 * for quiescence only when no single condition exists, which is the honest case
 * for "the mount has finished committing".
 *
 * `waitForQuiet` is timer-based and works in both projects. `waitForQuietFrames`
 * drives `requestAnimationFrame` and is **browser-project only** — the node
 * project has no such function, which is why it is referenced inside a function
 * body and never at module scope.
 */

/** Poll interval for every wait in this suite. Short enough that a converted
 * wait is *faster* than the sleep it replaced, which is the point. */
export const POLL_MS = 5

/** Ceiling for every wait. Must exceed the slowest CI runner, not the
 * development machine — R154's macOS hook needed 120 s for a different reason,
 * but the general lesson holds: a bound tuned locally is not a bound. */
export const TIMEOUT_MS = 5000

/** Quiet window for `waitForQuiet`, and the value R154's converted helpers
 * settled on.
 *
 * **It has to exceed the `reparseDelayMs` the caller configured** (20–30 ms
 * across the suites that use this), or the wait can return in the gap between
 * an edit changing the snapshot synchronously and the debounce firing — R154's
 * "stable and not-yet-started are indistinguishable from outside". Callers
 * whose debounce is longer must pass their own `quietMs`. */
const DEFAULT_QUIET_MS = 50

/** Quiet frames for `waitForQuietFrames`, from R158. Two would be the number a
 * `paint()` helper already waits; three is the first that means "and nothing
 * arrived in the frame after the one that looked settled". */
const DEFAULT_QUIET_FRAMES = 3

export interface QuietOptions {
  /** How long nothing may change before the wait returns. */
  readonly quietMs?: number
  readonly pollMs?: number
  readonly timeoutMs?: number
  /** Named in the timeout message — worth setting when a file has several. */
  readonly label?: string
}

/**
 * Polls `sample()` until it returns the same value (by `Object.is`) for an
 * unbroken quiet window, then resolves. **Throws on timeout rather than
 * returning**, so a genuinely stuck subject fails loudly instead of silently
 * asserting against a state that never arrived — the failure mode a fixed sleep
 * has by construction.
 *
 * `sample` should return something with stable identity while at rest: a
 * `getSnapshot()` result, or a number derived from counters.
 */
export async function waitForQuiet<T>(sample: () => T, options: QuietOptions = {}): Promise<void> {
  const {
    quietMs = DEFAULT_QUIET_MS,
    pollMs = POLL_MS,
    timeoutMs = TIMEOUT_MS,
    label = 'waitForQuiet'
  } = options
  const deadline = Date.now() + timeoutMs
  let last = sample()
  let quietFor = 0
  while (quietFor < quietMs) {
    if (Date.now() > deadline) {
      throw new Error(`${label}: still changing after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    const current = sample()
    if (Object.is(current, last)) {
      quietFor += pollMs
    } else {
      last = current
      quietFor = 0
    }
  }
}

export interface QuietFramesOptions {
  readonly quietFrames?: number
  readonly timeoutMs?: number
  readonly label?: string
}

/**
 * The same wait, advanced by `requestAnimationFrame` instead of a timer.
 *
 * **Browser project only** (`*.test.tsx`, real Chromium). Use it where the
 * thing being waited on is React commits rather than session state — R158's
 * case, where CodeMirror's setup is *effect-driven* and so has no obligation to
 * land inside the two frames `paint()` waits.
 */
export async function waitForQuietFrames<T>(
  sample: () => T,
  options: QuietFramesOptions = {}
): Promise<void> {
  const {
    quietFrames = DEFAULT_QUIET_FRAMES,
    timeoutMs = TIMEOUT_MS,
    label = 'waitForQuietFrames'
  } = options
  const deadline = Date.now() + timeoutMs
  let last = sample()
  let quiet = 0
  while (quiet < quietFrames) {
    if (Date.now() > deadline) {
      throw new Error(`${label}: still changing after ${timeoutMs}ms`)
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const current = sample()
    if (Object.is(current, last)) {
      quiet += 1
    } else {
      last = current
      quiet = 0
    }
  }
}
