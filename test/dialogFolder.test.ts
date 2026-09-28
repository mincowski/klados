/**
 * R221 (`docs/plans/R221-electron-44.md` § 3.2) — the Open dialog's folder,
 * remembered by Klados since Electron 43 stopped letting the OS do it.
 * Against a real file system, as `mainDocuments.test.ts` tests the other
 * Electron-free halves of `main/documents.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDialogFolder } from '../src/core/dialogFolder'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klados-r221-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe('the Open dialog remembers its folder (R221)', () => {
  it('remembers nothing until a file is chosen, leaving Electron its default', async () => {
    const profile = await tempDir()
    const folder = createDialogFolder(() => join(profile, 'dialog-state.json'))
    expect(await folder.defaultPath()).toBeUndefined()
  })

  it("starts in the chosen file's folder, across a restart", async () => {
    const profile = await tempDir()
    const docs = join(await tempDir(), 'Customer Projects')
    await mkdir(docs)
    const stateFile = (): string => join(profile, 'nested', 'dialog-state.json')

    await createDialogFolder(stateFile).remember(join(docs, 'orders.xml'))
    // A new instance reads only the file — what a relaunch sees.
    expect(await createDialogFolder(stateFile).defaultPath()).toBe(docs)
    expect(JSON.parse(await readFile(stateFile(), 'utf-8'))).toEqual({ folder: docs })
  })

  it('the latest choice wins', async () => {
    const profile = await tempDir()
    const [a, b] = [await tempDir(), await tempDir()]
    const folder = createDialogFolder(() => join(profile, 'dialog-state.json'))
    await folder.remember(join(a, 'x.json'))
    await folder.remember(join(b, 'y.json'))
    expect(await folder.defaultPath()).toBe(b)
  })

  it('forgets a folder that no longer exists, rather than handing the dialog a dead path', async () => {
    const profile = await tempDir()
    const gone = join(await tempDir(), 'moved-away')
    await mkdir(gone)
    const folder = createDialogFolder(() => join(profile, 'dialog-state.json'))
    await folder.remember(join(gone, 'a.csv'))
    await rm(gone, { recursive: true })
    expect(await folder.defaultPath()).toBeUndefined()
  })

  it.each([
    ['not JSON', 'nonsense'],
    ['no folder', '{}'],
    ['a folder that is not a string', '{"folder":42}'],
    ['an empty folder', '{"folder":""}']
  ])('ignores a state file with %s', async (_label, contents) => {
    const profile = await tempDir()
    await writeFile(join(profile, 'dialog-state.json'), contents)
    const folder = createDialogFolder(() => join(profile, 'dialog-state.json'))
    expect(await folder.defaultPath()).toBeUndefined()
  })

  it('a failed write is reported and never fails the open', async () => {
    const profile = await tempDir()
    // The state file's parent is a file, so neither mkdir nor write can succeed.
    await writeFile(join(profile, 'blocker'), '')
    const onWriteError = vi.fn()
    const folder = createDialogFolder(
      () => join(profile, 'blocker', 'dialog-state.json'),
      onWriteError
    )
    await expect(folder.remember(join(profile, 'a.xml'))).resolves.toBeUndefined()
    expect(onWriteError).toHaveBeenCalledOnce()
  })
})
