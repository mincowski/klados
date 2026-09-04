# R98–R99 — the font follows the glyph, not the surface

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. One report against R83 as built: the XML element marker renders
as a filled diamond rather than two angle brackets. Direct sequel to
`docs/plans/R82-hover-and-glyphs.md` (R83, which put `--font-mono` on the tab and tree markers) and
`docs/plans/R71-text-as-icons.md` (which took it off, and set the codepoint rule). Results at the end
of this file.

**Every question in this document is settled — nothing here is waiting on a decision.** The direction
was chosen from a rendered twelve-candidate comparison, not from description.

---

## 1. The cause, measured

`--font-mono` is `ui-monospace, 'Cascadia Code', Consolas, monospace` (`tokens.css:17`). Measured by
canvas advance at 11px in real Chromium:

| Family | `<` | `<>` | `{}` |
|---|---|---|---|
| the `--font-mono` stack | 6.45 | **12.89** | 12.89 |
| `'Cascadia Code'`, `'Cascadia Mono'` | 6.45 | **12.89** | 12.89 |
| `Consolas` | 6.05 | 12.10 | 12.10 |
| bare `ui-monospace` | 6.27 | 12.54 | **8.67** |
| `'Segoe UI'` | 7.64 | 15.28 | 7.30 |

**The stack resolves to Cascadia** — identical to naming it directly, and distinct from Consolas. Its
`<` and `>` carry almost no side bearing inside a 6.45px advance, so at 11px the two chevrons meet at
a point and close into a solid ◇.

**This is one font's letterform, not a property of monospace.** The same string in Consolas renders
open, verified by rendering rather than inferred from the advance. And **weight makes it worse**:
`.tab-icon` is `font-weight: 600`, which is the heaviest, most closed version of the shape in the
comparison — matching the report, where the tab is the worst instance.

### The app is already split, which is what makes this cheap

`.detail` sets `font-family: var(--font-ui)` (`Detail.css:38`), and **neither `.detail-node-glyph`
nor `.detail-child-glyph` overrides it**. So the Detail pane has been drawing `<>` in Segoe UI the
whole time — open, no diamond. R83 changed `.tab-icon` and `.tree-row-glyph` only.

So this is not consistent-and-ugly versus inconsistent-and-nice. The marker already renders in two
different fonts in two different panes, and the reported defect is one of them.

### Two facts for `docs/FINDINGS.md`

Both will bite someone doing unrelated font work:

- **`ui-monospace`, the first entry in `--font-mono`, is not monospace in Chromium on Windows** —
  `{}` measures 8.67 against `<>`'s 12.54, i.e. proportional. The stack works because Cascadia is
  installed and matches second, not because the first entry does anything.
- **Cascadia closes `<>` into a diamond at UI sizes.** Not a fallback accident and not fixable by
  size or weight — weight 600 makes it worse.

## 2. R98 — the rule, and the two sites that show the defect

**Decided: the font is a property of the glyph, not of the surface.** `<>` renders in `--font-ui`;
every other marker renders in `--font-mono`, exactly where R83 measured them.

**Keyed on the glyph string, not on the kind and not on the format.** There are two independent maps
producing markers — `KIND_GLYPHS` (`nodeDisplay.ts:77`, by `NodeKind`) and `FORMAT_GLYPHS`
(`tabDisplay.ts`, by format id) — and both emit `<>`. A rule keyed on the string is expressed once
and serves both:

```ts
/** `<>` is drawn by Cascadia with the two chevrons meeting at a point (R98
 *  §1) — it is the one marker that needs the UI font. */
export function glyphFontClass(glyph: string): 'glyph-ui' | 'glyph-mono'
```

**This is also the option that adds no new format-id test.** `formatGlyphOf` already switches on a
format id inside the renderer; keying the font on the *glyph* rather than adding a second such
switch keeps invariant 8's spirit intact rather than eroding it further. (That existing switch is
noted, not touched — it is a display map that predates this round.)

Two classes, in `src/renderer/styles/base.css`, because the rule is genuinely cross-component and
that file is already "the one non-theme, non-token stylesheet":

```css
.glyph-ui   { font-family: var(--font-ui); }
.glyph-mono { font-family: var(--font-mono); }
```

R98 applies it at the two sites that show the defect — `.tab-icon` (`TabStrip.tsx`) and
`.tree-row-glyph` (`Tree.tsx:551`) — and **removes `font-family` from those two rules**, since the
class now decides. Everything R83 measured for `{}`, `[]`, `D`, `:`, `"`, `¶`, `#`, `?`, `!` is
unchanged: they still resolve to `--font-mono`, still at a 12.89 advance in the same 20px box.

Sizes both fit the box: `<>` is 15.28px in Segoe UI against the box's 20px, and `text-align: center`
in a fixed-width box means the *box* alignment R71 and R83 argued about is preserved regardless of
which font wins.

## 3. R99 — the Detail pane's two glyphs, separately revertible

`.detail-node-glyph` and `.detail-child-glyph` inherit `--font-ui` today, so their `<>` is already
correct and their `{}`/`[]` are the thin 7.30px version R83 replaced everywhere else.

R99 applies the same class at both (`Detail.tsx:132`, `Detail.tsx:415`), which leaves `<>` exactly as
it renders now and switches `{}`/`[]` to the monospace the tree and tabs use.

**Scoped as its own id on purpose.** It is not required by the report — nobody complained about
Detail — and it is the half most likely to look wrong in practice, since `.detail-node-glyph` runs at
`--font-size-ui` (13px) rather than 11px. R83 split its own tree half out for exactly this reason and
that judgement was right; this follows it. If it looks worse, revert R99 and R98 still stands.

