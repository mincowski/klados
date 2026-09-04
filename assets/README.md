# Klados — icon assets

Everything derives from `assets/icon.svg`. Rasters are generated, not hand-edited.

## Palette

| Token | Value | Use |
|---|---|---|
| Tile top | `#1F222A` | gradient start |
| Tile bottom | `#101216` | gradient end |
| Tile border | `#2A2E37` | 1.5px outer edge |
| Top highlight | `#FFFFFF` @ 14% → 0% | bevel along upper edge |
| Mark (dark) | `#E9A33C` | the mark, dark surfaces inside the app |
| Mark (light) | `#A9701E` | the mark, light surfaces inside the app |

Both are renderer-only. No generated raster contains the bare mark (D-054b), so the mark's
colour is always chosen against a theme Klados knows.

### Reference — a bare mark on a surface whose theme you don't control

Kept because the question recurs, not because anything currently depends on it. If a mark ever
has to sit on a surface Klados neither controls nor is told the theme of — an OS raster, an
embed, a README rendered on either background — one colour has to work on both. Measured
(WCAG; 3:1 is the minimum for a non-text UI element):

| Mark colour | Win11 light `#F3F3F3` | white | Win11 dark `#202020` | black |
|---|---:|---:|---:|---:|
| `#E9A33C` brand amber | **1.94** ✗ | 2.15 ✗ | 7.58 | 9.77 |
| `#C4881F` midpoint | 2.75 ✗ | 3.05 | 5.34 | 6.89 |
| **`#A9701E`** | **3.77** | 4.18 | **3.90** | 5.02 |

`#A9701E` is the only one that clears 3:1 in both directions — the brand amber fails outright
on a light surface. The tile never has this problem: it carries its own background and is
background-independent by construction, which is the whole reason it, not the mark, is what
gets handed to the OS.

## Sources — `assets/`

| File | Purpose |
|---|---|
| `icon.svg` | **Master.** Full-bleed tile with lift + top-edge highlight. |
| `icon-flat.svg` | Flat tile, no gradients. **No longer used by `tools/generate.py`** — kept as the flat reference drawing. See the iconset note below for why it was dropped. |
| `icon-macos.svg` | Padded to the macOS safe area (824 of 1024) for `.icns`. |
| `mark.svg` | Bare mark, `currentColor`, no tile. Docs, READMEs, large in-app use. |
| `mark-16.svg` | Small-size variant on a 16 grid: 2px strokes on integer coordinates. Source for `icon.ico`'s and `icons/*.png`'s sizes below 48px (M5c-PLAN.md J7 / D-054). |

**Why two mark files.** Scaling the 64px master to 16 gives 1.25px strokes that land between
pixels and blur. `mark-16.svg` is redrawn so strokes fall on whole pixels. Use it anywhere the
render size is 16–20px, including the title bar.

**Why every generated raster is the tile, at every size.** These files are what the *OS*
consumes — taskbar, Explorer, the `.exe`, the installer, file associations — and the tile is
for exactly those surfaces. `mark-16.svg` is **not rasterized at all**; it is inlined by the
renderer.

Sizes below 48px briefly came from `mark-16.svg` instead (D-054), to sharpen the native Windows
title bar. That was reverted (D-054b) because **Windows picks an `.ico` frame by pixel size,
not by which surface is asking**: the title bar wants ~16px at 100% scaling and ~24px at 150%,
the taskbar ~32px and ~48px, so a 48px boundary cut straight through the taskbar's own range
and the same build showed a bare mark in the taskbar at 100% scaling and the tile at 150%. The
blur that prompted D-054 was *resampling* — one 256px tile squeezed into every frame — not the
tile artwork; rendering natively per size fixes it without giving up the tile.

**Why the macOS iconset uses one source at every size.** It feeds the dock, Finder and
Launchpad — never a title bar, because a macOS window has no app icon in its title bar at all
(it shows a *document* proxy icon). So the tile is right at every size there, and the
question is only padding. It used to fall back to `icon-flat.svg` below 48px, which is
**full-bleed**, while `icon-macos.svg` insets the artwork to the macOS safe area (824 of 1024)
— giving 0% padding at 16/32px against 9.8% at 128px and up, so Klados rendered visibly
larger than its neighbours at small sizes and than itself at large ones. The original reason
for the flat fallback was gradient banding, which is a *resampling* artifact; nothing resamples
any more, since every frame is rendered at its own size. `icon-macos.svg` now covers all ten
frames.

