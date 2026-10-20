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

describe('R231 — isAppUrl compares the host of a file: URL', () => {
  // The same pathname under a host is a UNC path: `file://evil.example/C:/…`
  // is `\\evil.example\C:\…`, another machine's file. Comparing the pathname
  // alone accepted it as the app's own page.
  const OTHER_HOST =
    'file://evil.example/C:/Program%20Files/Klados/resources/app.asar/out/renderer/index.html'

  it('denies the app path on another host', () => {
    expect(new URL(OTHER_HOST).pathname).toBe(new URL(PROD_URL).pathname)
    expect(isAppUrl(OTHER_HOST, PROD_URL)).toBe(false)
  })

  it('accepts localhost, which the URL parser turns into no host at all', () => {
    // The plan expected a refusal here. But the URL standard's file-host rule
    // replaces `localhost` with the empty host (`new URL('file://localhost/C:/x')
    // .href` is `file:///C:/x`), so this is the app's own URL, the same local
    // file, not another machine's. Electron reports its page with no host as
    // well: measured, `location.href`, `webContents.getURL()` and
    // `mainFrame.url` are all `file:///C:/…` in the built app.
    const localhost = PROD_URL.replace('file:///', 'file://localhost/')
    expect(new URL(localhost).host).toBe('')
    expect(isAppUrl(localhost, PROD_URL)).toBe(true)
  })

  it('still allows the app page itself', () => {
    expect(isAppUrl(PROD_URL, PROD_URL)).toBe(true)
  })

  it('isPermissionGranted refuses the app path on another host', () => {
    expect(isPermissionGranted('clipboard-sanitized-write', OTHER_HOST, true, PROD_URL)).toBe(false)
    expect(isPermissionGranted('clipboard-sanitized-write', PROD_URL, true, PROD_URL)).toBe(true)
  })
})

/**
 * R240 (`docs/plans/R240-app-url-spelling.md` §1.3) — the app URL is Node's
 * `pathToFileURL`; the URL a page reports is Chromium's. Each pair below is a
 * folder `a<c>b` as the two spelled it, measured on Electron 44.4.5, and the
 * first is the packaged launch through `KLADOS~1` that R230 found.
 */
describe('R240 — isAppUrl accepts both spellings of the same file', () => {
  const page = (folder: string): string =>
    `file:///C:/Users/chris/AppData/Local/Temp/scratchpad/${folder}/app/resources/app.asar/out/renderer/index.html`

  // [what the folder holds, Node's spelling, Chromium's spelling]
  const PAIRS: readonly (readonly [string, string, string])[] = [
    ['an 8.3 alias', 'KLADOS%7E1', 'KLADOS~1'],
    ['~', 'a%7Eb', 'a~b'],
    ['[', 'a%5Bb', 'a[b'],
    [']', 'a%5Db', 'a]b'],
    ['%%', 'a%25%25b', 'a%%b'],
    ['a space', 'a%20b', 'a%20b'],
    ["! $ & ' ( ) + , ; = @", "a!$&'()+,;=@b", "a!$&'()+,;=@b"],
    ['^ ` { } #', 'a%5E%60%7B%7D%23b', 'a%5E%60%7B%7D%23b'],
    ['ä 日 😀', 'a%C3%A4%E6%97%A5%F0%9F%98%80b', 'a%C3%A4%E6%97%A5%F0%9F%98%80b']
  ]

  for (const [what, node, chromium] of PAIRS) {
    it(`a folder with ${what}`, () => {
      expect(isAppUrl(page(chromium), page(node))).toBe(true)
    })
  }

  it('the 8.3 pair differs as raw pathnames, so the test is not vacuous', () => {
    expect(new URL(page('KLADOS~1')).pathname).not.toBe(new URL(page('KLADOS%7E1')).pathname)
  })

  it('isPermissionGranted inherits it: Copy works from the short path (criterion 8)', () => {
    expect(
      isPermissionGranted('clipboard-sanitized-write', page('KLADOS~1'), true, page('KLADOS%7E1'))
    ).toBe(true)
  })
})

