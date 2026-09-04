/**
 * R68 (`R66-palette-polish.md` §3's own refinement) — `tooltipFor`
 * supplies the `Toggle ` verb an icon-only toggle button's stored title no
 * longer carries, exactly when `command.state` is set. R65 (`R65-shortcuts-help.md`
 * §2) — the chord shown is the effective one, not the shipped default.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resetKeybindingsStoreForTests, setKeybindings } from '../src/renderer/commands/keybindings'
import type { Command } from '../src/renderer/commands/registry'
import { tooltipFor } from '../src/renderer/commands/uiHelpers'

function command(overrides: Partial<Command> & Pick<Command, 'id' | 'title'>): Command {
  return {
    category: 'Test',
    surfaces: ['palette'],
    run: () => {},
    ...overrides
  }
}

afterEach(() => {
  resetKeybindingsStoreForTests()
})

describe('tooltipFor', () => {
  it('is just the title when there is no chord and no state', () => {
    expect(tooltipFor(command({ id: 'a', title: 'Save' }))).toBe('Save')
  })

  it('appends "(Chord)" when a chord exists', () => {
    setKeybindings([{ commandId: 'a', chord: ['Ctrl+S'] }])
    expect(tooltipFor(command({ id: 'a', title: 'Save' }))).toBe('Save (Ctrl+S)')
  })

  it('prefixes "Toggle " when state is set, even with no chord', () => {
    expect(tooltipFor(command({ id: 'a', title: 'Soft Wrap', state: () => true }))).toBe(
      'Toggle Soft Wrap'
    )
  })

  it('prefixes "Toggle " and appends the chord together', () => {
    setKeybindings([{ commandId: 'a', chord: ['Ctrl+Shift+W'] }])
    expect(tooltipFor(command({ id: 'a', title: 'Soft Wrap', state: () => false }))).toBe(
      'Toggle Soft Wrap (Ctrl+Shift+W)'
    )
  })

  it('reads the effective (overridden) chord, not the default', () => {
    setKeybindings([{ commandId: 'a', chord: ['Ctrl+Alt+T'] }])
    expect(tooltipFor(command({ id: 'a', title: 'Dark Theme', state: () => true }))).toBe(
      'Toggle Dark Theme (Ctrl+Alt+T)'
    )
  })
})