## Generated — `build/`

| Path | Contents |
|---|---|
| `icon.png` | 1024×1024. electron-builder derives platform formats from this. |
| `icon.ico` | Windows, multi-resolution: 16, 24, 32, 48, 64, 128, 256 — `icon.svg` (the tile) at every size. Each frame is its own render, **not** one image resampled; `generate.py` asserts the frame list after writing, because getting this wrong produces a valid file that silently loses frames. |
| `icon.icns` | macOS. |
| `Klados.iconset/` | macOS iconset, 10 files with @2x variants — `icon-macos.svg` at **every** size. |
| `icons/*.png` | 16 … 1024 for Linux and in-app use — `icon.svg` at every size, same as `icon.ico`. |

### Regenerating

```bash
uv run --with resvg-py --with pillow tools/generate.py
```

Rerun after any change to `assets/`. Do not edit files under `assets/build/` — they are outputs.
No global Python install and no venv to manage; `uv` fetches both packages into a throwaway
environment.

**Not cairosvg.** cairosvg needs libcairo as a *system* library and there is no pip-installable
cairo on Windows, so the script simply could not run here — `OSError: no library called
"cairo-2" was found`. That is why the rasters under `assets/build/` sat stale for a milestone
while the docs described artwork that had never been generated. `resvg-py` ships a prebuilt
binary in the wheel. `svglib`+`reportlab` was the other candidate and is wrong for these files:
it reports `mark-16.svg` as 12×12.

On macOS, `iconutil -c icns build/Klados.iconset -o build/icon.icns` produces a marginally
better `.icns` than the Pillow path, since it is the platform's own packer.

### macOS caveat

macOS uses a squircle (continuous corner curvature), not a rounded rectangle. `icon-macos.svg`
approximates it with `rx`, which is close enough to pass unnoticed beside most third-party apps
but is not geometrically exact. If it ever matters, redraw the tile path as a superellipse.

## Title bar

See `titlebar-preview.html` for dark, light and macOS renderings.

**The bare mark, never the tile.** A rounded dark tile inside a light title bar reads as a
sticker. The tile is for the OS — dock, taskbar, installer, file associations. In a title bar
the mark is a UI element.

There are two title bars, and they need different things. Keeping them apart is what stops a
theme-aware title bar from being planned around raster assets it does not need.

### Today — the native Windows title bar

The window is framed, so Windows draws the title bar and picks the icon out of what
`BrowserWindow({ icon })` was given. Klados has exactly one lever: which raster.

- **`assets/build/icon.ico`**, whose 16/24/32 frames are the bare mark. `src/main/index.ts`
  passes it on Windows and the 256px PNG elsewhere.
- **`#A9701E`**, per the palette note above — Windows title bars follow the *system* theme, so
  the raster has to survive both and only that amber does.
- macOS ignores the option entirely; its dock keeps the tile at every size, which is why the
  iconset loop in `tools/generate.py` is separate and unchanged.

### Later — a Klados-drawn title bar (roadmap)

Making the title bar follow Klados's *own* theme means a frameless window and drawing the
chrome in the renderer. When that happens the icon stops being an asset problem entirely:

- **Inline `mark-16.svg` as a component.** It is already authored with
  `stroke="currentColor"` for exactly this. Colour comes from a theme token, so the mark
  follows light/dark with the rest of the interface — CONCEPT.md §9.2, and invariant 9's
  no-literal-colours rule applies to it like any other component.
- **Do not generate light and dark raster variants for this.** Two PNGs would be two files to
  keep in sync, would not follow a theme the user changes at runtime, and would be blurry on a
  fractional-DPI display. One SVG and one token beats both. The `.ico` stays regardless — it
  is what the OS consumes for the taskbar, the `.exe` and the installer, and none of those
  can read an SVG.
- `#E9A33C` on dark surfaces and `#A9701E` on light, per the palette — inside the app the
  theme is known, so the brand amber is available where it has the contrast for it.

Amber also marks the active tab underline and the unsaved-changes dot. Keep the count low — if
amber marks everything it marks nothing, the same discipline as the elevation budget in §9.4.

## Still to do

- **Wordmark lockup.** Needs a real typeface decision and the letterforms converted to outlines;
  live text in an SVG renders differently on every machine.
- **File-type association icons**, if Klados registers for `.xml` / `.json`. Convention is the
  app mark on a document silhouette, tinted per format.
- **Installer and DMG background art.**
