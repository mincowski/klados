# R82–R83 — what R67 and R71 moved rather than fixed

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Two reports, and the same shape underneath both: a round fixed
the symptom it was given and pushed the cost somewhere nobody was looking. Homes of the rounds
being amended: `docs/plans/R66-palette-polish.md` (R67) and `docs/plans/R71-text-as-icons.md`.
Neither is reverted — both did the right thing, and this is the half they could not see.

Answers first.

---

## 1. R82 — the palette selection jumps back to the top, and R67 is why it started

The report: arrowing down through the command list, one row scrolls and the selection jumps back to
the top.

**Confirmed, with an exact cause.** Every option row carries a hover handler:

```tsx
onMouseEnter={() => setActiveIndex(index)}    // Palette.tsx:466 (commands), :515 (nodes)
```

and R67 added:

```tsx
containerRef.current?.querySelector('.palette-option-active')?.scrollIntoView({ block: 'nearest' })
```

`.palette-list` is `overflow-y: auto` (`CommandPalette.css:43`). So the sequence is:

1. `ArrowDown` increments `activeIndex`.
2. Once the selection reaches the last visible row, `scrollIntoView` scrolls the list by one row.
3. **The rows move under a stationary mouse pointer.** The browser fires `mouseenter` on whichever
   row slid beneath the cursor — a real DOM event, no pointer movement required.
4. That row's handler calls `setActiveIndex(itsOwnIndex)`.

If the pointer is resting anywhere above the selection — which it is, because the palette opens
under wherever the cursor already was — the selection snaps back to it. One row of scroll, then a
jump to the top. Exactly as described.

**This is not R67's bug so much as R67's discovery.** The hover handler predates it, but before
R67 nothing ever scrolled the list from the keyboard, so rows never moved under a still pointer and
the latent conflict was unreachable. The scroll fix is what made it reachable.

### Why the test did not catch it

`test/paletteRender.test.tsx:87` fires `totalOptions - 1` synthetic `ArrowDown` keydowns and asserts
the active row is inside the list rect. It passes, and it will keep passing, because **there is no
pointer anywhere near the list**. The test proves the scroll works; the defect lives entirely in the
interaction between that scroll and a pointer the test never places.

### The fix — hover must require actual pointer movement

The standard treatment, and the reason every editor and menu has this code: keyboard navigation
suppresses hover-activation until the pointer genuinely moves again.

- Track the last pointer position. On `mousemove` over the list, compare `clientX`/`clientY` against
  it; only a *changed* position re-enables hover-activation.
- Any arrow-key navigation disables it.
- `onMouseEnter` calls `setActiveIndex` only while enabled.

**Compare coordinates rather than relying on "scrolling doesn't fire `mousemove`."** It is true in
Chromium today and it is the kind of thing that changes; the coordinate check is immune either way
and costs one ref.

Both lists need it — commands (`:466`) and node matches (`:515`) — and both should share one
helper rather than growing two copies of the rule.

### The guard

