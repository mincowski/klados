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
 * - **Production** (`file:`, from `loadFile`): the same **file**: the same
 *   pathname **on the same host**. R231: a `file:` URL with a host is a UNC
 *   path on another machine, so the pathname alone matched
 *   `file://evil.example/C:/…/index.html` as the app's own page. The app's
 *   URL has an empty host, and Electron reports its page the same way
 *   (measured), so any URL with a host is now refused. (`file://localhost/`
 *   is not one: the URL parser turns that host into the empty one.)
 *
 *   Not merely "protocol is `file:`", which would let any local HTML file
 *   (including one an attacker persuaded the user to save) become a
 *   navigation target that inherits `window.api`.
 *
 *   **The pathnames are compared percent-decoded** (R240,
 *   `docs/plans/R240-app-url-spelling.md`). The app's URL is Node's
 *   `pathToFileURL`, which writes `~`, `[`, `]` and `%` as `%7E`, `%5B`, `%5D`
 *   and `%25`; Chromium reports its page with them literal. Compared raw, a
 *   Klados installed under any path containing one of them (an 8.3 name such
 *   as `RUNNER~1`, or `C:\~tools\`) refused every IPC call from its own page.
 *   Two spellings that decode to the same bytes are the same file to
 *   Chromium's loader, so this accepts only other spellings of the app's own
 *   file. See `decodedFilePath` for what is never decoded.
 *
 *   **Case stays significant.** Casing alone never differed (both URLs come
 *   from the same string, measured), and a case-insensitive compare would
 *   accept a different file on Linux, case-sensitive macOS volumes and
 *   case-sensitive NTFS folders.
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
    return (
      parsedTarget.protocol === 'file:' &&
      parsedTarget.host === parsedApp.host &&
      decodedFilePath(parsedTarget.pathname) === decodedFilePath(parsedApp.pathname)
    )
  }

  return parsedTarget.origin === parsedApp.origin && parsedTarget.origin !== 'null'
}

/** `/`, `\` and NUL: their escapes are never decoded. */
const KEPT_BYTES: readonly number[] = [0x2f, 0x5c, 0x00]

/**
 * A `file:` URL's pathname with every `%XX` replaced by the byte it names, in
 * one pass, as a string of byte values (R240). `new URL()` has already escaped
 * every non-ASCII character, so a byte string compares exactly.
 *
 * - **An encoded separator or NUL is never decoded**, in either case, so it
 *   never matches a literal `/` and cannot change the path's structure.
 *   Chromium refuses such URLs anyway (measured, `ERR_FAILED`). It becomes a
 *   code unit above 0xFF, which nothing else produces: kept as the text
 *   `%2F`, it would equal a decoded `%252F`, a file literally named `%2F`.
 * - **One pass**: `%257E` becomes `%7E`, never `~`.
 * - **Dot segments are not resolved here.** `new URL()` already resolved
 *   them, `%2E%2E` included (the URL standard counts it as `..`), so a
 *   decoded `%2E` is only ever a dot inside a name.
 * - **Hand-written, not `decodeURIComponent`**, which throws on `%%` and `%FF`
 *   (a throw here would refuse every IPC call) and decodes `%2F`. A `%` not
 *   followed by two hex digits stays literal.
 */
function decodedFilePath(pathname: string): string {
  let out = ''
  let i = 0
  while (i < pathname.length) {
    const hex = pathname.slice(i + 1, i + 3)
    if (pathname[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      const byte = parseInt(hex, 16)
      out += String.fromCharCode(KEPT_BYTES.includes(byte) ? 0x100 + byte : byte)
      i += 3
    } else {
      out += pathname[i]
      i += 1
    }
  }
  return out
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

/**
 * The one web permission Klados grants (R222,
 * `docs/plans/R222-clipboard-permission.md`): writing to the clipboard, which
 * every copy button needs (`Grid.tsx`'s export, `Detail.tsx`'s "Copy
 * path").
 *
 * R165 refused every permission on the premise that Klados needs none, and never
 * considered clipboard *write*. So every copy button failed silently from R165
 * on, measured on Electron 39 and 44 alike. `clipboard-read` stays refused, as
 * does everything else: writing reveals nothing. "Sanitized" names Chromium's
 * write path for the standard formats, on which HTML is sanitized before it
 * reaches the system clipboard; Klados writes plain text only.
 */
const GRANTED_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write']

/**
 * Whether a permission check or request is granted: a permission on the list,
 * asked for by the application's own page (`isAppUrl`, the rule R164 applies
 * to navigation and IPC senders), from the main frame. Chromium checks before it
 * requests (measured), and `main/index.ts` answers both through this, so
 * `navigator.permissions.query` reports what the page can actually do.
 *
 * A missing `requestingUrl`, which Electron types as optional on a check, is
 * refused.
 */
export function isPermissionGranted(
  permission: string,
  requestingUrl: string | undefined,
  isMainFrame: boolean,
  appUrl: string | null
): boolean {
  return (
    GRANTED_PERMISSIONS.includes(permission) &&
    isMainFrame &&
    requestingUrl !== undefined &&
    appUrl !== null &&
    isAppUrl(requestingUrl, appUrl)
  )
}
