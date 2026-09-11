# R196–R197 — the README is the landing page, and reads like documentation

<!-- status: built -->

**Built.** The last item before release, and the only one the project lead asked for that is not a
defect: *"On GitHub, the README.md is the landing page that the user first sees and it currently is
not very appealing."*

## 1. What is wrong with it

`README.md` is 236 lines and correct. It is also written for someone who has already decided to use
Klados — four paragraphs of prose before the first thing a visitor can act on, and **Download is
the second section rather than the first thing visible**.

The specific failures, as a landing page rather than as documentation:

- **Nothing scannable above the fold.** The tagline is followed by three paragraphs and a
  three-item pane list before the screenshot. A visitor deciding in five seconds gets prose.
- **The features are buried in sentences.** The table view, the command palette, Raw-mode editing
  and the keyboard-first design are all there and none is a bullet.
- **The tone is uniformly technical**, including sections a non-developer reads — "Limits worth
  knowing before you rely on it" opens with byte ceilings.

Not wrong: the content. This is a reorganization and a re-pitch, not a rewrite of the facts.

## 2. R196 — the README

**Structure**, from the top:

1. Title, tagline (unchanged wording).
2. **A feature list**, as bullets — the specification from the project lead: table view of similar
   child items, keyboard-native, command palette (`Ctrl+Shift+P`), Raw-mode editing, and
   **Download**, linking to the releases page.
3. The screenshot (R197).
4. The existing sections, in the existing order, **rewritten for a reader who is not a developer**
   — except **Development, which stays technical** and is explicitly out of scope for that pass.

**Download appears twice and that is deliberate**: once as a bullet a visitor can click without
scrolling, and once as the section that explains the unsigned-build warnings, which is a paragraph
nobody reads before they need it.

**What does not change**: every fact, every link, the unsigned-build guidance, the checksum
instructions, the licence. The `##` headings keep their text where they are already plain, so
inbound anchors (`#development`, `#license`) keep working.

## 3. R197 — the screenshot

The current hero image is a composite: light theme on the left half, dark on the right, **butted
together at a hard vertical line through the centre**. It slices the Detail table mid-column and
cuts the Tree out of the dark half entirely, which reads as a rendering fault rather than as a
deliberate comparison.

**Replaced by a diagonal split, dark in the upper-left, light in the lower-right**, the line running
bottom-left to top-right.

**Chosen by rendering, not by argument** (`docs/PLANNING.md` §1). All four combinations — dark
upper-left and dark lower-right, each with and without a seam along the join — were composited from
real captures and put in front of the project lead. Upper-left wins because the diagonal passes
through the empty space right of the Tree and above the table, so it cuts almost nothing carrying
information: the tree rows, the grid and the Raw source each stay whole. The mirror image puts the
same line through the source code.

**The seam is rejected, for now.** An amber hairline (`#E9A33C`, the brand colour) along the join
was rendered on the theory that a drawn boundary reads as deliberate where a butt join reads as a
glitch. Verdict: *"it could be cool if it would have some effect, but like that it doesn't help."*
Recorded rather than dropped — revisit only with a reference where it demonstrably works.

**And the capture becomes a script.** `scripts/screenshot-panes.mjs` regenerates the image:

> **It exists because the image it replaces could not be regenerated.** The previous composite was
> made by hand, so a UI change silently dated it and nobody could refresh it without redoing
> unknown steps.

That is R190's argument about the packaging blocklist and R155's about spikes, in a third place: an
artifact whose recipe is lost is an artifact that rots.

Three mechanisms in it are worth naming because each avoids a dependency on something fragile:

- **The document is seeded through `klados.sessionRestore`**, the app's own restore-on-launch path,
  because no harness can drive the native Open dialog — the boundary R164 §10 records.
- **The Raw pane is opened through the command palette**, since invariant 10 guarantees the palette
  reaches every command, so the script does not break when the title bar is rearranged.
- **It waits for `31.655 children` to appear**, not for a duration — R159's rule.

Compositing uses `clip-path` in Playwright's Chromium. **No new dependency.**

## 4. Rejected

