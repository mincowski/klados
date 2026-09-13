/**
 * User feedback after R8 shipped: the mark and the title text sit in boxes
 * centered on the same line, but their *ink* didn't optically match — the
 * mark's artwork is taller and already ink-centered in its own box, while
 * a capital letter's cap-height ink sits low in its line box (the font
 * reserves descender space below the baseline even though "N" has none).
 * Fixed first with a 1px `transform: translateY` nudge on
 * `.title-bar-mark`, and **R208 replaced that with `text-box-trim`**: the
 * title's text box is trimmed to its own cap-height ink, so centering the
 * boxes centers the ink for whatever font resolved. Real Chromium only:
 * `SVGGraphicsElement.getBBox()` and canvas
 * `TextMetrics.actualBoundingBox{Ascent,Descent}` are both exact-geometry
 * APIs jsdom cannot back with real numbers.
 *
 * **The skip is gone, and that is R208's acceptance rather than a
 * convenience.** It used to run only where `--font-ui` resolved to the one
 * font the 1px constant was calibrated against, because the constant was
 * wrong everywhere else — measured in Electron 39 across nine families, it
 * was wrong for eight of them. There is no constant now, so there is nothing
 * left for a font to invalidate, and the assertion runs everywhere. The
 * second test below is what makes that claim checkable rather than asserted:
 * it drives the same markup through several font families with deliberately
 * different cap-height-to-line-box ratios.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/TitleBar/TitleBar.css'
import { Mark } from '../src/renderer/components/TitleBar/Mark'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/** The mark's true visual ink extent — its own bounding box in viewBox
 * units, widened by half the 2px stroke width (round caps/joins extend
 * ink slightly past the raw path geometry), then mapped to page pixels
 * via the rendered element's own scale. */
function markInkCenter(markEl: SVGSVGElement): number {
  const rect = markEl.getBoundingClientRect()
  const bbox = markEl.getBBox()
  const strokeExtent = 1
  const scale = rect.height / 16 // viewBox is `0 0 16 16`
  const inkTop = rect.top + (bbox.y - strokeExtent) * scale
  const inkBottom = rect.top + (bbox.y + bbox.height + strokeExtent) * scale
  return (inkTop + inkBottom) / 2
}

/**
 * The title text's cap-height ink center.
 *
 * **Not measured from `actualBoundingBoxAscent`, and that is the whole
 * subtlety of this file.** Chromium quantizes that metric to whole pixels —
 * measured in Electron 39, Georgia's declared cap height is 9.000px and its
 * "K" reports an ink ascent of 10, Arial's are 9.313 and 10 — so a metric
 * that cannot resolve better than a pixel cannot adjudicate a half-pixel
 * question. An earlier version of this helper used it and put Georgia at
 * exactly 0.5 against a 0.5 tolerance, which was the measurement's
 * resolution showing through, not a misalignment on screen.
 *
 * The font's *declared* cap height is exact and is what the layout actually
 * uses. With R208's `text-box-edge: cap alphabetic` the content box runs
 * from that cap height down to the baseline, so the box **is** the
 * cap-height ink box and its center is the ink center — nothing to derive.
 *
 * The untrimmed branch is kept, and is not dead code: it is what the
 * negative-control test below relies on to show this assertion can still
 * fail. Without R208's trim there is no cap-height box to read, so the
 * baseline has to come from inline layout's own half-leading math, glyph
 * quantization and all.
 */