A test that arrows down **with a pointer parked over the list**: dispatch a `mousemove` at a fixed
coordinate over an early row, then fire the arrow keys, then assert `activeIndex` is where the
keyboard put it. It fails today. Real Chromium (`paletteRender.test.tsx`'s own project), because it
depends on real layout and real hit-testing.

---

## 2. R83 — the tab markers, and the argument R71 invalidated in its own commit

The report: JSON looked better in monospace; XML's `<>` could be narrower and more open; try
`⟨⟩` or `〈〉`.

R71 removed `--font-mono` from `.tab-icon` deliberately, and its stated reason was:

> The obvious reason to reach for a monospace font in a list of tabs is column alignment […] **It
> does not do that here**, because the three markers are not the same length: `<>` and `{}` are two
> characters, `[ ]` is three.

**That was true when it was written and false by the end of the same round.** R71 §5a changed
TOML's marker from `'[ ]'` to `'[]'` — the change is in `tabDisplay.ts` with an R71 comment on it.
Once all three markers are two characters, a fixed advance width equalises them exactly, which is
the thing the argument said was impossible. The premise was removed and the conclusion was kept.

### Measured

Canvas advance widths at the tab strip's own 11px/600, real Chromium on this machine, against the
20px centred `.tab-icon` box:

| Marker | `--font-ui` | `--font-mono` |
|---|---|---|
| `<>` XML | **15.28** | 12.89 |
| `{}` JSON | **7.30** | 12.89 |
| `[]` TOML | **7.30** | 12.89 |

In the UI font, XML's marker is **more than twice the width of JSON's** — 76% of the box against
37%. That is not a subtle typographic difference: one marker nearly fills its box while the other
floats small in the middle of an identical box directly beside it. **That is the reported "JSON
looked better before"**, and it is a size problem as much as a shape one. Monospace puts all three
at 12.89 — 64% of the box, identical, by construction.

**So: restore `font-family: var(--font-mono)` on `.tab-icon`.** Keep R71's `width: 20px;
text-align: center`, which is right and independent — it is what lets a future four-character
marker work at all.

### Both proposed angle brackets fail, for measured reasons

| Candidate | In `--font-ui` | In `--font-mono` | Width |
|---|---|---|---|
| `⟨⟩` U+27E8/9 | **not present** | **not present** | 8.35 both |
| `〈〉` U+2329/A | **not present** | **not present** | 8.35 both |
| `〈〉` U+3008/9 | not present | not present | 22.00 both |

Neither Segoe UI nor Cascadia Code/Mono has them. They render only because Windows has a fallback
font, and the identical 8.35 in both stacks is the proof: the same fallback serves both, so neither
stack's own fonts contributed anything.

Two consequences, either one disqualifying:

- **`⟨⟩` defeats the alignment we just restored.** It falls out of the monospace stack, so it draws
  at 8.35 while `{}` and `[]` draw at 12.89 — XML would be the odd one out again, in the opposite
  direction, having just been fixed.
- **It is precisely the `ⓘ` failure R71's rule was written to prevent**: "its shape varies with
  whatever font happens to resolve." The rule ("symbol-block codepoints may not be used as a mark")
  predicted this correctly. R71's *alignment* argument was wrong; its *codepoint* rule was right and
  should stand.

**`〈〉` U+2329/U+232A is worse and should be ruled out permanently.** Unicode gives it a canonical
decomposition to U+3008/U+3009, the CJK angle brackets — verified: `'〈'.normalize('NFC')` returns
U+3008. Any NFC pass anywhere turns the marker into full-width CJK punctuation, measured at
**22.00px** against a 20px box. Worth writing into `docs/FINDINGS.md`: it is a trap that will bite
anyone reaching for an angle bracket in this codebase again, and it is invisible until something
normalizes.

### What is actually available

Every candidate that resolves in **both** stacks, measured:

| Candidate | Block | `--font-ui` | `--font-mono` | Notes |
|---|---|---|---|---|
| `<>` | Basic Latin | 15.28 | 12.89 | today; the shape that prompted R71 |
| `‹›` U+2039/A | General Punctuation | 7.23 | 12.89 | narrower, more open angle |
| `«»` U+00AB/BB | Latin-1 Supplement | 11.87 | 12.89 | heavier, doubled chevrons |
| `</>` | Basic Latin | 19.82 | 19.34 | three chars — needs a wider box |

All four are inside R71's rule as written ("ASCII, with Latin-1 Supplement and General
Punctuation"), so none of them requires amending it.

### Decided: `<>` stays, in monospace

**Settled after looking at the rendered candidates.** `‹›` is rejected on sight — the guillemets sit
low and small, reading as quotation marks rather than as a tag. `⟨⟩` was preferred visually and is
rejected on the font evidence below. So the change is **the font, not the glyph**: restore
`--font-mono` to `.tab-icon` and leave all three markers as they are.

That is also the outcome with the least left to argue about later — `<>` is the literal syntax of
the format it marks, which was R71's own best argument and survives everything else in this section.

### Why `⟨⟩` had to be rejected even though it looks right

Widths were not the reason — unequal advance widths were explicitly acceptable. **Font availability
was.** Probed per family in real Chromium on this machine:

| Family (installed here) | U+27E8 `⟨` | U+2329 `〈` | U+3008 `〈` |
|---|---|---|---|
| Segoe UI | — | — | — |
| Cascadia Code / Cascadia Mono | — | — | — |
| Consolas | — | — | — |
| Arial, Times New Roman, Cambria Math | — | — | — |
| **Segoe UI Symbol** | **yes** | — | — |

*That table is a width heuristic and is not trustworthy family by family* — it reports `—` for
Cambria Math, which does contain U+27E8. Read it only for the rows that matter, the stacks the app
actually names, and lean on the independent evidence below.

**The independent evidence.** U+27E8 measures **16.69px identically** under `--font-ui`,
`--font-mono`, bare `serif` and bare `monospace` — four unrelated stacks resolving to one common
last-resort — while `'Segoe UI Symbol'` named explicitly gives **13.28px**. Four stacks agreeing on
a width that none of their own fonts produces is only possible if none of them contains the glyph.
And Chromium is not even picking the installed system font that does.

The same technique is what confirms the tree glyphs below: in a monospace font every character has
the *same* advance, so a fallback character is visible as a deviation. All thirteen of the tree's
own glyphs measure 6.45 — none of them falls back.

So the rendered shape is chosen by a fallback chain **nothing in this app names or controls**, which
is exactly the `ⓘ` failure R71's codepoint rule was written to prevent, restated with a measurement
instead of an impression. It renders fine here; that says nothing about the macOS and Linux builds,
which were not measured and cannot be from this machine.

**The only way to have `⟨⟩` safely would be to bundle a font that contains it** — a new asset, a
licence question and a per-build size cost for one 11px tab marker. Not worth proposing.

### The tree glyph has to move too, or R71's report comes back

The glyph is not changing, so `nodeDisplay.ts:79` keeps `'<>'`. **The font is a different matter,
and this is the part that is easy to miss.**

R71 §1 was answering "make the tab's XML marker more like the tree view's node icon", and it
achieved that by giving `.tab-icon` the tree's typography. Restoring monospace to `.tab-icon`
*alone* re-splits them: the tab would draw `<>` at 12.89 and the tree at 15.28, in different fonts —
the exact divergence R71 was asked to remove.

**So apply `--font-mono` to `.tree-row-glyph` as well.** The tree's other glyphs are
`D : " ¶ # ? !` (one character) alongside `<> {} []` (two). **Measured, not assumed**: all thirteen
characters draw at exactly 6.45 in `--font-mono` at 11px — the uniform advance that proves none of
them falls back, `¶` U+00B6 included. Within a 20px centred box they stay centred whatever their
advance. The two
surfaces keep the deliberate differences R71 documented — weight 600 versus 400, and the tree's
`--syntax-punctuation` tint — and stop differing in the one dimension that was reported.

**This half is independently revertible**, and it touches a surface that was not reported on: if the
tree looks worse in place, drop it and say so in the Results rather than keeping it out of tidiness.

---

## Definition of done

- [x] R82 — arrowing through the palette with the pointer resting over the list keeps the selection
      where the keyboard put it. Both lists, one shared helper. A real-Chromium test that parks a
      pointer and fails against today's code.
- [x] R83 — `.tab-icon` is `--font-mono` again; all three markers measure the same advance width.
- [x] R83 — `.tree-row-glyph` is `--font-mono` too, so the tab marker and the tree glyph still match
      (or it is reverted, with the reason recorded). No glyph changes: `<>` stays.
- [x] R83 — `docs/plans/R71-text-as-icons.md` §1's alignment argument is corrected in place rather
      than left to contradict this file, and the U+2329 → U+3008 normalization trap is in
      `docs/FINDINGS.md`.

---

## Results

**Built as specified.**

**R82.** `Palette.tsx` gained `useHoverGate`, one hook instance shared by both option lists. The
first design (a separate `mousemove` listener clearing a `suppressedRef`, checked from
`onMouseEnter`) had a real ordering bug, caught by the guard test's own "genuine pointer move
re-enables hover" case: Chromium fires `mouseover` (what `onMouseEnter` synthesizes from) *before*
the accompanying `mousemove` for the same pointer transition, so a separate listener would still
see the stale, suppressed flag at the moment `mouseenter` itself fired for a targeted jump onto a
new row — the suppression would only lift a tick too late. Fixed by moving the coordinate check
into the hover handler itself: `activateOnHover(event, activate)` compares the entering event's own
`clientX`/`clientY` against the last-seen position and clears suppression there, removing the race
rather than papering over it. `suppressHover()` is called from the `ArrowDown`/`ArrowUp` branch of
`onKeyDown`.

`test/paletteHoverGuard.test.tsx` uses `userEvent.hover` (`@vitest/browser/context`, real
Playwright pointer automation) rather than a dispatched `MouseEvent` — a synthetic `dispatchEvent`
never moves the actual OS-level cursor Chromium tracks for its own automatic re-hit-testing after a
layout shift, so it cannot reproduce the bug at all; confirmed by running the test against the
pre-fix code, where it fails (lands on option index 14 instead of 34). The test also confirms a
genuine subsequent pointer move still re-activates hover afterward — the gate isn't a one-way latch.

**R83.** `.tab-icon` (`TabStrip.css`) and `.tree-row-glyph` (`Tree.css`) both regained
`font-family: var(--font-mono)`; the `width`/`text-align` centring R71 added stays on both. No
glyph changed. `test/tabStrip.test.tsx`'s R71 describe block is renamed R71/R83 and its assertion
inverted (`toContain('mono')`); a new `test/treeGlyphFont.test.tsx` covers the tree glyph the same
way. `docs/plans/R71-text-as-icons.md` §1 gained a correction block in place rather than being left
to contradict this file, and the U+2329→U+3008 normalization trap is in `docs/FINDINGS.md`.

**Tests**: `test/paletteHoverGuard.test.tsx` (new), `test/tabStrip.test.tsx` (one assertion
inverted), `test/treeGlyphFont.test.tsx` (new). Full suite green except the same pre-existing,
unrelated flaky failures noted in `docs/plans/R78-find-affordances.md`'s own Results, plus one more
of the same kind seen this round (`tabStrip.test.tsx`'s chevron-scroll test, timing-sensitive under
full-suite load, passes reliably alone).
