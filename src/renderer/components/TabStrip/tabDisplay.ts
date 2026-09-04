/**
 * R25 (`R24-tabs.md` §3, `CONCEPT.md` §11.4). Pure logic for the tab
 * strip's anatomy — no React, so it's directly testable the way
 * `wrapperDescent.ts`/`gridDetection.ts` are.
 */
import type { DocumentSessionState } from '../../session/documentSession'
import type { TabId } from '../../session/tabs'

export interface TabDisplayInfo {
  readonly fileName: string | null
  readonly filePath: string | null
  readonly formatId: string | null
  readonly dirty: boolean
}

/** What a tab shows regardless of its document's phase — `null` fields for
 * every phase that hasn't reached `'ready'` yet (a tab mid-open still needs
 * a label; `documentSession.ts`'s `'confirmSize'`/`'parsing'` phases already
 * carry a `fileName` for exactly this). */
export function tabDisplayInfoOf(state: DocumentSessionState): TabDisplayInfo {
  switch (state.phase) {
    case 'empty':
    case 'error':
      return { fileName: null, filePath: null, formatId: null, dirty: false }
    case 'confirmSize':
    case 'parsing':
      return { fileName: state.fileName, filePath: null, formatId: null, dirty: false }
    case 'ready':
      return {
        fileName: state.document.fileName,
        filePath: state.document.filePath,
        formatId: state.document.formatId,
        dirty: state.document.dirty
      }
  }
}

/** §11.4: a format icon chosen by a UI-side map keyed on `capabilities.id`
 * — never supplied by the format module (invariant 8). Each format's most
 * characteristic punctuation, tinted with an existing syntax-hue token
 * (already desaturated/muted by design, per §11.4's "a rainbow of
 * saturated icons would compete with the active tab's amber") rather than
 * inventing a parallel set of tab-icon tokens. */
const FORMAT_GLYPHS: Record<string, { readonly glyph: string; readonly colorVar: string }> = {
  xml: { glyph: '<>', colorVar: 'var(--syntax-tag-name)' },
  json: { glyph: '{}', colorVar: 'var(--syntax-attr-name)' },
  // R71 (`R71-text-as-icons.md` §5a): was `'[ ]'` (a space) — with
  // `.tab-icon` now a fixed-width centred box (matching `.tree-row-glyph`,
  // §1), the space did nothing but disagree with `nodeDisplay.ts`'s own
  // `'[]'` for the same format.
  toml: { glyph: '[]', colorVar: 'var(--syntax-number)' }
}

const DEFAULT_GLYPH = { glyph: '—', colorVar: 'var(--surface-fg-secondary)' }

export function formatGlyphOf(formatId: string | null): { glyph: string; colorVar: string } {
  if (formatId === null) return DEFAULT_GLYPH
  return FORMAT_GLYPHS[formatId] ?? DEFAULT_GLYPH
}

export interface TabLabelInput {
  readonly id: TabId
  readonly fileName: string | null
  readonly filePath: string | null
}

export interface TabLabel {
  readonly id: TabId
  /** The display text — `fileName`, or `parentDir/fileName` when another
   * open tab shares the same `fileName` (§11.4's "same-name disambiguation":
   * `config.yaml` open three times is ordinary, not an edge case). */
  readonly text: string
}

/** The smallest distinguishing path segment, per §11.4 — one directory
 * level up from the filename. Two tabs whose immediate parent also
 * collides keep the same (still merely non-unique, never wrong) label
 * rather than walking further up the path; a strip is not a project tree,
 * and this is the case CONCEPT.md's own example (`data/config.yaml` beside
 * `test/config.yaml`) covers. */
export function tabLabelsOf(tabs: readonly TabLabelInput[]): readonly TabLabel[] {
  const counts = new Map<string, number>()
  for (const tab of tabs) {
    if (tab.fileName === null) continue
    counts.set(tab.fileName, (counts.get(tab.fileName) ?? 0) + 1)
  }
  return tabs.map((tab) => {
    // Covers both a genuinely empty tab and one whose open attempt failed
    // (`empty`/`error` — the only phases `tabDisplayInfoOf` gives a `null`
    // `fileName`) — `'parsing'`/`'confirmSize'` already carry a real
    // `fileName` by then, so there's no ambiguity with an in-progress open.
    if (tab.fileName === null) return { id: tab.id, text: 'New Tab' }
    const duplicate = (counts.get(tab.fileName) ?? 0) > 1
    if (!duplicate || tab.filePath === null) return { id: tab.id, text: tab.fileName }
    const segments = tab.filePath.replace(/\\/g, '/').split('/')
    const parentDir = segments.length >= 2 ? segments[segments.length - 2] : undefined
    return {
      id: tab.id,
      text:
        parentDir !== undefined && parentDir !== '' ? `${parentDir}/${tab.fileName}` : tab.fileName
    }
  })
}
