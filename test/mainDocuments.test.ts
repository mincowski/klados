/**
 * R51 (`R51-main-process.md`) — the Electron wiring around these two
 * concerns (`main/documents.ts`'s `document:stat`/`document:write` and the
 * `klados-file://` protocol handler) has no test of its own; these do,
 * directly against the extracted plain modules
 * (`src/core/mainDocumentIO.ts`, `src/core/readTokenProtocol.ts`) rather
 * than against Electron's `dialog`/`protocol`/`BrowserWindow`, which cannot
 * run outside a real Electron process. `test/readTokenRegistry.test.ts`
 * already covers the mint/take/TTL half of the security model; this file
 * covers the request-handling half that consumes a token.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm, chmod, readFile, writeFile, stat, link, symlink, lstat } from 'fs/promises'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  nodeWriteFs,
  WRITE_CHUNK_BYTES,
  statDocument,
  writeDocument,
  type WriteDocumentFs,
  type WriteHandle
} from '../src/core/mainDocumentIO'
import { handleReadTokenRequest } from '../src/core/readTokenProtocol'
import { createReadTokenRegistry } from '../src/core/readTokenRegistry'
import { fileErrorFrom } from '../src/core/fileErrors'
import { holdWithoutSharing } from './support/holdWithoutSharing'

/** The kind a rejection carries across IPC (R220), or null if untagged. */
async function kindOfRejection(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
  } catch (err) {
    return fileErrorFrom(err)?.kind ?? null
  }
  throw new Error('expected a rejection')
}

/** POSIX permission bits deny nothing to root, which some CI containers run as. */
const canDenyByMode = process.platform !== 'win32' && process.getuid?.() !== 0

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klados-r51-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('statDocument', () => {
  it('reports size and readOnly: false for a writable file', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'doc.xml')
    await writeDocument(path, new TextEncoder().encode('<a/>').buffer as ArrayBuffer)

    const result = await statDocument(path)
    expect(result.size).toBe(4)
    expect(result.readOnly).toBe(false)
  })

  it('reports readOnly: true for a file with the write bit cleared', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'doc.xml')
    await writeDocument(path, new TextEncoder().encode('<a/>').buffer as ArrayBuffer)
    await chmod(path, 0o444)

    const result = await statDocument(path)
    expect(result.readOnly).toBe(true)

    // Restore write access so the temp-dir cleanup in `afterEach` can
    // actually remove it — a read-only file left behind would otherwise
    // fail `rm` on some platforms.
    await chmod(path, 0o644)
  })

  it('rejects for a path that does not exist, rather than reporting a fake stat', async () => {
    const dir = await makeTempDir()
    await expect(statDocument(join(dir, 'missing.xml'))).rejects.toThrow()
  })

  // R220: IPC delivers only the message, so the kind has to be in it.
  it('tags a missing file as missing', async () => {
    const dir = await makeTempDir()
    expect(await kindOfRejection(statDocument(join(dir, 'missing.xml')))).toBe('missing')
  })

  it('refuses a folder, which stat alone would report as a file of some size', async () => {
    const dir = await makeTempDir()
    expect(await kindOfRejection(statDocument(dir))).toBe('folder')
  })
})

