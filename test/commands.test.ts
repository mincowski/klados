import { beforeEach, describe, expect, it } from 'vitest'
import {
  evaluateContextExpression,
  getContext,
  resetContextForTests,
  setContext,
  type ContextKeys
} from '../src/renderer/commands/context'
import {
  commandsForSurface,
  getAllCommands,
  getCommand,
  isCommandEnabled,
  registerCommand,
  resetCommandRegistryForTests,
  type Command
} from '../src/renderer/commands/registry'
import { resolveIcon } from '../src/renderer/commands/icons'

function command(overrides: Partial<Command> & Pick<Command, 'id'>): Command {
  return {
    title: overrides.id,
    category: 'Test',
    surfaces: ['palette'],
    run: () => {},
    ...overrides
  }
}

describe('command registry (D3)', () => {
  beforeEach(() => {
    resetCommandRegistryForTests()
    resetContextForTests()
  })

  it('registers and retrieves a command by id', () => {
    registerCommand(command({ id: 'a' }))
    expect(getCommand('a')?.id).toBe('a')
    expect(getAllCommands()).toHaveLength(1)
  })

  it('throws on a duplicate id', () => {
    registerCommand(command({ id: 'dup' }))
    expect(() => registerCommand(command({ id: 'dup' }))).toThrow(/duplicate/i)
  })

  // A malformed `when` used to surface as a throw from whichever surface
  // queried the registry first, taking down the palette, the command bar
  // and every pane header at once — arbitrarily far from the typo that
  // caused it. Compiling at registration moves the failure to the
  // definition, and means no surface can be broken by one bad command.
  it('rejects a malformed when at registration, not at query time', () => {
    expect(() => registerCommand(command({ id: 'bad', when: 'focus ==' }))).toThrow()
    expect(getCommand('bad')).toBeUndefined()

    registerCommand(command({ id: 'good', when: 'focus == tree' }))
    expect(() => commandsForSurface('palette', getContext())).not.toThrow()
  })

  it('commandsForSurface filters by surface', () => {
    registerCommand(command({ id: 'a', surfaces: ['palette'] }))
    registerCommand(command({ id: 'b', surfaces: ['palette', 'titleBar'] }))
    registerCommand(command({ id: 'c', surfaces: ['contextMenu'] }))
    expect(commandsForSurface('titleBar', getContext()).map((c) => c.id)).toEqual(['b'])
    expect(
      commandsForSurface('palette', getContext())
        .map((c) => c.id)
        .sort()
    ).toEqual(['a', 'b'])
  })

  it('commandsForSurface filters by when against the live context', () => {
    registerCommand(command({ id: 'treeOnly', when: 'focus == tree' }))
    registerCommand(command({ id: 'always' }))

    expect(
      commandsForSurface('palette', getContext())
        .map((c) => c.id)
        .sort()
    ).toEqual(['always'])

    setContext('focus', 'tree')
    expect(
      commandsForSurface('palette', getContext())
        .map((c) => c.id)
        .sort()
    ).toEqual(['always', 'treeOnly'])
  })

  it('commandsForSurface orders by weight, registration order breaking ties', () => {
    registerCommand(command({ id: 'c', weight: 2 }))
    registerCommand(command({ id: 'a', weight: 1 }))
    registerCommand(command({ id: 'b', weight: 1 }))
    expect(commandsForSurface('palette', getContext()).map((cmd) => cmd.id)).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  // The invariant itself (CONCEPT.md §7): not enforced by a throw in
  // registerCommand (see registry.ts's own comment on why), but by this
  // test running over whatever is actually registered — including every
  // real command module in the app, once `commands/builtins.ts` and later
  // view-owned command modules are imported for their side effects.
  it('every command reachable from any surface is reachable from the palette', async () => {
    resetCommandRegistryForTests()
    await import('../src/renderer/commands/builtins')

    for (const cmd of getAllCommands()) {
      if (cmd.surfaces.length === 0) continue
      expect(cmd.surfaces, `${cmd.id} is not reachable from the palette`).toContain('palette')
    }
    expect(getAllCommands().length).toBeGreaterThan(0)
  })
})

describe('context store', () => {
  beforeEach(() => resetContextForTests())

  it('setContext updates the snapshot and notifies subscribers, but not on a no-op set', () => {
    const before = getContext()
    setContext('hasSelection', true)
    expect(getContext().hasSelection).toBe(true)
    expect(getContext()).not.toBe(before)

    const after = getContext()
    setContext('hasSelection', true) // unchanged
    expect(getContext()).toBe(after)
  })
})

describe('evaluateContextExpression (D3)', () => {
  const base: ContextKeys = {
    focus: 'tree',
    format: 'xml',
    nodeKind: 'Element',
    hasSelection: true,
    hasDiagnostics: false,
    isReadOnly: true,
    isWrapped: false,
    canGoBack: false,
    canGoForward: false,
    canUndo: false,
    canRedo: false,
    isDirty: false,
    hasExternalChange: false,
    canFormat: false,
    hasPendingTransform: false,
    hasPendingCloseTab: false,
    hasPendingQuit: false,
    hasRecentFiles: false
  }

  it('bare truthiness', () => {
    expect(evaluateContextExpression('hasSelection', base)).toBe(true)
    expect(evaluateContextExpression('isWrapped', base)).toBe(false)
  })

  it('equality against an unquoted identifier literal', () => {
    expect(evaluateContextExpression('focus == tree', base)).toBe(true)
    expect(evaluateContextExpression('focus == raw', base)).toBe(false)
  })

  it('equality against a quoted string literal', () => {
    expect(evaluateContextExpression("format == 'xml'", base)).toBe(true)
    expect(evaluateContextExpression('format == "json"', base)).toBe(false)
  })

  it('!=', () => {
    expect(evaluateContextExpression('focus != raw', base)).toBe(true)
    expect(evaluateContextExpression('focus != tree', base)).toBe(false)
  })

  it('negation', () => {
    expect(evaluateContextExpression('!isWrapped', base)).toBe(true)
    expect(evaluateContextExpression('!hasSelection', base)).toBe(false)
  })

  it('&& and ||', () => {
    expect(evaluateContextExpression('focus == tree && hasSelection', base)).toBe(true)
    expect(evaluateContextExpression('focus == tree && isWrapped', base)).toBe(false)
    expect(evaluateContextExpression('focus == raw || hasSelection', base)).toBe(true)
    expect(evaluateContextExpression('focus == raw || isWrapped', base)).toBe(false)
  })

  it('precedence: && binds tighter than ||', () => {
    // (false && true) || true -> true, NOT false && (true || true) -> false
    expect(evaluateContextExpression('isWrapped && hasSelection || isReadOnly', base)).toBe(true)
  })

  it('precedence: ! binds tighter than &&', () => {
    // (!isWrapped) && hasSelection -> true && true -> true
    expect(evaluateContextExpression('!isWrapped && hasSelection', base)).toBe(true)
    // !(isWrapped && hasSelection) would also be true here, so use a case that discriminates:
    const other: ContextKeys = { ...base, hasSelection: false }
    // (!isWrapped) && hasSelection -> true && false -> false
    expect(evaluateContextExpression('!isWrapped && hasSelection', other)).toBe(false)
    // !(isWrapped && hasSelection) -> !(false && false) -> true
    expect(evaluateContextExpression('!(isWrapped && hasSelection)', other)).toBe(true)
  })

  it('parentheses override precedence', () => {
    // isWrapped && (hasSelection || isReadOnly) -> false && true -> false
    expect(evaluateContextExpression('isWrapped && (hasSelection || isReadOnly)', base)).toBe(false)
  })

  it('throws on malformed input', () => {
    expect(() => evaluateContextExpression('focus ==', base)).toThrow()
    expect(() => evaluateContextExpression('&& focus', base)).toThrow()
    expect(() => evaluateContextExpression('(focus == tree', base)).toThrow()
    expect(() => evaluateContextExpression('tree == focus == raw', base)).toThrow()
  })
})

// M5e-PLAN.md R8 — the real, currently-registered commands, per the
// `builtins.ts` import instruction above rather than synthetic fixtures.
describe('R8 fixes', () => {
  // Deliberately does not `resetCommandRegistryForTests()`: `builtins.ts`'s
  // dynamic import is cached after its first load (by this file's own
  // "every command reachable" test, or by this `beforeEach` if that test
  // didn't run first) — resetting here would wipe the registry with no way
  // to repopulate it, since a second `import()` of an already-loaded
  // module is a no-op.
  beforeEach(async () => {
    resetContextForTests()
    await import('../src/renderer/commands/builtins')
  })

  // 8b: Save used to render enabled with nothing to save — `enabledWhen`
  // now requires `isDirty` too, not just `!isReadOnly`.
  it('Save is disabled when clean, enabled when dirty', () => {
    const save = getCommand('klados.document.save')
    expect(save).toBeDefined()
    const clean: ContextKeys = { ...getContext(), isDirty: false, isReadOnly: false }
    const dirty: ContextKeys = { ...getContext(), isDirty: true, isReadOnly: false }
    expect(isCommandEnabled(save!, clean)).toBe(false)
    expect(isCommandEnabled(save!, dirty)).toBe(true)
    // D-056: disabled, not hidden — `when` must still pass on a clean,
    // writable document, or the button would vanish instead of grey out.
    expect(evaluateContextExpression(save!.when ?? 'true', clean)).toBe(true)
  })

  // 8d: the Detail toggle's icon used to be `document` — shared with no
  // other title-bar icon and reads as "new page." Now `apps-list-detail`,
  // resolvable and distinct from Tree/Raw's own icons.
  it('Toggle Detail Pane uses a distinct, resolvable icon', () => {
    const toggleDetail = getCommand('klados.layout.toggleDetail')
    const toggleTree = getCommand('klados.layout.toggleTree')
    const toggleRaw = getCommand('klados.layout.toggleRaw')
    expect(toggleDetail?.icon).toBe('apps-list-detail')
    expect(resolveIcon(toggleDetail!.icon!)).toBeTruthy()
    expect(toggleDetail?.icon).not.toBe(toggleTree?.icon)
    expect(toggleDetail?.icon).not.toBe(toggleRaw?.icon)
    expect(resolveIcon('apps-list-detail')).not.toBe(resolveIcon('folder-open'))
  })
})

// M5e-PLAN.md R9 — the pretty-print button. D-057 already settled the
// placement (Raw pane header); R11 made `canFormat` true for XML, which is
// what actually unblocks this. The command itself (`requestTransform`) was
// already exercised by M5-PLAN.md's H4-H8 tests — this only covers what R9
// adds: the `paneHeader`/`pane: 'raw'` surfacing and its icon.
describe('R9 — Format button in the Raw pane header', () => {
  beforeEach(async () => {
    resetContextForTests()
    await import('../src/renderer/commands/builtins')
  })

  function rawPaneHeaderCommands(context: ContextKeys): Command[] {
    return commandsForSurface('paneHeader', context).filter((command) => command.pane === 'raw')
  }

  it('is registered with a resolvable icon, reachable from the palette too (invariant 10)', () => {
    const format = getCommand('klados.document.format')
    expect(format).toBeDefined()
    expect(format!.pane).toBe('raw')
    expect(format!.surfaces).toContain('paneHeader')
    expect(format!.surfaces).toContain('palette')
    expect(resolveIcon(format!.icon!)).toBeTruthy()
  })

  it('appears in the Raw pane header when the document can be formatted and is writable', () => {
    const context: ContextKeys = { ...getContext(), canFormat: true, isReadOnly: false }
    const ids = rawPaneHeaderCommands(context).map((c) => c.id)
    expect(ids).toContain('klados.document.format')
  })

  it('is hidden (not just disabled) when the format has no formatter, or the document is read-only', () => {
    const noFormatter: ContextKeys = { ...getContext(), canFormat: false, isReadOnly: false }
    const readOnly: ContextKeys = { ...getContext(), canFormat: true, isReadOnly: true }
    expect(rawPaneHeaderCommands(noFormatter).map((c) => c.id)).not.toContain(
      'klados.document.format'
    )
    expect(rawPaneHeaderCommands(readOnly).map((c) => c.id)).not.toContain('klados.document.format')
  })

  it('does not appear in the Tree or Detail pane headers', () => {
    const context: ContextKeys = { ...getContext(), canFormat: true, isReadOnly: false }
    const treeIds = commandsForSurface('paneHeader', context)
      .filter((c) => c.pane === 'tree')
      .map((c) => c.id)
    const detailIds = commandsForSurface('paneHeader', context)
      .filter((c) => c.pane === 'detail')
      .map((c) => c.id)
    expect(treeIds).not.toContain('klados.document.format')
    expect(detailIds).not.toContain('klados.document.format')
  })
})

// R71 (`R71-text-as-icons.md` §5b, acceptance 1) — the six symbol-
// block glyphs replaced (status bar: ⓘ/⚠/⊗; Find bar: ↑/↓/✕; the
// shortcuts panel's own close button: ✕), referenced directly via
// `<Icon name="...">` rather than a `Command.icon` field, so they need
// their own resolution check — R38's own shape (`resolveIcon(icon!)` off a
// found command) doesn't reach them.
describe('R71 — the six replacement icons all resolve', () => {
  for (const name of ['info', 'warning', 'error-circle', 'arrow-up', 'arrow-down', 'dismiss']) {
    it(`"${name}" resolves through resolveIcon`, () => {
      expect(resolveIcon(name)).toBeTruthy()
    })
  }
})
