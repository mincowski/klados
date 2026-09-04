/**
 * R101 (`R100-raw-external-rewrite.md` §4): a static enumeration guard, not
 * a per-path test — R100's own regression tests (`test/rawExternalRewrite.
 * test.tsx`) cover the five call sites known *today*. This test exists so a
 * sixth method added later that replaces `document.sourceBuffer` fails here
 * if it forgets to mark `externalRewrites`, instead of silently shipping
 * stale-until-you-scroll Raw View behaviour the way R100's five did.
 *
 * Enumeration works by scanning every top-level function declared inside
 * `createDocumentSession` for the two shapes that actually replace
 * `OpenDocument.sourceBuffer`: `new SourceBuffer(...)` and `sourceBuffer:
 * result.sourceBuffer` (the reparse-result shape `startParse`/
 * `reloadFromDisk` share). Any such function must also reference
 * `externalRewrites` in its own body — either incrementing it (an external
 * rewrite) or setting it to `0` (the initial open, a fresh baseline, not an
 * increment but still an explicit mark) — unless it is `applyEdit`, the one
 * documented exception (`OpenDocument.externalRewrites`'s own doc comment):
 * the Raw editor's own path, where the view already has the text.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE_PATH = 'src/renderer/session/documentSession.ts'

const DOCUMENTED_EXCEPTIONS = new Set(['applyEdit'])

/** Finds every `function name(` / `async function name(` declared at any
 * depth in `src`, and returns each one's full body (from its opening brace
 * to the matching closing brace, via simple depth counting — no template
 * literals or regex-with-braces appear in this file's function bodies, so a
 * naive scan is exact here, not just a heuristic). */
function extractFunctionBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>()
  const declPattern = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{/g
  let match: RegExpExecArray | null
  while ((match = declPattern.exec(src)) !== null) {
    const name = match[1]!
    const bodyStart = match.index + match[0].length
    let depth = 1
    let i = bodyStart
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    bodies.set(name, src.slice(bodyStart, i - 1))
  }
  return bodies
}

describe('R101 — every sourceBuffer-rewriting method marks externalRewrites', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8')
  const bodies = extractFunctionBodies(src)

  it('found a non-trivial number of functions to check (the scan itself works)', () => {
    // A canary against the regex silently matching nothing (a refactor that
    // changes function declaration style, say) and this test passing only
    // because its loop below never ran.
    expect(bodies.size).toBeGreaterThan(10)
    expect(bodies.has('applyEdit')).toBe(true)
    expect(bodies.has('applyReplaceAll')).toBe(true)
  })

  for (const [name, body] of bodies) {
    const replacesSourceBuffer =
      body.includes('new SourceBuffer(') || body.includes('sourceBuffer: result.sourceBuffer')
    if (!replacesSourceBuffer) continue

    it(`${name} either marks externalRewrites or is the documented applyEdit exception`, () => {
      const marksRewrite = body.includes('externalRewrites')
      expect(marksRewrite || DOCUMENTED_EXCEPTIONS.has(name)).toBe(true)
    })
  }
})
