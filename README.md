# Klados

A viewer and editor for node-based data formats — XML, JSON, and later TOML and YAML.

Most tools of this kind either show you a tree or show you text. Klados shows you both,
plus a third thing: when a node contains a list of similar children, their contents are
collected into a **table**. A file with two thousand `<car>` elements becomes a grid with
one row per car, which is usually what you actually wanted to look at.

Three synchronized views:

- **Tree** — the document structure
- **Detail** — the selected node's contents, as tables; repeating children become a grid
- **Raw** — the source text, unmodified

Editing happens in the Raw view only, which means saving a file never reformats it. Your
comments, key order, quoting style and indentation are preserved byte-for-byte, because
Klados writes back the bytes rather than regenerating them from a model.

Designed to stay usable on files in the hundreds of megabytes.

## Status

**Pre-alpha — not yet usable.** Under active initial development. Nothing here is stable,
including the things this README says are stable.

See [`docs/CONCEPT.md`](docs/CONCEPT.md) for the full design, and
[`M0-PLAN.md`](M0-PLAN.md) for what is currently being built.

## Development setup

### Prerequisites

- **Node.js 22 LTS or newer** — check with `node --version`
- **npm** (bundled with Node) or **pnpm**, if you prefer it
- **Git**

No other global tooling is required. Everything else installs locally.

### Getting started

```bash
git clone https://github.com/<owner>/klados.git
cd klados
npm install
npm run dev
```

`npm run dev` starts Electron with hot reload for the renderer process. Editing files
under `src/renderer/` updates the running app; changes to the main process restart it.

### Commands

| Command | Purpose |
|---|---|
| `npm run dev` | run the app in development mode |
| `npm run build` | produce a production build |
| `npm run package` | build a distributable for the current platform |
| `npm test` | run the test suite |
| `npm run test:watch` | run tests in watch mode |
| `npm run test:large` | include fixtures over 50 MB, normally skipped |
| `npm run lint` | lint and check formatting |
| `npm run typecheck` | run the TypeScript compiler without emitting |
| `npm run inspect -- <file>` | parse a file from the command line and report on it |

### Test fixtures

Some tests need large generated files that are deliberately **not** committed. They live in
`spike/fixtures/`, rebuilt with:

```bash
tsx spike/generate-fixtures.ts
```

Expect it to take a couple of minutes and a gigabyte of disk. Tests that require them skip
cleanly if they are absent.

### Project layout

```
src/
  core/        format-agnostic: buffer, node store, interning, row index
  formats/     one module per format (xml, json, …)
  worker/      parsing off the main thread
  renderer/    UI
  main/        Electron main process
test/
docs/
```

The important boundary is that **nothing above `formats/` knows which format produced a
document.** See `src/core/types.ts` for the contract each format implements.

## Contributing

Not yet accepting contributions — the architecture is still moving. Once it settles, this
section will explain how.

## License

MIT. See [`LICENSE`](LICENSE).

Third-party notices are generated at build time into `THIRD-PARTY-NOTICES.txt`.
