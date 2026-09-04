# R60 — the elevated surface in dark mode

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Follows `docs/plans/R57-notification-emphasis.md`, whose Results
disclosed half of this and declined to fix it there; amends `CONCEPT.md` §9.3. Results, decisions
and the log entry: `docs/DECISIONS.md` D-077, `docs/LOG.md`.

The report: in dark mode the notification's background is "very gray" next to VS Code's, which sits
close to the editor background and is separated by a thin frame — and **in light mode NodePad
already does exactly that**. Also: keep the amber severity edge (R57 §4), it works.

The light/dark asymmetry is the whole finding. Light did not get this right on purpose.

---

## 1. Two separate things, both confirmed in the running app

Measured against the built app in dark mode, sampling the real dirty-close prompt (not a mock) with
`getComputedStyle`:

```
background   rgb(61, 68, 83)     #3d4453   --elev-2-bg      (--gray-700)
border-top   rgb(61, 68, 83)     #3d4453   --surface-border (--gray-700)
pane         rgb(20, 23, 30)     #14171e   --surface-bg     (--gray-900)
```

**a. The frame does not exist in dark.** `--surface-border` and `--elev-2-bg` resolve to the *same
token*. R57's hairline is drawn, and it is the same colour as the thing it is drawn on — 1:1,
exactly. R57's own Results found this (`info`'s edge measured at "exactly 1:1 in dark") and
deliberately left it: raising `--surface-border` is a token change touching every bordered surface,
which §4's "What R57 does not do" declined to decide locally. That was the right call then. This is
the report that reopens it.

**b. The panel is four ramp steps above the pane.** `--gray-700` on `--gray-900`, 1.836:1. That is
the "very gray": not a tint of the background, a different surface entirely.

So dark has a loud fill and no frame. Light has a quiet fill and a frame. The complaint is precise.

## 2. Light is right by accident, and that is the useful part

In the light theme `--elev-2-bg` **is** `--surface-bg` — both `--gray-0`, confirmed by R57 with
`getComputedStyle` (both `rgb(255, 255, 255)`). The panel is the same colour as the pane, and R57's
1px hairline is the only thing that makes it a panel.

That is the VS Code shape, arrived at by accident: R57 added the hairline to fix a white-on-white
defect, not to build an elevation mechanism. **Dark should be made to do deliberately what light
already does accidentally.**

## 3. `CONCEPT.md` §9.3 is what makes dark different, and it needs amending

§9.3 gives elevation exactly two mechanisms:

> - **Light theme** — background stays near-white; the shadow carries the elevation
> - **Dark theme** — shadow drops to near-zero; the background steps progressively lighter

The reasoning is sound and still holds: shadow does not read on a dark surface, so something else
must carry elevation. But §9.3 assumes that something can only be the background, and **R57
introduced a third mechanism without noticing** — a border reads equally well on both themes, which
is exactly what neither shadow nor a background step manages.

Once a border is available, dark's background step no longer has to do all the work alone, and it
stops needing to be four steps. This is a `CONCEPT.md`-is-wrong-in-practice report of the kind the
working agreements expect, not a deviation from it: §9.3's *premise* survives (elevation is a token
pair, shadow alone fails on dark), only its enumeration of mechanisms is incomplete.

## 4. R57 fixed one surface out of seven

`--elev-2-bg` has seven consumers, all of them genuinely transient floating surfaces — the tier is
clean, and none of them sits inside a pane where it could collide with `--row-hover-bg`:

| Surface | Has a border? |
|---|---|
| `notifications/Notifications.css` | **yes** (R57) |
| `components/Find/Find.css` | no |
| `components/Palette/CommandPalette.css` | no |
| `components/StatusBar/StatisticsPanel.css` | no |
| `components/TabStrip/TabStrip.css` (overflow menu) | no |
| `components/Detail/Grid.css` ×2 (column-picker dropdowns) | no |

**So the other six are white-on-white in light mode right now**, separated by `--elev-2-shadow` and
nothing else — the exact defect R57 diagnosed, fixed in one place and left standing in six. They do
not read as broken today only because nobody has reported the command palette specifically.

This decides the shape of R60: **the hairline belongs to the tier, not to `Notifications.css`.**
Darkening `--elev-2-bg` without moving the border first would turn six invisible-in-light surfaces
into six invisible-in-*both* surfaces.

