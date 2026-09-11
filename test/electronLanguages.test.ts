/**
 * R195 — the configured `electronLanguages` value actually matches a locale
 * that exists.
 *
 * **This guards a footgun with no feedback of its own.** electron-builder keeps
 * a locale file when the *wanted* string starts with the *file's* name, not the
 * other way round (`ElectronFramework.js`, `removeUnusedLanguagesIfNeeded`).
 * Windows Electron ships `en-GB.pak` and `en-US.pak` and **no `en.pak`**, so
 * the obvious-looking `electronLanguages: [en]` matches nothing and deletes all
 * 55 files including English.
 *
 * Every signal you would hope for is absent, all three verified by building it:
 *
 * - The build **succeeds**.
 * - The "no locales found matching wanted languages" warning does **not** fire —
 *   it is emitted only when *nothing* was deleted, and deleting everything is
 *   the silent path.
 * - The resulting application **launches cleanly**, nothing on stderr.
 *
 * The failure would appear much later as a missing string in a Chromium-drawn
 * menu, with nothing pointing back at a line in `electron-builder.yml`. So the
 * check belongs somewhere that fails, not in a comment that warns.
 *
 * Run against the **real** filenames in `node_modules/electron/dist/locales/`
 * rather than a hardcoded list: the set is Electron's to change, and a list
 * copied here would drift exactly the way the packaging blocklist R190 removed
 * did.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CONFIG = 'electron-builder.yml'
const ELECTRON_DIST = 'node_modules/electron/dist'

/** The `electronLanguages:` block — a flat list of scalars, read without a YAML parser (R173). */
function configuredLanguages(): string[] {
  const lines = readFileSync(CONFIG, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((line) => line === 'electronLanguages:')
  expect(start, `${CONFIG} has no top-level "electronLanguages:" key`).toBeGreaterThanOrEqual(0)

  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith('#') || line.trim() === '') continue
    const item = /^ {2}- (.+?)\s*$/.exec(line)
    if (item === null) break
    out.push((item[1] ?? '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'))
  }
  return out
}

/**
 * electron-builder's own rule, reproduced from
 * `app-builder-lib/out/electron/ElectronFramework.js`.
 *
 * The argument order is the whole point and is deliberately spelled out rather
 * than simplified: `wanted` is what the config asks for, `file` is the locale
 * on disk, and the `startsWith` runs on `wanted`.
 */
function keepsLocale(wanted: string, fileLanguage: string): boolean {
  const w = wanted.trim().toLowerCase()
  const f = fileLanguage.toLowerCase()
  return w === f || w.startsWith(`${f}-`) || w.startsWith(`${f}_`)
}

/**
 * Every locale name Electron ships, found by searching rather than by naming a
 * path — **because naming one was this test's own first defect.**
 *
 * It hardcoded `dist/locales/*.pak`, which is the Windows and Linux layout, and
 * went red on macOS where Electron keeps locales as `.lproj` directories inside
 * the framework bundle. Verified on Windows, asserted about every platform:
 * `docs/FINDINGS.md` lists that as this project's most repeated mistake, and
 * this is another instance of it.
 *
 * electron-builder itself branches on the platform for exactly this
 * (`ElectronFramework.js` — `.pak` under `locales`, or `.lproj` beside the
 * framework Resources). A search finds both without this file having to know
 * the macOS bundle path, which cannot be checked from a Windows machine — and
 * would be one rename away from silently finding nothing again.
 */
function findLocaleNames(dir: string, depth = 0): string[] {
  if (depth > 8 || !existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // macOS: `en.lproj`, `de.lproj`, … beside the framework's Resources.
      if (entry.name.endsWith('.lproj')) found.push(entry.name.slice(0, -'.lproj'.length))
      else found.push(...findLocaleNames(join(dir, entry.name), depth + 1))
    } else if (entry.name.endsWith('.pak') && basename(dir) === 'locales') {
      // Windows and Linux: `en-US.pak`, `de.pak`, … **inside `locales/`**, which
      // is the only directory electron-builder touches.
      //
      // The parent check is not tidiness. `dist/` also holds `resources.pak`,
      // `chrome_100_percent.pak` and `chrome_200_percent.pak`, and counting
      // those would let "found some locales" pass on a tree where `locales/`
      // had disappeared entirely — a green assertion standing on files that
      // are not locales at all.
      found.push(entry.name.slice(0, -'.pak'.length))
    }
  }
  return found
}

const localeFiles = findLocaleNames(ELECTRON_DIST)

describe('electronLanguages selects a locale that exists', () => {
  it('finds the locales Electron ships, on whatever platform this is', () => {
    // Not skipped when absent: a silently-skipped test is how this class of
    // check stops meaning anything — and this assertion earned its keep
    // immediately, failing loudly on macOS when the path was hardcoded rather
    // than passing on an empty set.
    expect(
      localeFiles.length,
      `no .pak files or .lproj directories under ${ELECTRON_DIST}`
    ).toBeGreaterThan(0)

    // English under either naming: `en-US.pak` on Windows and Linux, `en` from
    // `en.lproj` on macOS. Asserted so a search that silently found some
    // unrelated directory cannot stand in for the real thing.
    expect(localeFiles.some((name) => name.toLowerCase().startsWith('en'))).toBe(true)
  })

  it('keeps at least one locale', () => {
    const wanted = configuredLanguages()
    expect(
      wanted.length,
      'electronLanguages is empty — every locale would be kept'
    ).toBeGreaterThan(0)

    const kept = localeFiles.filter((file) => wanted.some((w) => keepsLocale(w, file)))
    expect(
      kept,
      `electronLanguages ${JSON.stringify(wanted)} matches no locale under ${ELECTRON_DIST}. ` +
        'electron-builder would delete every locale, the build would succeed, and the app ' +
        'would launch — see the header of this file.'
    ).not.toEqual([])
  })

  it('keeps English', () => {
    const wanted = configuredLanguages()
    const kept = localeFiles.filter((file) => wanted.some((w) => keepsLocale(w, file)))
    expect(kept.some((file) => file.toLowerCase().startsWith('en'))).toBe(true)
  })

  it('demonstrates the rule that makes "en" wrong', () => {
    // The asymmetry, asserted rather than described, so a future reader can see
    // it is real without building anything. `en-US` keeps `en-US.pak`; `en`
    // does not, because the match runs `wanted.startsWith(file + '-')`.
    expect(keepsLocale('en-US', 'en-US')).toBe(true)
    expect(keepsLocale('en', 'en-US')).toBe(false)
    // And why `en-US` is still right on macOS, whose framework ships `en.lproj`.
    expect(keepsLocale('en-US', 'en')).toBe(true)
  })
})
