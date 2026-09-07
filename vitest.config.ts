import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// M5e-PLAN.md R10: two projects, not one changed config. The node project
// is the existing 841-test suite, untouched glob and untouched speed. The
// browser project is new — real Chromium via Playwright, for component
// tests that need real layout (scrollHeight, computed styles, rAF), which
// jsdom/happy-dom cannot give CodeMirror or the virtualized grid/tree.

// R141: raised from Vitest's 5 s default, which is sized for ordinary unit
// tests and is wrong for this suite.
//
// This project deliberately contains heavy tests — parsers are invariant-
// tested rather than example-tested (M0-PLAN B12), so a single case may format
// a document nested 9,000 deep, or drive a predicate across 400,000
// candidates. On a development machine those clear 5 s; on a CI runner they do
// not. The first release build ran the suite on Windows and macOS for the
// first time (`ci.yml` only ever ran ubuntu) and three of them failed at once
// at 6.2 s, 6.8 s and 8.4 s.
//
// **This weakens no assertion.** None of those tests measures elapsed time —
// they assert "does not throw", "re-parses to the same tree", "returns the
// same set". Where this project does budget performance it does so explicitly
// (`expect(elapsed).toBeLessThan(...)` in `namespaceResolution.test.ts` and
// `pathPredicateBudget.test.ts`), so the timeout is a hang guard, not a
// performance gate, and raising it cannot hide a regression those tests would
// have caught.
//
// 30 s is ~3.5× the slowest observed run. Two genuinely extreme cases keep
// their own larger per-test overrides.
const TEST_TIMEOUT_MS = 30_000

// `mainElectron.test.ts` launches the real built application in `beforeAll`.
// Cold-starting Electron on a CI runner is well past the 10 s hook default.
//
// R154: that hook now carries its own 120 s override, because a macOS runner
// exceeds even this. The value here stays at 30 s deliberately — it is a hang
// guard for the other 152 files, and the one hook that genuinely needs longer
// should say so at the hook rather than buy it for everything.
const HOOK_TIMEOUT_MS = 30_000

// Set per project rather than once at the root: with `projects`, each entry
// carries its own resolved config, so a root-level value is not something to
// rely on inheriting.
const timeouts = { testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS }

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          passWithNoTests: true,
          ...timeouts
        }
      },
      {
        plugins: [react()],
        test: {
          name: 'browser',
          include: ['test/**/*.test.tsx'],
          passWithNoTests: true,
          ...timeouts,
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }]
          }
        }
      }
    ]
  }
})
