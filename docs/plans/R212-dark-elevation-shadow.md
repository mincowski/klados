# R212 — the elevation shadow does nothing in dark

<!-- status: built -->

**Built.** Dark's `--elev-2-shadow` is now `0 6px 16px rgba(0, 0, 0, 0.55)` — a value between
this plan's (a) and (b), chosen by the project lead from six rendered in the running application —
and `.raw-wrapping-overlay` has the tier's hairline (§ 5). `CONCEPT.md` §9.3 is amended and D-102
records the decision. **The plan's own recommendation (b) and its §4 alternative (e) were both
wrong**, for the same reason: the round measured a hard ceiling neither of them knew about. See
§ 9. Raised by the project lead while looking at R206's rendered comparison: *"in light mode
the shadow shows nicely, but in dark mode it doesn't. I guess it is still there, just hard to see
because the background is dark. Should the shadow become lighter than the background?"*

The observation is correct and the shadow is indeed still there. Whether that is a defect is the
question, and it is not a small one: **`--elev-2-shadow` has nine consumers**, so any answer is an
application-wide change, and the current behaviour is not an oversight — `CONCEPT.md` §9.3
specifies it.

Kept out of R206–R208 deliberately. Those are three cosmetic defects in three components;
this revises a documented design rule for every floating surface in the application.

## 1. What is actually there

| Theme | `--elev-2-shadow` |
|---|---|
| light | `0 4px 12px rgba(20, 23, 30, 0.14), 0 2px 4px rgba(20, 23, 30, 0.08)` |
| dark | `0 2px 8px rgba(0, 0, 0, 0.3)` |

Near-black at 30% over `--gray-850` (`#1c202a`) on `--gray-900` (`#14171e`). It renders; it is
just not distinguishable from the pane it falls on.

The nine consumers, from `grep -rn "var(--elev-2-shadow)" src/`:

`Detail/Grid.css` ×2 (the column-picker dropdowns), `Find/Find.css`, `Help/Shortcuts.css`,
`Palette/CommandPalette.css`, `Raw/Raw.css` (`.raw-wrapping-overlay`),
`StatusBar/StatisticsPanel.css`, `TabStrip/TabStrip.css` (the overflow menu),
`notifications/Notifications.css`.

## 2. It is specified, not accidental

`CONCEPT.md` §9.3:

> - **Light theme** — background stays near-white; the shadow carries the elevation
> - **Dark theme** — shadow drops to near-zero; the background steps progressively lighter

`R60-dark-elevation.md` §3 already amended the *enumeration* here — it found that R57 had
introduced a third mechanism, a border, which reads on both themes where neither shadow nor a
background step manages it — but left the premise standing: **shadow does not read on a dark
surface, so something else must carry elevation in dark.**

And `CommandPalette.css`'s own header comment already states the consequence as measured fact:

> dark — border 1.84 against the app behind it, doing essentially all the work; the background
> step is only 1.10 and `--elev-2-shadow` is near-black on a near-black surface.

So the honest framing of this round is **not** "the dark shadow is broken". It is: *dark's
elevation is carried by two mechanisms that both work, and a third that contributes nothing —
should the third be made to contribute, or removed as dead weight?* Those are different questions
from the one that was asked, and the second one has not been considered before.

## 3. Rendered, because §1 of `PLANNING.md` requires it