**Regenerating the screenshot in CI.** It needs a display, a gitignored 10 MB fixture, and a person
to look at the result. A hero image is a judgement, not an assertion; automating its production
without automating that judgement produces a stale image faster.

**Pixel-diffing the screenshot against a baseline.** `M5e-PLAN.md` §4 already rejected this for the
capture script it wrote, and nothing has changed.

**Rewriting the Development section for non-developers.** It is read by developers. Named here
because "rewrite the README for a less technical audience" would otherwise swallow it.

## 5. Acceptance

1. The feature bullets are present, immediately after the tagline, with Download among them.
2. The screenshot is the new diagonal composite, and `scripts/screenshot-panes.mjs` regenerates it.
3. Every link in the README resolves, and the `#development` and `#license` anchors still work.
4. No fact changes: the unsigned-build guidance, the checksum instructions and the limits keep
   their content.
5. `npm test`, `npm run typecheck`, `npm run lint` clean — the script is linted like any other
   source file.

## 6. Version

**No bump.** Documentation and one image; no application code changes.

---

## 7. Results

**Landed as planned.** `README.md` rewritten, `docs/screenshots/three-panes.png` replaced,
`scripts/screenshot-panes.mjs` added.

### Acceptance

All five. Notes on two of them:

**Criterion 4 — "no fact changes" — has one deliberate exception, and it is a correction.** The
Development section said `npm run test:large` *"currently fails with a worker timeout"* and takes
*"around twenty minutes"*. Both stopped being true: R187–R189 fixed the ten failures and R193 made
it exit 0, at **six minutes**. The README was the last place still carrying the old claim — the
Owed table and `FINDINGS.md` were corrected in their own rounds and this was missed. It now reads
"takes around six minutes and is not part of CI".

**Criterion 2 — the script regenerates the image, but not byte-identically.** Two consecutive runs
produce visually identical frames with different SHA-256s: a caret blink and sub-pixel antialiasing
differ. That is worth stating rather than leaving someone to discover it as a suspected bug — the
script reproduces the *picture*, and nothing here is or should be a pixel-diff assertion
(`M5e-PLAN.md` §4).

### The choice was made by looking, and the first three renders were wrong

`docs/PLANNING.md` §1 asks for visual decisions to be rendered before they are written down as
settled, and this round is a straightforward case for it — with the wrinkle that **the renders
themselves had to be debugged twice.**

1. The first pass used `polygon(0 0, 100% 0, 100% 100%)`, which splits **top-left to bottom-right**
   — the opposite diagonal to the one asked for.
2. The second pass added an amber seam along the join whose gradient was **90° out**: CSS gradients
   stripe *perpendicular* to their angle, so using the split line's own angle drew a line across
   the join rather than along it. Caught by the project lead looking at the image, not by me.

Both were found by rendering and looking. Neither would have been found by reasoning, and the
second was invisible to me until a solid-colour geometry test isolated it — which is the cheap
check that should have come first.

**The outcome also reversed a recommendation.** Dark-lower-right looked right in the argument; once
four real composites were side by side, dark-**upper**-left was clearly better, because the
diagonal there crosses the empty region right of the Tree and above the table rather than the Raw
pane's source code.

**And the seam lost.** It was built on a sound argument — a butt join reads as a rendering fault,
a drawn boundary reads as intent — and the rendering disagreed: *"it could be cool if it would have
some effect, but like that it doesn't help."* Recorded in `screenshot-panes.mjs` beside the clip it
would have decorated, so the next person weighing it starts from the result rather than the theory.
That is §1's table in miniature: two reversals, both with sound written arguments behind them.

### Review

Found one thing, in the new script rather than the README: three functions lacked return-type
annotations, which `.mjs` cannot express. Resolved the way `electron-screenshot.mjs` already had —
a disable comment naming the reason — rather than by loosening the rule. Caught by reading the lint
exit code, which is now the third round running that has mattered.

`npm test` 2030 passed / 5 skipped. `typecheck` and `lint` clean. Every internal link resolves and
both in-page anchors (`#development`, `#license`) still work.

### Owed

**Nothing.**
