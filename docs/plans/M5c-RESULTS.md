# M5c results

Filled in as tasks land, per `docs/plans/M5c-PLAN.md` §5's order: J1 → J2 → J3 → J9's
first measurement (this section) → J4–J8 → J9's remainder.

## J9a — measurement before continuing past J1–J3

`docs/plans/M5c-PLAN.md` §1.1's own table was produced by a `node` harness
timing `rawOffsets.ts`'s two conversions directly, not the live app. This
section re-runs the same style of harness against the fix, as the gate the
plan's own §5 requires before building J4 onward on top of it. A full
in-app measurement (a real `requestAnimationFrame` loop driving a real
`EditorView` at 200 MB, both an ASCII and a non-ASCII fixture) is J9's
remaining, larger task and is **not** what this section covers — flagged
rather than conflated with it, the same distinction `M2-RESULTS.md`'s own
gap note draws between a synthetic harness and the real rendered app.

Harness: build a ~1 MB window (ASCII fixture and a café/straße/你好/münchen
non-ASCII fixture), simulate ~240 decoration marks in view at 10%/50%/90%
depth, and time the old shape (`rawOffsets.ts`'s two conversions called
directly per mark, `buildDecorationSet`'s pre-J1 pattern) against the new
one (`buildOffsetMap` once, then `map.toUnits`/`map.toBytes` per mark).

| Fixture | Depth | Old (per rebuild) | New (map build + 240 marks) |
|---|---|---:|---:|
| ASCII | 10% | 151.9 ms | 4.1 ms |
| ASCII | 50% | 735.5 ms | 4.7 ms |
| ASCII | 90% | 1308.3 ms | 6.6 ms |
| non-ASCII | 10% | 165.9 ms | 11.0 ms |
| non-ASCII | 50% | 820.3 ms | 20.3 ms |
| non-ASCII | 90% | 1514.7 ms | 12.0 ms |

The "new" column includes rebuilding the offset map from scratch every
call, for a fair apples-to-apples comparison with the old per-call
approach. In the live app this is a pessimistic number: `handle.map` is
built once per re-slice (`Raw.tsx`'s `applyReslice`/mount effect) and
reused across every scroll-driven viewport change that doesn't cross a
window boundary, so a typical decoration rebuild during a scroll pays only
the per-mark walk (the map-build overhead above, roughly 2–15 ms of the
"new" figures, doesn't recur on every frame the way it does in this
harness).

§1.1's own numbers (measured differently — a real ~1 MB XML fixture, not
this harness's repeated-unit fixture) put the pre-fix cost at 313 ms /
1368 ms / 2479 ms at the same three depths. This harness's ASCII numbers
are lower (151–1308 ms) because its fixture differs, but the shape — cost
scaling roughly linearly with depth into the window — and the order of
magnitude both match, confirming this harness is measuring the same
regression. Post-fix, both fixtures land under 21 ms even including the
one-time map build; the J1 acceptance bar (`buildDecorationSet` itself
under 5 ms once the map already exists) is met by a wide margin once the
map-build cost is excluded, as it would be for any scroll that doesn't
cross a window boundary.

**Conclusion: proceed to J4.** The regression J1–J3 targeted is gone by
every measure this harness can take; J9's own full in-app pass (§ below,
still open) is the remaining, larger confirmation.

## J9b — remaining measurement

### 3. The regression guard — done

`test/rawDecorationsRegressionGuard.test.ts`: a counting spy on
`String.prototype.codePointAt`, not a timing assertion, per the plan's own
instruction. `buildDecorationSet` itself can't be exercised directly (it
needs a real `EditorView`; this project has no DOM/browser test
environment, `rawEdit.ts`'s own top comment) — the guard is written one
level down, against `rawOffsetMap.ts`'s checkpoint walk, which is the
actual primitive the O(window) cost lived in and J1 fixed. It asserts a
single conversion at 90% into a ~1 MB mixed-content window costs under
2 000 `codePointAt` calls (bounded by `CHECKPOINT_STRIDE`, not by
position), that the call count at 10% and 90% into the window are the same
order of magnitude (the defining shape of the pre-fix bug — cost scaling
with depth), and that 100 conversions scattered across the window don't
each re-walk from 0. All three pass.

### 1 and 2 — not run; flagged, not silently skipped

**The real-app `requestAnimationFrame` frame-time pass** (continuous
scroll through a 200 MB file, ASCII and non-ASCII fixtures, median frame
time and count-over-32ms — the same shape `M1-RESULTS.md` §1 used) and
**the window-crossing cost before/after J3** both need a running Electron
window with a real `EditorView` under load. This session has no display
attached to drive one — `npm run dev` needs an interactive GUI session,
and the Claude Browser tool renders a plain web page, not an Electron
`BrowserWindow` (it cannot load `nodepad://`-scheme content or exercise
`window.api`'s IPC bridge either). Confirmed by the harness in J9a's own
section above, and by the direct `rawOffsetMap` proof in §3 just above,
that the mechanism is fixed; the live-app frame-time number itself is
still unmeasured.

**What this means for the plan's own gate**: §5's "if J1's acceptance
figures are not met, stop and report" is satisfied (J1's harness figures
are met by a wide margin, §J9a above) — that gate was about the fix
working at all, not about this specific in-app pass, which the plan
already treats as a separate, later confirmation. Recorded here as open
rather than claimed, matching `M2-RESULTS.md`'s own precedent for a gap
it flagged instead of smoothing over ("grid and Tree scroll frame time…
need a real `requestAnimationFrame` loop driving real rendered React
components"). Whoever next has a GUI session available should run it
before relying on this milestone's Raw-view performance being fully
closed out.

## J7 — icon rasterization, closed (D-054a)

J7's code change landed with M5c; its **rasterization did not**, and was
recorded as open rather than claimed. It has now run. Three things came out
of actually executing what had only been written down — recorded here
because two of them mean the previous entry's description of the assets was
wrong, not merely incomplete.

**The generator could never have run on this platform.** It imported
`cairosvg`, which needs libcairo as a *system* library; there is no
pip-installable cairo on Windows, so it failed at import regardless of how
Python was installed. The earlier note ("neither Python nor `cairosvg`/
`Pillow` are installed") diagnosed the missing interpreter and stopped
there — installing Python would not have helped. Now `resvg-py` (prebuilt
binary in the wheel) via `uv run --with resvg-py --with pillow
tools/generate.py`, so there is nothing to install globally.

**Two silent bugs in `tools/generate.py`**, both of which would have
produced a green run and wrong output:

1. Output went to `build/`, not `assets/build/` — a second, unread tree
   beside the stale real one.
2. The `.ico` was written from a single image plus a `sizes=` list, which
   makes Pillow resample that one image into every frame. The 16/24/32
   frames would have been a downscaled *tile* — exactly what D-054 forbids
   and the opposite of what `assets/README.md` claimed. Fixing it needs
   `append_images`, and the `save` call must be made on the **largest**
   frame: Pillow skips any requested size larger than the image it is
   called on, so writing from the 16px frame produces a valid, silent,
   single-frame `.ico`. The script now asserts its own frame list.

**Verified after regeneration** (reading the written `.ico` back, not
trusting the run): seven frames — 16, 24, 32, 48, 64, 128, 256. Coverage
25.8% / 24.0% / 23.4% at 16/24/32 with transparent corners (the bare mark),
97.0% / 96.1% at 48/256 (the tile). The split is real.

**The mark colour changed to `#A9701E`** for every OS-facing raster. A
raster handed to the OS has no theme to follow — a Windows title bar takes
the *system* theme — so one file must work on both. `#E9A33C` measures
**1.94:1** against the Win11 light title bar, below the 3:1 non-text UI
minimum `assets/README.md` itself cites; `#A9701E` is 3.77:1 light and 3.90:1 dark,
the only amber in the palette that clears both. See D-054a.

**Not closed:** J7's acceptance is "verify by running the app, not by
inspecting the file." The frames are confirmed correct *in the file*; the
title bar itself still needs a GUI session, the same gap J9's items 1 and 2
have.

### J7 addendum — the source split is reverted (D-054b)

Running the app showed the title bar icon crisp, which was the task's own
point — and the **Windows taskbar** showing the bare monogram, which was
not wanted and contradicts `assets/README.md`'s own rule that the tile is the OS's
icon.

The mechanism, which the file could not have revealed: **Windows picks an
`.ico` frame by pixel size, not by which surface is asking.** There is no
"title bar frame." The title bar takes the small icon (~16px at 100%
scaling, ~24px at 150%), the taskbar the large one (~32px, ~48px), so J7's
48px boundary ran through the taskbar's own range — the same build showed
a bare mark in the taskbar at 100% scaling and the tile at 150%. That is
incoherent independent of which one anybody prefers.

Every frame is `icon.svg` again, verified by reading the `.ico` back:
96–98% opaque coverage at all of 16/24/32/48/256.

**The blur J7 existed to fix stays fixed**, because it was never the tile's
fault — it was one 256px gradient tile resampled into every frame, which
D-054a's `append_images` correction is what actually cured. Rendered
natively at its own size the tile is clearly legible at 24 and 32 and
acceptable at 16; compared side by side at 5× before reverting.

Worth recording for the pattern rather than the icon: J7's plan **named
this exact side effect** ("the Windows taskbar at small sizes also becomes
the bare mark") and dismissed it in the same sentence ("judged an
improvement"). Predicting a consequence is not evaluating it, and no
amount of reading the file would have settled it — only looking at the
running app did.
