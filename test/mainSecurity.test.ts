/**
 * R164–R165 (`docs/plans/R164-release-security-hardening.md` §2e, §3) — the
 * predicates behind the navigation guard, the IPC sender check and the
 * `openExternal` allowlist.
 *
 * **This file is the piece the plan requires to go red before the guard
 * exists.** The exploit chain it defends against cannot be reproduced here —
 * native drag-drop is not dispatchable from the harness, and `main` is not
 * loadable by the test suite — so the honest test is of the *decision*, not the
 * chain. §2c of the plan makes the same point about the guard itself: the value
 * is that it denies every unexpected navigation whatever the trigger, so
 * pinning the test to one trigger would test the wrong thing.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { isAllowedExternalUrl, isAppUrl, isPermissionGranted } from '../src/core/mainSecurity'

const DEV_URL = 'http://localhost:5173'
const PROD_URL = 'file:///C:/Program%20Files/Klados/resources/app.asar/out/renderer/index.html'

describe('R164 — isAppUrl, in development', () => {
  it('allows the dev server origin, with or without a trailing path', () => {
    expect(isAppUrl('http://localhost:5173/', DEV_URL)).toBe(true)
    expect(isAppUrl('http://localhost:5173/index.html', DEV_URL)).toBe(true)
    // Vite serves its client and HMR endpoints from the same origin; pinning
    // the whole URL would break the development loop for no gain.
    expect(isAppUrl('http://localhost:5173/@vite/client', DEV_URL)).toBe(true)
  })

  it('denies a different port, host or scheme on the same host', () => {
    expect(isAppUrl('http://localhost:5174/', DEV_URL)).toBe(false)
    expect(isAppUrl('http://evil.example/', DEV_URL)).toBe(false)
    expect(isAppUrl('https://localhost:5173/', DEV_URL)).toBe(false)
  })

  it('denies remote content — the case the whole round exists for', () => {
    expect(isAppUrl('https://example.com/', DEV_URL)).toBe(false)
    expect(isAppUrl('https://attacker.example/drop-me.html', DEV_URL)).toBe(false)
  })
})

describe('R164 — isAppUrl, in production', () => {
  it('allows exactly the file that was loaded, ignoring query and hash', () => {
    expect(isAppUrl(PROD_URL, PROD_URL)).toBe(true)
    expect(isAppUrl(`${PROD_URL}?x=1`, PROD_URL)).toBe(true)
    expect(isAppUrl(`${PROD_URL}#/tree`, PROD_URL)).toBe(true)
  })

  it('denies another local file — "protocol is file:" is not the rule', () => {
    // The looser check the plan explicitly declined. A local HTML file an
    // attacker persuaded the user to save would otherwise become a navigation
    // target that inherits `window.api`.
    expect(isAppUrl('file:///C:/Users/victim/Downloads/payload.html', PROD_URL)).toBe(false)
    expect(isAppUrl('file:///etc/passwd', PROD_URL)).toBe(false)
  })

  it('denies remote content and the read-token scheme', () => {
    expect(isAppUrl('https://example.com/', PROD_URL)).toBe(false)
    // `klados-file:` is a fetch scheme, never a navigation target.
    expect(isAppUrl('klados-file://some-token/', PROD_URL)).toBe(false)
  })
})

describe('R164 — isAppUrl fails closed', () => {
  it('denies anything unparseable rather than throwing', () => {
    expect(isAppUrl('', PROD_URL)).toBe(false)
    expect(isAppUrl('not a url', PROD_URL)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', 'not a url')).toBe(false)
  })

  it('denies an opaque origin rather than matching one against another', () => {
    // Two `data:` URLs both have origin "null"; a plain `origin ===` test would
    // call them the same page.
    expect(isAppUrl('data:text/html,<script>1</script>', 'data:text/html,x')).toBe(false)
  })
})

/**
 * R165 (`docs/plans/R164-release-security-hardening.md` §3) — the
 * `openExternal` allowlist.
 *
 * `setWindowOpenHandler` handed **any** URL a new-window request carried
 * straight to `shell.openExternal`, which gives the string to the OS handler.
 * Unreachable today, and that is the argument for fixing it now rather than
 * later: nothing depends on the looser behaviour, so the change costs nothing
 * to make now and would cost a round to make later, under pressure, with a
 * real link already in the UI.
 */
describe('R165 — isAllowedExternalUrl', () => {
  it('forwards the schemes a link can legitimately be', () => {
    expect(isAllowedExternalUrl('https://github.com/mincowski/klados')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('mailto:someone@example.com')).toBe(true)
  })

  it('drops anything the OS would action as something other than a page', () => {
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isAllowedExternalUrl('smb://attacker.example/share')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    // The scheme behind Follina (CVE-2022-30190) — a concrete reminder that
    // "some scheme the OS knows about" is not a small set.
    expect(isAllowedExternalUrl('ms-msdt:/id')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
  })
})

/**
 * Every permission name Electron's own types list for the check handler, read
 * from the installed `electron.d.ts` rather than copied here, so a permission
 * a later Electron adds is covered without anyone remembering to add it.
 */
function electronPermissionNames(): string[] {
  const types = readFileSync('node_modules/electron/electron.d.ts', 'utf8')
  const signature =
    /setPermissionCheckHandler\(handler: \(\(webContents: [^,]+, permission: ([^,]+(?:\|[^,]+)*), requestingOrigin/.exec(
      types
    )
  if (signature === null)
    throw new Error('setPermissionCheckHandler signature not found in electron.d.ts')
  return [...signature[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('R222 — isPermissionGranted', () => {
  const PAGE = PROD_URL

  it('grants clipboard-sanitized-write to the app page, in the main frame', () => {
    expect(isPermissionGranted('clipboard-sanitized-write', PAGE, true, PROD_URL)).toBe(true)
    expect(
      isPermissionGranted('clipboard-sanitized-write', 'http://localhost:5173/', true, DEV_URL)
    ).toBe(true)
  })

  it('refuses every other permission Electron knows, clipboard-read included', () => {
    const names = electronPermissionNames()
    expect(names).toContain('clipboard-read')
    expect(names).toContain('notifications')
    expect(names.length).toBeGreaterThan(30)
    const granted = names.filter((name) => isPermissionGranted(name, PAGE, true, PROD_URL))
    expect(granted).toEqual(['clipboard-sanitized-write'])
  })

  it('refuses it to anything but the app page', () => {
    const other = 'file:///C:/Users/someone/Downloads/saved.html'
    expect(isPermissionGranted('clipboard-sanitized-write', other, true, PROD_URL)).toBe(false)
    expect(
      isPermissionGranted('clipboard-sanitized-write', 'https://example.com/', true, PROD_URL)
    ).toBe(false)
    expect(isPermissionGranted('clipboard-sanitized-write', 'not a url', true, PROD_URL)).toBe(
      false
    )
  })

  it('refuses it to a subframe, even of the app page', () => {
    expect(isPermissionGranted('clipboard-sanitized-write', PAGE, false, PROD_URL)).toBe(false)
  })

  it('refuses it without a requesting URL, or before the app URL is known', () => {
    expect(isPermissionGranted('clipboard-sanitized-write', undefined, true, PROD_URL)).toBe(false)
    expect(isPermissionGranted('clipboard-sanitized-write', PAGE, true, null)).toBe(false)
  })
})
