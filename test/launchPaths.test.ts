/**
 * R219 (`docs/plans/R219-open-with.md` §3) — which command-line arguments are
 * files to open. The one place a path reaches Klados from outside the Open
 * dialog and drag-and-drop, so every rule is pinned.
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'path'
import { launchPathsFrom } from '../src/core/launchPaths'

const cwd = resolve('/work')
const file = (name: string): string => resolve(cwd, name)
const files = new Set([file('a.xml'), file('b.json'), resolve('/elsewhere/c.csv'), file('app.js')])
const isFile = (path: string): boolean => files.has(path)

function packaged(...args: string[]): string[] {
  return launchPathsFrom(['Klados.exe', ...args], {
    defaultApp: false,
    workingDirectory: cwd,
    isFile
  })
}

describe('launchPathsFrom (R219)', () => {
  it('takes an absolute path, as "Open with" passes it', () => {
    expect(packaged(file('a.xml'))).toEqual([file('a.xml')])
  })

  it('skips the executable itself', () => {
    expect(
      launchPathsFrom([file('a.xml')], { defaultApp: false, workingDirectory: cwd, isFile })
    ).toEqual([])
  })

  it('under `electron .`, skips the app path too — else a dev launch opens its entry script', () => {
    expect(
      launchPathsFrom(['electron.exe', file('app.js'), file('b.json')], {
        defaultApp: true,
        workingDirectory: cwd,
        isFile
      })
    ).toEqual([file('b.json')])
  })

  it("under `electron .`, finds the app path where a second instance's argv has it: after the switches", () => {
    // Measured: `second-instance` delivers the second process's command line
    // with Chromium's switches moved to the front.
    expect(
      launchPathsFrom(
        [
          'electron.exe',
          '--user-data-dir=/tmp/p',
          '--allow-file-access-from-files',
          file('app.js'),
          file('b.json')
        ],
        { defaultApp: true, workingDirectory: cwd, isFile }
      )
    ).toEqual([file('b.json')])
  })

  it('skips every switch, including ones naming an existing file', () => {
    files.add(file('--inspect'))
    try {
      expect(
        packaged('--user-data-dir=/tmp/x', '--inspect', '-flag', '--allow-file-access-from-files')
      ).toEqual([])
    } finally {
      files.delete(file('--inspect'))
    }
  })

  it('resolves a relative path against the launching process, not this one', () => {
    expect(packaged('a.xml')).toEqual([file('a.xml')])
    expect(
      launchPathsFrom(['Klados.exe', 'c.csv'], {
        defaultApp: false,
        workingDirectory: resolve('/elsewhere'),
        isFile
      })
    ).toEqual([resolve('/elsewhere/c.csv')])
  })

  it('drops what is not an existing regular file, and empty arguments', () => {
    expect(packaged(file('missing.xml'), cwd, '')).toEqual([])
  })

  it('keeps order and drops repeats', () => {
    expect(packaged(file('b.json'), file('a.xml'), 'b.json')).toEqual([
      file('b.json'),
      file('a.xml')
    ])
  })
})
