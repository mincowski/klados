# R206–R208 — three disclosed cosmetic defects

<!-- status: built -->

**Built** — two fixes and one accept-and-close, the outcome § 5 named in advance. Three entries
from `docs/TASKS.md`'s Owed table, each found, measured and deliberately not fixed by the round that
found it. Planned together because they share a shape — all three are cosmetic, all three were
disclosed rather than hidden, and **none of them is a bug in the file that declares it**.

**One of the three is partly stale**, which is § 1's first finding and the reason this plan
re-measured all of them instead of trusting the table. **Re-measuring found the other two wrong
too**, which the plan did not anticipate: **R207's recorded cause is not the cause** — it is an
ordinary sibling painting over the corner, not a rasterization artifact, and the fix § 2
recommended was tested and does nothing — and **R208's `text-box-trim` probe returned a false
negative on its first reading**. Results in § 8.

**R206 built** (the severity edge, not the hairline the entry pointed at), **R207 accepted and
closed** with its record corrected, **R208 built** with `text-box-trim` and the skip removed.

## 1. R206 — the `info` notification's hairline

### The owed entry is out of date

It reads: *"clears 3:1 contrast in neither theme (exactly 1:1 in dark — same token both sides)."*
The headline is still true. **The parenthetical is not.**

R57 measured dark at exactly 1:1 because `--surface-border` and `--elev-2-bg` were both
`--gray-700`. **R60 then moved `--elev-2-bg` to `--gray-850` in dark for precisely that reason**
(`R60-dark-elevation.md` §5) — and `test/notifications.test.tsx` was updated with it, carrying a
comment that explains the change. Only the Owed table was left behind.

Re-measured from the current tokens:

| Theme | hairline | surface | ratio | |
|---|---|---|---|---|
| light | `--surface-border` `#dde1e7` | `--elev-2-bg` `#ffffff` | **1.31:1** | below 3:1 |
| dark | `--surface-border` `#3d4453` | `--elev-2-bg` `#1c202a` | **1.67:1** | below 3:1 |

### Which inverts the priority

The entry points at dark, which is now **the better of the two**. Light is the worse case, and for a
reason the entry does not mention: in light, `--surface-bg` and `--elev-2-bg` are **both `--gray-0`**,
so a notification is literally white-on-white and the 1.31:1 hairline is the *only* thing that
separates it from the pane. In dark the two backgrounds differ, so the hairline is not carrying the
boundary alone.

**R57 introduced the hairline for exactly this reason** and its §2 says so. The light case is
therefore not a cosmetic shortfall but the one place where the boundary genuinely depends on a
sub-3:1 edge.

### The options, with their costs

**(a) Raise `--surface-border`'s contrast.** What R57 declined, and the reason is now quantified:
**42 rules consume `var(--surface-border)`**. It is the application's frame colour, so this is not a
notification change at all — every panel, pane divider, input and strip moves with it. A 3:1 border
against every surface it touches would be a visibly heavier application.

**(b) Give `.notification-info` its own edge token.** Scoped to one rule, no blast radius. But there
is **no `--diagnostic-info-*` token** — the palette has warning, error and fatal only — and R57
deliberately gave `info` no severity colour, so this invents a severity for the one level that is
defined by not having one.

**(c) Raise only the notification's own hairline**, leaving `--surface-border` alone elsewhere: a
`--notification-border` token stepped to clear 3:1 over `--elev-2-bg` in both themes. Scoped like
(b), but without inventing a severity — the edge stays neutral and merely becomes visible.

**(d) Accept it, and fix the table.** The hairline is not the sole affordance in dark, and in light
the notification also carries `--elev-2-shadow`.

**Recommended: (c), or (d) with the table corrected.** (a) is out on the 42-consumer count; (b)
contradicts R57's own design. **(c) is the smallest change that addresses the light case**, which is
the one that matters. The choice between (c) and (d) is a project-lead call about whether a
white-on-white notification separated by a 1.31:1 line is acceptable — **and it should be made by
looking at it**, per `PLANNING.md` §1, not from the ratio.

