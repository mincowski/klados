/**
 * R225 (`docs/plans/R225-winget-package.md` §3) — the installer never kills a
 * running Klados. `assets/build/installer.nsh` replaces electron-builder's
 * running-app check, which ends the process with `Stop-Process` after a prompt
 * that answers itself under `/S`, so `winget upgrade` lost unsaved edits.
 *
 * **The replacement only works while electron-builder still asks for it.** It
 * is a macro electron-builder looks up by name; if an update renamed or
 * dropped that hook, the build would go on succeeding with the stock check
 * back in force and nothing would say so. So this reads electron-builder's
 * own template, not only Klados's file.
 *
 * The behaviour itself, a silent install refusing and the Retry prompt, is
 * verified against the built installer (the plan's §8), which no test here
 * can run.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const INSTALLER = readFileSync('assets/build/installer.nsh', 'utf8')
const TEMPLATE = readFileSync(
  'node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh',
  'utf8'
)

/** The body of `!macro <name>` … `!macroend`. */
function macro(source: string, name: string): string {
  const match = new RegExp(`^!macro ${name}\\b[^\\n]*\\n([\\s\\S]*?)^!macroend`, 'm').exec(source)
  if (match === null) throw new Error(`no !macro ${name}`)
  return match[1]!
}

describe('the installer never kills a running Klados (R225)', () => {
  it("electron-builder's CHECK_APP_RUNNING still inserts customCheckAppRunning instead of its own check", () => {
    const check = macro(TEMPLATE, 'CHECK_APP_RUNNING')
    expect(check).toMatch(
      /!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning\s+!else\s+[\s\S]*!insertmacro _CHECK_APP_RUNNING/
    )
  })

  it('the stock helpers the replacement reuses still exist', () => {
    expect(() => macro(TEMPLATE, 'IS_POWERSHELL_AVAILABLE')).not.toThrow()
    expect(macro(TEMPLATE, 'FIND_PROCESS')).toContain('$INSTDIR')
  })

  it('Klados defines the replacement, and it neither kills nor stops a process', () => {
    const custom = macro(INSTALLER, 'customCheckAppRunning')
    expect(custom).toContain('!insertmacro FIND_PROCESS')
    expect(custom).not.toMatch(/KILL_PROCESS|Stop-Process|taskkill/i)
  })

  it('silent and cancelled runs exit with the code the winget manifest maps to packageInUse', () => {
    expect(INSTALLER).toMatch(/^!define KLADOS_RUNNING_EXIT_CODE 3$/m)
    const custom = macro(INSTALLER, 'customCheckAppRunning')
    expect(custom.match(/SetErrorLevel \$\{KLADOS_RUNNING_EXIT_CODE\}/g)).toHaveLength(2)
  })
})
