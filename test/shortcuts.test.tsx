/**
 * R65 (`R65-shortcuts-help.md`) — the shortcuts panel. Real Chromium
 * via `react-dom/client` (`test/notifications.test.tsx`'s own pattern) for
 * the same reason: focus containment and computed-style border assertions
 * both need real layout and real focus, which jsdom fakes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import {
  createKeymapController,
  DEFAULT_KEYBINDINGS,
  resetKeybindingsStoreForTests,
  setKeybindings
} from '../src/renderer/commands/keybindings'
import { getAllCommands } from '../src/renderer/commands/registry'
import { Shortcuts } from '../src/renderer/components/Help/Shortcuts'
import {
  closeShortcuts,
  openShortcuts,
  resetShortcutsStoreForTests
} from '../src/renderer/components/Help/shortcutsStore'
// Static, once per file — `test/notifications.test.tsx`'s own reasoning:
// registers every built-in command, including `klados.help.shortcuts`
// itself, as an import side effect.
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Help/Shortcuts.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetShortcutsStoreForTests()
  resetKeybindingsStoreForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetShortcutsStoreForTests()
  resetKeybindingsStoreForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

describe('R65 §6 acceptance 1 — every bound command appears in the panel', () => {
  it('every DEFAULT_KEYBINDINGS entry resolves to a registered, palette-surfaced command the panel renders', async () => {
    openShortcuts()
    await paint(<Shortcuts />)
    const text = container.textContent ?? ''

    for (const binding of DEFAULT_KEYBINDINGS) {
      const command = getAllCommands().find((c) => c.id === binding.commandId)
      expect(command, `${binding.commandId} is registered`).toBeDefined()
      expect(command!.surfaces, `${binding.commandId} is palette-surfaced`).toContain('palette')
      expect(text, `${binding.commandId} ("${command!.title}") renders in the panel`).toContain(
        command!.title
      )
    }
  })
})

describe('R65 §6 acceptance 2 — the panel shows the effective binding, not the default', () => {
  it('renders an overridden chord instead of the shipped default', async () => {
    openShortcuts()
    await paint(<Shortcuts />)
    expect(container.textContent).toContain('Ctrl+Shift+L') // the shipped default for Dark Theme

    setKeybindings([{ commandId: 'klados.theme.toggle', chord: ['Ctrl+Alt+T'] }])
    await paint(<Shortcuts />)

    expect(container.textContent).toContain('Ctrl+Alt+T')
    expect(container.textContent).not.toContain('Ctrl+Shift+L')
  })
})

describe('R65 §6 acceptance 3 — opening, closing, and focus restoration', () => {
  it('renders nothing while closed', async () => {
    await paint(<Shortcuts />)
    expect(container.querySelector('.shortcuts-panel')).toBeNull()
  })

  it('opens (via the store, as the palette command and F1 both do) and closes on Escape, restoring focus', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    openShortcuts()
    await paint(<Shortcuts />)
    expect(container.querySelector('.shortcuts-panel')).not.toBeNull()

    const panel = container.querySelector('.shortcuts-panel')!
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await paint(<Shortcuts />)

    expect(container.querySelector('.shortcuts-panel')).toBeNull()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('F1, through the real keymap controller and DEFAULT_KEYBINDINGS, opens the panel', async () => {
    const controller = createKeymapController(() => DEFAULT_KEYBINDINGS)
    const handled = controller.handleKeyDown(
      new KeyboardEvent('keydown', { key: 'F1' }) as KeyboardEvent
    )
    expect(handled).toBe(true)
    await paint(<Shortcuts />)
    expect(container.querySelector('.shortcuts-panel')).not.toBeNull()
    controller.dispose()
    closeShortcuts()
  })

  it('the klados.help.shortcuts command itself opens the panel', async () => {
    const command = getAllCommands().find((c) => c.id === 'klados.help.shortcuts')!
    expect(command.title).toBe('Help: Shortcuts')
    command.run({} as never)
    expect(container.textContent).toBe('') // not painted yet
    await paint(<Shortcuts />)
    expect(container.querySelector('.shortcuts-panel')).not.toBeNull()
    closeShortcuts()
  })
})

describe('R65 §6 acceptance 4 — the panel is an elevated surface with a real border (R60)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`.shortcuts-panel resolves a non-none border in ${theme}`, async () => {
      document.documentElement.dataset.theme = theme
      openShortcuts()
      await paint(<Shortcuts />)

      const panel = container.querySelector('.shortcuts-panel')!
      const style = getComputedStyle(panel)
      expect(style.borderTopStyle).not.toBe('none')
      expect(style.borderTopColor).not.toBe('rgba(0, 0, 0, 0)')
    })
  }
})
