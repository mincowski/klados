/**
 * R164 (`docs/plans/R164-release-security-hardening.md`) — the security
 * predicates the main process enforces, kept pure and here rather than inline
 * in `main/index.ts` for the same reason `mainQuitFlow.ts` and
 * `mainDocumentIO.ts` are: main-process code cannot be exercised by the test
 * suite, and a guard nobody can test is a guard nobody can trust.
 *
 * **What these defend.** `preload/index.ts` exposes `window.api` on whatever
 * origin the renderer happens to be showing, and the IPC behind it mints read
 * tokens for any path (`documents.ts`) and writes any bytes to any path
 * (`mainDocumentIO.writeDocument`). That is deliberate and correct *while the
 * renderer is the app's own page* — the token model's own header says the token
 * is the whole security model, and that premise holds only if the renderer
 * cannot be navigated somewhere else. Nothing enforced it before R164.
 *
 * **One rule, two enforcement points.** `isAppUrl` decides both what may be
 * navigated to and which frame may speak over IPC, because they are the same
 * question — *is this still our page?* — asked at two chokepoints. The
 * navigation guard is the primary control; the sender check is what still holds
 * if some future path reaches a context the navigation guard never saw.
 */

/**
 * True when `target` is the application's own page.
 *
 * The comparison is deliberately asymmetric between dev and production,
 * because the two load in genuinely different ways:
 *
 * - **Dev** (`http:`/`https:`, from `ELECTRON_RENDERER_URL`): same **origin**.
 *   Vite's dev server navigates within its own origin for HMR and serves the
 *   entry at more than one path, so pinning the full URL would break the
 *   development loop for no security gain — an attacker who can serve from
 *   `localhost:5173` has already won by other means.
 * - **Production** (`file:`, from `loadFile`): the same **file**, compared on
 *   pathname alone. Not merely "protocol is `file:`", which would let any local
 *   HTML file — including one an attacker persuaded the user to save — become a
 *   navigation target that inherits `window.api`.
 *
 * Anything unparseable is denied. A guard that throws on a malformed URL fails
 * open at the call site, which is the wrong direction for this to fail in.
 */
export function isAppUrl(target: string, appUrl: string): boolean {
  let parsedTarget: URL
  let parsedApp: URL
  try {
    parsedTarget = new URL(target)
    parsedApp = new URL(appUrl)
  } catch {
    return false
  }

  if (parsedApp.protocol === 'file:') {
    return parsedTarget.protocol === 'file:' && parsedTarget.pathname === parsedApp.pathname
  }

  return parsedTarget.origin === parsedApp.origin && parsedTarget.origin !== 'null'
}

/**
 * Schemes `shell.openExternal` may be handed (R165).
 *
 * `openExternal` gives the string to the OS handler, so without this a `file:`,
 * `smb:` or `ms-msdt:` URL arriving through `setWindowOpenHandler` would be
 * actioned by the OS rather than opened as a page.
 *
 * **Unreachable today**, which is the argument for fixing it now rather than
 * later: the renderer has no external links, no `window.open` and no
 * `target="_blank"`, so nothing depends on the looser behaviour and the right
 * answer is obvious. The moment someone adds a link — or a `window.open` slips
 * past R164's guard — this becomes the thing standing between a URL and the
 * shell.
 */
const EXTERNAL_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:']

export function isAllowedExternalUrl(target: string): boolean {
  try {
    return EXTERNAL_SCHEMES.includes(new URL(target).protocol)
  } catch {
    return false
  }
}
