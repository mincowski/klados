# R206–R208 — three disclosed cosmetic defects

<!-- status: open -->

**Open.** Three entries from `docs/TASKS.md`'s Owed table, each found, measured and deliberately not
fixed by the round that found it. Planned together because they share a shape — all three are
cosmetic, all three were disclosed rather than hidden, and **none of them is a bug in the file that
declares it**.

**One of the three is partly stale**, which is § 1's first finding and the reason this plan
re-measured all of them instead of trusting the table.

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
