/**
 * Guards the one fragile property of `src/renderer/devPerformanceTracks.ts`:
 * it only works if it runs *before* `react-dom/client` is evaluated, which in
 * an ES module graph means being the first import in the entry module. A tidy-
 * up that sorts `main.tsx`'s imports alphabetically, or moves this one down
 * next to the other side-effect imports (`./theme`, `./commands/builtins`),
 * silently reintroduces a renderer that hangs and grows past 12 GB on the
 * first Format, edit, undo or reload of any document — with nothing failing
 * until someone runs the app by hand.
 *
 * A source-text assertion rather than a behavioural one on purpose: the thing
 * that breaks is module *evaluation order*, which a test importing the modules
 * itself cannot observe (Vitest has already loaded React by then).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN = new URL('../src/renderer/main.tsx', import.meta.url)

describe('devPerformanceTracks', () => {
  it('is the first import in main.tsx, before react-dom', () => {
    const source = readFileSync(MAIN, 'utf-8')
    const imports = [...source.matchAll(/^import\s.*?from\s+'(.+?)'|^import\s+'(.+?)'/gm)].map(
      (m) => m[1] ?? m[2]
    )

    expect(imports.length).toBeGreaterThan(1)
    expect(imports[0]).toBe('./devPerformanceTracks')

    // The specific ordering that matters, stated directly so a failure says
    // what is actually wrong rather than just "index 0 changed".
    const reactDom = imports.indexOf('react-dom/client')
    expect(reactDom).toBeGreaterThan(0)
    expect(imports.indexOf('./devPerformanceTracks')).toBeLessThan(reactDom)
  })

  it('disables the gate React reads, rather than stubbing it with a function', () => {
    // `supportsUserTiming` tests `typeof console.timeStamp === 'function'`, so
    // a no-op stub would leave the prop-diff walk enabled. Deletion is the
    // whole mechanism; assert the module does that and not something weaker.
    const source = readFileSync(
      new URL('../src/renderer/devPerformanceTracks.ts', import.meta.url),
      'utf-8'
    )
    expect(source).toMatch(/Reflect\.deleteProperty\(console, 'timeStamp'\)/)
    expect(source).toMatch(/import\.meta\.env\.DEV/)
  })
})
