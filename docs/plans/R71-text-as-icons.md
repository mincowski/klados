# R71 — the glyphs that are still text

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Follows `docs/plans/R38-tab-strip-polish.md`, which fixed four of
these and left the rest. Two reports: the status bar's `ⓘ` looks wrong, and the tab strip's XML
marker has brackets at the wrong angle. Results at the end of this file.

**Revised after the first draft.** The draft treated this as "replace text with icons," with the
format markers as the headline. That was the wrong axis. **The problem is not text-versus-icon, it
is which codepoints** — and once that is the rule, the format markers stay text and the task gets
smaller.

---

## 1. The tab marker and the tree glyph are the same string

The report suggests making the tab's XML marker "more like in tree view the node icon." They are
already the same characters:

```ts
FORMAT_GLYPHS.xml = { glyph: '<>', … }          // tabDisplay.ts:45
KIND_GLYPHS[NodeKind.Element] = '<>'            // nodeDisplay.ts:79
```

The difference is entirely typographic, and both rules are short enough to quote in full:

```css
.tab-icon        { flex: none; font-family: var(--font-mono); font-size: 11px; font-weight: 600 }
.tree-row-glyph  { flex: none; width: 20px; text-align: center; font-size: 11px;
                   color: var(--syntax-punctuation) }
```

Measured as rendered: `.tab-icon` resolves to `ui-monospace` at weight 600, 12.9px wide;
`.tree-row-glyph` to the UI font at weight 400 in a fixed 20px box. A monospace `<` and `>` are
drawn wide and shallow to fill a fixed advance width; the UI font draws them narrower and steeper.
**That is the reported different angle** — bold monospace versus regular UI, not a different glyph.

*(The tree row measured was the document root, whose glyph is `D`. So this compares the two
**styles**, which is what differs, not two side-by-side `<>` renderings.)*

### The monospace is not buying what it looks like it is buying

The obvious reason to reach for a monospace font in a list of tabs is column alignment — a fixed
advance width putting every tab's label at the same offset. **It does not do that here**, because
the three markers are not the same length: `<>` and `{}` are two characters, `[ ]` is three. A fixed
advance equalises *characters*, not *strings*, so TOML's marker is half again as wide as the other
two and the labels do not line up anyway.

So `--font-mono`'s only actual effect on this element is the bracket shape that prompted the report.

**And the tree already solves alignment correctly**: `width: 20px; text-align: center`, which works
for any glyph of any length. That is the in-repo precedent, it needs no monospace, and copying it to
`.tab-icon` fixes the angle and the alignment in the same three lines.

> **Correction (R83, `docs/plans/R82-hover-and-glyphs.md` §2).** This premise held for exactly as
> long as it took §5a below to change TOML's marker from `'[ ]'` to `'[]'` — once all three markers
> are two characters, a fixed advance width *does* equalise them, which is the thing this section
> said was impossible. The width problem this section reports is real (measured again in R83: `<>`
> draws at more than twice `{}`/`[]`'s width in `--font-ui`, 76% of the 20px box against 37%, which
> is what a later report called "JSON looked better before") — the fix was misdiagnosed as
> unrelated to monospace when it is exactly what monospace corrects. `--font-mono` is back on
> `.tab-icon` and `.tree-row-glyph` both; the `width`/`text-align` mechanism this section
> recommended stays, since it is what keeps centring correct for any future glyph length regardless
> of the font's own advance behaviour.

## 2. The rule is about codepoints, not about text

`ⓘ` is U+24D8, CIRCLED LATIN SMALL LETTER I — a **letterform in a circle**, from Enclosed
Alphanumerics. It inherits the UI font's `i`, its optical weight never matches the drawn `⚠` beside
it, and its shape varies with whatever font happens to resolve. That is why it was the one noticed.

`<>` `{}` `[]` are Basic Latin punctuation. Every font has them, their shapes are conventional, and
they are *the actual syntax of the formats they mark* — no drawn icon says "XML" better than `<>`
does, given that `code_20_regular` is itself a drawing of `<>`.

**So the rule is: ASCII (with Latin-1 Supplement and General Punctuation) may be used as a mark;
symbol-block codepoints may not.** That explains both reports at once — why `<>` reads fine in the
tree and `ⓘ` does not — and it is checkable, which the vaguer "use icons everywhere" was not.

It also settles what the first draft left open. `bracket_*_20_regular` does not exist at 20px, so an
icon family for the three formats could not be completed from the vendored set at all. Under this
rule that gap stops mattering: **all three markers stay text**, the family is complete and
consistent by construction, and a fourth format gets a marker for free without waiting on an icon to
exist.

