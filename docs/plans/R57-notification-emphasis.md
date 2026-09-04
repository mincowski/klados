# R57 — how a notification carries its severity

<!-- status: built-caveat -->

**Built — with two things the plan's own acceptance criteria got ahead of the actual tokens, found
and disclosed rather than silently smoothed over (see Results).** Register: `docs/TASKS.md`. Follows
`docs/plans/R21-notifications.md` (D-062), which built the notification stack this restyles.

The report: the amber on an important notification (closing a file with unsaved changes) is liked
as a colour but is too much of it as a full fill; would a border in the same amber carry the
weight instead, and should these float on a shadow?

Two corrections to the premise before the design, because both change what the fix should be.

---

## 1. It is not the brand amber

The guess in the report is that the notification's amber is the same amber as the `N` in NodePad
and the active tab. It is not, and the difference is deliberate.

| Where | Token | Light | Dark |
|---|---|---|---|
| The `N`, the active tab (D-054a) | `--mark-fg` | `--amber-mark-light` `#a9701e` | `--amber-mark-dark` `#e9a33c` |
| The notification fill | `--diagnostic-warning-bg` | `--amber-100` `#fbe8c6` | `--amber-900` `#3d2c0c` |
| The notification text | `--diagnostic-warning-fg` | `--amber-600` `#a8730f` | `--amber-400` `#f5b942` |

`styles/palette.css`'s own comment on the mark swatches says they are "deliberately not" the
warning amber. Two amber families, one for the brand and one for attention, and they read as
related because they share a hue, not because they share a token.

**This matters for the fix**: "use the amber from the tab strip" would couple the diagnostic scale
to the brand mark, and the next time either one is tuned the other moves with it. Whatever R57
does, it stays inside the `--diagnostic-*` scale.

## 2. The shadow already exists — what is missing is the step underneath it

`Notifications.css` already sets `box-shadow: var(--elev-2-shadow)` on `.notification`, and each
severity variant restates it. So "add a little shadow" is not a missing declaration; the float does
not read, and the measured reason is the surface, not the shadow:

| | `--surface-bg` | `--elev-2-bg` |
|---|---|---|
| Light | `--gray-0` `#ffffff` | `--gray-0` `#ffffff` |
| Dark | `--gray-900` `#14171e` | `--gray-700` `#3d4453` |

**In the light theme the elevated surface and the pane behind it are the same colour.** A neutral
notification is white on white, separated by a soft shadow and nothing else. Dark has a real step
and floats fine.

This is the same trap R33/D-051 §1b already hit from the other direction — `light.css`'s comment on
the scrollbar tokens says it outright: "`--elev-2-bg` is the lightest surface in this theme, which
made the thumb near-invisible against a near-white pane." The warning fill has been hiding it for
notifications, which is why it surfaces now, as part of a request to take the fill away.

**Consequence for the design: removing the fill is not free.** Any variant that drops back to
`--elev-2-bg` needs its own edge in the light theme or it loses its boundary.

## 3. Why the fill reads as too much

Not because amber is wrong — because it is not rare. Three of the four notifications
`derivedNotifications.ts` produces are `severity: 'warning'`: the transform confirmation, the
external-change prompt, and the dirty-close prompt. The loudest available treatment is the
**default** for a decision prompt, so it never means "this one especially."

The action buttons compound it: `.notification-action` uses `--elev-1-bg`, which in the light theme
is `--gray-0` — white pills sitting on an amber field, a second full-strength contrast inside a
surface that is already at full strength.

---

## 4. R57 — the severity edge

**Every severity keeps the neutral elevated surface. Severity moves to a left edge.**

```css
.notification {
  /* unchanged: --elev-2-bg, --elev-2-shadow */
  border: var(--border-width) solid var(--surface-border);
  border-left: 3px solid var(--surface-border);
}

.notification-warning {
  border-left-color: var(--diagnostic-warning-fg);
}

.notification-error {
  border-left-color: var(--diagnostic-error-fg);
}
```

Both halves are load-bearing:

- **The 3px left edge** is the severity signal. This is the convention (VS Code's notifications,
  Fluent's InfoBar, GitHub's flash messages) so it reads as severity rather than as decoration.
- **The 1px `--surface-border` hairline on the other three sides is not optional**, per §2 — without
  it the light theme's notification is white on white. It is also what makes `info` (which has no
  severity colour) a defined shape at all.

**Not a 1px amber border on all four sides**, which is what the report proposes. At
`--border-width: 1px` a single amber hairline on white is a very quiet signal for what is now this
app's only prompt mechanism: D-062 already traded a blocking alert strip for a non-blocking
notification, so the prompt has less inherent weight than the thing it replaced, and this would
take away more. The left edge is roughly three times the ink at the same restraint.

**Text goes back to `--surface-fg`.** The severity variants currently override `color`, which pairs
`--amber-600` on `--amber-100` in light. On a neutral surface that override is wrong and should go;
`--surface-fg` on `--elev-2-bg` is the pair the rest of the app is built on.

