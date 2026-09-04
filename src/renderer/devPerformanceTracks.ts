/**
 * Disables React's dev-only "Performance tracks" instrumentation, which is
 * unusable against this application's props and makes the renderer hang.
 *
 * **The defect it works around.** In a DEV build, `react-dom`'s
 * `logComponentRender` runs on every commit. Whenever a component re-renders
 * with a props object that isn't referentially identical to the previous one
 * — which is *every* re-render, since JSX allocates a fresh props object each
 * time — it calls `addObjectDiffToProperties(alternate.memoizedProps, props)`
 * to build a human-readable prop diff for Chrome's "Components ⚛" track. That
 * walk recurses three levels deep and, at the bottom level, enumerates objects
 * with `for...in` — and `for...in` over an `Int32Array` yields **one key per
 * element**, each pushing a freshly allocated `[label, value]` string pair.
 *
 * Klados hands whole `OpenDocument`s to components as props (`Tree`,
 * `Detail`, `Raw`, `StatusBar`, `Scrubber` all take `document`), so the walk
 * reaches `document.store`'s parallel typed arrays and `document.rowIndex` /
 * `lineIndex` / `nameIndex` at exactly that bottom level. On a 10 MB document
 * that is tens of millions of string allocations per component per commit,
 * across both the old and the new props. Measured: the renderer stops
 * responding within a second and grows past 12 GB RSS, with the main thread
 * parked in `addObjectToProperties` and no application frame on the stack.
 *
 * It does **not** fire on first open (a mount has no `alternate` to diff
 * against), which is why this only ever showed up after an *in-place* store
 * replacement — a Format/Minify, an edit's reparse, undo/redo, or a reload.
 *
 * **Why this lever.** `supportsUserTiming` is computed once, when
 * `react-dom` first evaluates, from `typeof console.timeStamp === 'function'
 * && typeof performance.measure === 'function'`. Removing `console.timeStamp`
 * before that module is imported makes the whole logging path — the prop
 * diff included — inert. `performance.measure` is deliberately left alone:
 * it's the standard API, and this project's own measurement harnesses use it.
 *
 * **What it costs.** The React "Components ⚛" and "Scheduler ⚛" tracks no
 * longer appear in Chrome DevTools performance profiles. They were never
 * usable here anyway — recording one is what the hang *is*. Everything else
 * about DEV (StrictMode's double-invoke, Fast Refresh, React DevTools itself)
 * is untouched, since none of it goes through this gate.
 *
 * **This must stay the first import in `main.tsx`** — it has to run before
 * `react-dom/client` is evaluated, not merely before the first render. Nothing
 * enforces that but the comment there and this one.
 *
 * Production builds never reach this file's body: the tracks are DEV-only in
 * React, and `import.meta.env.DEV` folds the guard away at build time.
 */
if (import.meta.env.DEV) {
  // Deleted rather than reassigned: the gate tests `typeof === 'function'`,
  // so a no-op stub would still pass it. Nothing in this codebase calls
  // `console.timeStamp`, and it is configurable on Chrome's `console`.
  Reflect.deleteProperty(console, 'timeStamp')
}

export {}
