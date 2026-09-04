/**
 * Renders a resolved `IconRef` (CONCEPT.md §9.5). The Fluent source SVGs
 * carry no `fill` on their `<path>`s, so `.icon svg { fill: currentColor }`
 * (Icon.css) is what makes them pick up the surrounding text colour — SVG
 * `fill` is an inherited CSS property, so it cascades to every path that
 * doesn't set its own.
 *
 * `dangerouslySetInnerHTML` is safe here specifically because the source
 * is `resolveIcon`'s own static, build-time-bundled import list (vendored
 * library markup), never anything derived from user or document content.
 */
import type { JSX } from 'react'
import { resolveIcon, type IconRef } from '../../commands/icons'
import './Icon.css'

export function Icon({ name }: { readonly name: IconRef }): JSX.Element | null {
  const svg = resolveIcon(name)
  if (svg === undefined) return null
  return <span className="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
}
