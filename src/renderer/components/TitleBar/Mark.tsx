/**
 * M5d-PLAN.md R1 — the app mark, inline rather than routed through
 * `commands/icons.ts`'s Fluent `IconRef` map: that map resolves *command*
 * glyphs, and this is the app's own identity mark (`assets/mark-16.svg`),
 * a different thing that happens to also be an SVG. `currentColor` plus
 * `--mark-fg` (TitleBar.css) is what D-054a/D-054b settled on instead of a
 * light/dark raster pair — see `assets/README.md`'s "Later — a Klados-drawn
 * title bar".
 */
import type { JSX } from 'react'

export function Mark(): JSX.Element {
  // M5d-PLAN.md R6: purely decorative next to the title text, which already
  // carries the accessible name ("Klados" or the open document) — a
  // second `aria-label="Klados"` here would double-announce it.
  return (
    <svg
      className="title-bar-mark"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 4V12M11 4L5 9M9.21 5.49L12 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
