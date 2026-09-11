# R193 — Vitest 3 to 5

<!-- status: built -->

**Built.** Dependabot PR #22 had been open since 2026-09-09, red on all three platforms. It
closes two medium advisories (CVE-2026-84373, `vitest` and `@vitest/mocker`, both
development-scope) and is two majors, not a bump: **3.2.7 → 5.0.0**.

**All five acceptance criteria met**, counts identical to Vitest 3 and nothing relaxed to get
there. **And § 4's hypothesis turned out to be right where it can be measured: `npm run test:large`
now exits 0.** That closes R187's owed item — see § 7.

## 1. Why the Dependabot PR is red, measured rather than read

Reproduced in a worktree with the PR's own lockfile. **Two independent breakages**, and the first
one hides the second, which is why the CI log shows only one:

**`src/preload/api.ts(78,24): error TS2503: Cannot find namespace 'NodeJS'`** — and it is
`typecheck:web`, not `typecheck:node`, which is the whole explanation. `tsconfig.web.json` sets
`"types": ["vite/client"]` and includes `src/preload/*.d.ts`, so this file is compiled by a program
that declares **no Node globals** — correctly, since a renderer under `contextIsolation` has none.
`NodeJS.Platform` resolved there anyway, as a transitive leak: the web project also compiles the
browser tests, those import `vitest`, and Vitest 3's type surface pulled `@types/node` into the
program. **The upgrade did not create this; it removed the accident that was hiding it.**

**`Error: Browser Mode was enabled, but provider was not specified anywhere`** — reachable only
after the first is fixed, because `typecheck` gates the test step. `browser.provider` stopped being
a string in v4.

A third, found only by running the suite once the config parsed: **three test files fail to
import**, with *"vitest/browser can be imported only inside the Browser Mode"*.

## 2. The three changes

**`browser.provider` is an imported object, not a string.** v4 split the providers into their own
packages; `@vitest/browser-playwright` declares `peerDependencies: { vitest: '5.0.0', playwright:
'*' }`.

```ts
import { playwright } from '@vitest/browser-playwright'
// …
browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: 'chromium' }] }
```

**This is a new dependency and was agreed before adding it** (`CLAUDE.md` § Conventions). It is not
new capability: it is the `provider: 'playwright'` string, repackaged upstream. `@vitest/browser`
stays — `@vitest/browser-playwright` depends on it.

**`@vitest/browser/context` is now a stub that always throws.** Its own source says so:

```js
// Vitest resolves "vitest/browser" as a virtual module instead
export const userEvent = null
throw new Error('vitest/browser can be imported only inside the Browser Mode. …')
```

The three files importing `userEvent` from it move to `vitest/browser`:
`crlfCaretPosition.test.tsx`, `paletteHoverGuard.test.tsx`, `recentFilesUi.test.tsx`.

**`NodeJS.Platform` becomes a named union** in `src/preload/api.ts`, not `"node"` added to
`tsconfig.web.json`'s `types`. The preload boundary exists to hand the renderer plain data; adding
Node's globals to the renderer's type program so one string can be spelled would be fixing the
wrong end. The union is left open with `(string & {})` because preload assigns `process.platform`
directly and that has values beyond the three this app branches on.

## 3. What must be true for this to be a bump and not a rewrite

**The test counts must be identical.** A major upgrade that silently stops collecting a file, or
stops running a suite, reports green by doing less — and this suite has a documented instance of
exactly that shape (R187: a command nobody could run was hiding two real assertion failures behind
eight timeouts). The number to match is **2000 passed, 5 skipped, 166 files**.

**Nothing may be relaxed to make it pass.** No skipped test, no widened timeout, no `retry` — which
R153 rejected for a reason that still holds, that it *"would have hidden R152's missing wait
completely."* If a test genuinely cannot work under v5, that is a finding to report, not to
configure around.

## 4. The hanging job is a hypothesis, not a justification