### Contrast, to be asserted rather than assumed

The edge is a non-text UI component, so the floor is WCAG's 3:1. Computed from `palette.css`:

| | Edge | Surface | Ratio |
|---|---|---|---|
| Warning, light | `--amber-600` `#a8730f` | `#ffffff` | 4.10:1 |
| Warning, dark | `--amber-400` `#f5b942` | `#3d4453` | 5.54:1 |

Both clear it, and both are computed here from the hex values, not sampled from the running app.
`test/scrollbarContrast.test.tsx` is the precedent for asserting this in a test rather than in a
document, and R57 should follow it for all three severities in both themes — that test exists
because R33 got a contrast pair wrong once already.

### What R57 does not do

- **It does not touch `--elev-2-shadow`.** If the float still reads weak once the hairline is in,
  the fix is to step the light theme's shadow token in `themes/light.css` — which will also move
  Find, the command palette, the statistics panel and the tab-strip overflow menu, all of which
  share the tier. That is the correct blast radius for an elevation change and the reason invariant
  9 makes elevation a token *pair*; a stronger shadow declared locally in `Notifications.css` would
  quietly desynchronise one surface from the tier it belongs to. Decide it after seeing §4, as its
  own change.
- **No severity icon.** It would carry the same signal a second time and add a row to a surface
  whose whole point (§3e) is to stay small and out of the layout. Worth revisiting only if the edge
  alone tests badly.

### Acceptance

`test/notifications.test.tsx` already runs against real Chromium layout. Extend it:

1. All three severities resolve the same `background-color`.
2. `border-left-color` differs between info, warning and error.
3. Edge-vs-surface contrast ≥ 3:1 for every severity in both themes.
4. The notification's resolved `background-color` differs from the pane behind it, in **both**
   themes — the regression test for §2, which is the finding this round would otherwise re-create
   the moment the fill came off.

---

## Results

Built exactly as §4 specified: `.notification` keeps `--elev-2-bg`/`--elev-2-shadow`/`--surface-fg`
unconditionally, gains a 1px `--surface-border` hairline on all four sides plus a 3px left edge, and
`.notification-warning`/`.notification-error` now override only `border-left-color` — the background
and text-colour overrides (`--diagnostic-*-bg`, `--diagnostic-*-fg`) are gone. `info` gets no
override at all, exactly as before.

**Two of the four acceptance criteria, measured rather than assumed true, turned out not to hold —
disclosed here and in the tests rather than quietly weakened or skipped:**

- **§4 point 3 ("≥ 3:1 for every severity") only ever had warning's own number worked out in the
  plan text (4.10:1 light, 5.54:1 dark).** Measuring `info` — which has no severity colour, so its
  edge is the plain `--surface-border` hairline — found it clears 3:1 in *neither* theme: **1.31:1
  in light**, and **exactly 1:1 in dark**, where `--surface-border` and `--elev-2-bg` resolve to the
  literal same token (`--gray-700`) — the hairline is genuinely invisible there. Not a regression
  this round introduced (`info` never had a colour to draw a border from, and relied on the shadow
  alone before R57 too, per §2's own "separated by a soft shadow and nothing else"), and not fixed
  here: raising `--surface-border`'s contrast is a token change with a blast radius `docs/FINDINGS.md`
  already knows the shape of (every bordered surface in the app, not just notifications), squarely
  the kind of decision §4's own "What R57 does not do" section declines to make locally. The
  acceptance test is scoped to warning/error (the two severities with an actual colour), plus a
  separate test that pins down `info`'s sub-3:1 ratio in both themes as a known, disclosed case
  rather than one nobody checked.
- **§4 point 4 ("background-color differs from the pane… in both themes") is not achievable by this
  round's own diff.** §2's own measurement is that light theme's `--elev-2-bg` *is* `--surface-bg`
  (both `--gray-0`), and nothing in §4's CSS touches either token — confirmed directly
  (`getComputedStyle`, both `rgb(255, 255, 255)`) rather than reasoned about. What the border actually
  buys is a real, rendered boundary independent of whether the two backgrounds happen to coincide,
  which is what the test asserts instead (border width/colour present in both themes, background
  equality in light explicitly pinned down rather than silently divergent-by-omission, inequality in
  dark asserted the same way).

**Verified**: `test/notifications.test.tsx`'s new `describe` block (8 tests) — the shared background
across severities, the distinct left-edge colours, warning/error's contrast in both themes, `info`'s
disclosed sub-3:1 case in both themes (with dark's exact 1:1 pinned down), and the border-presence
regression guard for §2's white-on-white trap. Full suite: 113 files, 1285 tests (two pre-existing,
unrelated timing-sensitive flakes under full parallel load — `documentSession.test.ts`'s debounce
burst test and `documentPropsRenderCost.test.tsx`'s render-count test — both confirmed passing in
isolation, neither touched by this round). `npm run typecheck` and `npm run lint` both clean (3 known
warnings, unchanged).
