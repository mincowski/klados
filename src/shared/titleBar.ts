/**
 * M5d-PLAN.md R1 — the one thing the frameless title bar needs shared
 * between main (which sizes `titleBarOverlay` and seeds its first paint)
 * and the renderer (which lays out the drawn bar). Kept in its own file,
 * outside both `src/main` and `src/renderer`, for the same reason
 * `src/core/parseClient.ts` is the one renderer file explicitly added to
 * `tsconfig.node.json`'s include list in reverse: a value read by two
 * processes needs exactly one declaration, or it drifts the way
 * `--scrubber-width` once did as two separate literals.
 */

/** Reaches both `src/main/index.ts` (`titleBarOverlay.height`) and
 * `TitleBar.tsx` (its own root height) — never duplicate this number. */
export const TITLE_BAR_HEIGHT_PX = 36

export type TitleBarTheme = 'light' | 'dark'

export interface TitleBarOverlayColors {
  readonly color: string
  readonly symbolColor: string
  readonly height: number
}

/**
 * Windows' `titleBarOverlay` paints outside CSS's reach, so it needs literal
 * hex rather than the theme tokens `styles/themes/*.css` define — this is
 * the one place in the app allowed to hold color literals for that reason,
 * invariant 9's "no literal colours in components" applying to renderer
 * components, not to an OS API argument. Values match `--elev-1-bg` /
 * `--surface-fg` in `styles/themes/light.css` and `dark.css` (`--gray-0`
 * `/` `--gray-900` for light, `--gray-800` `/` `--gray-100` for dark, per
 * `styles/palette.css`) — kept in sync by hand since the OS side of this
 * can't read a CSS custom property.
 */
const OVERLAY_COLORS: Record<
  TitleBarTheme,
  { readonly color: string; readonly symbolColor: string }
> = {
  light: { color: '#ffffff', symbolColor: '#14171e' },
  dark: { color: '#262b36', symbolColor: '#eceef2' }
}

export function titleBarOverlayColorsFor(theme: TitleBarTheme): TitleBarOverlayColors {
  return { ...OVERLAY_COLORS[theme], height: TITLE_BAR_HEIGHT_PX }
}
