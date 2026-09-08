/**
 * R52 (`R51-main-process.md`) — `createDocumentWatcherRegistry`
 * against fake `stat`/`watch` implementations, never a real filesystem.
 * Covers exactly the behaviours the plan named: two tabs on the same path
 * share one underlying watcher, a key's own watch replaces whatever that
 * key was watching before, and a stale callback from a torn-down watcher
 * can't clobber a path it no longer owns.
 */
import { describe, expect, it, vi } from 'vitest'
import { createDocumentWatcherRegistry, type WatchHandle } from '../src/core/documentWatchers'

interface FakeFs {
  mtimes: Map<string, number>
  /** Every `WatchHandle` `watch()` handed out, keyed by path, in creation
   * order — a test fires `[path][n].fire()` to simulate the OS noticing
   * something, and reads `.closed` to confirm teardown. */
  watchersFor: Map<string, { fire: () => void; closed: boolean }[]>
}

function createFakeFs(): FakeFs & { deps: Parameters<typeof createDocumentWatcherRegistry>[0] } {
  const mtimes = new Map<string, number>()
  const watchersFor = new Map<string, { fire: () => void; closed: boolean }[]>()

  const deps = {
    stat: async (path: string): Promise<{ mtimeMs: number } | null> => {
      const mtimeMs = mtimes.get(path)
      return mtimeMs === undefined ? null : { mtimeMs }
    },
    watch: (path: string, onEvent: () => void): WatchHandle => {
      const record = { fire: onEvent, closed: false }
      const list = watchersFor.get(path) ?? []
      list.push(record)
      watchersFor.set(path, list)
      return {
        close: () => {
          record.closed = true
        }
      }
    }
  }

  return { mtimes, watchersFor, deps }
}

