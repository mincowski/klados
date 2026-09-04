import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// M5e-PLAN.md R10: two projects, not one changed config. The node project
// is the existing 841-test suite, untouched glob and untouched speed. The
// browser project is new — real Chromium via Playwright, for component
// tests that need real layout (scrollHeight, computed styles, rAF), which
// jsdom/happy-dom cannot give CodeMirror or the virtualized grid/tree.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          passWithNoTests: true
        }
      },
      {
        plugins: [react()],
        test: {
          name: 'browser',
          include: ['test/**/*.test.tsx'],
          passWithNoTests: true,
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
