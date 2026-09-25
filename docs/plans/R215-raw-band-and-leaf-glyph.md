# R215–R216 — Raw's node band as a guide, and a leaf glyph for XML elements

<!-- status: built -->

**Built.** Both from user feedback relayed by the project lead, both decided on renderings in the
running application (`PLANNING.md` §1), and landed together because each is a few lines. Neither
changes behaviour; both are what a node looks like. Planned for a bug-fix release (1.1.1).

- **R215** — the selected node's span in Raw is its own soft grey in both focus states, no longer
  `--selection-bg`. Decision: D-107.
- **R216** — an XML element with no element children shows `•` instead of `<>` in the Tree and
  the Detail pane. Decision: D-108.

## 1. R215 — the node band in Raw

### The report

> *In raw view, when a node is selected, the text might be hard to read due to the grey
> highlight. […] this should be only a mild guide to the eye, not make it harder to read the
> selected text.*

The project lead proposed 50% of today's grey in light and 80% in dark, and asked for it checked.

### What was there

`.raw .cm-np-selected` painted `--selection-bg`, which R113 made focus-aware on `.raw-pane`: grey
(`--row-selected-inactive-bg`) while the keyboard is elsewhere — the usual case, since a node is
normally selected from the Tree — and blue (`--row-selected-bg`) while Raw has focus. **The text
selection uses the same token** (R117's `::selection`).

### Measured: text on the band

WCAG contrast for every syntax colour on the band, the weakest two shown, against the surface
without it:

| Theme | Band | Weakest text on the band | Off the band | Band vs. surface |
|---|---|---|---|---|
| light | 100% `--gray-300` — was | string 2.46, comment 2.57 | 4.10, 4.27 | 1.66 |
| light | 50% (proposed) | string 3.22, comment 3.35 | | 1.27 |
| light | **40% — chosen** | string 3.37, comment 3.52 | | 1.22 |
| dark | 100% `--gray-700` — was | comment 2.29, number 3.04 | 4.20, 5.58 | 1.84 |
| dark | 80% (proposed) | comment 2.63, number 3.49 | | 1.60 |
| dark | **60% — chosen** | comment 3.00, number 3.99 | | 1.40 |

Rendered side by side, **dark at 80% could not be told from the full grey**, so 60% was put next to
it; the project lead chose 60% for dark and, having seen 40% for light too, 40% there.

### Found while rendering: the focused case was worse

With Raw focused, the band and a text selection were **the same blue**. Double-clicking a word
inside the selected node — which also moves the node selection to the enclosing node, so the word is
always inside the band — produced a selection that could not be seen at all, in either theme. The
grey report was the visible half of a token shared by two things that must look different.

**Chosen, by the project lead**: the band is grey in *both* focus states, and blue belongs to the
text selection alone. It is a guide, not a selection, and it no longer claims to show where the
keyboard is — the caret and the pane's focus ring do that.

### What landed

- `--raw-node-band-bg` in both themes:
  `color-mix(in srgb, var(--row-selected-inactive-bg) N%, var(--surface-bg))`, 40 in light and 60
  in dark. Built from the existing semantic tokens rather than a new palette entry, so it follows
  either if they are ever retuned. Resolves to `rgb(231, 233, 237)` and `rgb(45, 50, 62)`.
- `Raw.css`'s `.cm-np-selected` reads it. `::selection` is untouched.
- `test/inactiveSelection.test.tsx`'s R115 test is replaced rather than loosened: the band is
  asserted **equal across focus states, exactly the value above per theme, and never equal to the
  text selection's colour**. Run against the old rule it fails on the first assertion.
- `docs/plans/R113-inactive-selection.md`'s table row for the span carries a note pointing here.

**Dark's text selection is itself weak** — `--blue-900` on `--gray-900` — and a selected word on the
band shows, but faintly. That is true everywhere in dark, not introduced here, and is left alone.

## 2. R216 — a leaf glyph for XML elements

### The report

> *For an XML file, every node in the tree view has the "<>" icon. That looks a bit boring and
> misleading. We should have different icons for elements that have child elements (not
> attributes, real child elements) and elements that don't.*

### The rule

An element is a **leaf** when none of its children is an element. Attributes are not children in
`NodeStore` at all; text, CDATA, comments and processing instructions are children but not
structure. So `<title>The Odyssey</title>`, `<reviewed/>`, `<stamped by="me"/>` and
`<commented><!-- … --></commented>` are leaves; `<mixed>text <b>bold</b></mixed>` is not.

Keyed on `NodeKind.Element`, not on a format (invariant 8). Only XML produces elements today; JSON,
TOML and CSV nodes keep their kind glyphs unchanged, which a test checks node by node.

### Chosen by rendering

Candidates were drawn in the running Tree at its real 11px, both themes, with containers kept on `<>`:

| Leaf glyph | Outcome |
|---|---|
| `‹›` | collapses into an unreadable blob at 11px |
| `</>` | clearest of the bracketed ones, but reads as a generic "code" mark |
| `<·>` | quiet, legible |
| `< >` | looks like a spacing bug |
| `<…>` on containers instead | wider than the 20px glyph column |
| containers in `--syntax-tag-name`, no glyph change | too subtle |
| `:` | would echo JSON's name-and-value rows, but too faint, and JSON uses it for containers too |
| `◦` | too faint, especially in dark |
| `=`, `ab` | both promise a value an empty element does not have; `ab` also competes with `¶` |
| `›` | reads as a collapsed disclosure beside the real `▸` |
| `–`, `▪` | workable; the dash reads as a tree connector, the square heavier than needed |
| **`•`** | **chosen** — legible in both themes, no collision, no claim to contradict |

Dropping the brackets also sharpened what `<>` means: it now marks exactly the elements with element
children.

### What landed

- `nodeDisplay.ts`: `LEAF_ELEMENT_GLYPH` and `glyphOfNode(store, node)`, which returns it for an
  element without element children and the kind glyph otherwise. `glyphOf(kind)` stays for callers
  that have only a kind.
- The walk for an element child stops at the first one, and is **cached per store** exactly like
  `childCountOf`: an element holding only non-element children is walked to its end, and a visible
  row repeats the call on every render. The cache is keyed by `NodeStore` in a `WeakMap`, and every
  edit replaces the store, so it cannot go stale.
- Used by the Tree row, the Detail heading and the Detail children list. The Kind column and the
  glyph's tooltip still say *Element*.
- `•` draws in `--font-mono`, like every marker but `<>` (D-084); asserted in both the Tree and the
  Detail font tests.
- `test/leafElementGlyph.test.ts`: every element in a fixture covering text, empty, attribute-only,
  comment-only, PI-only, CDATA-only and mixed content; an element child after 2,000 comments; and
  every non-element node in XML and JSON unchanged. Two older font tests used a lone `<a/>` as their
  `<>` sample, which is now correctly a leaf; they use a container and also check the leaf.

## 3. Review

Read from `git diff`, once per id, before each commit.

- **R215 — a test that could not fail.** The new band test asserted the band differs from the text
  selection by comparing computed strings, but `color-mix()` computes to `color(srgb …)` and the
  selection to `rgb(…)`, so the strings always differed. Now compared as channels.
- **R216 — the record overstated the choice.** The candidate count was written as twelve (fourteen
  were rendered), and `nodeDisplay.ts` called the bullet the *only* legible candidate, which `–`
  and `▪` also were. Both corrected; the comment also named CDATA, which it had left out of what
  does not count as an element child.
- Invariants: no literal colours (the mix is of tokens, in the theme files); nothing
  format-specific above `src/formats/` (keyed on a kind); no per-render O(children) walk left
  uncached.
- Verified in the built application, not only in tests: the band in both themes with the Tree
  focused, the band with a word selected inside it in both themes with Raw focused, and the Tree
  glyphs in both themes.