**Either way the Owed entry is corrected**, since it currently sends the next reader at the wrong
theme.

## 2. R207 — the scrubber thumb's flat top corners at `top: 0`

### What R33 established, and it is unusually well established

`docs/plans/R33-scrollbars-and-selection.md` addendum 1, confirmed with real-Electron screenshots:
when `.scrubber-thumb`'s `top` is exactly `0`, its top corners render flat although
`border-radius: 4px` is present in computed style. The bottom corners round normally.

**It is not a CSS bug in this project**, and that was demonstrated rather than argued: a freshly
created, unrelated `position: fixed` div with the same radius, appended straight to `document.body`
with no ancestry relationship to `.scrubber`, shows the identical artifact at the same fractional
`top` (`438.8125px` in the fixture) — and rounds normally at an arbitrary Y. Two candidate fixes were
tried and **ruled out empirically**: `transform: translateZ(0)`, and a 2px inset moving the thumb off
the neighbouring `.pane-header` border.

The working theory is a Chromium rasterization artifact at a particular fractional device-pixel row,
reachable because the pane heights are not integers — `--row-height`, banner presence and the
resizable Raw/Detail split compose to a non-round number.

### The honest options

**(a) Pixel-snap pane heights in the layout system.** The real fix, and the one R33 named as *"bigger
and riskier than this report's scope"*. It touches the layout every pane depends on, to remove a
cosmetic artifact in one frame of one component.

**(b) Snap only the scrubber's own container**, rounding its height or offset to a whole device
pixel. Much smaller than (a), and **unverified** — R33's evidence says the artifact follows the
fractional Y, so snapping the ancestor that produces it *should* work, but two other plausible fixes
already failed here. This is a probe before it is a plan.

**(c) Leave it, and record it as accepted rather than open.**

**Recommended: (b) as a timeboxed probe, falling back to (c).** Spend one session reproducing R33's
harness and testing whether snapping the scrubber's container resolves it. If it does, it is a
contained fix. If it does not, close the item as accepted — **this has now been investigated twice,
and a third open-ended attempt is worse value than a decision.**

**Explicitly not recommended: (a).** Reshaping the layout system for a one-frame rounding artifact
inverts the risk against the benefit.

### What this round must not do

**Do not widen the artifact's description to "scrollbars".** The Owed entry says *"the scrollbar
thumb's corner radius"*; R33's own text is about `.scrubber-thumb`, and `ScrollStrip.css` shares the
radius but was not what was measured. Fixing the entry's wording is part of the round, and re-testing
`.scrollbar-thumb` at `top: 0` before claiming anything about it is the rest.

## 3. R208 — the title-bar mark's nudge is calibrated for one font

### What is there

`TitleBar.css` centres the mark's *ink* against the title's cap-height ink rather than centring their
boxes, because a 12px-tall mark and a 9px cap-height cannot share top and bottom edges at once. The
two ink centres measured 1px apart, so:

```css
.title-bar-mark { transform: translateY(1px); }
```

**The constant is the problem, not the technique.** `--font-ui` is
`-apple-system, 'Segoe UI', system-ui, sans-serif`, which resolves to a different font per platform,
and a different font puts the cap-height ink somewhere else. CI's first run caught it: a Linux runner
measured 1px out against a 0.5px tolerance.

`test/titleBarInkAlignment.test.tsx` **skips** where the calibrated font is absent, deliberately —
its own comment says widening the tolerance to 1px would make the test pass everywhere while no
longer detecting the misalignment it exists for. That reasoning is right and the round should not
undo it.

### The options

**(a) Compute the nudge at runtime.** The test already derives it — canvas `TextMetrics` against the
computed font — so the same measurement in the component could set a `--mark-nudge` custom property.
Correct on every font, at the cost of a canvas measurement at mount and a value that is no longer
readable in the stylesheet.

