import { _electron as electron } from 'playwright'
const app = await electron.launch({ args: ['out/main/index.js'] })
const proc = app.process()
const chunks = []
proc.stderr?.on('data', (d) => chunks.push('ERR ' + d.toString()))
proc.stdout?.on('data', (d) => chunks.push('OUT ' + d.toString()))
const page = await app.firstWindow()
page.on('console', (m) => chunks.push('CONSOLE ' + m.text()))
page.on('pageerror', (e) => chunks.push('PAGEERROR ' + String(e)))
await page.waitForLoadState('load')
await new Promise((r) => setTimeout(r, 1500))
console.log(chunks.join('\n').slice(0, 4000))
await app.close().catch(() => {})
process.exit(0)
