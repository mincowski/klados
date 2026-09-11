# R193 — Vitest 3 to 5

<!-- status: open -->

**Open.** Dependabot PR #22 has been open since 2026-09-09, red on all three platforms. It closes
two medium advisories (CVE-2026-84373, `vitest` and `@vitest/mocker`, both development-scope) and
is two majors, not a bump: **3.2.7 → 5.0.0**.

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