**(b) `text-box-trim` / `text-box-edge`.** CSS gained exactly this: trimming a text box to its
cap-height so ink aligns without a magic constant. **Whether it is usable here is not asserted** —
this project runs Electron 39, whose Chromium is well past the version that shipped it, but
`PLANNING.md` §2 is explicit that a feature existing is not evidence that it applies. **Mount it in
the browser test project and measure the ink centres before writing it into a plan as settled.**

**(c) Per-platform constants.** Rejected: it enumerates the fonts someone might have, which is not a
closed set — a Linux runner is not one platform's worth of fonts.

**(d) Accept it.** A 1px optical difference on platforms whose UI font is neither of the two common
ones.

**Recommended: probe (b) first, fall back to (a).** (b) removes the constant rather than computing
it, which is the difference between a fix and a better workaround — but only if it measures right,
and that measurement is the first task of the round, not an assumption in this plan.

### The test is the acceptance

**The skip must become unnecessary, not be deleted.** If the round works, the assertion runs on every
platform because the alignment no longer depends on which font resolved. A round that removes the
skip while leaving a hardcoded nudge has made the test lie — which is precisely what the current
skip was written to avoid.

## 4. What these three have in common

Worth naming, because it is the argument for planning them together rather than as three tickets.

**Each was found by looking at the running application, not by a test** — R57 and R60 from using
notifications, R33 from real-Electron screenshots, R208 from the first CI run on a third platform.
That is `FINDINGS.md`'s recurring line, and it holds for all three.

**Each was disclosed rather than hidden**, and the disclosures are load-bearing: R33's addendum
records the two fixes that *failed*, which is what stops a third round retrying them; the title-bar
test skips rather than widening a tolerance, keeping its ability to detect the thing it exists for;
R57's test pins `info`'s ratio as a known case. **The cost of that discipline shows up here** — all
three were still findable years later with their evidence intact.

**And one drifted anyway.** R60 fixed half of R206's defect and updated the test, but not the Owed
table, so the entry has been pointing at the wrong theme ever since. **The board is machine-checked
for status and not for content** (`test/docsStatus.test.ts` compares markers to the board; nothing
compares an Owed entry to the code it describes). That is a real gap and this plan does not propose
closing it — a test that verified prose against behaviour is not a thing — but it is the reason
§ 1 re-measured rather than trusted.

## 5. Rejected across all three

**Bundling these into one commit because they are all "cosmetic".** They touch three unrelated
subsystems and two of them are probes with a real chance of concluding "leave it". One `R` id each,
reviewed and committed separately, per `CLAUDE.md`.

**Fixing them because they are on a list.** Two of the three have a defensible "accept and close"
outcome, and R207's is the *recommended* one if its probe fails. **A round that closes an item by
deciding not to chase it has done its job**, and the plan says so up front so that outcome does not
read as a failure later.

## 6. Acceptance

1. **R206**: the Owed entry states the current ratios and names light as the worse case; whichever of
   (c)/(d) is chosen is recorded with the reason; if (c), both themes clear 3:1 and
   `test/notifications.test.tsx`'s disclosure test is updated rather than deleted.
2. **R207**: the probe's result is recorded either way. If it fails, the entry moves from Owed to
   accepted, naming all three ruled-out approaches so a fourth attempt starts informed.
3. **R207**: `.scrollbar-thumb` is tested at `top: 0` before any claim is made about it, and the
   entry's "scrollbar" wording is corrected to whatever that shows.
4. **R208**: the ink centres are **measured** on the chosen approach, in the browser project, against
   more than one font family — the defect is that one font's measurement was generalized, and a fix
   validated on one font would repeat it exactly.
5. **R208**: the skip becomes unnecessary rather than being removed, and the assertion runs on every
   platform.
6. Every visual outcome is **rendered and looked at** before being called done (`PLANNING.md` §1).
   All three are visual by definition; none of them can be concluded from a number.