function titleGlyphInkCenter(titleEl: HTMLElement): number {
  const rect = titleEl.getBoundingClientRect()
  const cs = getComputedStyle(titleEl)
  if (cs.textBoxTrim === 'trim-both') return rect.top + rect.height / 2

  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const metrics = ctx.measureText(titleEl.textContent!.charAt(0))
  const baseline =
    rect.top +
    (rect.height - (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) / 2 +
    metrics.fontBoundingBoxAscent
  const inkTop = baseline - metrics.actualBoundingBoxAscent
  const inkBottom = baseline + metrics.actualBoundingBoxDescent
  return (inkTop + inkBottom) / 2
}

/**
 * Width comparison, not `document.fonts.check()`. That API only reports on
 * fonts declared through `@font-face`; for a locally installed system font it
 * returns `true` unconditionally, so an earlier version of this guard was
 * inert and the test still ran — and still failed — on CI.
 *
 * Rendering a string that exercises very different advance widths against
 * `monospace`, then against `"<name>", monospace`, is the standard detection:
 * if the width moves, the named face actually resolved; if it does not, the
 * fallback rendered both times.
 */
function fontIsAvailable(name: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d')
  if (ctx === null) return false
  const probe = 'MMMMMMMMMWWWWWWWWWiiiiiiiii'
  ctx.font = '72px monospace'
  const fallbackWidth = ctx.measureText(probe).width
  ctx.font = `72px "${name}", monospace`
  return ctx.measureText(probe).width !== fallbackWidth
}

describe('title bar mark/title optical (ink) alignment', () => {
  it('the mark and the title text share an ink center, not just a box center', async () => {
    await paint(
      <div className="title-bar" style={{ height: '36px' }}>
        <div className="title-bar-title-area">
          <Mark />
          <span className="title-bar-title">
            <span className="title-bar-title-head">Klado</span>
            <span className="title-bar-title-tail">s.xml</span>
          </span>
        </div>
      </div>
    )

    const mark = container.querySelector('.title-bar-mark') as unknown as SVGSVGElement
    const title = container.querySelector('.title-bar-title-head') as HTMLElement

    const markCenter = markInkCenter(mark)
    const titleCenter = titleGlyphInkCenter(title)

    // Box centers (both elements are flex-centered on the same line) are
    // already within a fraction of a pixel of each other by construction
    // — the bug was ink not matching despite that. Half a pixel of
    // tolerance is well under anything a person could perceive.
    expect(Math.abs(markCenter - titleCenter)).toBeLessThan(0.5)
  })

  /**
   * R208 acceptance 4: **more than one font family**, because the defect was
   * one font's measurement generalized, and a fix validated on one font
   * would repeat it exactly. These four sit at deliberately different
   * cap-height-to-line-box ratios — measured in Electron 39, the old 1px
   * constant needed to be -0.5, -0.5, +1 and 0 respectively.
   *
   * A font that does not resolve is skipped individually rather than
   * skipping the suite: a missing Georgia says nothing about whether the
   * mechanism works, and the mechanism is what is under test.
   */
  for (const font of ['Arial', 'Georgia', 'Segoe UI', 'Times New Roman']) {
    it(`ink centers coincide with no per-font constant: ${font}`, async () => {
      await paint(
        <div className="title-bar" style={{ height: '36px' }}>
          <div className="title-bar-title-area">
            <Mark />
            <span className="title-bar-title" style={{ fontFamily: `"${font}", monospace` }}>
              <span className="title-bar-title-head">Klado</span>
              <span className="title-bar-title-tail">s.xml</span>
            </span>
          </div>
        </div>
      )
      if (!fontIsAvailable(font)) return

      const mark = container.querySelector('.title-bar-mark') as unknown as SVGSVGElement
      const head = container.querySelector('.title-bar-title-head') as HTMLElement
      expect(Math.abs(markInkCenter(mark) - titleGlyphInkCenter(head))).toBeLessThan(0.5)
    })
  }

  /**
   * The mechanism, asserted directly rather than only through its effect. If
   * `text-box-trim` silently stopped applying, the assertions above would
   * still pass on whichever font happened to need no nudge and fail
   * confusingly on the rest; this says which of the two broke.
   */
  it('the title text box is trimmed to its cap height, not the line box', async () => {
    await paint(
      <div className="title-bar" style={{ height: '36px' }}>
        <div className="title-bar-title-area">
          <Mark />
          <span className="title-bar-title">
            <span className="title-bar-title-head">Klado</span>
            <span className="title-bar-title-tail">s.xml</span>
          </span>
        </div>
      </div>
    )
    const head = container.querySelector('.title-bar-title-head') as HTMLElement
    const cs = getComputedStyle(head)
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const m = ctx.measureText('K')
    const lineBox = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent

    expect(cs.textBoxTrim).toBe('trim-both')

    // The **content** box, not the border box: the descender headroom lives
    // in padding, so `getBoundingClientRect()` is the trimmed box plus that
    // padding back again and would say nothing about the trim.
    const contentHeight =
      head.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    expect(contentHeight).toBeLessThan(lineBox - 2)

    // The headroom must cancel out of layout exactly, or the flex centering
    // above is centering something other than the cap-height box.
    expect(parseFloat(cs.paddingTop) + parseFloat(cs.marginTop)).toBeCloseTo(0, 5)
    expect(parseFloat(cs.paddingBottom) + parseFloat(cs.marginBottom)).toBeCloseTo(0, 5)
  })

  /**
   * **The regression this round nearly shipped.** `text-box-edge: cap
   * alphabetic` puts the box's bottom edge on the baseline, and R5's ellipsis
   * puts `overflow: hidden` on the same box — which clips to the padding box.
   * With no padding, `pygmy-jaguar-query.xml` rendered as
   * `pvgmv-iaguar-querv.xml`: every descender cut off flat, and the round
   * would have traded a one-pixel misalignment for mangled filenames.
   *
   * Caught by reviewing the diff and rendering a filename that actually has
   * descenders in it, which the earlier fixtures ("Klados", "Klado"+"s.xml")
   * did not — the assertions above were all green while this was broken.
   *
   * Asserted through geometry rather than pixels: the painted box must reach
   * far enough below the baseline to contain the deepest descender of the
   * text it holds.
   */
  it('descenders are not clipped by the trimmed box', async () => {
    await paint(
      <div className="title-bar" style={{ height: '36px', width: '400px' }}>
        <div className="title-bar-title-area">
          <Mark />
          <span className="title-bar-title">
            <span className="title-bar-title-head">pygmy-jaguar-query</span>
            <span className="title-bar-title-tail">.xml</span>
          </span>
        </div>
      </div>
    )
    const head = container.querySelector('.title-bar-title-head') as HTMLElement
    const cs = getComputedStyle(head)
    expect(cs.overflow).toBe('hidden')

    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const descent = ctx.measureText(head.textContent!).actualBoundingBoxDescent
    expect(descent).toBeGreaterThan(0) // the fixture must actually have descenders

    // The baseline is the content box's bottom edge (`alphabetic`); the clip
    // happens at the padding box's bottom edge, one padding further down.
    expect(parseFloat(cs.paddingBottom)).toBeGreaterThan(descent)
  })

  /**
   * **The negative control**, and the reason the assertions above are
   * evidence rather than a restatement of the CSS. With R208's trim removed
   * the two centers must come apart — if they did not, this file would be
   * passing because the measurement is insensitive, not because the mark is
   * aligned, which is precisely the failure mode the old skip was written to
   * avoid on a different axis.
   *
   * Scoped to Segoe UI: the divergence is font-dependent (measured across
   * nine families, the untrimmed error ranges from 0 to 1px, and three
   * families need no nudge at all), so a font-agnostic version of this test
   * would be asserting something untrue.
   */
  it('without the trim the two centers come apart — the assertion has teeth', async () => {
    await paint(
      <div className="title-bar" style={{ height: '36px' }}>
        <div className="title-bar-title-area">
          <Mark />
          <span className="title-bar-title" style={{ fontFamily: '"Segoe UI", monospace' }}>
            <span className="title-bar-title-head" style={{ textBox: 'normal' }}>
              Klado
            </span>
            <span className="title-bar-title-tail">s.xml</span>
          </span>
        </div>
      </div>
    )
    if (!fontIsAvailable('Segoe UI')) return

    const mark = container.querySelector('.title-bar-mark') as unknown as SVGSVGElement
    const head = container.querySelector('.title-bar-title-head') as HTMLElement
    expect(getComputedStyle(head).textBoxTrim).toBe('none')
    expect(Math.abs(markInkCenter(mark) - titleGlyphInkCenter(head))).toBeGreaterThanOrEqual(0.5)
  })

  /**
   * R5's middle truncation lives on the very box R208 trimmed, so this is the
   * regression the change could plausibly have caused — checked rather than
   * assumed, per the working agreement about a plan's claims having to be
   * true of the code that landed.
   */
  it('text-overflow: ellipsis still triggers on the trimmed head', async () => {
    await paint(
      <div className="title-bar" style={{ height: '36px', width: '160px' }}>
        <div className="title-bar-title-area">
          <Mark />
          <span className="title-bar-title">
            <span className="title-bar-title-head">
              a-very-long-file-name-that-cannot-possibly-fit-in-this-bar
            </span>
            <span className="title-bar-title-tail">.xml</span>
          </span>
        </div>
      </div>
    )
    const head = container.querySelector('.title-bar-title-head') as HTMLElement
    expect(getComputedStyle(head).textOverflow).toBe('ellipsis')
    expect(head.scrollWidth).toBeGreaterThan(head.clientWidth)
  })
})
