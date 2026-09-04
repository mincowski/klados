#!/usr/bin/env python3
"""Generate Klados raster icon assets from SVG sources.

Run with uv (no global Python install needed, no venv to manage):

    uv run --with resvg-py --with pillow tools/generate.py

Outputs land in assets/build/. Do not hand-edit anything there.

**Why resvg and not cairosvg.** cairosvg needs libcairo as a *system* library;
there is no pip-installable cairo on Windows, so `import cairosvg` fails on a
clean machine with `OSError: no library called "cairo-2" was found` — which is
why this script had never actually been run here and the rasters under
assets/build/ went stale. resvg-py ships a prebuilt Rust binary in the wheel
and needs nothing else. svglib+reportlab was the other candidate and was
rejected: it mis-parses these files' viewBox (it reports mark-16.svg as
12x12, not 16x16).
"""
import io, os
import resvg_py
from PIL import Image

SRC = "assets"
# Every consumer reads from assets/build: electron-builder.yml's
# `buildResources`, src/main/index.ts's `?asset` import, assets/README.md's
# own table. This used to be a bare "build", which resolves relative to the
# repo root and quietly produced a *second*, unread output tree while the
# real assets stayed stale.
OUT = "assets/build"
OUT_PNG = f"{OUT}/icons"
os.makedirs(OUT_PNG, exist_ok=True)


# Every source this script rasterizes carries its own fills. `mark-16.svg`
# does NOT — it is authored with `stroke="currentColor"` so it can be inlined
# in the renderer and take a theme token — and it is deliberately not
# rasterized here at all any more (see the SIZES comment below, and D-054b).
# If it ever comes back, it needs a colour substituted before this call,
# because a rasterizer has no CSS cascade to resolve `currentColor` against.
def render(svg_path, size):
    with open(svg_path, "r", encoding="utf-8") as f:
        svg = f.read()
    png = resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size)
    return Image.open(io.BytesIO(bytes(png))).convert("RGBA")


# The tile at EVERY size. These rasters are what the OS consumes — taskbar,
# Explorer, the .exe, the installer, file associations — and assets/README.md's
# own rule is that the tile is for exactly those surfaces while the bare mark
# is a UI element used inside the window.
#
# This briefly used mark-16.svg below 48px, to sharpen the *native* Windows
# title bar (D-054). That was wrong for two reasons, both found by looking at
# the running app:
#
#  1. Windows picks an .ico frame by pixel size, not by which surface is
#     asking. The taskbar wants roughly 32px at 100% scaling and 48px at
#     150% — straddling the 48px split — so the same build showed a bare
#     mark in the taskbar on one machine and the tile on another. An icon
#     that changes identity with display scaling is incoherent regardless of
#     which of the two you prefer.
#  2. The blur that prompted D-054 was the *resampling* (one 256px gradient
#     tile squeezed into every frame), not the tile artwork. Rendering the
#     tile natively at 16/24/32 fixes it without giving up the tile at all.
#
# The native title bar is a temporary consumer anyway: M5d R1 has Klados
# draw its own, at which point the title-bar mark is inline SVG with a theme
# token (D-054a) and no raster is involved. See D-054b.
SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

images = {}
for s in SIZES:
    img = render(f"{SRC}/icon.svg", s)
    images[s] = img
    img.save(f"{OUT_PNG}/{s}.png")
    print(f"  icons/{s}.png")

# electron-builder master — derives .icns/.ico from this when they're absent.
# The explicit icon.ico below is what keeps that derivation from happening,
# because it would downsample this one 1024 tile into every frame.
images[1024].save(f"{OUT}/icon.png")
print("  icon.png (1024, electron-builder master)")

# Windows multi-resolution .ico.
#
# `Image.save(..., format="ICO", sizes=[...])` takes ONE image and resamples
# it into every frame — so passing images[256] with a size list produced an
# .ico whose 16/24/32 frames were a downscaled *tile*, exactly what D-054
# says they must not be, while assets/README.md documented the opposite. The frames
# have to be handed over individually via `append_images` (Pillow >= 9.3),
# which is what actually puts the per-size renders above into the file.
#
# Save from the LARGEST frame, not the smallest: Pillow's ICO writer skips
# any requested size bigger than the image `save` was called on, so calling
# it on the 16px frame silently produced a single-frame .ico — no error, a
# file that opens fine, and Windows quietly back to resampling one bitmap.
# Verified below rather than trusted.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
base = images[max(ICO_SIZES)]
base.save(
    f"{OUT}/icon.ico",
    format="ICO",
    sizes=[(s, s) for s in ICO_SIZES],
    append_images=[images[s] for s in ICO_SIZES if s != max(ICO_SIZES)],
)
written = sorted(s for s, _ in Image.open(f"{OUT}/icon.ico").ico.sizes())
if written != sorted(ICO_SIZES):
    raise SystemExit(f"icon.ico has frames {written}, expected {sorted(ICO_SIZES)}")
print(f"  icon.ico ({', '.join(map(str, ICO_SIZES))}; every frame rendered at its own size)")

# macOS: padded artwork, standard iconset sizes. The tile at EVERY size —
# this loop deliberately does not use the bare mark, because macOS has no
# app icon in a title bar to begin with (a macOS window shows a *document*
# proxy icon, not the app's) and this iconset only ever feeds the dock,
# Finder and Launchpad, which are the tile's own surfaces.
#
# One source for all ten frames, and it must stay that way. This used to
# fall back to icon-flat.svg below 48px, which is FULL-BLEED — while
# icon-macos.svg insets the artwork to the macOS safe area (824 of 1024).
# The result was a 16/32px icon with 0% padding sitting in Finder beside
# 128px+ frames with 9.8%, so Klados rendered visibly larger than its
# neighbours at small sizes and than itself at large ones. The original
# reason for the flat fallback — gradient banding — was a *resampling*
# artifact, and nothing here resamples any more: every frame is rendered at
# its own size.
#
# It also no longer borrows MARK_BELOW. That constant now means "below this,
# use the bare mark," which has nothing to do with macOS padding; sharing it
# meant changing the mark rule would silently change this iconset too.
os.makedirs(f"{OUT}/Klados.iconset", exist_ok=True)
ICONSET = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
for base, scale in ICONSET:
    px = base * scale
    name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
    render(f"{SRC}/icon-macos.svg", px).save(f"{OUT}/Klados.iconset/{name}")
print("  Klados.iconset/ (10 files, icon-macos.svg at every size)")

try:
    images[1024].save(f"{OUT}/icon.icns", format="ICNS")
    print("  icon.icns")
except Exception as e:
    print(
        f"  icon.icns SKIPPED ({type(e).__name__}) — "
        "run `iconutil -c icns assets/build/Klados.iconset` on macOS, "
        "or let electron-builder derive it from icon.png"
    )