describe('writeDocument', () => {
  it('writes exactly the given bytes, verbatim', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'doc.xml')
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e]) // BOM + "<a/>"

    await writeDocument(path, bytes.buffer as ArrayBuffer)

    const written = await readFile(path)
    expect(Array.from(written)).toEqual(Array.from(bytes))
  })

  it('overwrites existing content rather than appending', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'doc.xml')
    await writeDocument(path, new TextEncoder().encode('<first/>').buffer as ArrayBuffer)
    await writeDocument(path, new TextEncoder().encode('<b/>').buffer as ArrayBuffer)

    const written = await readFile(path, 'utf-8')
    expect(written).toBe('<b/>')
  })

  it('rejects rather than silently failing when the target directory does not exist', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'nonexistent-subdir', 'doc.xml')
    await expect(
      writeDocument(path, new TextEncoder().encode('<a/>').buffer as ArrayBuffer)
    ).rejects.toThrow()
  })

  it('tags a vanished folder as missing (R220)', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'nonexistent-subdir', 'doc.xml')
    const write = writeDocument(path, new TextEncoder().encode('<a/>').buffer as ArrayBuffer)
    expect(await kindOfRejection(write)).toBe('missing')
  })

  it.runIf(process.platform === 'win32')(
    'tags a file another program holds as locked, and leaves it untouched (R220)',
    async () => {
      const dir = await makeTempDir()
      const path = join(dir, 'held.csv')
      await writeDocument(path, new TextEncoder().encode('a,b').buffer as ArrayBuffer)
      const release = await holdWithoutSharing(path)
      try {
        const write = writeDocument(path, new TextEncoder().encode('x').buffer as ArrayBuffer)
        expect(await kindOfRejection(write)).toBe('locked')
      } finally {
        await release()
      }
      expect(await readFile(path, 'utf-8')).toBe('a,b')
    }
  )
})

/**
 * R237 (`docs/plans/R236-save-and-watch.md` §1) — Save checks for room before
 * it touches the file, and then writes the same file object in place.
 *
 * `writeFile` opens with `O_TRUNC` (Windows: `CREATE_ALWAYS`), so the original
 * is empty before the first byte is written: a full disk left the user with a
 * destroyed file, and the `full` message described a file already gone. And
 * `CREATE_ALWAYS` refuses an existing *hidden* file outright (`EPERM`).
 *
 * The fakes wrap the real file system rather than replacing it, so every test
 * still writes a real file and reads it back; only the call being studied is
 * faked.
 */
