/**
 * R173 (`docs/plans/R172-published-identity.md`) — the strings a package
 * manager correlates against, locked.
 *
 * A package manager does not adopt a file, it adopts an *identity*: the
 * uninstall registry key, the `Publisher` and `DisplayName` written beside it,
 * the installer's URL. Change one after a release ships and every existing
 * install is orphaned — no upgrade detection, no uninstall entry that matches.
 * Every one of those values is a string in a config file that reads like a
 * formatting preference and is actually a compatibility contract.
 *
 * `nsis.guid` has carried a comment saying "**Never change it**" for its whole
 * life, and nothing has ever enforced it. This project's rule is that a
 * constraint is enforced by test rather than by discipline (invariant 10), and
 * `test/docsStatus.test.ts` is the precedent: a test whose only job is to stop
 * two files drifting apart.
 *
 * **These assertions go through electron-builder's own `AppInfo`, not through
 * the config values.** Reading `author.name` back out of `package.json` and
 * asserting it equals `author.name` is a test of its own fixture. What ships is
 * one resolution step away from what is written down — R172 exists precisely
 * because that step turned out to route three different questions through one
 * field — so the resolved value is the only thing worth asserting.
 *
 * Every failure message names the consequence, not just the mismatch. Someone
 * who breaks one of these is doing something reasonable-looking, and needs to
 * be told what it costs rather than which string differs.
 */
import { readFileSync } from 'node:fs'
import { AppInfo } from 'electron-builder'
import { describe, expect, it } from 'vitest'

const PKG = 'package.json'
const BUILDER = 'electron-builder.yml'
const LICENSE = 'LICENSE'

/**
 * The handful of scalars this test needs out of `electron-builder.yml`.
 *
 * Deliberately not a YAML parser and deliberately not a dependency. The file's
 * value is its comments, so it will stay YAML, but every value read here is a
 * plain one-line scalar at depth 0 or 1 — and adding a parser to the manifest
 * to read seven of them would be a new dependency bought for a test.
 *
 * Depth is capped at one level on purpose: a key that moves deeper is a
 * restructure, and `scalar()` throwing "not found" is the correct response to
 * one rather than a silent pass. Comment lines, list items and keys with no
 * value never match.
 */
function scalars(): Map<string, string> {
  const out = new Map<string, string>()
  let section = ''
  for (const line of readFileSync(BUILDER, 'utf8').split('\n')) {
    const m = /^( *)([A-Za-z][A-Za-z0-9_]*): (.+)$/.exec(line)
    if (m === null) {
      // A top-level key with no inline value opens a section (`nsis:`, `linux:`).
      const open = /^([A-Za-z][A-Za-z0-9_]*):\s*$/.exec(line)
      if (open !== null) section = open[1] as string
      continue
    }
    const [, indent, key, value] = m as unknown as [string, string, string, string]
    if (indent.length === 0) {
      section = ''
      out.set(key, value.trim())
    } else if (indent.length === 2) {
      out.set(`${section}.${key}`, value.trim())
    }
  }
  return out
}

const config = scalars()

function scalar(key: string): string {
  const value = config.get(key)
  if (value === undefined) {
    throw new Error(
      `${BUILDER} has no \`${key}\`. R172 pinned it because it is part of the published ` +
        `identity; if it moved, this test has to move with it rather than stop looking.`
    )
  }
  return value
}

const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as Record<string, unknown>

/**
 * `AppInfo` reads only `metadata`, `devMetadata` and `config` off the packager,
 * so the real `package.json` and the real config resolve against a stub of it.
 * `electron-builder` re-exports the class from its public entry point — this
 * reaches into no internals and adds nothing to the dependency tree.
 *
 * Only the file's top-level keys are handed over, which is exactly the shape
 * `AppInfo` reads: a dotted key here is a `nsis`/`linux`/`win` value that
 * belongs to a target rather than to the config root. Passing them through
 * unflattened would be inert, but it would also read like a real config and
 * invite someone to assert against one.
 */
function appInfo(): AppInfo {
  const root = [...config].filter(([key]) => !key.includes('.'))
  const info = {
    metadata: pkg,
    devMetadata: {},
    config: Object.fromEntries(root)
  } as unknown as ConstructorParameters<typeof AppInfo>[0]
  return new AppInfo(info, null)
}

