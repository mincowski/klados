# H11 spike — read the document once, in the process that parses it

**Question:** does `fetch()` on a custom protocol, called from a `Worker`, materialize the
response body once (≈1× peak RSS) or twice (≈2×, via internal chunk accumulation before the
final `arrayBuffer()`)? This is the single number M5-PLAN.md's H11 says decides go/no-go.

## Harness

`main.js` + `index.html` + `worker.js`, a standalone Electron script — not part of the app,
run directly via `electron spike/h11-protocol-fetch/main.js <fixture> [no-content-length]`.

- Registers a custom scheme (`nodepad-spike`) via `protocol.registerSchemesAsPrivileged`
  (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`, `stream`, `bypassCSP`).
- `protocol.handle('nodepad-spike', ...)` serves a fixture file through a `fs.ReadStream`
  converted to a web `ReadableStream` (`stream.Readable.toWeb`) — main never reads the whole
  file into memory itself.
- A hidden `BrowserWindow` loads a local `index.html` (`loadFile`, a `file://` origin — the
  packaged-build shape) that spawns a real dedicated `Worker`.
- The worker does `await (await fetch(url)).arrayBuffer()` and posts back `{ byteLength, ms }`.
- Main reads the renderer process's own RSS via `app.getAppMetrics()` before the fetch starts
  and after the result lands, reporting the delta — this is "peak RSS in the fetching
  process" from the plan, measured directly rather than inferred.

## Results

| Fixture | Content-Length set? | File size | RSS delta | Multiple |
|---|---|---:|---:|---:|
| `cars-200mb.xml` | yes | 209,715,235 B | 212,188 KB | **1.03×** |
| `cars-200mb.xml` | yes (repeat) | 209,715,235 B | 212,156 KB | **1.03×** |
| `cars-200mb.xml` | no | 209,715,235 B | 212,096 KB | **1.03×** |
| `cars-500mb.xml` | yes | 524,288,214 B | 520,404 KB | **1.00×** |
| `cars-500mb.xml` | no | 524,288,214 B | 521,228 KB | **1.00×** |

**A ~1.0× peak, consistently, with or without `Content-Length`.** The plan's own gate
language ("Chromium can preallocate when `Content-Length` is set, but that is unverified
here") predicted `Content-Length` would matter; measured, it doesn't — Chromium's fetch
implementation apparently already accumulates the streamed body efficiently (a doubling
growth strategy converges close to 1× for a single large read regardless of whether the
final size was known up front). This is a *better* result than the plan's own best case, not
a worse one: no upstream requirement to have `fs.stat`'s size available before the response
even starts.

## Gate verdict: **go**

Per the plan's own gate: "A 1× peak is a go." Confirmed at both 200 MB and 500 MB, and the
worker-context requirement (`document:read`'s IPC hop is what this replaces) is satisfied
directly — the fetch runs inside a genuine dedicated `Worker`, not the document.

## What was and wasn't verified

- **Verified**: the scheme resolves and streams correctly from a `Worker` context, under a
  packaged-build-shaped load (`loadFile`, `file://` origin).
- **Not separately verified**: the `npm run dev` shape (`ELECTRON_RENDERER_URL`, an `http://`
  origin). Custom protocol registration is scheme-level, not origin-level, so there is no
  structural reason to expect this to behave differently — but it was not measured, and the
  plan asks for both explicitly. Worth a five-minute confirmation before H12 ships, not a
  reason to withhold the go/no-go verdict here.
- **Not built**: the security requirement (an opaque, single-use, main-minted token → path
  map; the URL must never carry a path directly) — this spike's own `/fixture` route is a
  fixed, hardcoded path for measurement purposes only, explicitly not the shape H12 would
  ship. See `DECISIONS.md`'s entry for this spike for the design sketch H12 would need.

Recorded in `docs/DECISIONS.md`.
