/**
 * R220 (`docs/plans/R220-file-error-messages.md` § 5) — the kind survives the
 * trip, and every kind has its words.
 */
import { describe, expect, it } from 'vitest'
import {
  FILE_ERROR_KINDS,
  classifyFileError,
  describeFileError,
  encodeFileError,
  fileErrorFrom,
  folderError,
  type FileAction,
  type FileErrorKind
} from '../src/core/fileErrors'

function nodeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** What the renderer actually receives from a rejected `ipcRenderer.invoke`:
 * the message only, behind Electron's prefix — measured in § 1. */
function acrossIpc(err: Error, channel = 'document:stat'): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${err.message}`)
}

const CODES: readonly (readonly [string, FileErrorKind])[] = [
  ['ENOENT', 'missing'],
  ['ENOTDIR', 'missing'],
  ['EACCES', 'denied'],
  ['EPERM', 'denied'],
  ['EISDIR', 'folder'],
  ['EBUSY', 'locked'],
  ['ENOSPC', 'full'],
  ['EDQUOT', 'full'],
  ['EROFS', 'readOnlyDisk'],
  ['EIO', 'other']
]

describe('classifying, encoding and decoding (R220)', () => {
  it.each(CODES)('%s is %s, and survives IPC', (code, kind) => {
    const original = nodeError(code, `${code}: something, stat 'C:\\data\\a.json'`)
    expect(classifyFileError(original)).toBe(kind)

    const encoded = encodeFileError(original)
    expect(encoded).toHaveProperty('code', code)
    expect(fileErrorFrom(encoded)).toEqual({ kind, detail: original.message })
    expect(fileErrorFrom(acrossIpc(encoded))).toEqual({ kind, detail: original.message })
  })

  it('an error without a code, or not an Error at all, is other', () => {
    expect(classifyFileError(new Error('x'))).toBe('other')
    expect(classifyFileError('x')).toBe('other')
    expect(classifyFileError(null)).toBe('other')
  })

  it('an untagged error is not a file error, whatever its words', () => {
    expect(fileErrorFrom(new Error('ENOENT: no such file or directory'))).toBeNull()
    expect(fileErrorFrom(new Error("Unrecognized format for 'a.bin'"))).toBeNull()
    expect(fileErrorFrom('[klados-file-error:nonsense] x')).toBeNull()
  })

  it('a folder is refused as one', () => {
    expect(fileErrorFrom(encodeFileError(folderError('C:\\data')))?.kind).toBe('folder')
  })

  it('a multi-line system message is kept whole', () => {
    const encoded = encodeFileError(nodeError('EIO', 'EIO: i/o error\nsecond line'))
    expect(fileErrorFrom(acrossIpc(encoded))?.detail).toBe('EIO: i/o error\nsecond line')
  })
})

describe('the words (R220 § 2)', () => {
  const path = 'C:\\Users\\someone\\AppData\\Local\\Temp\\r219-probe\\probe.json'
  const say = (kind: FileErrorKind, action: FileAction, detail = ''): string =>
    describeFileError({ kind, detail }, action, path)

  it('every kind and action, exactly', () => {
    expect(say('missing', 'open')).toBe("probe.json can't be opened: it no longer exists.")
    expect(say('missing', 'reload')).toBe("probe.json can't be reloaded: it no longer exists.")
    expect(say('missing', 'save')).toBe("probe.json can't be saved: its folder no longer exists.")
    expect(say('denied', 'open')).toBe("Klados isn't allowed to open probe.json.")
    expect(say('denied', 'reload')).toBe("Klados isn't allowed to reload probe.json.")
    expect(say('denied', 'save')).toBe("Klados isn't allowed to save probe.json.")
    expect(say('folder', 'open')).toBe('probe.json is a folder, not a file.')
    expect(say('locked', 'open')).toBe("probe.json can't be opened: another program is using it.")
    expect(say('locked', 'save')).toBe("probe.json can't be saved: another program is using it.")
    expect(say('full', 'save')).toBe("probe.json can't be saved: the disk is full.")
    expect(say('readOnlyDisk', 'save')).toBe("probe.json can't be saved: the drive is read-only.")
    expect(say('other', 'open', 'EIO: i/o error, read')).toBe(
      "probe.json can't be opened: EIO: i/o error, read"
    )
  })

  it('names the file, never the whole path', () => {
    for (const kind of FILE_ERROR_KINDS) {
      for (const action of ['open', 'reload', 'save'] as const) {
        const words = say(kind, action, 'detail')
        expect(words).toContain('probe.json')
        expect(words).not.toContain('r219-probe')
      }
    }
  })

  it('a POSIX path too', () => {
    expect(describeFileError({ kind: 'missing', detail: '' }, 'open', '/home/a/b.xml')).toBe(
      "b.xml can't be opened: it no longer exists."
    )
  })
})
