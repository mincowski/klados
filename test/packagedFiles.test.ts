/**
 * R191 — the packaging allowlist stays an allowlist.
 *
 * `electron-builder.yml`'s `files:` list used to hold only negative patterns.
 * electron-builder's default is `**` + `/*`, and exclusions *narrow* that
 * default rather than replacing it, so the rule in force was "ship the whole
 * working tree except these six patterns". The result was a 1202 MB asar whose
 * application part — `out/` — is eight files and 2.0 MB, carrying `docs/`,
 * `test/`, `CLAUDE.md`, `.claude/`, `scripts/`, `tools/` and the tsconfigs
 * along with it.
 *
 * The reason a test exists rather than a comment is that the old list was
 * *demonstrably* unmaintainable, not just theoretically so: it excluded three
 * tsconfigs and the repository has five, because two were added later and
 * nothing prompted anyone back to the packaging config. It excluded
 * `README.md` and not `CLAUDE.md`, which did not exist when the line was
 * written. Every file added to the repository shipped by default and kept
 * shipping until somebody remembered. That is what this makes impossible to do
 * quietly — widening the allowlist is now a deliberate edit in two places.
 *
 * **What this proves and what it does not.** It proves the *configuration*
 * selects only the application. It does not run electron-builder, so it does
 * not prove the *pack*; that was verified once by measurement (the plan's § 4:
 * four top-level asar entries, 31 MB, app launches) and is re-verified by
 * anyone who builds. `ci.yml` excludes packaging on purpose (R141) and a full
 * pack per pull request would cost minutes for a check this makes in
 * milliseconds.
 *
 * `node_modules` is deliberately absent from `files:` and is still packed —
 * electron-builder collects production dependencies outside this matcher — so
 * its absence here is correct rather than an omission.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CONFIG = 'electron-builder.yml'

/**
 * The complete intended contents of the packaged application, minus
 * `node_modules`, which electron-builder collects on its own.
 *
 * `out/` is the built application, including the `?asset` outputs
 * electron-vite emits into `out/main/chunks/` — which is why `assets/` is not
 * here. `package.json` is required, Electron reading `main` from it. `LICENSE`
 * is a condition of distributing the software.
 */
const ALLOWED = ['out/**', 'package.json', 'LICENSE'] as const

/** The whole pattern vocabulary this test can evaluate: a name, or `name/**`. */
const SUPPORTED = /^[A-Za-z0-9._-]+(\/\*\*)?$/

/**
 * Read the `files:` block. Hand-rolled rather than adding a YAML parser: the
 * block is a flat list of scalars, and `CLAUDE.md` § Conventions asks before
 * new dependencies. Same approach as `test/publishedIdentity.test.ts` (R173).
 */
function filesPatterns(): string[] {
  const lines = readFileSync(CONFIG, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => l === 'files:')
  expect(start, `${CONFIG} has no top-level "files:" key`).toBeGreaterThanOrEqual(0)

  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith('#') || line.trim() === '') continue
    const item = /^ {2}- (.+?)\s*$/.exec(line)
    // Any non-item, non-comment line at column 0 ends the block.
    if (item === null) break
    // Strip the quoting electron-builder's own examples use.
    out.push((item[1] ?? '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'))
  }
  return out
}

/**
 * Whether `pattern` selects `path`.
 *
 * The vocabulary is deliberately tiny — an exact name, or a directory followed
 * by `/**` — and **anything outside it throws rather than returning `false`**.
 *
 * That is not defensiveness. The first version returned `false` for an
 * unrecognized pattern, and the mutation run caught it: with `**` + `/*` added
 * to `files:`, the "ships nothing else" assertion below went *green*, because
 * the matcher did not recognize the pattern and so found nothing selected. A
 * matcher that silently mis-evaluates reports a pass for a configuration it has
 * not understood, which is worse than having no test at all.
 */
function selects(pattern: string, path: string): boolean {
  if (!SUPPORTED.test(pattern)) {
    throw new Error(
      `${CONFIG} has a files: pattern this test cannot evaluate: ${JSON.stringify(pattern)}. ` +
        'Extend the matcher deliberately rather than letting it report a pass it has not earned.'
    )
  }
  if (pattern.endsWith('/**')) {
    return path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
  }
  return path === pattern
}

describe('the packaged application is an allowlist, not the repository', () => {
  it('every pattern is positive and within the tiny supported vocabulary', () => {
    const offenders = filesPatterns().filter((p) => !SUPPORTED.test(p) || p.startsWith('!'))
    expect(
      offenders,
      'a negative pattern narrows electron-builder\'s "**/*" default instead of ' +
        'replacing it, which is the defect R190 removed; a brace expansion or a ' +
        'bare glob is outside what this test can evaluate honestly'
    ).toEqual([])
  })

  it('selects exactly the application', () => {
    expect(filesPatterns()).toEqual([...ALLOWED])
  })

  it('ships nothing else the repository contains', () => {
    // Read the real repository rather than a hardcoded list, so a directory
    // added after this test was written is checked too.
    // `out` is the application and `node_modules` is collected by
    // electron-builder rather than by these patterns; `dist` and `.git` are not
    // repository content. Everything else at the top level must not be selected
    // — `spike/` included, which is where the 1166 MB came from.
    const skip = new Set(['node_modules', 'out', 'dist', '.git'])
    const top = readdirSync('.').filter((name) => !skip.has(name))

    const patterns = filesPatterns()
    const shipped = top.filter((name) => patterns.some((p) => selects(p, name)))

    expect(shipped.sort(), 'repository entries selected for packaging').toEqual([
      'LICENSE',
      'package.json'
    ])
  })

  it('still ships the application itself', () => {
    const patterns = filesPatterns()
    // `package.json` is not optional — Electron reads `main` from it — and
    // `out/` is what `main` points at.
    expect(patterns.some((p) => selects(p, 'out/main/index.js'))).toBe(true)
    expect(patterns.some((p) => selects(p, 'package.json'))).toBe(true)
  })
})
