import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetContextForTests, setContext } from '../src/renderer/commands/context'
import { registerCommand, resetCommandRegistryForTests } from '../src/renderer/commands/registry'
import {
  createKeymapController,
  DEFAULT_KEYBINDINGS,
  defaultChordFor,
  effectiveChordFor,
  formatChord,
  getKeybindings,
  loadKeybindings,
  normalizeKeyCombo,
  resetKeybindingsStoreForTests,
  saveKeybindingOverrides,
  setKeybindings,
  subscribeKeybindings,
  type KeyBinding,
  type KeymapController
} from '../src/renderer/commands/keybindings'

function keyEvent(init: {
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  const event = {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    preventDefault: vi.fn()
  }
  return event as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

describe('normalizeKeyCombo', () => {
  it('orders modifiers Ctrl, Alt, Shift, Meta and uppercases single-char keys', () => {
    expect(normalizeKeyCombo(keyEvent({ key: 'l', ctrlKey: true, shiftKey: true }))).toBe(
      'Ctrl+Shift+L'
    )
    expect(normalizeKeyCombo(keyEvent({ key: 'l', ctrlKey: true }))).toBe('Ctrl+L')
  })

  it('leaves multi-character key names (F6, Escape) as-is', () => {
    expect(normalizeKeyCombo(keyEvent({ key: 'F6' }))).toBe('F6')
    expect(normalizeKeyCombo(keyEvent({ key: 'F6', shiftKey: true }))).toBe('Shift+F6')
  })

  it('a bare modifier keypress is not a combo', () => {
    expect(normalizeKeyCombo(keyEvent({ key: 'Control', ctrlKey: true }))).toBeNull()
    expect(normalizeKeyCombo(keyEvent({ key: 'Shift', shiftKey: true }))).toBeNull()
  })
})

describe('formatChord', () => {
  it('joins a single combo as-is', () => {
    expect(formatChord(['Ctrl+O'])).toBe('Ctrl+O')
  })

  it('joins a two-part chord with a space', () => {
    expect(formatChord(['Ctrl+K', 'Ctrl+S'])).toBe('Ctrl+K Ctrl+S')
  })
})

describe('defaultChordFor', () => {
  it('finds the default chord for a bound command', () => {
    expect(defaultChordFor('klados.document.open')).toEqual(['Ctrl+O'])
  })

  it('returns null for an unbound command', () => {
    expect(defaultChordFor('klados.does.not.exist')).toBeNull()
  })
})

// R37 (`R35-tab-overflow.md` §4, D-067): `Alt+1`…`Alt+9`, not
// `Ctrl+1`…`Ctrl+9` (already pane focus). No two default bindings should
// ever collide, which is the general regression guard these fall under —
// specific enough to catch this round's own additions, general enough to
// catch the next one's.
describe('DEFAULT_KEYBINDINGS', () => {
  it('has no duplicate chords', () => {
    const chordKeys = DEFAULT_KEYBINDINGS.map((b) => b.chord.join(' '))
    expect(new Set(chordKeys).size).toBe(chordKeys.length)
  })

  it('binds Alt+1..Alt+8 to the numbered tab-select commands and Alt+9 to the last tab', () => {
    for (let i = 1; i <= 8; i++) {
      expect(defaultChordFor(`klados.tabs.select${i}`)).toEqual([`Alt+${i}`])
    }
    expect(defaultChordFor('klados.tabs.selectLast')).toEqual(['Alt+9'])
  })
})

describe('createKeymapController (D4)', () => {
  let controller: KeymapController
  const runA = vi.fn()
  const runB = vi.fn()
  const runWhenGated = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    resetCommandRegistryForTests()
    resetContextForTests()
    runA.mockClear()
    runB.mockClear()
    runWhenGated.mockClear()

    registerCommand({ id: 'a', title: 'A', category: 'Test', surfaces: ['palette'], run: runA })
    registerCommand({ id: 'b', title: 'B', category: 'Test', surfaces: ['palette'], run: runB })
    registerCommand({
      id: 'gated',
      title: 'Gated',
      category: 'Test',
      surfaces: ['palette'],
      when: 'focus == tree',
      run: runWhenGated
    })

    const bindings: KeyBinding[] = [
      { commandId: 'a', chord: ['Ctrl+A'] },
      { commandId: 'b', chord: ['Ctrl+K', 'Ctrl+S'] },
      { commandId: 'gated', chord: ['Ctrl+G'] }
    ]
    controller = createKeymapController(() => bindings)
  })

  afterEach(() => {
    controller.dispose()
    vi.useRealTimers()
  })

  it('fires a single-key binding and consumes the event', () => {
    const event = keyEvent({ key: 'a', ctrlKey: true })
    const handled = controller.handleKeyDown(event)
    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(runA).toHaveBeenCalledOnce()
  })

  it('an unbound combo is not consumed', () => {
    const event = keyEvent({ key: 'z', ctrlKey: true })
    expect(controller.handleKeyDown(event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('a two-part chord fires the right command', () => {
    const first = controller.handleKeyDown(keyEvent({ key: 'k', ctrlKey: true }))
    expect(first).toBe(true)
    expect(controller.pendingChord).toBe('Ctrl+K')
    expect(runB).not.toHaveBeenCalled()

    const second = controller.handleKeyDown(keyEvent({ key: 's', ctrlKey: true }))
    expect(second).toBe(true)
    expect(controller.pendingChord).toBeNull()
    expect(runB).toHaveBeenCalledOnce()
  })

  it('a mistyped chord cancels cleanly — no command fires, and pending state clears', () => {
    controller.handleKeyDown(keyEvent({ key: 'k', ctrlKey: true }))
    expect(controller.pendingChord).toBe('Ctrl+K')

    const mistyped = controller.handleKeyDown(keyEvent({ key: 'x', ctrlKey: true }))
    expect(mistyped).toBe(true) // consumed — see keybindings.ts's own comment on why
    expect(controller.pendingChord).toBeNull()
    expect(runA).not.toHaveBeenCalled()
    expect(runB).not.toHaveBeenCalled()

    // A fresh keypress afterward behaves normally, not as a phantom third chord key.
    const fresh = controller.handleKeyDown(keyEvent({ key: 'a', ctrlKey: true }))
    expect(fresh).toBe(true)
    expect(runA).toHaveBeenCalledOnce()
  })

  it('a pending chord auto-cancels after the timeout', () => {
    controller.handleKeyDown(keyEvent({ key: 'k', ctrlKey: true }))
    expect(controller.pendingChord).toBe('Ctrl+K')

    vi.advanceTimersByTime(1500)
    expect(controller.pendingChord).toBeNull()

    // The second chord key, now arriving after the timeout, is just an
    // unbound combo on its own — it must not complete the stale chord.
    const event = keyEvent({ key: 's', ctrlKey: true })
    expect(controller.handleKeyDown(event)).toBe(false)
    expect(runB).not.toHaveBeenCalled()
  })

  it('a binding whose command when is false does not fire, and the event is not consumed', () => {
    const event = keyEvent({ key: 'g', ctrlKey: true })
    expect(controller.handleKeyDown(event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(runWhenGated).not.toHaveBeenCalled()

    setContext('focus', 'tree')
    const secondEvent = keyEvent({ key: 'g', ctrlKey: true })
    expect(controller.handleKeyDown(secondEvent)).toBe(true)
    expect(runWhenGated).toHaveBeenCalledOnce()
  })

  it('a binding for an unregistered command id does nothing and is not consumed', () => {
    const dangling = createKeymapController(() => [{ commandId: 'nonexistent', chord: ['Ctrl+9'] }])
    const event = keyEvent({ key: '9', ctrlKey: true })
    expect(dangling.handleKeyDown(event)).toBe(false)
    dangling.dispose()
  })

  // The chord path has to agree with the single-key path above: a command
  // whose `when` is false lets the key through. Otherwise a disabled chord
  // swallows the first keypress *and* — since the pending branch consumes
  // unconditionally — the next one too.
  it('a chord whose command when is false does not start a pending chord', () => {
    const gatedChord = createKeymapController(() => [
      { commandId: 'gated', chord: ['Ctrl+K', 'Ctrl+S'] }
    ])
    const first = keyEvent({ key: 'k', ctrlKey: true })
    expect(gatedChord.handleKeyDown(first)).toBe(false)
    expect(first.preventDefault).not.toHaveBeenCalled()
    expect(gatedChord.pendingChord).toBeNull()

    // ...and the key that would have completed it is likewise untouched,
    // rather than being eaten by a chord that never should have started.
    const second = keyEvent({ key: 's', ctrlKey: true })
    expect(gatedChord.handleKeyDown(second)).toBe(false)
    expect(runWhenGated).not.toHaveBeenCalled()

    setContext('focus', 'tree')
    expect(gatedChord.handleKeyDown(keyEvent({ key: 'k', ctrlKey: true }))).toBe(true)
    expect(gatedChord.pendingChord).toBe('Ctrl+K')
    expect(gatedChord.handleKeyDown(keyEvent({ key: 's', ctrlKey: true }))).toBe(true)
    expect(runWhenGated).toHaveBeenCalledOnce()

    gatedChord.dispose()
  })
})

describe('keybindings persistence (D4)', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    ;(globalThis as { window?: typeof window }).window = originalWindow
  })

  it('loadKeybindings falls back to defaults when window.api is unavailable', async () => {
    ;(globalThis as { window?: unknown }).window = undefined
    const bindings = await loadKeybindings()
    expect(bindings.find((b) => b.commandId === 'klados.theme.toggle')?.chord).toEqual([
      'Ctrl+Shift+L'
    ])
  })

  it('loadKeybindings merges a persisted override on top of the defaults', async () => {
    const read = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify([{ commandId: 'klados.theme.toggle', chord: ['Ctrl+Alt+T'] }])
      )
    ;(globalThis as { window?: unknown }).window = {
      api: { keybindings: { read, write: vi.fn() } }
    }

    const bindings = await loadKeybindings()
    expect(bindings.find((b) => b.commandId === 'klados.theme.toggle')?.chord).toEqual([
      'Ctrl+Alt+T'
    ])
    // Everything not overridden survives untouched.
    expect(bindings.find((b) => b.commandId === 'klados.focus.next')?.chord).toEqual(['F6'])
  })

  it('loadKeybindings degrades to defaults on a malformed override file', async () => {
    const read = vi.fn().mockResolvedValue('{ not valid json')
    ;(globalThis as { window?: unknown }).window = {
      api: { keybindings: { read, write: vi.fn() } }
    }

    const bindings = await loadKeybindings()
    expect(bindings.find((b) => b.commandId === 'klados.theme.toggle')?.chord).toEqual([
      'Ctrl+Shift+L'
    ])
  })

  it('saveKeybindingOverrides writes through the api and is a no-op without it', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as { window?: unknown }).window = {
      api: { keybindings: { read: vi.fn(), write } }
    }

    await saveKeybindingOverrides([{ commandId: 'klados.theme.toggle', chord: ['Ctrl+Alt+T'] }])
    expect(write).toHaveBeenCalledWith(
      JSON.stringify([{ commandId: 'klados.theme.toggle', chord: ['Ctrl+Alt+T'] }], null, 2)
    )

    ;(globalThis as { window?: unknown }).window = undefined
    await expect(saveKeybindingOverrides([])).resolves.toBeUndefined()
  })
})