describe('R237 — writeDocument checks for room, then writes in place', () => {
  const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer

  /** The real file system with a log of the handle calls. `overrides`
   * replaces whole functions; `handleOverrides` replaces handle methods and
   * is given the real handle to delegate to. */
  function loggedFs(
    overrides: Partial<WriteDocumentFs> = {},
    handleOverrides: (real: WriteHandle) => Partial<WriteHandle> = () => ({})
  ): { fs: WriteDocumentFs; calls: string[] } {
    const calls: string[] = []
    const fs: WriteDocumentFs = {
      ...nodeWriteFs,
      open: async (path, flags) => {
        calls.push(`open ${flags}`)
        const real = await nodeWriteFs.open(path, flags)
        const faked = handleOverrides(real)
        return {
          truncate: async (len) => {
            calls.push(`truncate ${len}`)
            await (faked.truncate ?? ((l: number) => real.truncate(l)))(len)
          },
          write: async (buffer, offset, length, position) => {
            const result = await (faked.write ?? real.write.bind(real))(
              buffer,
              offset,
              length,
              position
            )
            calls.push(`write ${result.bytesWritten}@${position}`)
            return result
          },
          sync: async () => {
            calls.push('sync')
            await (faked.sync ?? (() => real.sync()))()
          },
          close: async () => {
            calls.push('close')
            await real.close()
          }
        }
      },
      ...overrides
    }
    return { fs, calls }
  }

  /** `statfs` reporting exactly `freeBytes` available. */
  const freeSpace = (freeBytes: number): Pick<WriteDocumentFs, 'statfs'> => ({
    statfs: async () => ({ bavail: freeBytes, bsize: 1 })
  })

  async function fileWith(text: string): Promise<string> {
    const path = join(await makeTempDir(), 'doc.json')
    await writeFile(path, text)
    return path
  }

  it('refuses a save the disk has no room for, with the full kind, before opening the file', async () => {
    const path = await fileWith('{"original":true}')
    const { fs, calls } = loggedFs(freeSpace(0))

    const write = writeDocument(path, encode('{"original":true,"longer":1}'), fs)

    expect(await kindOfRejection(write)).toBe('full')
    expect(await readFile(path, 'utf-8')).toBe('{"original":true}')
    expect(calls).toEqual([])
  })

  it('saves anyway when statfs itself fails', async () => {
    const path = await fileWith('{"a":1}')
    const { fs } = loggedFs({
      statfs: async () => {
        throw Object.assign(new Error('ENOSYS: function not implemented, statfs'), {
          code: 'ENOSYS'
        })
      }
    })

    await writeDocument(path, encode('{"a":2}'), fs)

    expect(await readFile(path, 'utf-8')).toBe('{"a":2}')
  })

  it('counts the space the old contents free: exactly enough saves, one byte less refuses', async () => {
    const before = '0123456789'
    const after = '0123456789abcdef' // six bytes more
    const enough = await fileWith(before)
    await writeDocument(enough, encode(after), loggedFs(freeSpace(6)).fs)
    expect(await readFile(enough, 'utf-8')).toBe(after)

    const short = await fileWith(before)
    const refused = writeDocument(short, encode(after), loggedFs(freeSpace(5)).fs)
    expect(await kindOfRejection(refused)).toBe('full')
    expect(await readFile(short, 'utf-8')).toBe(before)
  })

  it('needs the whole size for a file that does not exist yet', async () => {
    const dir = await makeTempDir()
    const bytes = encode('{"new":1}') // 9 bytes
    await writeDocument(join(dir, 'fits.json'), bytes, loggedFs(freeSpace(9)).fs)
    expect(await readFile(join(dir, 'fits.json'), 'utf-8')).toBe('{"new":1}')

    const refused = writeDocument(join(dir, 'short.json'), bytes, loggedFs(freeSpace(8)).fs)
    expect(await kindOfRejection(refused)).toBe('full')
    await expect(stat(join(dir, 'short.json'))).rejects.toThrow()
  })

  it.runIf(process.platform === 'win32')(
    'saves a hidden file on Windows, and it stays hidden',
    async () => {
      const path = await fileWith('{"a":1}')
      execFileSync('attrib', ['+h', path])

      await writeDocument(path, encode('{"a":2}'))

      expect(await readFile(path, 'utf-8')).toBe('{"a":2}')
      // `attrib` prints the attribute columns, then the path.
      const attributes = execFileSync('attrib', [path], { encoding: 'utf-8' }).split(path)[0]!
      expect(attributes).toContain('H')
    }
  )

  it('keeps the file object: the same inode or file ID', async () => {
    const path = await fileWith('{"a":1}')
    const before = (await stat(path, { bigint: true })).ino

    await writeDocument(path, encode('{"a":2}'))

    expect((await stat(path, { bigint: true })).ino).toBe(before)
  })

  it.runIf(process.platform !== 'win32')('keeps the mode bits on POSIX', async () => {
    const path = await fileWith('{"a":1}')
    await chmod(path, 0o640)

    await writeDocument(path, encode('{"a":2}'))

    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })

  it('keeps a hard link: both names read the new bytes', async () => {
    const path = await fileWith('{"a":1}')
    const other = join(dirname(path), 'other-name.json')
    await link(path, other)

    await writeDocument(path, encode('{"a":2}'))

    expect((await stat(path)).nlink).toBe(2)
    expect(await readFile(other, 'utf-8')).toBe('{"a":2}')
  })

  it('keeps a symlink a symlink, and writes through it to its target', async (ctx) => {
    const target = await fileWith('{"a":1}')
    const linkPath = join(dirname(target), 'via-link.json')
    try {
      await symlink(target, linkPath)
    } catch (err) {
      // Windows refuses to create one without developer mode or elevation.
      ctx.skip(`cannot create a symlink here: ${(err as Error).message}`)
    }

    await writeDocument(linkPath, encode('{"a":2}'))

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf-8')).toBe('{"a":2}')
  })

  it.runIf(process.platform === 'win32')('keeps an alternate data stream on Windows', async () => {
    const path = await fileWith('{"a":1}')
    await writeFile(`${path}:klados-test`, 'stream contents')

    await writeDocument(path, encode('{"a":2}'))

    expect(await readFile(path, 'utf-8')).toBe('{"a":2}')
    expect(await readFile(`${path}:klados-test`, 'utf-8')).toBe('stream contents')
  })

  it('leaves no old tail when the new contents are shorter', async () => {
    const path = await fileWith('x'.repeat(1000))

    await writeDocument(path, encode('0123456789'))

    expect(await readFile(path, 'utf-8')).toBe('0123456789')
  })

  it('truncates, writes from offset 0, flushes, then closes the one handle it opened', async () => {
    const path = await fileWith('{"a":1}')
    const { fs, calls } = loggedFs()

    await writeDocument(path, encode('{"a":22}'), fs)

    expect(calls).toEqual(['open r+', 'truncate 0', 'write 8@0', 'sync', 'close'])
  })

  it('creates a file that does not exist by falling back from r+ to w', async () => {
    const path = join(await makeTempDir(), 'new.json')
    const { fs, calls } = loggedFs()

    await writeDocument(path, encode('{}'), fs)

    expect(calls.slice(0, 2)).toEqual(['open r+', 'open w'])
    expect(await readFile(path, 'utf-8')).toBe('{}')
  })

  it('falls back to w only for a missing file: any other open failure touches nothing', async () => {
    // The real locked-file test above cannot tell these apart, because `w`
    // fails on a held file too. Here only `r+` fails, so a fallback on any
    // error would truncate the file `r+` was refused.
    const path = await fileWith('{"a":1}')
    const { fs, calls } = loggedFs()
    const loggedOpen = fs.open
    fs.open = async (p, flags) => {
      if (flags === 'r+') {
        calls.push('open r+')
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
      }
      return loggedOpen(p, flags)
    }

    const write = writeDocument(path, encode('{"a":2}'), fs)

    expect(await kindOfRejection(write)).toBe('denied')
    expect(calls).toEqual(['open r+'])
    expect(await readFile(path, 'utf-8')).toBe('{"a":1}')
  })

  it('keeps writing when the system writes fewer bytes than asked', async () => {
    const path = await fileWith('{"a":1}')
    const { fs, calls } = loggedFs({}, (real) => ({
      // Two bytes at a time, as a short write would.
      write: (buffer, offset, length, position) =>
        real.write(buffer, offset, Math.min(2, length), position)
    }))

    await writeDocument(path, encode('{"b":2}'), fs)

    expect(await readFile(path, 'utf-8')).toBe('{"b":2}')
    expect(calls.filter((c) => c.startsWith('write'))).toEqual([
      'write 2@0',
      'write 2@2',
      'write 2@4',
      'write 1@6'
    ])
  })

  it('writes a large buffer in pieces of at most WRITE_CHUNK_BYTES', async () => {
    // One call for a whole 200 MB buffer measured 5× slower than pieces.
    const path = await fileWith('{}')
    const size = WRITE_CHUNK_BYTES * 2 + 5
    const bytes = new Uint8Array(size).fill(0x20)
    const { fs, calls } = loggedFs()

    await writeDocument(path, bytes.buffer as ArrayBuffer, fs)

    expect(calls.filter((c) => c.startsWith('write'))).toEqual([
      `write ${WRITE_CHUNK_BYTES}@0`,
      `write ${WRITE_CHUNK_BYTES}@${WRITE_CHUNK_BYTES}`,
      `write 5@${WRITE_CHUNK_BYTES * 2}`
    ])
    expect((await stat(path)).size).toBe(size)
  })

  it('a failing flush is a failed save, and still closes the handle', async () => {
    const path = await fileWith('{"a":1}')
    const { fs, calls } = loggedFs({}, () => ({
      sync: async () => {
        throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' })
      }
    }))

    await expect(writeDocument(path, encode('{"a":2}'), fs)).rejects.toThrow(/EIO/)
    expect(calls.at(-1)).toBe('close')
  })

  it('closes the handle when the write fails part-way', async () => {
    const path = await fileWith('{"a":1}')
    const { fs, calls } = loggedFs({}, () => ({
      write: async () => {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
          code: 'ENOSPC'
        })
      }
    }))

    const write = writeDocument(path, encode('{"a":2}'), fs)

    expect(await kindOfRejection(write)).toBe('full')
    expect(calls.filter((c) => c.startsWith('open')).length).toBe(1)
    expect(calls.filter((c) => c === 'close').length).toBe(1)
  })
})

