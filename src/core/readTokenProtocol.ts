/**
 * The `klados-file://` protocol handler's actual logic (`main/documents.ts`'s
 * own header: "the token is the whole security model" — a token-to-path
 * map, never a URL-to-path map, is what keeps this from being an
 * arbitrary-file-read oracle). Pulled out so it can be unit-tested without
 * standing up Electron's `protocol` API — the same reasoning
 * `readTokenRegistry.ts` already applied to the mint/take logic itself
 * (R51, `R51-main-process.md`). No Electron import: `documents.ts` is
 * the thin wiring, `protocol.handle(SCHEME, (request) =>
 * handleReadTokenRequest(request, readTokens))`.
 */
import { open, type FileHandle } from 'fs/promises'
import { Readable } from 'stream'
import type { ReadTokenRegistry } from './readTokenRegistry'
import { classifyFileError, fileErrorMessage, folderError, type FileErrorKind } from './fileErrors'

/** R220: one status per kind, for anyone reading the protocol by hand; the
 * worker reads the kind from the body, which a cross-origin `fetch` can see
 * without a CORS header naming it. */
const STATUS_OF_KIND: Readonly<Record<FileErrorKind, number>> = {
  missing: 404,
  denied: 403,
  folder: 409,
  locked: 423,
  full: 500,
  readOnlyDisk: 500,
  other: 500
}

/**
 * Single-use: `take` consumes the entry the moment a request for it
 * arrives, whether or not the read below actually succeeds — a failed read
 * shouldn't leave a still-valid token sitting around either. Refuses an
 * unknown, expired or already-consumed token with a 404, never by throwing
 * — this runs inside `protocol.handle`, where a thrown error is a worse
 * failure mode than an honest "not found" response.
 *
 * R220 (`docs/plans/R220-file-error-messages.md` § 3): the file is **opened
 * before answering**, so a failure is answered with its kind — this used to
 * `stat` and answer 404 for everything, and a locked file (which `stat`s
 * fine on Windows, measured) failed only once the stream began, as an
 * anonymous fetch error. A folder is refused by asking: Windows opens one
 * without complaint. The stream then reads from the same handle, so the size
 * and the bytes come from one open file.
 */
export async function handleReadTokenRequest(
  request: Request,
  readTokens: Pick<ReadTokenRegistry, 'take'>
): Promise<Response> {
  const token = new URL(request.url).hostname
  const path = readTokens.take(token)
  if (path === undefined) return new Response('Not found', { status: 404 })

  let handle: FileHandle | undefined
  let size: number
  try {
    handle = await open(path, 'r')
    const info = await handle.stat()
    if (info.isDirectory()) throw folderError(path)
    size = info.size
  } catch (err) {
    await handle?.close()
    const kind = classifyFileError(err)
    const detail = err instanceof Error ? err.message : String(err)
    return new Response(fileErrorMessage(kind, detail), { status: STATUS_OF_KIND[kind] })
  }

  // `size` can go stale between this stat and the stream actually reading
  // the file (truncated or appended to underneath us) — if it does,
  // Chromium's net stack rejects the mismatched content-length and the
  // fetch fails, which `runParseFromUrlJob` already catches as an ordinary
  // read error. Fails safe; not worth a second stat. The stream closes the
  // handle when it ends or is destroyed.
  const webStream = Readable.toWeb(handle.createReadStream()) as ReadableStream
  return new Response(webStream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(size)
    }
  })
}