## 3. The inventory

R38 replaced `‹ › ⌄ +` in the tab strip and stopped there. What survives, excluding comments:

| Where | Glyph | Block | Verdict |
|---|---|---|---|
| `tabDisplay.ts:45-47` | `<>` `{}` `[ ]` `—` | Basic Latin + Gen. Punct. | **stays text** (§1's typography fix) |
| `nodeDisplay.ts:77-89` | `D <> {} [] : " ¶ # ? !` | Basic Latin + Latin-1 | **stays text**, unchanged |
| `StatusBar.tsx:125` | `ⓘ` | Enclosed Alphanumerics | **iconify** — the reported one |
| `StatusBar.tsx:113` | `⚠` | Misc. Symbols | **iconify** |
| `StatusBar.tsx:104` | `⊗` | Mathematical Operators | **iconify** |
| `FindBar.tsx:239/242/245` | `↑` `↓` `✕` | Arrows + Dingbats | **iconify** |
| `Tree.tsx:545` | `▾` `▸` | Geometric Shapes | defer — per row (§4b) |
| `Grid.tsx:919/963/983/1296` | `▲▼` `◆◇` `●` `▸` | Geometric Shapes | defer — per column/row (§4b) |
| `Grid.tsx:1277`, `gridExport.ts:164` | `✓` | Dingbats | **never** — it is data (§4a) |

Six sites to iconify, all in bounded chrome. That is the whole of R71's icon work.

## 4. Two exclusions, and they are the point of the task

**a. `✓` is data, not chrome.** `Grid.tsx:1277` renders `✓` as a cell's *value* — the presence
marker for an empty element — and `gridExport.ts:164` emits the same character into exported
CSV/TSV/Markdown. R39/D-068 made that deliberate: exporting a presence marker as a token rather than
collapsing it to blank. An SVG icon cannot be copied to the clipboard as a value, so iconifying the
cell would silently change what the grid *means* and desynchronise it from its own export.

**b. The deferred glyphs render once per visible row or cell.** `Tree.tsx:545`'s twisty and
`Grid.tsx`'s sort/pin/filter/expander marks are per row or per column. `Icon` renders
`dangerouslySetInnerHTML` with a full SVG string per instance (`Icon.tsx:19`) — fine for R38's four
buttons and the six here, a different cost class in a virtualized list that R30 already measured as
the dominant tab-switch cost. They are also the most conventional shapes in the table (a disclosure
triangle, a sort caret), so they are the least urgent.

If the deferred set is wanted later, the mechanism is a CSS `mask-image` or a sprite sheet — one
paint, no per-instance DOM — not `<Icon>`. Measure before and after; do not assume the per-row cost
is negligible because the button case was.

## 5. The work

**a. `.tab-icon` — three lines.** Drop `font-family: var(--font-mono)`, add a fixed `width` and
`text-align: center`, matching `.tree-row-glyph`. Three details:

- **`--font-mono` is what changes the angle; `font-weight: 600` only changes thickness.** Only the
  angle was reported. Keep the weight unless it reads heavy once the family changes — the marker is
  a badge and wants to stay legible at 11px.
- **Keep the per-format colour.** `tabDisplay.ts` already assigns `--syntax-tag-name` /
  `--syntax-attr-name` / `--syntax-number`, which is what makes the three distinguishable at a
  glance. Nothing here touches it.
- While there: `tabDisplay.ts` uses `'[ ]'` where `nodeDisplay.ts` uses `'[]'`. With a fixed-width
  centred box the space is doing nothing. Make them the same string.

**b. Six icons.** All verified present in the vendored `@fluentui/svg-icons` set:

| Replaces | Icon |
|---|---|
| `ⓘ` | `info_20_regular` |
| `⚠` | `warning_20_regular` |
| `⊗` | `error_circle_20_regular` |
| `↑` / `↓` | `arrow_up_20_regular` / `arrow_down_20_regular` |
| `✕` | `dismiss_20_regular` |

Verify each import resolves anyway, since `vite/client`'s ambient `*.svg?raw` declaration makes a
**misspelled icon path type-check cleanly** — the trap R54's addendum recorded, and the reason CI now
runs a build.

**The status bar's counts stay text.** Only the mark becomes an icon: `⚠ 3` becomes `<Icon> 3`, not
an icon that encodes the number.

### Acceptance

1. Every icon name a component references resolves through `resolveIcon` — the same shape R38 used.
2. **No component renders a codepoint outside Basic Latin, Latin-1 Supplement and General
   Punctuation**, except the deferred and data glyphs listed explicitly in §3. This is §2's rule as
   a test, and it is what stops the next `ⓘ` from being added quietly. The exclusion list must be
   enumerated rather than expressed as a range: `⊗` is U+2297 (Mathematical Operators) and `ⓘ` is
   U+24D8 (Enclosed Alphanumerics), so any single "symbols" range wide enough to catch both also
   catches the whole deferred set.
3. `.tab-icon` resolves a non-monospace `font-family` and a fixed width — the regression test for
   §1, since the alignment it now depends on is a CSS property rather than a font one.

---

## Results

Built §5's two pieces (a, b) plus what building the acceptance-2 scan (below) found beyond §3's own
inventory.

**§5a — `.tab-icon`.** `TabStrip.css` dropped `font-family: var(--font-mono)` and `font-weight`
stayed; gained `width: 20px; text-align: center`, `.tree-row-glyph`'s own mechanism. `tabDisplay.ts`'s
`'[ ]'` became `'[]'`, matching `nodeDisplay.ts`'s own string for the same format — the space was
inert once the box became fixed-width.

**§5b — six icons.** `info`/`warning`/`error-circle`/`arrow-up`/`arrow-down`/`dismiss` added to
`commands/icons.ts`'s static import map, all verified present in the vendored set before importing.
`StatusBar.tsx`'s `⊗`/`⚠`/`ⓘ` and `FindBar.tsx`'s `↑`/`↓`/`✕` replaced with `<Icon>`. The status bar's
counts stay text, per the plan's own instruction (`<Icon name="error-circle" /> {errorCount}`, not an
icon encoding the number).