describe('handleReadTokenRequest', () => {
  it('serves the file at the token-mapped path with the right size and content-type', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'doc.xml')
    const bytes = new TextEncoder().encode('<a><b/></a>')
    await writeDocument(path, bytes.buffer as ArrayBuffer)

    const registry = createReadTokenRegistry(1000)
    const token = registry.mint(path)

    const response = await handleReadTokenRequest(new Request(`klados-file://${token}/`), registry)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    const body = new Uint8Array(await response.arrayBuffer())
    expect(Array.from(body)).toEqual(Array.from(bytes))
  })

  it('refuses an unknown token with 404, never falling through to a path', async () => {
    const registry = createReadTokenRegistry(1000)
    const response = await handleReadTokenRequest(
      new Request('klados-file://never-minted/'),
      registry
    )
    expect(response.status).toBe(404)
  })

  it('is single-use: a second request for the same token 404s', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'doc.xml')
    await writeDocument(path, new TextEncoder().encode('<a/>').buffer as ArrayBuffer)
    const registry = createReadTokenRegistry(1000)
    const token = registry.mint(path)

    const first = await handleReadTokenRequest(new Request(`klados-file://${token}/`), registry)
    expect(first.status).toBe(200)
    // Drain the body — otherwise the still-open stream can outlive the test.
    await first.arrayBuffer()

    const second = await handleReadTokenRequest(new Request(`klados-file://${token}/`), registry)
    expect(second.status).toBe(404)
  })

  it('refuses (404) rather than throwing when the token is valid but the file is gone', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'vanished.xml')
    const registry = createReadTokenRegistry(1000)
    const token = registry.mint(path) // never actually written

    const response = await handleReadTokenRequest(new Request(`klados-file://${token}/`), registry)
    expect(response.status).toBe(404)
    // R220: and says so, in the body the worker reads.
    expect(fileErrorFrom(await response.text())?.kind).toBe('missing')
  })

  /** R220: a request for path, answered — status and the kind in the body. */
  async function answer(path: string): Promise<{ status: number; kind: string | null }> {
    const registry = createReadTokenRegistry(1000)
    const token = registry.mint(path)
    const response = await handleReadTokenRequest(new Request(`klados-file://${token}/`), registry)
    const body = await response.text()
    return { status: response.status, kind: fileErrorFrom(body)?.kind ?? null }
  }

  it('refuses a folder as one — Windows opens a folder without complaint (R220)', async () => {
    const dir = await makeTempDir()
    expect(await answer(dir)).toEqual({ status: 409, kind: 'folder' })
  })

  it.runIf(canDenyByMode)('refuses a file it may not read as denied (R220)', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'secret.xml')
    await writeDocument(path, new TextEncoder().encode('<a/>').buffer as ArrayBuffer)
    await chmod(path, 0o000)
    try {
      expect(await answer(path)).toEqual({ status: 403, kind: 'denied' })
    } finally {
      await chmod(path, 0o644)
    }
  })

  it.runIf(process.platform === 'win32')(
    'refuses a file another program holds as locked, before any byte is sent (R220)',
    async () => {
      const dir = await makeTempDir()
      const path = join(dir, 'held.csv')
      await writeDocument(path, new TextEncoder().encode('a,b').buffer as ArrayBuffer)
      const release = await holdWithoutSharing(path)
      try {
        expect(await answer(path)).toEqual({ status: 423, kind: 'locked' })
      } finally {
        await release()
      }
    }
  )

  it('a URL naming a path directly rather than a token still resolves through the registry only — no path fallback', async () => {
    const dir = await makeTempDir()
    const path = join(dir, 'doc.xml')
    await writeDocument(path, new TextEncoder().encode('<a/>').buffer as ArrayBuffer)
    const registry = createReadTokenRegistry(1000)
    // Never minted for this "token" — an attacker-shaped URL trying to name
    // the path itself, exactly the oracle `documents.ts`'s header warns
    // against a naive handler being.
    const response = await handleReadTokenRequest(
      new Request(`klados-file://${encodeURIComponent(path)}/`),
      registry
    )
    expect(response.status).toBe(404)
  })
})