describe('R240 — isAppUrl still refuses other files', () => {
  const APP = 'file:///C:/Apps/a%7Eb/out/renderer/index.html'

  it('another path', () => {
    expect(isAppUrl('file:///C:/Apps/a~c/out/renderer/index.html', APP)).toBe(false)
  })

  it('an encoded / in place of a separator, in either case', () => {
    expect(isAppUrl('file:///C:/Apps/a~b%2Fout/renderer/index.html', APP)).toBe(false)
    expect(isAppUrl('file:///C:/Apps/a~b%2fout/renderer/index.html', APP)).toBe(false)
  })

  it('an encoded \\ in place of a separator, in either case', () => {
    expect(isAppUrl('file:///C:/Apps/a~b%5Cout/renderer/index.html', APP)).toBe(false)
    expect(isAppUrl('file:///C:/Apps/a~b%5cout/renderer/index.html', APP)).toBe(false)
  })

  it('an encoded NUL', () => {
    expect(isAppUrl('file:///C:/Apps/a~b/out/renderer/index.html%00', APP)).toBe(false)
  })

  it('a file literally named %5C is not the encoded separator it spells', () => {
    // Linux allows `\` in a name, and `pathToFileURL` writes it `%5C`. Decoded
    // `%255C` is the text `%5C`; it must not meet the kept escape.
    const linuxApp = 'file:///opt/a%5Cb/index.html'
    expect(isAppUrl('file:///opt/a%255Cb/index.html', linuxApp)).toBe(false)
    expect(isAppUrl(linuxApp, linuxApp)).toBe(true)
  })

  it('no double decode: %257E is not ~', () => {
    expect(isAppUrl('file:///C:/Apps/a%257Eb/out/renderer/index.html', APP)).toBe(false)
  })

  it('an encoded .. segment is the URL parser’s, before any decoding', () => {
    // The plan expected `%2E%2E` to survive as text. Measured, the URL
    // standard treats `%2E%2E` (any case) as a `..` segment and resolves it,
    // for Chromium as for Node, so it names the same file and is accepted;
    // decoding cannot create a `..` the parser did not already resolve.
    const encoded = 'file:///C:/Apps/a~b/x/%2E%2E/out/renderer/index.html'
    expect(new URL(encoded).pathname).toBe('/C:/Apps/a~b/out/renderer/index.html')
    expect(isAppUrl(encoded, APP)).toBe(true)
    // An escaped dot inside a name is just a dot.
    expect(isAppUrl('file:///C:/Apps/a~b/out/renderer/index%2Ehtml', APP)).toBe(true)
    expect(isAppUrl('file:///C:/Apps/a~b/out/renderer%2E/index.html', APP)).toBe(false)
  })

  it('a path differing only in case', () => {
    expect(isAppUrl('file:///C:/Apps/A~B/out/renderer/index.html', APP)).toBe(false)
    expect(isAppUrl('file:///C:/Apps/a~b/out/renderer/INDEX.html', APP)).toBe(false)
  })

  it('an unparseable URL', () => {
    expect(isAppUrl('file://[/a~b', APP)).toBe(false)
  })
})

describe('R240 — isAppUrl never throws (criterion 3)', () => {
  // `decodeURIComponent` throws on these; a throw in the guard refuses every
  // IPC call.
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['file:///C:/a%FFb/index.html', 'file:///C:/a%FFb/index.html', true],
    ['file:///C:/a%FFb/index.html', 'file:///C:/a%FEb/index.html', false],
    ['file:///C:/ab/index.html%', 'file:///C:/ab/index.html%25', true],
    ['file:///C:/ab/index.html%', 'file:///C:/ab/index.html', false],
    ['file:///C:/a%%b/index.html', 'file:///C:/a%25%25b/index.html', true],
    ['file:///C:/a%%b/index.html', 'file:///C:/a%25b/index.html', false]
  ]
  for (const [target, app, expected] of cases) {
    it(`${target} against ${app}`, () => {
      expect(() => isAppUrl(target, app)).not.toThrow()
      expect(isAppUrl(target, app)).toBe(expected)
    })
  }
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
