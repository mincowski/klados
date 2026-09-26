/**
 * The plain-fs half of `main/documents.ts`'s `document:stat`/`document:write`
 * handlers, pulled out so it can be unit-tested directly — same reasoning
 * `readTokenRegistry.ts` already applied to the token logic (R51,
 * `R51-main-process.md`). Neither function touches Electron; `documents.ts`
 * is the thin IPC wiring around them.
 */
import { access, stat, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { encodeFileError, folderError } from './fileErrors'

export interface DocumentStatResult {
  readonly size: number
  readonly readOnly: boolean
}

/** `fs.stat` plus a write-access probe — read before a document's bytes are
 * ever read, so D6's size-limit checks (soft cap confirm, hard ceiling
 * refusal) never have to load bytes just to decide whether to.
 *
 * R220: a failure rejects with its kind tagged into the message
 * (`fileErrors.ts`), because IPC delivers nothing else. A folder is refused
 * here, since `stat` of one succeeds. */
export async function statDocument(path: string): Promise<DocumentStatResult> {
  let size: number
  try {
    const info = await stat(path)
    if (info.isDirectory()) throw folderError(path)
    size = info.size
  } catch (err) {
    throw encodeFileError(err)
  }
  const writable = await access(path, fsConstants.W_OK)
    .then(() => true)
    .catch(() => false)
  return { size, readOnly: !writable }
}

/**
 * Writes exactly `bytes` — invariant 6/7: never text, never re-encoded.
 * Overwrites unconditionally; the caller (`isReadOnly`) is what keeps this
 * from ever being invoked against a file the user can't write to. Any
 * failure (read-only target, vanished directory, permission error)
 * propagates as a rejected promise rather than being swallowed — the
 * renderer's save flow is what turns that into an honest failure
 * notification — tagged with its kind (R220), as `statDocument`'s are.
 */
export async function writeDocument(path: string, bytes: ArrayBuffer): Promise<void> {
  try {
    await writeFile(path, Buffer.from(bytes))
  } catch (err) {
    throw encodeFileError(err)
  }
}