Four candidates were rendered in a mock of the notification stack and the command palette
(`scratchpad`, R206's session) before this plan was written. Recorded here because the images do
not survive the session:

| | value | how it reads |
|---|---|---|
| **a** | `0 2px 8px rgba(0,0,0,.3)` — shipped | no visible contribution; the card is defined by its border and the background step |
| **b** | `0 8px 24px rgba(0,0,0,.75)` | a real cast shadow, clearly visible against the alternating row bands; the most conventional of the four |
| **c** | `0 0 0 1px rgba(255,255,255,.08), 0 8px 24px rgba(0,0,0,.6)` | the light rim competes with the existing 1px `--surface-border`, reading as a double border |
| **d** | `0 4px 16px rgba(255,255,255,.10)` | the literal inversion; reads as the card *emitting* light rather than sitting above the surface |

**Provisional recommendation: (b)**, with (e) below as the serious alternative. But this is a
visual decision and the render above is a *mock*, not the application — see § 6.

**(c) is rejected on what was seen**: this project's elevated tier already carries a 1px
`--surface-border` on every surface (R60 §5 part 1, verified still true — all nine consumers have
it except `.raw-wrapping-overlay`, see § 5), so a light rim is a second border, not a shadow.

**(d) is rejected on grounds the render confirms**: a light halo inverts the light source. The
light theme's shadow says "this is above the page"; a glow says "this is glowing". The two themes
are peers (`CONCEPT.md` §9.1) but they should not describe *different physics*.

## 4. The option that was not on the list

**(e) delete `--elev-2-shadow` in dark** — set it to `none` and let `CONCEPT.md` §9.3's own
statement be true in the stylesheet rather than approximately true.

This deserves a line because it is the conclusion the current evidence actually supports. The
shadow contributes nothing measurable, and a token whose value is "invisible" is a maintenance
trap: someone will eventually tune it, see no change, and conclude something else is wrong. R60's
§4 found exactly this shape — a hairline that was invisible because two tokens resolved to the
same value, sitting there looking like it worked.

Against (e): the pair is `CONCEPT.md` §9.4 / invariant 9's *token pair* (background + shadow), and
`none` is a legitimate value for the pair's second half rather than a violation of it. Worth
confirming rather than assuming.

## 5. Two things found while measuring this, which belong to this round

**`.raw-wrapping-overlay` is an eighth `--elev-2-bg` surface with no hairline** (`Raw.css:61`).
R60 §5 part 1 gave the hairline to every elevated surface *then existing*; this one was added
afterwards by D12 and did not get it. It is white-on-white in light for the one frame it shows.
Small, and genuinely a one-frame element — but it is the same defect R60 fixed six times, and
whichever way R212 goes it should either get the hairline or be recorded as deliberately exempt.

**`docs/FINDINGS.md` still says only one of seven elevated surfaces has a border.** R60 made that
false and the entry was not updated — the same drift `R206-disclosed-ui-defects.md` §4 names,
found again one file over. Corrected as part of R206's round rather than left for this one.

## 6. What this round must do before deciding

1. **Render in the application, not in a mock.** §3's images are a hand-built approximation of
   two surfaces. The real question is how nine surfaces look, and the palette over a *populated*
   Tree/Detail/Raw layout is the case that matters — a shadow reads differently over flat
   background than over alternating row bands, and the mock had only one of those.
2. **Measure, do not eyeball, what the shadow buys.** The existing precedent is
   `test/scrollbarContrast.test.tsx` and `test/notifications.test.tsx`: sample the rendered pixels
   just outside each surface's edge and state the delta against the pane. "Visible" is a number
   here, and the current value's number is what makes (e) arguable.
3. **Check all nine, not one.** The two grid dropdowns open *inside* a pane over row bands; the
   palette floats over the whole layout; `.raw-wrapping-overlay` sits in a corner for one frame.
   A value tuned on the notification stack alone is R208's mistake in a new place — one sample
   generalized.
4. **Say what happens to `CONCEPT.md` §9.3.** Every outcome except (a) changes it: (b) and (c)
   make dark's shadow load-bearing, (e) makes its "drops to near-zero" literal. The concept
   document is amended in the same commit either way.

## 7. Rejected

**Changing light's shadow.** Nothing is wrong with it and it is not what was asked. Stated because
"make the two themes consistent" is the tempting generalization and it would be a regression.

**Making this a notification-only change.** The token is shared by nine surfaces and R60's whole
finding was that the elevated tier must be treated as a tier. Giving `.notification` a private
shadow is how the tier drifts apart again.

**Folding it into R206.** Separate blast radius, separate `R` id, per `CLAUDE.md` — and R206's
own § 5 rejects bundling unrelated cosmetics for exactly this reason.

## 8. Version

**Ask on landing.** Candidate: patch — an appearance change in one theme with no capability
change. If the outcome is (e), it is a token value and a `CONCEPT.md` correction and arguably not
even that.


## 9. Results — built

### What landed

`src/renderer/styles/themes/dark.css` — `--elev-2-shadow: 0 6px 16px rgba(0, 0, 0, 0.55)`, up from
`0 2px 8px rgba(0, 0, 0, 0.3)`. Light is untouched (§ 7).

`src/renderer/components/Raw/Raw.css` — `.raw-wrapping-overlay` gets
`border: var(--border-width) solid var(--surface-border)`, closing § 5's first finding.

`test/elevationBorders.test.ts` — the enumeration gains `Raw.css` and `Notifications.css`, **and
stops being the authority**: a new test walks `src/renderer` for every stylesheet declaring
`background: var(--elev-2-bg)` and fails if one is not listed. § 5's finding was not really "this
surface has no border" — it was "a hand-maintained list of surfaces went four rounds out of date
while its own test passed", and adding one entry would have left that intact.

`test/elevationShadow.test.ts` — new. Four assertions on the token itself: not `none` and alpha at
least 0.5; near-black rather than inverted; light's two-layer pair intact; and dark's
`--elev-2-bg` still stepped off `--surface-bg`, invariant 9's first half. Mutation-verified —
restoring the old `rgba(0,0,0,.3)` fails the first, an inverted white value fails the second.

`docs/CONCEPT.md` — § 6.4's requirement, met: §9.3's dark bullet is reordered so the border and
the step come first and the shadow last, the ceiling below is written into the section, and the
key+ambient sentence is marked as light's.

### The ceiling, which is the round's actual finding

**A black shadow on `--surface-bg` cannot exceed 1.171:1, at any opacity, over any blur.** That
ratio is `--gray-900` (`#14171e`, relative luminance 0.0086) against pure black — the whole budget.
For comparison the background step alone is 1.101:1, and the hairline is 1.836:1.

This is why both of this plan's own candidate answers were wrong. **(b) was recommended as "a real
cast shadow"** — it measures 1.07:1–1.12:1, which is a real *change* but not a real mechanism, and
adopting it under that description would have left the next person believing dark's shadow does
work the border is actually doing. **(e), setting it to `none`, was argued from "the shadow
contributes nothing measurable"** — measurement says a stronger value contributes little rather
than nothing, and over the grid's alternating row bands that little is visible.

The candidate the measurement makes interesting is §3's **(d)**, the inversion, rejected there as
"the card *emitting* light". It measures **best of the six**, 1.14:1 to 1.41:1, and now there is a
reason: a near-black pane has luminance headroom upward and none downward, so a white shadow is not
a weaker option — it is the only strong one. Still rejected, but on consistency rather than on
strength, which is a different and more honest rejection. It is also the one the project lead
originally asked about, so the answer to *"should the shadow become lighter than the background?"*
is that it is the only thing that would really work, and it is being declined anyway.

**And (c) is now rejected twice over.** §3 rejected the light rim by eye, as reading like a second
border. All of its 1.20:1–1.41:1 comes from that rim, which paints 1px outside the border box — so
the arithmetic says exactly what the eye did.

### How it was measured

The full method, because §6.2 asked for numbers rather than adjectives and the apparatus does not
survive the session:

1. **The real application**, not a mock — Playwright's `_electron` against the built app, the same
   route `scripts/electron-screenshot.mjs` and `scripts/screenshot-panes.mjs` use, with the
   document seeded through the restore-on-launch path (a harness cannot drive the native Open
   dialog). A generated 800-car inventory with **64 distinct child names**, because
   `GRID_COLUMN_CAP` is 60 and the column picker does not exist below that; 11 tabs, because the
   overflow menu does not exist until the strip overflows.
2. **All nine consumers**, per §6.3 — the palette, both grid dropdowns, the tab-strip overflow
   menu, Find, the shortcuts panel, the statistics panel, the notification stack, and
   `.raw-wrapping-overlay`.
3. **One surface opened once, then screenshotted under all seven candidates**, the value set as an
   inline custom property on `:root`. Identical geometry in every frame is what makes a pixel
   difference attributable to the shadow and nothing else.
4. **Differenced against the `none` frame**, over every pixel within 32px outside the surface box,
   **grouped by the unshadowed colour at each pixel**. The first version did not group, and its
   "peak delta" landed on a text glyph behind the palette — 34 of 255, entirely misleading. The
   pane is whichever colours actually cover the ring, and the grid dropdowns' ring is two colours
   because it is row bands.

**Two surfaces needed the harness to do something unusual**, both recorded because the next person
will hit them:

- **The notification stack.** Notifications auto-dismiss after 5 s unless they are errors or carry
  actions, which is shorter than seven screenshots. `Expand All` over 51,200 nodes trips the
  20,000-node ceiling and pushes a real one, and hovering it pauses the timer
  (`Notifications.tsx`'s own `onMouseEnter`), so the surface stays alive for the sweep. The
  external-change notification would have matched what the project lead was looking at more
  closely, but touching the file on disk did not raise one within the harness's wait.
- **`.raw-wrapping-overlay` lives for exactly one animation frame** — `enableWrapDeferred` sets it,
  the next rAF clears it. Seven consecutive screenshots caught it **zero times**. Replacing
  `window.requestAnimationFrame` with one that queues its callbacks instead of running them holds
  the frame open indefinitely, and React still paints, since it does not schedule through rAF.
  Nothing about the app's own CSS changes, which is what makes the capture legitimate.
  **Two other things were needed to get there, and are why it took three attempts**: the Raw pane's
  visibility is persisted per profile, so "run the toggle command" is not the same as "have it
  open"; and only *enabling* wrap shows the overlay, so which way the toggle happens to go decides
  whether there is anything to capture at all.

**The apparatus is not kept.** `CLAUDE.md`'s test for that is whether anyone will run it again, and
this drives nine surfaces through UI affordances that move — a fixture generator, a palette query
per surface, a click target per dropdown. It would rot the way R155's dead spike did. The numbers
it produced are recorded above instead.

### The review found two stale records

Per `CLAUDE.md`'s review-then-commit pass, reading `git diff`:

- **`docs/FINDINGS.md`'s elevation entry said dark's `--elev-2-bg` is `--gray-700`.** It has been
  `--gray-850` since R60 — and this is the same entry R206 corrected once already, in the same
  sentence, for a different stale clause. Corrected.
- **`docs/TASKS.md` said "Next free id: R212"** while R212's own register row sat above it.
  Corrected to R213.

### Version

Patch, per § 8's candidate — an appearance change in one theme, no capability change.
