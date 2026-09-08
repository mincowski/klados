/**
 * R164 (`docs/plans/R164-release-security-hardening.md` §2e) — the
 * predicate behind the navigation guard and the IPC sender check.
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
import { isAppUrl } from '../src/core/mainSecurity'

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
