# R215–R217 — Raw's node band as a guide, a stronger text selection, and a leaf glyph for XML elements

<!-- status: built -->

**Built.** All three from user feedback relayed by the project lead, all decided on renderings in
the running application (`PLANNING.md` §1), and landed together because each is a few lines. None
changes behaviour; all are what a node or a selection looks like. Planned for a bug-fix release (1.1.1).

- **R215** — the selected node's span in Raw is its own soft grey in both focus states, no longer
  `--selection-bg`. Decision: D-107.
- **R216** — an XML element with no element children shows `•` instead of `<>` in the Tree and
  the Detail pane. Decision: D-108.
- **R217** — Raw's text selection, while the pane is focused, is a stronger blue than a row band's,
  so it stands out from R215's band. Decision: D-109.

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
*Addressed by R217 (§3)*, after the project lead found the selection still too faint against the
band in both themes.

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

## 3. R217 — a stronger blue for Raw's text selection

### The report

After R215 landed, the project lead: *"I'm still not so happy with the band highlighting. But I
think the actual issue is that we should choose a different color for text selection. A text
selection is still barely visible with respect to the node highlight band."*

### Why it barely showed

Raw's focused selection was `--row-selected-bg`, the Tree and grid's selected-row band. Measured
against R215's node band:

| Theme | Selection | Against the band | Against the surface |
|---|---|---|---|
| light | `--blue-100` | **1.02:1** — the same brightness; only hue separates them | 1.24:1 |
| dark | `--blue-900` | 1.21:1, and *darker* than the band | 1.15:1 |

A row band has to be pale enough to carry a whole row of text, which is right for the Tree and the
grid and wrong for a selection that sits on another band.

### Chosen by rendering

Three stronger blues per theme were rendered in the running application, Raw focused, four lines
selected inside the selected `book`'s band:

| Theme | Candidate | Against the band | Weakest text on it |
|---|---|---|---|
| light | **A — `--blue-200`** — chosen | 1.32:1 | string 2.56, comment 2.66 |
| light | B — `--blue-400` at 50% | 1.40:1 | string 2.40 |
| light | C — `--blue-300` at 75% | 1.47:1 | string 2.29 |
| dark | **A — `--blue-700`** — chosen | 1.29:1 | comment 2.34, tag 3.16 |
| dark | B — `--blue-500` at 50% | 1.30:1 | comment 2.32 |
| dark | C — `--blue-500` at 60% | 1.49:1 | comment 2.02 |

B rendered almost indistinguishable from A; C began washing out amber text in light and comments
in dark. **A is two existing palette entries**, no mixing. The project lead chose A.

**The cost is stated, not hidden**: every stronger blue lowers the contrast of the text it covers,
to 2.56:1 in light and 2.34:1 in dark at the weakest. A selection is transient, and one that cannot
be seen is the worse failure. In dark, blue tag names on a blue selection lose the most, being the
same hue.

### What landed

- `--text-selection-bg` in both themes — `--blue-200` in light, `--blue-700` in dark — read by
  `.raw-pane:focus-within`'s `--selection-bg`. **Raw only**: the Tree's and grid's selected rows
  keep `--row-selected-bg`, which has no band under it to compete with.
- **The unfocused selection is unchanged** (`--row-selected-inactive-bg`); it is grey on a lighter
  grey, 1.36:1 against the band in light and 1.31:1 in dark.
- `test/inactiveSelection.test.tsx`: both Raw tests now assert `--text-selection-bg`, the light
  value exactly, and **a contrast of more than 1.25:1 between the band and the selection in both
  themes** — the property the report was about. With the old blue the value assertions fail; with
  only the contrast rule checked (the token set back to `--blue-100`), it fails at 1.023:1.

## 4. Review

Read from `git diff`, once per id, before each commit.

- **R215 — a test that could not fail.** The new band test asserted the band differs from the text
  selection by comparing computed strings, but `color-mix()` computes to `color(srgb …)` and the
  selection to `rgb(…)`, so the strings always differed. Now compared as channels.
- **R216 — the record overstated the choice.** The candidate count was written as twelve (fourteen
  were rendered), and `nodeDisplay.ts` called the bullet the *only* legible candidate, which `–`
  and `▪` also were. Both corrected; the comment also named CDATA, which it had left out of what
  does not count as an element child.
- **R217 — one unclear comment.** `light.css` said the selection stands out from "the node band
  above", naming no token; it now names `--raw-node-band-bg`. Nothing else: `--row-selected-bg` has
  no other reader in Raw, and `--text-selection-bg` has exactly one.
- Invariants: no literal colours (the mix is of tokens, in the theme files); nothing
  format-specific above `src/formats/` (keyed on a kind); no per-render O(children) walk left
  uncached.
- Verified in the built application, not only in tests: the band in both themes with the Tree
  focused, the band with a word selected inside it in both themes with Raw focused, the Tree glyphs
  in both themes, and R217's selection over the band in both themes.
