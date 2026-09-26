/**
 * R220 (`docs/plans/R220-file-error-messages.md`) — a file system failure,
 * told in words.
 *
 * **Why the kind travels inside the message.** An error thrown in an
 * `ipcMain.handle` reaches the renderer with its `message` only — no `code`,
 * no `errno` — behind Electron's own `Error invoking remote method '<channel>':
 * ` prefix (measured, and documented by Electron). The read route loses it
 * too: the worker sees an HTTP response, not an error. So the one place the
 * code still exists — the main process, and the protocol handler — classifies
 * it and writes the kind into the message as a tag, and the renderer finds
 * the tag **wherever it sits**, never parsing the prefix in front of it or
 * Node's wording behind it.
 *
 * Imported by the main process, the parse worker and the renderer; no Node or
 * DOM import, so it compiles in all three.
 */

export const FILE_ERROR_KINDS = [
  'missing',
  'denied',
  'folder',
  'locked',
  'full',
  'readOnlyDisk',
  'other'
] as const

export type FileErrorKind = (typeof FILE_ERROR_KINDS)[number]

/** What the renderer recovers from a tagged message: the kind, and the
 * system's own message for the `other` case's words. */
export interface FileError {
  readonly kind: FileErrorKind
  readonly detail: string
}

export type FileAction = 'open' | 'reload' | 'save'

/** Node's `code` → kind (plan § 2). `EBUSY` is what Windows reports for a file
 * another program holds without sharing — measured, on open, read and write;
 * `stat` of such a file succeeds. */
const KIND_OF_CODE: Readonly<Record<string, FileErrorKind>> = {
  ENOENT: 'missing',
  ENOTDIR: 'missing',
  EACCES: 'denied',
  EPERM: 'denied',
  EISDIR: 'folder',
  EBUSY: 'locked',
  ENOSPC: 'full',
  EDQUOT: 'full',
  EROFS: 'readOnlyDisk'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function classifyFileError(err: unknown): FileErrorKind {
  const code = (err as { code?: unknown } | null)?.code
  return (typeof code === 'string' ? KIND_OF_CODE[code] : undefined) ?? 'other'
}

const TAG = 'klados-file-error'
const TAG_PATTERN = new RegExp(`\\[${TAG}:([A-Za-z]+)\\] ?([\\s\\S]*)$`)

/** The tagged message for `kind`: what `fileErrorFrom` finds again. */
export function fileErrorMessage(kind: FileErrorKind, detail: string): string {
  return `[${TAG}:${kind}] ${detail}`
}

/** A Node file system error, re-thrown so its kind survives IPC. Keeps `code`
 * for anything in the main process that still reads it. */
export function encodeFileError(err: unknown): Error {
  const encoded = new Error(fileErrorMessage(classifyFileError(err), messageOf(err)))
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') Object.assign(encoded, { code })
  return encoded
}

/** Windows opens a folder without complaint (measured: `open` succeeds, only
 * the read fails), and `stat` succeeds everywhere — so a folder is refused by
 * asking, not by waiting for the read. */
export function folderError(path: string): Error {
  return Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), {
    code: 'EISDIR'
  })
}

/** The tagged kind in `err`'s message, or `null` for any error that was not
 * tagged — which is then not a file system error, and keeps its own words. */
export function fileErrorFrom(err: unknown): FileError | null {
  const match = TAG_PATTERN.exec(messageOf(err))
  if (match === null) return null
  const kind = FILE_ERROR_KINDS.find((k) => k === match[1])
  return kind === undefined ? null : { kind, detail: match[2]!.trim() }
}

export function fileNameOf(path: string): string {
  return path.replace(/^.*[\\/]/, '')
}

const PARTICIPLE: Readonly<Record<FileAction, string>> = {
  open: 'opened',
  reload: 'reloaded',
  save: 'saved'
}

/** The sentence, leading with the file's name (plan § 2). The full path is
 * not in it: where there is room, the caller shows it on a line of its own. */
export function describeFileError(error: FileError, action: FileAction, path: string): string {
  const name = fileNameOf(path)
  const cannot = `${name} can't be ${PARTICIPLE[action]}`
  switch (error.kind) {
    case 'missing':
      // `writeFile` creates a missing file; what is missing on save is the folder.
      return action === 'save'
        ? `${cannot}: its folder no longer exists.`
        : `${cannot}: it no longer exists.`
    case 'denied':
      return `Klados isn't allowed to ${action} ${name}.`
    case 'folder':
      return `${name} is a folder, not a file.`
    case 'locked':
      return `${cannot}: another program is using it.`
    case 'full':
      return `${cannot}: the disk is full.`
    case 'readOnlyDisk':
      return `${cannot}: the drive is read-only.`
    case 'other':
      return `${cannot}: ${error.detail}`
  }
}
