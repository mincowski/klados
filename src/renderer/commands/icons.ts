/**
 * Resolves an `IconRef` to raw SVG markup (CONCEPT.md §9.5 — Fluent
 * System Icons, MIT, chosen because the set is drawn separately at each
 * size rather than scaled from one master). Every icon actually used is
 * a static import, not a directory scan — Vite's `?raw` import inlines
 * the SVG source as a string at build time, and a static import list is
 * what lets Vite know which of the package's several thousand icons to
 * bundle at all.
 *
 * Regular weight throughout: CONCEPT.md's Regular/Filled pairing is for
 * *state* (selected node, active toggle), which nothing here needs yet —
 * every icon below is a static command glyph, not a state indicator.
 */
import add from '@fluentui/svg-icons/icons/add_20_regular.svg?raw'
import appsListDetail from '@fluentui/svg-icons/icons/apps_list_detail_20_regular.svg?raw'
import arrowCollapseAll from '@fluentui/svg-icons/icons/arrow_collapse_all_20_regular.svg?raw'
import arrowCounterclockwise from '@fluentui/svg-icons/icons/arrow_counterclockwise_20_regular.svg?raw'
import arrowDown from '@fluentui/svg-icons/icons/arrow_down_20_regular.svg?raw'
import arrowExpandAll from '@fluentui/svg-icons/icons/arrow_expand_all_20_regular.svg?raw'
import arrowRedo from '@fluentui/svg-icons/icons/arrow_redo_20_regular.svg?raw'
import arrowRepeatAll from '@fluentui/svg-icons/icons/arrow_repeat_all_20_regular.svg?raw'
import arrowSwap from '@fluentui/svg-icons/icons/arrow_swap_20_regular.svg?raw'
import arrowUndo from '@fluentui/svg-icons/icons/arrow_undo_20_regular.svg?raw'
import arrowUp from '@fluentui/svg-icons/icons/arrow_up_20_regular.svg?raw'
import arrowWrap from '@fluentui/svg-icons/icons/arrow_wrap_20_regular.svg?raw'
import chevronDown from '@fluentui/svg-icons/icons/chevron_down_20_regular.svg?raw'
import chevronLeft from '@fluentui/svg-icons/icons/chevron_left_20_regular.svg?raw'
import chevronRight from '@fluentui/svg-icons/icons/chevron_right_20_regular.svg?raw'
import codeText from '@fluentui/svg-icons/icons/code_text_20_regular.svg?raw'
import copy from '@fluentui/svg-icons/icons/copy_20_regular.svg?raw'
import dismiss from '@fluentui/svg-icons/icons/dismiss_20_regular.svg?raw'
import errorCircle from '@fluentui/svg-icons/icons/error_circle_20_regular.svg?raw'
import filter from '@fluentui/svg-icons/icons/filter_20_regular.svg?raw'
import folderOpen from '@fluentui/svg-icons/icons/folder_open_20_regular.svg?raw'
import info from '@fluentui/svg-icons/icons/info_20_regular.svg?raw'
import panelBottom from '@fluentui/svg-icons/icons/panel_bottom_20_regular.svg?raw'
import panelLeft from '@fluentui/svg-icons/icons/panel_left_20_regular.svg?raw'
import save from '@fluentui/svg-icons/icons/save_20_regular.svg?raw'
import search from '@fluentui/svg-icons/icons/search_20_regular.svg?raw'
import tableSettings from '@fluentui/svg-icons/icons/table_settings_20_regular.svg?raw'
import textBulletListSquare from '@fluentui/svg-icons/icons/text_bullet_list_square_20_regular.svg?raw'
import warning from '@fluentui/svg-icons/icons/warning_20_regular.svg?raw'
import type { IconRef } from './registry'

export type { IconRef }

const ICONS: Record<IconRef, string> = {
  'panel-left': panelLeft,
  // M5e-PLAN.md R8d — was `document`, which reads as "new page" next to
  // Open File's own folder icon and shares no family with `panel-left`/
  // `panel-bottom`. `apps-list-detail` depicts a master/detail layout,
  // which is what the pane actually is.
  'apps-list-detail': appsListDetail,
  // M5d-PLAN.md R4 — deliberately distinct from Open File's icon: two
  // simultaneously-visible buttons with the same glyph would be genuinely
  // ambiguous, not just a style nit.
  'folder-open': folderOpen,
  'panel-bottom': panelBottom,
  'expand-all': arrowExpandAll,
  'collapse-all': arrowCollapseAll,
  wrap: arrowWrap,
  // M5e-PLAN.md R9 — Format's own icon, in the Raw pane header (D-057).
  'code-text': codeText,
  copy,
  filter,
  'table-settings': tableSettings,
  undo: arrowUndo,
  redo: arrowRedo,
  save,
  revert: arrowCounterclockwise,
  search,
  // R38 (`R38-tab-strip-polish.md` §1) — the tab strip's overflow
  // controls, replacing the Unicode `‹`/`›`/`⌄`/`+` glyphs.
  'chevron-left': chevronLeft,
  'chevron-right': chevronRight,
  'chevron-down': chevronDown,
  add,
  // R63 (`R61-keyboard-workflow.md` §6) — the palette's title-bar
  // button. "A list of things in a box"; shares no icon family with any
  // button above it (search, code-text, apps-list-detail all taken).
  'text-bullet-list-square': textBulletListSquare,
  // R71 (`R71-text-as-icons.md` §5b) — six symbol-block glyphs
  // replaced (status bar: ⓘ/⚠/⊗; Find bar: ↑/↓/✕). The format markers
  // (`<>`/`{}`/`[]`) and node-kind glyphs stay text by the same round's own
  // rule — Basic Latin/Latin-1/General Punctuation may be a mark, a
  // symbol-block codepoint may not.
  info,
  warning,
  'error-circle': errorCircle,
  'arrow-up': arrowUp,
  'arrow-down': arrowDown,
  // R90 (`R86-find-as-query-surface.md` §6) — Replace's own two arrows
  // swapping one thing for another read directly as "replace"; Replace
  // All pairs it with the circular "all" glyph the tab-strip/tree already
  // use for their own "every one of these" actions (`arrow-repeat-all`
  // isn't reused from elsewhere — `filter`'s own icon is taken by the
  // Tree/Grid filter row).
  'arrow-swap': arrowSwap,
  'arrow-repeat-all': arrowRepeatAll,
  dismiss
}

/** `undefined` for an unknown ref — the caller decides what to render
 * instead (a text fallback, or nothing) rather than this module deciding
 * for every caller alike. */
export function resolveIcon(ref: IconRef): string | undefined {
  return ICONS[ref]
}