describe('the published identity is frozen (R172, R173)', () => {
  it('the uninstall registry key is the pinned GUID', () => {
    expect(
      scalar('nsis.guid'),
      'The Add/Remove Programs key is named after `nsis.guid`, and package managers and updaters ' +
        'key installed state off that name. Changing it orphans every existing install: no upgrade ' +
        'detection, no uninstall entry that matches. It is pinned rather than derived so that ' +
        'changing `appId` cannot move it either.'
    ).toBe('318f6304-c1a1-5b48-8b0d-d9b77e332a6b')
  })

  it('the installer URL is stable across versions', () => {
    expect(
      scalar('nsis.artifactName'),
      'Once a release ships, the download URL is the handle anything downstream refers to — a ' +
        'winget manifest, a script, a link in an issue. Only `${version}` may vary between ' +
        'releases; anything else in this pattern breaks every URL already published.'
    ).toBe('${name}-${version}-setup.${ext}')
  })

  it('the Add/Remove Programs Publisher is the project', () => {
    expect(
      appInfo().companyName,
      'ARP `Publisher` resolves from `package.json` `author.name` through `AppInfo.companyName`, ' +
        'which has no override of any kind. R172 set it to the project because that is what a user ' +
        'reading Add/Remove Programs installed, and because it is what a winget identifier would ' +
        'be namespaced to. Changing it back to a person changes what every future installer writes.'
    ).toBe('Klados')
  })

  it('the Add/Remove Programs DisplayName is the product', () => {
    expect(
      appInfo().productName,
      '`nsis.uninstallDisplayName` is `${productName}`, so this is the name in Add/Remove Programs ' +
        'and the name a package manager displays. It is half of what a user uses to recognise an ' +
        'install as the one they already have.'
    ).toBe('Klados')
  })

  it('the Debian Maintainer is a person, and does not follow the Publisher', () => {
    expect(
      scalar('linux.maintainer'),
      "Debian's `Maintainer` means the person responsible for the package, which is a different " +
        'question from who publishes the software. `FpmTarget.js:85` derives it from `author.name` ' +
        '+ `author.email` when it is absent — and `author.name` is the project now, so dropping ' +
        'this line produces `Klados <…>`: a project name in a field whose grammar wants a person.'
    ).toBe('mincowski <8300485+mincowski@users.noreply.github.com>')
  })

  it('the copyright names the contributors, and matches LICENSE', () => {
    const resolved = appInfo().copyright

    expect(
      resolved,
      'This lands in `LegalCopyright` on both `Klados.exe` and the installer, and in macOS ' +
        '`NSHumanReadableCopyright`. Unset, it derives `Copyright © <build year> <companyName>` — ' +
        'naming `Klados`, an entity that does not exist, in every shipped binary. It is pinned to ' +
        'the holder `LICENSE` already names.'
    ).toBe('Copyright © 2026 Klados contributors')

    // The one difference the two are allowed to have: a licence file
    // conventionally keeps the ASCII `(c)`, a version resource uses `©`.
    const licenceLine = readFileSync(LICENSE, 'utf8').split('\n')[2] ?? ''
    const normalise = (s: string): string => s.replace('(c)', '©').trim()

    expect(
      normalise(licenceLine),
      'The shipped binary and the file that actually grants the licence must not disagree about ' +
        `who holds the rights. ${LICENSE} line 3 and \`copyright\` in ${BUILDER} name the same ` +
        'holder and the same year, differing only in the copyright symbol; changing the holder in ' +
        'one place alone is what this catches.'
    ).toBe(normalise(resolved))
  })

  it('the install is per-user and one-click', () => {
    // Asserted the way `CommonWindowsInstallerConfiguration.js:26-27` reads
    // them — `perMachine === true` and `oneClick === false` — rather than as
    // the absence of two keys, so writing the current behaviour down
    // explicitly stays green and only a real change fails.
    expect(
      config.get('nsis.perMachine') === 'true',
      'Per-user today: `%LOCALAPPDATA%\\Programs` and `HKCU`. Setting `perMachine` relocates the ' +
        'uninstall key to `HKLM`, which is exactly the orphaning `nsis.guid` is pinned to prevent, ' +
        "and forces winget's `Scope` to change on an identity that has already been published. A " +
        'file viewer needs no administrative rights, and per-user is what lets `winget install` ' +
        'run without elevation.'
    ).toBe(false)

    expect(
      config.get('nsis.oneClick') === 'false',
      '`oneClick: false` produces an assisted installer and moves the install directory from ' +
        '`%LOCALAPPDATA%\\Programs` to `Program Files`. After a release that is the same class of ' +
        'break as changing the scope, and a viewer opened from a file association has nothing to ' +
        'ask the user during installation.'
    ).toBe(false)
  })

  it('the macOS bundle identifier and the Windows executable name are unchanged', () => {
    expect(
      scalar('appId'),
      '`appId` is the macOS `CFBundleIdentifier` — the identity macOS itself uses for defaults, ' +
        'file associations and TCC permission grants. Changing it makes an updated app a stranger ' +
        'to the system. On Windows the GUID pin has already made the uninstall key independent of ' +
        'it, so there is nothing to gain here and a real thing to lose.'
    ).toBe('com.klados.app')

    expect(
      scalar('win.executableName'),
      'The executable name is what a Start-menu shortcut, a file association and any script that ' +
        'launches Klados point at. It is also the `InternalName` in the version resource.'
    ).toBe('Klados')
  })
})