**What building the acceptance-2 scanner found, beyond §3's own inventory**: §3's table predates
`docs/plans/R65-shortcuts-help.md`'s own `Shortcuts.tsx`, which didn't exist when this plan was written and
turned out to have two violations of its own — the curated key-name table used `↑`/`↓`/`→`/`←`
(Arrows block) to describe Tree/Grid's own arrow-key bindings, and the panel's close button used the
same `✕` this round already iconifies everywhere else. Fixed rather than merely flagged, since both
are this session's own code: the curated table now spells the keys as words (`Up`/`Down`/`Left`/
`Right`), and the close button uses the same `dismiss` icon `FindBar.tsx`'s does.

**Acceptance.** All three built as specified:

1. `test/commands.test.ts` gained a `describe('R71 — the six replacement icons all resolve')` block
   (6 tests) — these six aren't reached by commands/registry `icon` fields the way R38's icons are
   (`<Icon>` is called directly, not through a `Command`), so they needed their own check rather than
   reusing R38's existing shape verbatim.
2. `test/textAsIcons.test.ts` (new) — a source-text scan over every `.ts`/`.tsx` file under
   `src/renderer` (116 files), comments stripped, checking every remaining character against the
   allowed ranges plus an explicit per-file allowlist for the §3/§4 exclusions (`Tree.tsx`'s twisty,
   `Grid.tsx`'s sort/pin/drill marks, `gridExport.ts`'s presence marker). One test per file, so a
   violation names exactly where it is; a new file with a stray symbol-block character fails on its
   own line, not a shared aggregate assertion.
3. `test/tabStrip.test.tsx` gained a `describe('TabStrip format glyph styling (R71)')` block —
   real Chromium, `getComputedStyle` on a mounted `.tab-icon`, asserting the font-family no longer
   contains "mono" and the width/text-align match `.tree-row-glyph`'s own values.

**Review.** No findings in the six-icon replacement or the CSS fix themselves. One thing worth
recording: the acceptance-2 scanner's own design was reconsidered once while writing it — the first
attempt scanned raw source with no comment-stripping and immediately flagged this file's own
explanatory prose (which quotes the very codepoints being disallowed, to say what they were replaced
with) as a false positive. Comment-stripping fixed it; disclosed here since a scanner "passing" is
easy to mistake for "found nothing," when what actually happened was the first version was too naive
to trust.

**Tests.** 6 (icon resolution) + 116 (per-file codepoint scan) + 1 (tab-icon CSS) = 123 new/changed
assertions across three files, all real or structural (no rendered-DOM mount needed for the scan).
`npm run typecheck` and `npm run lint` both clean; the full suite passes (one flaky
`tabStrip.test.tsx` order-dependent failure observed in a full-suite run — the same class of flake
R47 already documented for this file — confirmed to pass both standalone and file-level, not a
regression from this round's CSS change).
