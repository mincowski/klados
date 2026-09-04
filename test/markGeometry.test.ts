/**
 * The app mark exists twice: as `assets/mark-16.svg`, which `tools/generate.py`
 * rasterizes into everything the OS consumes, and as a hand-copied path inside
 * `src/renderer/components/TitleBar/Mark.tsx`, which is what the title bar
 * actually draws (D-054b: one SVG and one theme token, not a light/dark raster
 * pair — so the renderer cannot read the asset the way the packager does).
 *
 * Two copies of one fact, with nothing keeping them equal. That is exactly how
 * R144's mark shipped wrong: the round-cap correction to D-087's geometry was
 * applied to all five SVGs and to the regenerated rasters, and `npm run dev`
 * went on drawing the uncorrected path, because the title bar was never reading
 * those files. The asset and the component disagreed for as long as it took
 * someone to notice by eye.
 *
 * This is invariant 10's precedent applied one level down — "enforced by test,
 * not discipline". It does not check that the mark is *good*; it checks that
 * there is only one answer to what the mark is.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MARK_16 = 'assets/mark-16.svg'
const MARK_TSX = 'src/renderer/components/TitleBar/Mark.tsx'

/** The single `d` attribute of a file that must contain exactly one path. */
function onlyPathData(file: string): string {
  const source = readFileSync(file, 'utf8')
  const matches = [...source.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1] as string)
  expect(matches, `${file} must contain exactly one path`).toHaveLength(1)
  return (matches[0] as string).trim()
}

describe('the title-bar mark matches the asset it is a copy of', () => {
  it('draws the same path as assets/mark-16.svg', () => {
    expect(onlyPathData(MARK_TSX)).toBe(onlyPathData(MARK_16))
  })

  it('keeps the stroke width the asset uses', () => {
    // Written as `stroke-width` in the SVG and `strokeWidth` in JSX, so the
    // values are compared rather than the attribute text.
    const svg = /stroke-width="([^"]+)"/.exec(readFileSync(MARK_16, 'utf8'))?.[1]
    const tsx = /strokeWidth="([^"]+)"/.exec(readFileSync(MARK_TSX, 'utf8'))?.[1]
    expect(svg).toBeDefined()
    expect(tsx).toBe(svg)
  })

  it('keeps the 16-unit viewBox, so the two are in the same coordinate space', () => {
    // Without this the paths could match textually and still render differently.
    for (const file of [MARK_16, MARK_TSX]) {
      expect(readFileSync(file, 'utf8'), file).toContain('viewBox="0 0 16 16"')
    }
  })

  it('leaves the mark colourable by a theme token (invariant 9)', () => {
    // `currentColor` plus `--mark-fg` is what D-054b chose over a raster pair;
    // a literal colour here would break the light/dark title bar silently.
    for (const file of [MARK_16, MARK_TSX]) {
      expect(readFileSync(file, 'utf8'), file).toContain('currentColor')
    }
  })
})
