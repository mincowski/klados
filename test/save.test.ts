import { describe, expect, it, vi } from 'vitest'
import { saveDocument } from '../src/renderer/session/save'

function fakeApi(
  write: (path: string, bytes: ArrayBuffer) => Promise<void>
): Parameters<typeof saveDocument>[0] {
  return { document: { write } } as Parameters<typeof saveDocument>[0]
}

describe('saveDocument', () => {
  it('writes the exact bytes handed to it, unmodified', async () => {
    const original = new TextEncoder().encode('<root>hello</root>')
    let written: ArrayBuffer | null = null
    const api = fakeApi(async (_path, bytes) => {
      written = bytes
    })

    const outcome = await saveDocument(api, { path: 'C:/docs/a.xml', bytes: original })

    expect(outcome).toEqual({ ok: true })
    expect(written).not.toBeNull()
    expect(new Uint8Array(written!)).toEqual(original)
  })

  it('passes the exact path through', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const api = fakeApi(write)
    await saveDocument(api, { path: 'C:/docs/exact-path.json', bytes: new Uint8Array([1, 2, 3]) })
    expect(write).toHaveBeenCalledWith('C:/docs/exact-path.json', expect.anything())
  })

  it('turns a rejected write into a message-carrying failure, not a thrown error', async () => {
    const api = fakeApi(async () => {
      throw new Error('disk full')
    })
    const outcome = await saveDocument(api, { path: 'C:/docs/a.xml', bytes: new Uint8Array() })
    expect(outcome).toEqual({ ok: false, message: 'disk full' })
  })

  it("copies the bytes rather than handing over the caller's own buffer view", async () => {
    // `.slice()` before crossing the IPC boundary — mutating the source
    // array after the call must not retroactively change what was "sent".
    const source = new Uint8Array([1, 2, 3])
    let written: ArrayBuffer | null = null
    const api = fakeApi(async (_path, bytes) => {
      written = bytes
    })
    await saveDocument(api, { path: 'C:/docs/a.xml', bytes: source })
    source[0] = 99
    expect(new Uint8Array(written!)).toEqual(new Uint8Array([1, 2, 3]))
  })
})
