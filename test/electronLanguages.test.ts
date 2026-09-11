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
import { describe, expect, it } from 'vitest'

const CONFIG = 'electron-builder.yml'
const LOCALES_DIR = 'node_modules/electron/dist/locales'

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

const localeFiles = existsSync(LOCALES_DIR)
  ? readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.pak'))
  : []

describe('electronLanguages selects a locale that exists', () => {
  it('finds the Electron locale directory to check against', () => {
    // Not skipped when absent: a silently-skipped test is how this class of
    // check stops meaning anything. `npm ci` puts it there on every platform.
    expect(localeFiles.length, `no .pak files under ${LOCALES_DIR}`).toBeGreaterThan(0)
  })

  it('keeps at least one locale', () => {
    const wanted = configuredLanguages()
    expect(
      wanted.length,
      'electronLanguages is empty — every locale would be kept'
    ).toBeGreaterThan(0)

    const kept = localeFiles.filter((file) =>
      wanted.some((w) => keepsLocale(w, file.replace(/\.pak$/, '')))
    )
    expect(
      kept,
      `electronLanguages ${JSON.stringify(wanted)} matches no file in ${LOCALES_DIR}. ` +
        'electron-builder would delete every locale, the build would succeed, and the app ' +
        'would launch — see the header of this file.'
    ).not.toEqual([])
  })

  it('keeps English', () => {
    const wanted = configuredLanguages()
    const kept = localeFiles.filter((file) =>
      wanted.some((w) => keepsLocale(w, file.replace(/\.pak$/, '')))
    )
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