describe('createDocumentWatcherRegistry', () => {
  it('notifies the registered key when the file content actually changes', async () => {
    const fs = createFakeFs()
    fs.mtimes.set('C:/docs/a.json', 100)
    const registry = createDocumentWatcherRegistry(fs.deps)
    const onChange = vi.fn()

    await registry.watch('tab-1', 'C:/docs/a.json', onChange)
    fs.mtimes.set('C:/docs/a.json', 200)
    fs.watchersFor.get('C:/docs/a.json')![0]!.fire()
    await drainTaskQueue()

    expect(onChange).toHaveBeenCalledWith('tab-1')
  })

  it('does not notify on a spurious event with no mtime change', async () => {
    const fs = createFakeFs()
    fs.mtimes.set('C:/docs/a.json', 100)
    const registry = createDocumentWatcherRegistry(fs.deps)
    const onChange = vi.fn()

    await registry.watch('tab-1', 'C:/docs/a.json', onChange)
    fs.watchersFor.get('C:/docs/a.json')![0]!.fire() // mtime unchanged
    await drainTaskQueue()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('two keys watching the same path share one underlying watcher, and both are notified', async () => {
    const fs = createFakeFs()
    fs.mtimes.set('C:/docs/shared.json', 100)
    const registry = createDocumentWatcherRegistry(fs.deps)
    const onChangeA = vi.fn()
    const onChangeB = vi.fn()

    await registry.watch('tab-1', 'C:/docs/shared.json', onChangeA)
    await registry.watch('tab-2', 'C:/docs/shared.json', onChangeB)
    expect(fs.watchersFor.get('C:/docs/shared.json')).toHaveLength(1) // one real watcher

    fs.mtimes.set('C:/docs/shared.json', 200)
    fs.watchersFor.get('C:/docs/shared.json')![0]!.fire()
    await drainTaskQueue()

    expect(onChangeA).toHaveBeenCalledWith('tab-1')
    expect(onChangeB).toHaveBeenCalledWith('tab-2')
  })

  it('unwatching one of two keys on a shared path keeps the watcher open for the other', async () => {
    const fs = createFakeFs()
    fs.mtimes.set('C:/docs/shared.json', 100)
    const registry = createDocumentWatcherRegistry(fs.deps)
    const onChangeA = vi.fn()
    const onChangeB = vi.fn()

    await registry.watch('tab-1', 'C:/docs/shared.json', onChangeA)
    await registry.watch('tab-2', 'C:/docs/shared.json', onChangeB)
    registry.unwatch('tab-1')

    expect(fs.watchersFor.get('C:/docs/shared.json')![0]!.closed).toBe(false)

    fs.mtimes.set('C:/docs/shared.json', 200)
    fs.watchersFor.get('C:/docs/shared.json')![0]!.fire()
    await drainTaskQueue()

    expect(onChangeA).not.toHaveBeenCalled()
    expect(onChangeB).toHaveBeenCalledWith('tab-2')
  })

  it('unwatching the last key on a path closes the underlying watcher', async () => {
    const fs = createFakeFs()
    fs.mtimes.set('C:/docs/a.json', 100)
    const registry = createDocumentWatcherRegistry(fs.deps)

    await registry.watch('tab-1', 'C:/docs/a.json', vi.fn())
    registry.unwatch('tab-1')

    expect(fs.watchersFor.get('C:/docs/a.json')![0]!.closed).toBe(true)
  })

  it("a key's watch replaces whatever it was watching before, releasing the old path's refcount", async () => {
    const fs = createFakeFs()
    fs.mtimes.set('C:/docs/a.json', 100)
    fs.mtimes.set('C:/docs/b.json', 100)
    const registry = createDocumentWatcherRegistry(fs.deps)
    const onChange = vi.fn()

    await registry.watch('tab-1', 'C:/docs/a.json', onChange)
    await registry.watch('tab-1', 'C:/docs/b.json', onChange)

    // The old path's only watcher is closed — nothing is watching it anymore.
    expect(fs.watchersFor.get('C:/docs/a.json')![0]!.closed).toBe(true)

    fs.mtimes.set('C:/docs/a.json', 999) // a's own change must not fire
    fs.watchersFor.get('C:/docs/a.json')![0]!.fire()
    fs.mtimes.set('C:/docs/b.json', 200)
    fs.watchersFor.get('C:/docs/b.json')![0]!.fire()
    await drainTaskQueue()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('tab-1')
  })

  it("watching a path that cannot be stat'd is a no-op — nothing registered, no watcher started", async () => {
    const fs = createFakeFs() // no mtime set for the path — stat resolves null
    const registry = createDocumentWatcherRegistry(fs.deps)
    const onChange = vi.fn()

    await registry.watch('tab-1', 'C:/docs/missing.json', onChange)

    expect(fs.watchersFor.get('C:/docs/missing.json')).toBeUndefined()
    registry.unwatch('tab-1') // must not throw for a key that never actually registered
  })

  it('unwatch for an unknown key is a harmless no-op', () => {
    const fs = createFakeFs()
    const registry = createDocumentWatcherRegistry(fs.deps)
    expect(() => registry.unwatch('never-watched')).not.toThrow()
  })

  it('unwatchMatching releases every key the predicate accepts, and only those', async () => {
    const fs = createFakeFs()
    fs.mtimes.set('C:/docs/a.json', 100)
    fs.mtimes.set('C:/docs/b.json', 100)
    const registry = createDocumentWatcherRegistry(fs.deps)
    const onChangeA = vi.fn()
    const onChangeB = vi.fn()

    await registry.watch('window1-tab1', 'C:/docs/a.json', onChangeA)
    await registry.watch('window2-tab1', 'C:/docs/b.json', onChangeB)

    registry.unwatchMatching((key) => key.startsWith('window1'))

    expect(fs.watchersFor.get('C:/docs/a.json')![0]!.closed).toBe(true)
    expect(fs.watchersFor.get('C:/docs/b.json')![0]!.closed).toBe(false)
  })

  it('a stale callback from a torn-down-and-replaced watcher on the same path does not fire', async () => {
    const fs = createFakeFs()
    fs.mtimes.set('C:/docs/a.json', 100)
    const registry = createDocumentWatcherRegistry(fs.deps)
    const onChange = vi.fn()

    await registry.watch('tab-1', 'C:/docs/a.json', onChange)
    const staleWatcher = fs.watchersFor.get('C:/docs/a.json')![0]!

    registry.unwatch('tab-1') // closes the first watcher
    fs.mtimes.set('C:/docs/a.json', 200)
    await registry.watch('tab-2', 'C:/docs/a.json', onChange) // fresh entry, same path

    // The old (closed) watcher's callback still fires late — must not
    // clobber the fresh entry's own baseline or spuriously notify tab-2.
    staleWatcher.fire()
    await drainTaskQueue()

    expect(onChange).not.toHaveBeenCalled()
  })
})

/**
 * R160 (`docs/plans/R159-fixed-duration-waits.md` §5): renamed from
 * `flushMicrotasks`, which is what it was called and not what it did — the body
 * is two *macrotask* hops. The behaviour was right and the name was wrong,
 * which is this round's failure mode with the halves swapped.
 *
 * A macrotask boundary drains the whole microtask queue, and a watcher's
 * `fire()` handler awaits a real `stat` before deciding, so two turns cover the
 * registration and the decision. **It stays a drain rather than becoming a
 * condition because half these assertions are negative** — `not.toHaveBeenCalled`
 * has no condition to wait for, and giving the handler a bounded number of real
 * turns to misbehave in is the correct tool for it.
 */
async function drainTaskQueue(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