// R65 (`R65-shortcuts-help.md` §2) — the effective-bindings store.
// Before this existed, the loaded (possibly user-overridden) result lived
// only in `App.tsx`'s own private closure; every display surface read
// `DEFAULT_KEYBINDINGS` instead and could silently show the wrong chord.
describe('the effective-keybindings store (R65 §2)', () => {
  afterEach(() => {
    resetKeybindingsStoreForTests()
  })

  it('getKeybindings() is DEFAULT_KEYBINDINGS before anything sets it', () => {
    expect(getKeybindings()).toBe(DEFAULT_KEYBINDINGS)
  })

  it('setKeybindings() replaces the store and notifies subscribers', () => {
    const override: readonly KeyBinding[] = [
      { commandId: 'klados.theme.toggle', chord: ['Ctrl+Alt+T'] }
    ]
    let notified = 0
    const unsubscribe = subscribeKeybindings(() => notified++)

    setKeybindings(override)

    expect(getKeybindings()).toBe(override)
    expect(notified).toBe(1)
    unsubscribe()
  })

  it('effectiveChordFor reads the live store, not DEFAULT_KEYBINDINGS', () => {
    expect(effectiveChordFor('klados.theme.toggle')).toEqual(['Ctrl+Shift+L']) // the shipped default, before any override

    setKeybindings([{ commandId: 'klados.theme.toggle', chord: ['Ctrl+Alt+T'] }])
    expect(effectiveChordFor('klados.theme.toggle')).toEqual(['Ctrl+Alt+T'])
    // defaultChordFor is unmoved by the override — the two are deliberately
    // different functions, per this module's own doc comments.
    expect(defaultChordFor('klados.theme.toggle')).toEqual(['Ctrl+Shift+L'])
  })

  it('effectiveChordFor returns null for a command with no binding, in either store', () => {
    expect(effectiveChordFor('klados.does.not.exist')).toBeNull()
  })
})
