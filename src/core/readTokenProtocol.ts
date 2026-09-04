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
import { stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import type { ReadTokenRegistry } from './readTokenRegistry'

/**
 * Single-use: `take` consumes the entry the moment a request for it
 * arrives, whether or not the read below actually succeeds — a failed read
 * shouldn't leave a still-valid token sitting around either. Refuses an
 * unknown, expired or already-consumed token with a 404, never by throwing
 * — this runs inside `protocol.handle`, where a thrown error is a worse
 * failure mode than an honest "not found" response.
 */
export async function handleReadTokenRequest(
  request: Request,
  readTokens: Pick<ReadTokenRegistry, 'take'>
): Promise<Response> {
  const token = new URL(request.url).hostname
  const path = readTokens.take(token)
  if (path === undefined) return new Response('Not found', { status: 404 })

  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return new Response('Not found', { status: 404 })
  }

  // `size` can go stale between this stat and the stream actually reading
  // the file (deleted/replaced/resized underneath us) — if it does,
  // Chromium's net stack rejects the mismatched content-length and the
  // fetch fails, which `runParseFromUrlJob` already catches as an ordinary
  // read error. Fails safe; not worth a second stat.
  const nodeStream = createReadStream(path)
  const webStream = Readable.toWeb(nodeStream) as ReadableStream
  return new Response(webStream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(size)
    }
  })
}
