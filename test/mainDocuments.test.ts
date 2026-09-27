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
import { mkdtemp, rm, chmod, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { statDocument, writeDocument } from '../src/core/mainDocumentIO'
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