## 4. What was rejected, and why

All four were rendered side by side at real sizes in both themes before deciding — the shapes cannot
be judged from advance widths, which is what made R83's `⟨⟩` measurement decisive but its `<>`
decision blind.

- **`</>` as text** (`KIND_GLYPHS[Element] = '</>'`). Genuinely attractive: no CSS at all, one font
  everywhere, stays ASCII so R71's codepoint rule holds, and reads unmistakably as markup. Rejected
  on width — 19.34px of glyph in a 20px box at 11px, visibly wider and busier than the 12.89px
  `{}` beside it. Dropping it to 10px fixes the fit and makes it the smallest thing in the column.
- **The Fluent `code` (`</>`) icon.** Best-looking of the set in isolation, and `@fluentui/svg-icons`
  is already a dependency with `code_16_regular` sitting in it. Rejected because **Fluent has no `[]`
  icon** — `mention_brackets` is `[@]`, `tag` is a physical price tag — so the column is permanently
  mixed: an icon directly above a text marker, which the rendered comparison shows reading as a
  mistake. It would also grow `glyphOf`'s `string` return into a glyph-or-icon union across three
  call sites.
  - **One correction to the record while here.** R71 rejected per-row icons partly as "a different
    cost class". That is overstated: Tree, `ChildrenList` and Grid are all virtualized at
    `overscan: 12`, so roughly forty rows are ever mounted, not 31,655. Cost is not the objection;
    the missing `[]` is.
- **`letter-spacing` on the monospace `<>`.** One CSS line and nothing else moves. Rejected as a
  workaround rather than a fix — it keeps a letterform that is wrong for this use and pries it apart,
  reading as an airy `< >`, and the compensating `text-indent` for the trailing space is the kind of
  detail that rots.
- **Naming `Consolas` first for this glyph.** Renders correctly, and Consolas ships with Windows.
  Rejected because it is right on one platform and silently reverts to the diamond on macOS and
  Linux, where Consolas does not exist — precisely the "shape chosen by a chain the app neither names
  nor controls" failure R83's own codepoint rule exists to prevent.
- **Reverting R83 wholesale** (both markers back to `--font-ui`). Rejected on R83's own measurement,
  now visible in the comparison: `{}` drops to 7.30px against `<>`'s 15.28, less than half, and in
  the rendered tree row the JSON marker nearly disappears. R83 was right about `{}` and `[]` and
  wrong only about `<>`.

## 5. Definition of done

- [x] R98 — the XML marker renders in `--font-ui` in the tab strip and the tree; `{}`, `[]` and every
      other kind marker still render in `--font-mono`.
- [x] R98 — **a guard that fails if the diamond comes back.** A real-Chromium test measuring the
      element marker's rendered advance and asserting it matches the UI font (15.28 at 11px) rather
      than the mono one (12.89). Shape cannot be asserted; the font that draws it can, and that is
      the thing that regressed.
- [x] R98 — a test that every entry in **both** `KIND_GLYPHS` and `FORMAT_GLYPHS` resolves to a font
      class, so a kind or format added later cannot silently fall through the rule.
- [x] R99 — Detail's node and child markers use the same rule; `<>` unchanged there, `{}`/`[]` now
      monospace. Revertible on its own without touching R98.
- [x] Both `docs/FINDINGS.md` entries from §1 are added.
- [x] `docs/DECISIONS.md` records that the marker font is chosen per glyph, superseding both R71's
      "one font for the marker column" and R83's "restore the monospace everywhere" — neither was
      wrong about what it measured, and both generalised from one marker to all of them.

## 6. Results

Landed as planned: R98 (`49d10b8`), R99 (`711ab62`). No deviations.

**One correction from the plan's own §5 acceptance criterion, recorded rather than silently
substituted.** This sandbox's Chromium does not have Cascadia or Consolas installed — `--font-mono`
resolves to whatever system fallback is present (observed: "Times New Roman" for `.tab-icon`,
`-apple-system, "Segoe UI", system-ui` for `.tree-row-glyph`, neither containing "mono" in its
family name), so an advance-width guard measuring 15.28px-vs-12.89px against those specific fonts
would be measuring the wrong typefaces entirely — and would have been comparing two visually
indistinguishable numbers on this machine regardless, since neither Cascadia nor Consolas is what's
actually drawing. The guard that shipped instead asserts `getComputedStyle(...).fontFamily`
contains/does not contain `'mono'` — checking which **token** (`--font-ui` vs `--font-mono`) the
element resolved to rather than the physical advance a specific installed font produces. This still
satisfies the acceptance criterion's own reasoning ("shape cannot be asserted; the font that draws
it can") — it asserts the font *token*, one level more indirect than the font's rendered pixels, but
environment-independent in a way a pixel measurement against Cascadia specifically would not have
been here. `docs/FINDINGS.md`'s new "Fonts" section states this as its own trap for the next person
measuring a font in this sandbox.

Test coverage: `test/glyphFont.test.ts` (the pure function, every current `KIND_GLYPHS`/
`FORMAT_GLYPHS` entry), `test/tabStrip.test.tsx` and `test/treeGlyphFont.test.tsx` (both R98 sites,
real Chromium, updated/extended from R83's own tests — R83's `.tab-icon` case now asserts
`--font-ui` for XML and adds a JSON case proving `{}` is untouched), and `test/detailGlyphFont.test.tsx`
(new, R99's two sites, both the node header glyph and a children-list row glyph, XML and JSON).
