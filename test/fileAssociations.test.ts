/**
 * R219 (`docs/plans/R219-open-with.md` §2) — Klados is offered in each
 * operating system's "Open with" for exactly the extensions its format modules
 * claim. Three declarations, one per platform, so this is what keeps them one
 * list: a format gaining an extension fails here until every installer offers
 * it.
 *
 * `electron-builder.yml` is read by hand, as `packagedFiles.test.ts` does,
 * rather than adding a YAML parser for two lists.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { supportedExtensionsList } from '../src/formats/registry'

const EXTENSIONS = supportedExtensionsList()
  .split(', ')
  .map((ext) => ext.replace(/^\./, ''))
  .sort()

const CONFIG = readFileSync('electron-builder.yml', 'utf8')
const INSTALLER = readFileSync('assets/build/installer.nsh', 'utf8')

/** The lines of a top-level section (`mac:`), up to the next one. */
function section(name: string): string {
  const start = CONFIG.indexOf(`\n${name}:\n`)
  if (start === -1) throw new Error(`no ${name}: section`)
  const rest = CONFIG.slice(start + name.length + 3)
  const end = rest.search(/\n[A-Za-z]/)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('file associations (R219)', () => {
  it('the formats claim the six extensions this was written for', () => {
    expect(EXTENSIONS).toEqual(['csv', 'json', 'tab', 'toml', 'tsv', 'xml'])
  })

  it('macOS: every extension, and only at rank Alternate — never a default', () => {
    const mac = section('mac')
    const block = mac.slice(mac.indexOf('  fileAssociations:'))
    const exts = [...block.matchAll(/^ {4}- ext: (.+)$/gm)].flatMap((m) =>
      m[1]!
        .replace(/[[\]]/g, '')
        .split(',')
        .map((e) => e.trim())
    )
    expect(exts.sort()).toEqual(EXTENSIONS)
    const entries = exts.length === 0 ? 0 : block.match(/^ {4}- ext:/gm)!.length
    expect(block.match(/^ {6}rank: Alternate$/gm)).toHaveLength(entries)
    expect(block).not.toMatch(/rank: (Default|Owner)/)
  })

  it('no top-level fileAssociations, which would also drive the Windows installer', () => {
    expect(CONFIG).not.toMatch(/^fileAssociations:/m)
  })

  it('Linux: a MimeType= line only, never a MIME definition that redefines the type', () => {
    const linux = section('linux')
    const types = [...linux.slice(linux.indexOf('  mimeTypes:')).matchAll(/^ {4}- (.+)$/gm)].map(
      (m) => m[1]
    )
    expect(types).toEqual([
      'application/xml',
      'text/xml',
      'application/json',
      'application/toml',
      'text/csv',
      'text/tab-separated-values'
    ])
    expect(CONFIG).not.toMatch(/^\s+mimeType:/m)
  })

  it('Windows: every extension registered for Open with, and removed on uninstall', () => {
    const body = (macro: string): string => {
      const start = INSTALLER.indexOf(`!macro ${macro}\n`)
      return INSTALLER.slice(start, INSTALLER.indexOf('!macroend', start))
    }
    const registered = [...body('customInstall').matchAll(/kladosOpenWith "(\w+)"/g)].map(
      (m) => m[1]
    )
    const removed = [...body('customUnInstall').matchAll(/kladosNoOpenWith "(\w+)"/g)].map(
      (m) => m[1]
    )
    expect(registered.sort()).toEqual(EXTENSIONS)
    expect(removed.sort()).toEqual(EXTENSIONS)
  })

  it('Windows: never writes an extension default or a UserChoice', () => {
    const code = INSTALLER.split('\n')
      .filter((line) => !line.trimStart().startsWith(';'))
      .join('\n')
    // The extension's own default value: a write to `Software\Classes\.<ext>`
    // with an empty value name.
    expect(code).not.toMatch(/WriteRegStr SHELL_CONTEXT "Software\\Classes\\\.\$\{EXT\}" ""/)
    expect(code).not.toMatch(/UserChoice/)
    expect(code).not.toMatch(/APP_ASSOCIATE/)
  })

  it('Windows: files get the document icon, which the build ships with every frame', () => {
    expect(INSTALLER).toContain(
      'WriteRegStr SHELL_CONTEXT "Software\\Classes\\Klados.${EXT}\\DefaultIcon" "" "$INSTDIR\\resources\\document.ico"'
    )
    const win = section('win')
    expect(win).toMatch(
      /extraResources:\n\s+- from: assets\/build\/document\.ico\n\s+to: document\.ico/
    )

    // An .ico header: reserved 0, type 1, then the frame count and one
    // 16-byte entry per frame, whose first byte is the width (0 means 256).
    const ico = readFileSync('assets/build/document.ico')
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    const widths = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256)
    expect(widths.sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256])
  })
})