7. `npm test`, `npm run typecheck`, `npm run lint`, `npx stylelint` clean.

## 7. Version

**Ask on landing.** Candidate: patch — cosmetic fixes, no capability change. If all three conclude
"accept and close", **no bump and no code**, which is a legitimate outcome of this plan.

## 8. Results

**Built.** Two fixes and one accept-and-close, which is the outcome § 5 named in advance so it
would not read as a failure. **All three re-measurements found the plan's own inputs wrong in some
way**, which is the round's actual theme.

### R206 — the neutral edge, not the outline

**The measurements in § 1 held exactly**: light 1.31:1, dark 1.67:1, and light is the worse case.
Both options were rendered against a real pane at 1:1 in both themes and put in front of the
project lead, per `PLANNING.md` § 1.

**The choice was neither (c) nor (d), and it is better than both.** § 1's options were framed
around the *hairline*, because the Owed entry was. Looking at the render, the project lead
separated the two edges the entry had run together: **keep the hairline as it is, and make the
3px severity edge visible instead.**

That is the sharper reading of R57. `info` is the one level R57 defines by having *no* severity
colour — and it drew that edge in `--surface-border`, so the level with no colour was also the
only level with no visible edge at all. `--notification-edge` is that same neutral edge at
`--gray-500`, which clears 3:1 in both themes against both its neighbours: **4.27:1 light**,
**3.81:1 dark** against the card and 4.20:1 against the pane behind it. A warning and an error
still differ from it only in the edge *colour*, so R57's design is intact.

It is deliberately not `--diagnostic-info-*` — § 1(b)'s objection stands, and this token dodges it
by not being a hue.

**The hairline stays sub-3:1, accepted rather than owed**, for § 1(a)'s 42-consumer reason plus
one the plan did not have: giving this one surface a private hairline would split it off the
elevated tier R60 deliberately unified, which `test/elevationBorders.test.ts` asserts.

The disclosure test was **re-pointed rather than deleted**, as acceptance 1 required. It used to
pin `info`'s left edge as sub-3:1; what is still sub-3:1 is the hairline, so that is what it pins
now — to the measured 1.31/1.67 rather than a bare `< 3`, so a token change that moves it is
noticed. The severity-edge test widens from two severities to three, since `info` was only ever
excluded because it could not pass.

### R207 — the probe succeeded, and the diagnosis it tested was wrong

§ 2 recommended a timeboxed probe of (b), snapping the scrubber's container, falling back to
accepting. **Both halves of that turned out to be built on a false premise.**

R33's claim was a Chromium rasterization artifact at a fractional device-pixel row, evidenced by
an unrelated injected div reproducing it at the same Y. **It does not reproduce.** Sweeping every
1/16 CSS pixel at four device pixel ratios (1, 1.25, 1.5, 2) in two layout modes — an explicit
fractional `top`, and a flex-derived fractional height, which is how R33's own number arose — in
headless Chromium *and* in real Electron 39 via the `_electron` harness `scripts/electron-screenshot.mjs`
already uses, an injected div rounded correctly every time, **including at 438.8125 tested
explicitly**. Blink pixel-snaps paint offsets, so a fractional layout Y does not become a
fractional raster row.

The real `.scrubber-thumb` *does* show it: corner coverage 1.00/1.00 at the top against 0.81 at
the bottom, where 0.785 (π/4) is a correctly rounded corner.

**The cause is `.scrubber-marker-selected`** — a 3px square-cornered bar at `--accent`, spanning
the thumb's exact width, drawn one pixel above its top by the markers' own `translateY(-1px)`,
whenever the selection sits at the document start. Hide every `.scrubber-marker` and all four
corners round correctly. Confirmed by screenshotting the real thumb at 16× with and without them.

**And § 2's recommended fix was tested and does not work**: snapping the container to an integer Y
(473.0000 from 473.4844) changes nothing, because the fractional Y was never the cause.

