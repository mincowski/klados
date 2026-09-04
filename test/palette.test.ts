import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getContext, resetContextForTests, setContext } from '../src/renderer/commands/context'
import {
  commandsForSurface,
  registerCommand,
  resetCommandRegistryForTests,
  type Command
} from '../src/renderer/commands/registry'
import {
  fuzzyMatch,
  getRecencyRank,
  paletteLabel,
  paneForPaletteJump,
  parsePaletteInput,
  rankCommands,
  recordRecentCommand,
  resetPaletteRecencyForTests
} from '../src/renderer/components/Palette/paletteLogic'
import {
  closePalette,
  isPaletteOpen,
  openPalette,
  resetPaletteStoreForTests,
  subscribePaletteOpen,
  togglePalette
} from '../src/renderer/components/Palette/paletteStore'

// `paletteLogic`'s recency functions read/write `localStorage`, which
// doesn't exist under Vitest's default node environment (same reasoning as
// `theme.test.ts`'s `fakeStorage`) — installed once, at module scope, since
// `paletteLogic` is imported statically above rather than per-test.
function fakeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    }
  } as Storage
}
;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()

function command(overrides: Partial<Command> & Pick<Command, 'id' | 'title'>): Command {
  return {
    category: 'Test',
    surfaces: ['palette'],
    run: () => {},
    ...overrides
  }
}

describe('parsePaletteInput (D5)', () => {
  it('no prefix is command mode, unchanged query', () => {
    expect(parsePaletteInput('toggle theme')).toEqual({ mode: 'command', query: 'toggle theme' })
  })

  it('an explicit > is stripped but still command mode', () => {
    expect(parsePaletteInput('>toggle theme')).toEqual({ mode: 'command', query: 'toggle theme' })
  })

  it('@ is jump-to-node mode, prefix stripped', () => {
    expect(parsePaletteInput('@car')).toEqual({ mode: 'jumpToNode', query: 'car' })
  })

  it(': is go-to-position mode, prefix stripped', () => {
    expect(parsePaletteInput(':42')).toEqual({ mode: 'goToPosition', query: '42' })
  })

  it('empty input is command mode with an empty query', () => {
    expect(parsePaletteInput('')).toEqual({ mode: 'command', query: '' })
  })

  it('/ is path query mode, prefix stripped (M4-PLAN.md G9)', () => {
    expect(parsePaletteInput('/cars/car')).toEqual({ mode: 'pathQuery', query: 'cars/car' })
  })
})

describe('fuzzyMatch (D5)', () => {
  it('an empty query matches everything with score 0', () => {
    expect(fuzzyMatch('', 'Toggle Theme')).toEqual({ score: 0, indices: [] })
  })

  it('matches a subsequence regardless of case', () => {
    const match = fuzzyMatch('tgl', 'Toggle')
    expect(match).not.toBeNull()
    expect(match!.indices).toEqual([0, 2, 4])
  })

  it('does not match when the query characters are out of order', () => {
    expect(fuzzyMatch('gto', 'Toggle')).toBeNull()
  })

  it('does not match when a query character is missing entirely', () => {
    expect(fuzzyMatch('tglz', 'Toggle')).toBeNull()
  })

  it('scores a contiguous match higher than a scattered one for the same query', () => {
    const contiguous = fuzzyMatch('tog', 'Toggle Theme')!
    const scattered = fuzzyMatch('tom', 'Toggle Theme')! // T-o-...-M(theme)
    expect(contiguous.score).toBeGreaterThan(scattered.score)
  })

  it('scores an earlier match higher than the same query matching later', () => {
    const early = fuzzyMatch('foc', 'Focus Tree')!
    const late = fuzzyMatch('foc', 'Unfocus Tree')!
    expect(early.score).toBeGreaterThan(late.score)
  })
})

describe('rankCommands (D5)', () => {
  const noRecency = (): number => -1

  it('every registered command is reachable by an empty query', () => {
    const commands = [command({ id: 'a', title: 'Alpha' }), command({ id: 'b', title: 'Beta' })]
    expect(
      rankCommands(commands, '', noRecency)
        .map((r) => r.command.id)
        .sort()
    ).toEqual(['a', 'b'])
  })

  it('excludes commands whose title does not fuzzy-match the query', () => {
    const commands = [
      command({ id: 'theme', title: 'Toggle Theme' }),
      command({ id: 'tree', title: 'Focus Tree' })
    ]
    expect(rankCommands(commands, 'thm', noRecency).map((r) => r.command.id)).toEqual(['theme'])
  })

  it('a command with a recency rank sorts ahead of one without, regardless of fuzzy score', () => {
    const commands = [
      command({ id: 'better-score', title: 'aa' }),
      command({ id: 'recent', title: 'zz' })
    ]
    const recency = (id: string): number => (id === 'recent' ? 0 : -1)
    expect(rankCommands(commands, '', recency).map((r) => r.command.id)).toEqual([
      'recent',
      'better-score'
    ])
  })

  it('among commands with a recency rank, more recent (lower rank index) sorts first', () => {
    const commands = [command({ id: 'older', title: 'A' }), command({ id: 'newer', title: 'B' })]
    const recency = (id: string): number => (id === 'newer' ? 0 : 1)
    expect(rankCommands(commands, '', recency).map((r) => r.command.id)).toEqual(['newer', 'older'])
  })

  it('respects the live when context when fed through commandsForSurface', () => {
    resetCommandRegistryForTests()
    resetContextForTests()
    registerCommand(command({ id: 'always', title: 'Always Visible' }))
    registerCommand(command({ id: 'treeOnly', title: 'Tree Only', when: 'focus == tree' }))

    const beforeIds = rankCommands(commandsForSurface('palette', getContext()), '', noRecency).map(
      (r) => r.command.id
    )
    expect(beforeIds).toEqual(['always'])

    setContext('focus', 'tree')
    const afterIds = rankCommands(commandsForSurface('palette', getContext()), '', noRecency)
      .map((r) => r.command.id)
      .sort()
    expect(afterIds).toEqual(['always', 'treeOnly'])

    resetCommandRegistryForTests()
    resetContextForTests()
  })
})

