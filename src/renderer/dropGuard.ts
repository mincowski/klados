/**
 * R164 (`docs/plans/R164-release-security-hardening.md` §2d) — the window-level
 * drop guard: defence-in-depth for the navigation guard, and a real papercut
 * fixed on the way.
 *
 * **The `preventDefault` used to cover one subtree.** `Layout.tsx` attached
 * `onDragOver`/`onDrop` to its own `.layout` div, under a comment that read *"A
 * file dropped anywhere on the window opens it"* — but `App.tsx` renders
 * `<TitleBar />` and `<TabStrip />` as siblings *above* `<Layout />`, so roughly
 * 64px of window chrome had no drop handler at all. Anything dropped there fell
 * through to Chromium's default action, which for a dragged link is to navigate
 * the top frame.
 *
 * That comment is the same species of defect this codebase keeps finding: a
 * comment describing behaviour the body does not have. It was right about the
 * intent and wrong about the reach, and nobody noticed because the benign case
 * — dropping on the title bar — merely did nothing.
 *
 * **Main's `will-navigate` guard is what actually closes the hole**; this makes
 * the window stop being a drop target in the first place, and makes the
 * comment's promise true. Either alone would do; both is the point.
 */
import { getKladosApi } from './preloadApi'
import { openPathInNewTab } from './session/tabs'

/**
 * Attaches the guard and returns a disposer.
 *
 * `target` is a parameter so a test can drive a real listener on a real element
 * without dispatching at the actual `window`, which is shared with the rest of
 * the suite.
 */
export function installDropGuard(target: EventTarget = window): () => void {
  const onDragOver = (event: Event): void => {
    event.preventDefault()
  }

  const onDrop = (event: Event): void => {
    // Unconditionally, and before anything else can fail: the whole point is
    // that no drop anywhere reaches Chromium's default action, including a
    // dropped *link*, which carries no file and would otherwise fall through
    // the early returns below.
    event.preventDefault()

    // The behaviour this inherits from `Layout.tsx`, carried across with it:
    // the drag-drop half of D6's "opens by dialog, drag-drop, and command,"
    // alongside `openDialog` and `klados.document.open`. `getPathForFile`
    // (preload, `webUtils`) replaces the `File.path` Electron removed from the
    // renderer-side `File` object. R26 (`R24-tabs.md` §4): into a *new tab*,
    // the same "opening a file never touches whatever's already open" rule
    // `klados.document.open` follows — a dropped file used to silently replace
    // the active tab's own document.
    const file = (event as DragEvent).dataTransfer?.files[0]
    if (file === undefined) return
    const api = getKladosApi()
    if (api === undefined) return

    // **A dragged link produces a `File` with no path**, and `getPathForFile`
    // answers `''` for anything that did not come from the filesystem. Opening
    // `''` reaches `document:stat` and fails with
    // `ENOENT: no such file or directory, stat ''` — a red error box on a new
    // tab, from dropping a link on the tab strip.
    //
    // Inherited rather than introduced: `Layout.tsx` had the same two lines and
    // the same missing check. What changed is the reach — while the handler
    // covered only `.layout`, a link dropped on the chrome never got this far.
    // **Widening a guard exposed a latent defect behind it**, which is worth
    // recording as its own small lesson: the guard was right and the thing it
    // newly protects was not ready to be reached.
    const path = api.document.getPathForFile(file)
    if (path === '') return
    openPathInNewTab(path)
  }

  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}