This also explains R33's two ruled-out fixes, which is the tell that should have prompted an
earlier re-check: `translateZ(0)` is irrelevant to an overlapping sibling, and insetting the
*thumb* cannot move a marker positioned by document ratio.

**Acceptance 3 answered**: `.scrollbar-thumb` was tested at `top: 0` before any claim. It renders
correctly, and sits at an integer Y because `Scrollbar.css` adds its own 1px inset. The entry's
"scrollbar" wording was wrong and is corrected.

**Outcome: accepted as shipped**, decided by the project lead after four candidates were rendered
on the real strip with a realistic marker population — *"I don't see the issue when shipping as it
is."* The marker is doing its job and merely coincides with the thumb. The two candidates that
genuinely fix the corner do it by insetting markers to 3px or 2px, which narrows **every** marker
in the strip from 13px to 9px or 11px in a 15px track — a permanent cost to the diagnostic density
R200 had just finished working on, for a cosmetic overlap at one scroll position.

**The deliverable is therefore the record, and it was not cosmetic.** `docs/FINDINGS.md` carried
the wrong diagnosis as a general warning — *"any rounded corner near a pane boundary is at risk"*
— in the file `CLAUDE.md` says to read before implementing anything. Corrected, with the method
kept rather than the pixel: when a fix that should work does not, suspect the diagnosis before
reaching for a second fix. Also recorded there: `elementFromPoint` cannot adjudicate this, because
hit testing follows the layout radius while the complaint is about raster.

### R208 — `text-box-trim`, and the probe that nearly lied

§ 3 required measuring `text-box-trim` before treating it as settled (`PLANNING.md` § 2). **The
first measurement said it does not apply, and that was wrong.**

It parses, and `getComputedStyle` returns `trim-both` — but on `.title-bar-title` it changes no box
height at all. The property applies to **block containers**, and that element is `display: flex`,
which R5's middle truncation needs. On the leaf spans — flex items, and therefore block containers
— it trims to exactly the cap height: 17px → 9.109px for Segoe UI.

Had the probe stopped at the first result, the round would have reported a usable CSS feature as
inapplicable and fallen back to computing the nudge at runtime. Worth naming as its own lesson:
**"the feature computed but did nothing" is a reason to check what it applies to, not a result.**

Measured in Electron 39 across nine font families, ink-centre delta against a 0.5px tolerance:

| | fonts failing |
|---|---|
| the shipped 1px constant | **8 of 9** |
| no nudge at all | 6 of 9 |
| a runtime-computed nudge | 0 of 9 |
| `text-box-trim` | **0 of 9**, worst deviation 0.008px |

The required nudge ranges from **-0.5px to +1px** — so the constant was not merely uncalibrated
elsewhere, it was wrong in both directions.

**(a) was measured too and is also exact**, but is not taken: it moves the value out of the
stylesheet to solve a problem CSS now solves, which is § 3's own distinction between a fix and a
better workaround.

**The bare app name is wrapped in `-tail`**, because `text-box-trim` reaches a flex item and not an
anonymous run of text inside a flex container. Without it the one state with no open document
would have kept the uncorrected alignment while every other state got the fixed one.

**A regression the round nearly shipped, caught by the review pass.** `cap alphabetic` puts the
box's bottom edge on the baseline, and R5's ellipsis puts `overflow: hidden` on the same box, which
clips to the padding box: `pygmy-jaguar-query.xml` rendered as `pvgmv-iaguar-querv.xml`, every
descender sheared off flat. `overflow-x: hidden` with `overflow-y: visible` is not available — CSS
computes the visible one to `auto` — so the room comes from `padding-block: 0.5em`, cancelled by
`margin-block: -0.5em` so the margin box is still the cap-height box the flex centering aligns on.
0.5em is headroom rather than a calibration: it need only exceed the deepest descender, and being
too generous costs nothing, which is exactly what distinguishes it from the constant this round
removed.