## 5. R60 — the change

**Two parts, in this order.**

1. **Give every `--elev-2-bg` surface the hairline**, matching what `.notification` already has:
   `border: var(--border-width) solid var(--surface-border)`. Six files. This is a fix in its own
   right (§4) and is safe to land alone.
2. **Then, in `themes/dark.css` only**: `--elev-2-bg: var(--gray-850)` (`#1c202a`), replacing
   `--gray-700`. `--gray-850` already exists in the ramp and is already used by dark's
   `--row-alt-bg`, so this adds no palette entry.

`--surface-border`, `--elev-1-bg`, `--elev-2-shadow` and the whole light theme are **untouched**.

### What that measures out to

Rendered in the app with the token injected, against the shipped values:

| | Shipped | R60 |
|---|---|---|
| Panel vs pane | 1.836:1 (`#3d4453` on `#14171e`) | **1.087:1** (`#1c202a`) |
| Hairline vs panel | **1.000:1 — invisible** | **1.689:1** |
| Hairline vs pane | 1.836:1 | 1.836:1 |
| Body text vs panel | 8.41:1 | **14.20:1** |
| Action button vs panel | 1.451:1, **button darker than its own panel** | 1.164:1, **button lighter** |

Every ratio above is computed from the hex values these tokens actually resolved to in the running
app (`getComputedStyle`), not sampled from a screenshot.

For rough scale, VS Code's dark notification frame is somewhere around 1.5–1.6:1 — **from recalled
theme values, not measured here**, so treat it as an order-of-magnitude anchor for "a frame you can
see but not notice" and not as a target to match.

The action-button row is the one to read for *direction*, not magnitude — the ratio barely moves,
but which of the two is lighter flips. `.notification-action` uses `--elev-1-bg` (`--gray-800`), and
with the panel at `--gray-700` **the buttons are currently darker than the surface they sit on** — backwards for a control, and visible in the screenshots as buttons that sink
into the panel rather than sitting on it. R60 fixes that as a side effect: at `--gray-850` the panel
finally sits below its own controls.

### Why not the lighter candidate

`--gray-800` (`#262b36`) was rendered too, and it fails for a concrete measured reason rather than a
taste one: `--elev-1-bg` **is** `--gray-800`, so the action buttons and the panel become the same
colour and the buttons lose their fill entirely, surviving only as outlines. `--gray-850` is the
lightest value that keeps the panel below `--elev-1-bg`.

### Acceptance

`test/notifications.test.tsx` already asserts contrast in both themes against real Chromium and is
the natural home for the first two; the third is the one that would have caught this round's own bug
a round earlier:

1. Hairline-vs-own-background ≥ 1.5:1 in **both** themes — the direct regression test for §1a, and
   the assertion whose absence let a 1:1 border ship. R57's existing `info` test pins today's 1:1 as
   a *disclosed* value and must be updated, not deleted: the point of that test was that the number
   was known, and R60 changes what it is.
2. Panel-vs-pane in dark drops below 1.2:1 — asserting the panel is now a tint of the background
   rather than a separate surface, which is the actual request.
3. **Every `--elev-2-bg` surface resolves a non-`none` border in both themes.** Enumerated from the
   seven in §4 rather than spot-checked, so the next elevated surface someone adds without a border
   fails rather than joining a silent majority.

Body-text and severity-edge contrast both *improve* under R60 and need no new assertions — R57's
existing checks cover them and should simply keep passing.

### Recorded as

A `DECISIONS.md` entry amending §9.3: elevation in dark is carried by a **border plus a small
background step**, not by a large background step alone; the border is a property of the elevation
tier. The rejected alternatives are `--gray-800` (§5) and raising `--surface-border` instead of
lowering `--elev-2-bg` — the latter would have fixed §1a's invisible frame while leaving §1b's
four-step fill exactly as loud, which is the half of the complaint that prompted the report.

### Not in scope

**`--elev-1-bg` is not touched.** It is doing two unrelated jobs — flat app chrome (title bar, tab
strip, `DocumentArea`, `Detail`) *and* control fills (`.notification-action`, the grid's headers) —
and those two want different values the moment elevation stops being one monotonic ramp. R60 does
not need to resolve that, and resolving it would put the title bar's appearance inside a round about
notifications. Worth its own task if a control ever needs to sit on a surface `--elev-1-bg` cannot
serve.