R192 capped a Windows job that burned six hours after a fully green run, and R187 owes a line about
`test:large` exiting 1 on an unhandled RPC error with all 2038 tests passing. Both are Vitest
failing to shut down cleanly. Three majors of teardown fixes might well address them.

**That is a hypothesis and this plan does not rest on it.** The round's justification is the two
advisories and being three versions behind; a teardown fix would be a bonus. R187 spent most of a
round on three wrong hypotheses about that RPC error, each disproved by measurement, and the
correct response then was to stop guessing. The same applies here: `test:large` is the one place
the failure is reproducible, so **run it and report the exit code**, rather than inferring from a
green default suite that the class is fixed.

## 5. Acceptance

1. `npm test` reports exactly 2000 passed, 5 skipped, 166 files — matching Vitest 3.
2. `npm run typecheck` and `npm run lint` clean, with no new suppressions.
3. `npx electron-builder --dir` still produces a working package (vitest shares Vite with the
   build; R157 exists because a dependency bump can break the packaging toolchain while the suite
   cannot reach it).
4. No test skipped, no timeout raised, no `retry` added.
5. `npm run test:large` run once and its exit code reported, whatever it is.

## 6. Version

**No bump.** Development dependencies; nothing shipped changes. The `Platform` type is a shipped
source change but a type-level one — `src/preload/index.ts` still assigns `process.platform` and
the emitted JavaScript is byte-identical.

---

## 7. Results

**Landed as planned.** Four files changed plus the lockfile; no test skipped, no timeout widened,
no `retry`, no new suppression.

### Acceptance

| | | |
|---|---|---|
| 1 | counts match Vitest 3 | **2000 passed, 5 skipped, 166 files** — identical |
| 2 | typecheck and lint clean | 0 errors; the 3 pre-existing `react-hooks` warnings on `Tree.tsx` unchanged |
| 3 | packaging still works | `--dir` builds, asar 31 MB and four top-level entries as R190 left it, app launches with nothing on stderr |
| 4 | nothing relaxed | nothing skipped, no timeout raised, no `retry` |
| 5 | `test:large` run, exit code reported | **exit 0** |

Suite duration **60.8 s → 48.6 s** for the default run. `test:large` 397 s against R187's 350 s,
on 2042 tests rather than 2038 — the four extra are R191's.

### The measurement that mattered

**`npm run test:large` exits 0.** Under Vitest 3 it exited 1 on one unhandled
`[vitest-worker]: Timeout calling "onTaskUpdate"` with every test passing, which is R187's owed
item and the one reproducible instance of this project's teardown problem. Under 5.0.0 the error is
gone. The Owed table entry is removed and R187 § 14 records the closure beside the claim it
corrects.

**What this does not establish.** R187's fourth hypothesis — worker reuse after the invariants file
leaves hundreds of megabytes of garbage — was never tested, and still has not been. Three majors of
Vitest changed the outcome; *which* change, and whether the mechanism was the one suspected, is
unknown. The entry is closed on the measurement, not on an explanation.

**And it does not establish that R192's six-hour hang is fixed.** That one appeared once, on
`windows-latest`, on a run that passed the same commit at every other opportunity. A single green
`test:large` on one machine is evidence about a related symptom, not proof about an intermittent
one. What can be said is that the two known instances of "Vitest goes green and then does not shut
down cleanly" have the same shape, one of them is now measurably gone, and R192's cap bounds the
other at 25 minutes if it recurs.

### Review

Found one omission: `vitest.config.ts` gained the provider import with no comment, in a file whose
every other non-obvious value carries one. The error a future reader will hit —
*"Browser Mode was enabled, but provider was not specified anywhere"* — does not mention that
providers moved into their own packages, which is exactly the kind of gap this project's config
comments exist to close. Added.

Nothing else. The three `userEvent` import changes are mechanical; `paletteHoverGuard.test.tsx`
also had the old path in its prose header, which was updated with it rather than left to go stale.

### Owed

**Nothing.**