**Why it was green in review until then**: every fixture was `Klados` or `Klado` + `s.xml`, which
between them contain no descender. A text fixture that cannot exercise ascenders and descenders is
not a text fixture, and this is `CLAUDE.md`'s "tests that assert shape but not exact values" in a
new form.

**Acceptance 5 is met and acceptance 4 is what makes it checkable.** The skip is gone because there
is no constant left for a font to invalidate. Four font families assert the alignment directly; a
**negative control** asserts that removing the trim makes the centres diverge, so the suite cannot
pass by being insensitive; and the descender clipping has its own regression test.

`titleGlyphInkCenter` no longer measures `actualBoundingBoxAscent`. **Chromium quantizes it to
whole pixels** — Georgia's declared cap height is 9.000px and its "K" reports 10; Arial's are 9.313
and 10 — so it cannot adjudicate a half-pixel question, and an earlier version of this change put
Georgia at exactly 0.5 against a 0.5px tolerance for that reason alone. Widening the tolerance
would have been the obvious move and the wrong one, for the same reason the original skip was
right.

**Acceptance 6, looked at**: the mark, a filename with live descenders, and the dirty dot all land
on one optical line — dot centre and mark ink centre both within 0.008px of the text's cap-height
centre. The dot now centres on the cap height rather than the line box, which is a small
improvement nobody asked for and worth naming so it is not mistaken for drift.

### What the round did not do

**`docs/screenshots/title-bar.png` was regenerated and reverted.** `scripts/electron-screenshot.mjs`
waits a fixed 500 ms and the capture raced a loading overlay, producing a "Opening cars-10mb.xml…
90%" frame. Not caused by this round, and not fixed by it either — R208 changes nothing visible on
this machine's font (Segoe UI is the one font the old constant was correct for, and the trimmed
result differs by 0.008px), so the committed screenshot is still accurate. Reported rather than
committed, and rather than quietly working around.

**The dark elevation shadow** was raised by the project lead while looking at R206's render. It is
real, it is specified rather than broken, and `--elev-2-shadow` has nine consumers — so it is
`docs/plans/R212-dark-elevation-shadow.md`, not a fourth task here. § 5's own rejection of bundling
applies to it exactly.

### Verification

`npm test` **2131 passing**, 5 skipped, 173 files; `npm run typecheck`, `npm run lint` and
`npx stylelint "src/renderer/**/*.css"` clean — exit codes captured directly. Every visual outcome
was rendered from the **real built application** through Playwright's `_electron`, not from a mock,
and read back at magnification with a pixel grid.

### Review

Per `CLAUDE.md`, reviewed as a separate pass against `git diff` before each commit. **It found the
R208 descender regression**, described above — the round's own acceptance criteria were all green
at that point, and the fixtures could not have caught it. R206's diff was clean. Two documentation
drifts were found and corrected on the way, both of the kind § 4 names:

- **`docs/FINDINGS.md` still said only one of seven `--elev-2-bg` surfaces has a hairline.** R60
  gave it to the whole tier four rounds ago, and `test/elevationBorders.test.ts` asserts it.
- **`docs/TASKS.md`'s Owed table still listed `core/path/parse.ts`'s `NAME_CHAR` as ASCII-only.**
  R201 replaced it with `RESERVED_NAME_CHARS` two rounds ago; that round removed the `FINDINGS.md`
  entry and missed this one. My own miss, corrected here.

That is three drifted records found in one round — one of them (R207's) actively misleading for
two rounds. § 4 declines to propose closing the gap and that still stands: a test comparing prose
to behaviour is not a thing. But the rate is worth writing down.

## 9. Version

**No bump** — the project lead's call, and the third round running at 1.0.0. Nothing here changes
what the application can do. Whenever a bump does happen it now carries R199–R208 together,
including R202–R205' search and query behaviour changes, which are the part that will need
naming in a release note.
