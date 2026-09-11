# R194 — Save As offers no file type, so it can save a file the app cannot reopen

<!-- status: open -->

**Open.** Found by the project lead during R166's manual Save As check
(`docs/plans/R164-release-security-hardening.md` § 10) — the pass confirmed the dialog opens, and
the dialog turned out to be wrong.

## 1. The defect

`main/documents.ts:155` calls `showSaveDialog` with `{ title, defaultPath }` and **no `filters`**:

```ts
const options: Electron.SaveDialogOptions = { title: 'Save Document As', defaultPath }
```

The file-type dropdown therefore reads `*.*`, and **Electron appends an extension only from the
selected filter** — with none, a name typed without an extension is saved without one.

**That is not only a papercut.** `selectFormat` (`formats/registry.ts`) picks a module by
`detect(head, filename)`, and `src/core/types.ts`:224 states the rule the modules implement:
*"Extension match is a strong signal; content sniffing of the first non-…"*. CSV has no content
check at all (`docs/plans/R145-csv.md` § 5). So Save As can produce a file this application will
not reopen — most certainly for CSV, and by a weaker signal for the rest. **Save As is a
data-preservation path, and it can currently degrade the file it just wrote.**

The requested behaviour, from the report: two entries in the dropdown — the document's own type and
`*.*` — with the document's type preselected, so saving under a new name needs no thought about
extensions.

## 2. Where the knowledge goes, and where it must not

Invariant 8: *nothing above `src/formats/` knows which format produced a document.* The Open dialog
already breaks the spirit of it, and it is worth quoting because it is the same defect one step
earlier:

```ts
filters: [
  { name: 'XML/JSON/TOML/CSV documents',
    extensions: ['xml', 'json', 'toml', 'csv', 'tsv', 'tab'] },
  { name: 'All files', extensions: ['*'] }
]
```

A hand-maintained list in the **main process**, duplicating what the registry already declares.
Checked: it agrees with the registry exactly today (`.xml`, `.json`, `.toml`, `.csv/.tsv/.tab`), so
there is no live bug — but it is the *shape* R190 just spent a round removing from
`electron-builder.yml`. When R143's YAML lands, nothing makes anyone come back here, and the name
string drifts too.

**So the filters are built in `src/formats/registry.ts` and passed through IPC**, rather than main
importing the registry. Main currently imports from `../core` and never from `../formats`, and
keeping it that way matters for a reason beyond tidiness: importing `registry.ts` pulls all four
format modules — the parsers — into the main bundle, for a list of file extensions.

## 3. R194

Two pure functions in `src/formats/registry.ts`, beside the `supportedExtensionsList()` that
already derives from the same source, returning plain serializable data:

```ts
export interface DialogFilter {
  readonly name: string
  readonly extensions: readonly string[]   // no leading dot — Electron's shape
}

export function openDialogFilters(): readonly DialogFilter[]
export function saveAsDialogFilters(formatId: string, fileName: string): readonly DialogFilter[]
```

**`saveAsDialogFilters` leads with the file's own extension.** Today every format but CSV declares
one extension, so the rule is invisible — but `src/core/types.ts`:139 gives `[".xml", ".xsd",
".svg"]` as the shape it expects, and CSV already declares three. Saving `data.tsv` must not offer
`.csv` first. The rule:

```
extensions = format's declared list, with the current file's extension moved to the front
             if it is in that list; otherwise the declared list unchanged
```

so a `.tsv` file keeps `.tsv`, a file with no extension or a foreign one gets the format's first,
and an unknown `formatId` falls back to All files alone — today's behaviour, not a crash.

**Both dialogs take their filters as an IPC argument.** `openDialog()` becomes
`openDialog(filters)` and `saveAsDialog(defaultPath)` becomes `saveAsDialog(defaultPath, filters)`;
main forwards them to Electron and stops knowing any extension. `src/preload/api.ts` changes;
**`src/core/types.ts` does not** — `FormatCapabilities` already carries `extensions` and
`displayName`, which is why this needs no contract change at all.

**The trust question, stated rather than assumed.** Filters now arrive from the renderer. They are
display strings and extension lists handed to a native dialog, which validates them; they grant no
filesystem access, and the path the dialog returns is what it always was. `secureHandle`'s sender
guard (R164 § 2e) still gates who may call. This widens the IPC payload, not the IPC authority.

## 4. Rejected

**Hardcoding the current document's extension in main** — the defect in § 2, moved.

**Deriving the filter from `defaultPath` in main** (take whatever extension the current file has).
It needs no format knowledge and would fix the reported case, but it offers exactly one extension:
a `.tsv` document could not be saved as `.csv` without retyping, and a document whose file has no
extension gets nothing. The format is what knows the alternatives.

**`defaultPath` alone.** It already carries the current name *with* its extension, which is why the
pre-filled name looks right; the reported failure is what happens when the user *retypes* the name,
and no `defaultPath` value changes that.

## 5. Acceptance

1. Save As on a `.json` document offers `JSON documents (*.json)` selected, plus `All files`;
   typing `foo` with no extension writes `foo.json`.
2. Save As on a `.tsv` document offers `.tsv` **first**, not `.csv`.
3. A document whose file has no extension, or one outside its format's list, gets the format's
   first declared extension.
4. An unrecognized `formatId` yields All-files only, and does not throw.
5. `openDialogFilters()` equals the list main hardcodes today, derived — asserted against the
   registry so the label and the extensions both follow a newly registered format.
6. No extension string appears anywhere in `src/main/`.
7. `npm test`, `npm run typecheck`, `npm run lint` clean; `src/core/types.ts` unchanged.

**1–4 are unit-testable without a dialog** — they are pure functions of `(formatId, fileName)`.
What a test cannot drive is the native dialog itself, so the manual half is the same gesture R166
just performed: Save As on a JSON document, type a bare name, confirm `.json` on disk.

## 6. Version

**No bump** — 1.0.0 until first release, and this is a defect fix inside it.