// R66 (`R66-palette-polish.md` §1) — `Category: Title` is what's
// matched and rendered, not the title alone. Before this, `view` matched
// nothing in the View category unless the word also happened to appear in
// a command's own title.
describe('R66 §1 — the category is searchable, not just displayed', () => {
  const noRecency = (): number => -1

  it('paletteLabel is "Category: Title"', () => {
    expect(paletteLabel(command({ id: 'x', title: 'Toggle Word Wrap', category: 'View' }))).toBe(
      'View: Toggle Word Wrap'
    )
  })

  it('a query that only matches the category still finds the command', () => {
    const commands = [
      command({ id: 'wrap', title: 'Toggle Word Wrap', category: 'View' }),
      command({ id: 'save', title: 'Save', category: 'File' })
    ]
    expect(rankCommands(commands, 'view', noRecency).map((r) => r.command.id)).toEqual(['wrap'])
  })

  it("a matched command's indices point into Category: Title, not the title alone", () => {
    const commands = [command({ id: 'wrap', title: 'Toggle Word Wrap', category: 'View' })]
    const [entry] = rankCommands(commands, 'view', noRecency)
    expect(entry!.label).toBe('View: Toggle Word Wrap')
    // "view" (case-insensitive) matches "View" at the start of the label —
    // indices 0-3, not offset into "Toggle Word Wrap" as they would be if
    // matching against the title alone.
    expect(entry!.indices).toEqual([0, 1, 2, 3])
  })
})

// R68 (`R66-palette-polish.md` §3) — the six toggle commands each
// declare `state`, and their titles are the noun the state describes
// (`Dark Theme`, not `Toggle Light/Dark Theme` — the one non-cosmetic
// rename §3's own worked table calls out).
describe('R68 §3 — every toggle command declares state, named as a noun', () => {
  it('rankCommands preserves state on the ranked entry, unaffected by matching', () => {
    const isOn = (): boolean => true
    const commands = [command({ id: 'wrap', title: 'Soft Wrap', category: 'View', state: isOn })]
    const [entry] = rankCommands(commands, '', () => -1)
    expect(entry!.command.state?.()).toBe(true)
  })
})

describe('palette recency (D5)', () => {
  beforeEach(() => resetPaletteRecencyForTests())
  afterEach(() => resetPaletteRecencyForTests())

  it('an unused command has rank -1', () => {
    expect(getRecencyRank('klados.theme.toggle')).toBe(-1)
  })

  it('recording a command gives it rank 0', () => {
    recordRecentCommand('klados.theme.toggle')
    expect(getRecencyRank('klados.theme.toggle')).toBe(0)
  })

  it('re-recording a command moves it back to rank 0 rather than duplicating it', () => {
    recordRecentCommand('a')
    recordRecentCommand('b')
    recordRecentCommand('a')
    expect(getRecencyRank('a')).toBe(0)
    expect(getRecencyRank('b')).toBe(1)
  })

  it('persists across a reload — a fresh read of localStorage sees it', () => {
    recordRecentCommand('klados.theme.toggle')
    expect(localStorage.getItem('klados.palette.recency')).toContain('klados.theme.toggle')
  })
})

describe('palette open/close store (D5)', () => {
  beforeEach(() => resetPaletteStoreForTests())

  it('starts closed', () => {
    expect(isPaletteOpen()).toBe(false)
  })

  it('openPalette / closePalette toggle state and notify subscribers', () => {
    let notifications = 0
    const unsubscribe = subscribePaletteOpen(() => notifications++)

    openPalette()
    expect(isPaletteOpen()).toBe(true)
    expect(notifications).toBe(1)

    openPalette() // already open — no-op, no extra notification
    expect(notifications).toBe(1)

    closePalette()
    expect(isPaletteOpen()).toBe(false)
    expect(notifications).toBe(2)

    unsubscribe()
  })

  it('togglePalette flips state', () => {
    togglePalette()
    expect(isPaletteOpen()).toBe(true)
    togglePalette()
    expect(isPaletteOpen()).toBe(false)
  })
})

// R69 (`R69-focus-and-find.md` §1) — Tree for `@`/`/` (both name
// nodes), Raw for `:` (which names a position).
describe('paneForPaletteJump (R69 §1)', () => {
  it('@ (jumpToNode) and / (pathQuery) both land in Tree', () => {
    expect(paneForPaletteJump('jumpToNode')).toBe('tree')
    expect(paneForPaletteJump('pathQuery')).toBe('tree')
  })

  it(': (goToPosition) lands in Raw', () => {
    expect(paneForPaletteJump('goToPosition')).toBe('raw')
  })
})
