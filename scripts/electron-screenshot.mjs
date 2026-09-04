// M5e-PLAN.md R10b — launches the actual built app via Playwright's
// `_electron`, so the resulting PNG is a coding agent's substitute for a
// display: something it can read back, not just something a human running
// the app could have seen. Not a pixel-diff assertion (§4's own rule);
// this is a capture step, not a test.
import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const outDir = path.join(root, 'docs', 'screenshots')

// Plain .mjs, run directly by Node with no build step — a TS return-type annotation on the
// function below would be a syntax error, so the rule can't be satisfied here.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function main() {
  await mkdir(outDir, { recursive: true })

  const app = await electron.launch({
    args: [path.join(root, 'out', 'main', 'index.js')]
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  // Let the title bar, theme tokens and fonts settle before capturing.
  await window.waitForTimeout(500)

  const target = path.join(outDir, 'title-bar.png')
  await window.screenshot({ path: target })

  await app.close()
  console.log(`Wrote ${target}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
