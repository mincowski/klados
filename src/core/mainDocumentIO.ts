/**
 * The plain-fs half of `main/documents.ts`'s `document:stat`/`document:write`
 * handlers, pulled out so it can be unit-tested directly — same reasoning
 * `readTokenRegistry.ts` already applied to the token logic (R51,
 * `R51-main-process.md`). Neither function touches Electron; `documents.ts`
 * is the thin IPC wiring around them.
 */
import { access, open, realpath, stat, statfs } from 'fs/promises'
import { dirname } from 'path'
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
 * R237 (`docs/plans/R236-save-and-watch.md` §1) — the file system calls a save
 * makes, injected so a test can fake one of them (a full disk, a short write, a
 * failing flush) while the rest still touch a real file.
 */
export interface WriteHandle {
  truncate(len: number): Promise<void>
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface WriteDocumentFs {
  statfs(dir: string): Promise<{ bavail: number; bsize: number }>
  stat(path: string): Promise<{ size: number }>
  realpath(path: string): Promise<string>
  open(path: string, flags: 'r+' | 'w'): Promise<WriteHandle>
}

export const nodeWriteFs: WriteDocumentFs = {
  statfs: (dir) => statfs(dir),
  stat: (path) => stat(path),
  realpath: (path) => realpath(path),
  open: (path, flags) => open(path, flags)
}

/**
 * Refuses, with `ENOSPC`, a save the disk visibly has no room for — before the
 * file is opened, so the original is still whole when the `full` message says
 * so. The space the old contents occupy counts as free, since they are
 * replaced.
 *
 * A pre-check, not a guarantee (quotas, copy-on-write filesystems, another
 * writer), and **never a reason to block a save on its own**: a `statfs` that
 * fails skips the check. The volume asked is the one the bytes land on, so a
 * symlink is resolved first; a path that does not exist yet is asked about its
 * folder. A file whose size cannot be read counts as empty, which only ever
 * makes the check stricter.
 */
async function refuseWithoutRoom(
  path: string,
  byteLength: number,
  fs: WriteDocumentFs
): Promise<void> {
  const target = await fs.realpath(path).catch(() => path)
  let free: number
  try {
    const info = await fs.statfs(dirname(target))
    free = info.bavail * info.bsize
  } catch {
    return
  }
  const currentSize = await fs.stat(target).then(
    (info) => info.size,
    () => 0
  )
  if (byteLength > currentSize + free) {
    throw Object.assign(
      new Error(
        `ENOSPC: not enough free space to save, ${byteLength} bytes needed and ${currentSize + free} available, '${path}'`
      ),
      { code: 'ENOSPC' }
    )
  }
}

/**
 * The most one `write` call is given. Measured on Windows 11 / Node 24, 200 MB
 * written in place: one call for the whole buffer took 560 ms, against 106 ms
 * in 4 MiB pieces, flat from 2 to 16 MiB and 338 ms again at 32 MiB. Node's
 * own `writeFile` writes in pieces too, which is why it was never slow.
 */
export const WRITE_CHUNK_BYTES = 4 * 1024 * 1024

/** `r+` keeps the file object — owner, ACL, streams, hidden attribute, file
 * ID, links — and does not truncate on open. Only a file that does not exist
 * falls back to `w`, which creates it; any other failure (a lock, a permission)
 * is reported, having touched nothing. */
async function openInPlace(path: string, fs: WriteDocumentFs): Promise<WriteHandle> {
  try {
    return await fs.open(path, 'r+')
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err
    return fs.open(path, 'w')
  }
}

/**
 * Writes exactly `bytes` — invariant 6/7: never text, never re-encoded.
 * Overwrites whatever is there; the caller (`isReadOnly`) is what keeps this
 * from ever being invoked against a file the user can't write to. Any
 * failure (read-only target, vanished directory, permission error)
 * propagates as a rejected promise rather than being swallowed — the
 * renderer's save flow is what turns that into an honest failure
 * notification — tagged with its kind (R220), as `statDocument`'s are.
 *
 * R237: **in place, never by rename** (D-119). Check for room, open `r+`,
 * truncate to 0, write from offset 0, flush, close. Truncating before writing
 * rather than after is deliberate: a write that stops part-way then leaves a
 * file that is visibly short, never the new head on the old tail, which may
 * still parse. The flush is what makes success mean the bytes reached the disk;
 * a failed flush is a failed save.
 */
export async function writeDocument(
  path: string,
  bytes: ArrayBuffer,
  fs: WriteDocumentFs = nodeWriteFs
): Promise<void> {
  const data = new Uint8Array(bytes)
  try {
    await refuseWithoutRoom(path, data.byteLength, fs)
    const handle = await openInPlace(path, fs)
    let failed = false
    let failure: unknown
    try {
      await handle.truncate(0)
      let written = 0
      while (written < data.byteLength) {
        const { bytesWritten } = await handle.write(
          data,
          written,
          Math.min(WRITE_CHUNK_BYTES, data.byteLength - written),
          written
        )
        if (bytesWritten <= 0) {
          throw new Error(`write made no progress at byte ${written}, '${path}'`)
        }
        written += bytesWritten
      }
      await handle.sync()
    } catch (err) {
      failed = true
      failure = err
    }
    // Closed on every path. A close that fails after a good write is a failed
    // save too (a network share can report its error only here); after a
    // failed one, the first error is the one worth reporting.
    try {
      await handle.close()
    } catch (err) {
      if (!failed) {
        failed = true
        failure = err
      }
    }
    if (failed) throw failure
  } catch (err) {
    throw encodeFileError(err)
  }
}
