# R194 — Save As offers no file type, so it can save a file the app cannot reopen

<!-- status: built -->

**Built.** Found by the project lead during R166's manual Save As check
(`docs/plans/R164-release-security-hardening.md` § 10) — the pass confirmed the dialog opens, and
the dialog turned out to be wrong.

Save As offers **the extension the file already has**, then All files — see § 4a, which records the
rule this plan originally specified and why the project lead was right to replace it. The Open
dialog takes its list from the format registry, and **no file extension is named anywhere in
`src/main`**. **Nothing owed:** the native dialog was confirmed by hand on 2026-09-12 (§ 8).

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

**`saveAsDialogFilters` offers the file's own extension and nothing else.** See § 4a — an earlier
version of this section specified the format's whole declared list with the file's extension
leading, and that was wrong.

```
extensions = [the extension the file already has]   — or All files alone, if it has none
```

So `export.csv` is offered `.csv` and never `.tsv`; `payload.abc` is offered `.abc`, an extension
this application has never heard of; and `data`, with no extension, gets All files alone. **No
`formatId` is involved at all** — the signature is `saveAsDialogFilters(fileName)`.

**Both dialogs take their filters as an IPC argument.** `openDialog()` becomes
`openDialog(filters)` and `saveAsDialog(defaultPath)` becomes `saveAsDialog(defaultPath, filters)`;
main forwards them to Electron and stops knowing any extension. `src/preload/api.ts` changes;
**`src/core/types.ts` does not** — `FormatCapabilities` already carries `extensions` and
`displayName`, which is why this needs no contract change at all.

**The trust question, stated rather than assumed.** Filters now arrive from the renderer. They are
display strings and extension lists handed to a native dialog, which validates them; they grant no
filesystem access, and the path the dialog returns is what it always was. `secureHandle`'s sender
guard (R164 § 2e) still gates who may call. This widens the IPC payload, not the IPC authority.

## 4a. The rule this section used to specify, and why it was wrong

**Corrected after review by the project lead, before the round merged.** The original § 3 built the
Save As list from `FormatCapabilities.extensions` — every extension the document's format declares,
with the file's own leading. The question that undid it: *does saving a CSV as `.tsv` actually
change the separator?*

**It does not, and cannot.** Invariant 6 means Save writes the byte buffer verbatim; nothing
regenerates the document. Measured rather than reasoned: `sniffDialect(source, start)` takes only
bytes and has no filename parameter, so a comma file called `.tsv` still parses as comma-separated
— *this* application is unharmed, and every other tool that trusts the extension is not.

**The error was conflating two different questions.** `FormatCapabilities.extensions` answers
*"which files can this format open?"*. Save As asks *"which extensions may this document be written
under?"*. They are not the same set, and for CSV the gap is a dialog offering a conversion that
cannot happen.

**The second half is worse and more general**, and it is the argument that settled the design: an
`.abc` file that happens to contain XML is opened by content, and whoever named it `.abc` had a
reason. Offering it `.xml`, `.xsd` and `.svg` — a list from a format the *file* never claimed —
discards the one piece of information the user actually supplied. **The file already knows its
extension; the format is guessing.**

The replacement is smaller in every direction: no `formatId`, no registry lookup, no ordering rule,
no "what if the extension is foreign" branch, because a foreign extension is simply carried
through. § 4's third rejected option — deriving the filter from the path in main — was rejected on
the grounds that "it offers exactly one extension", which turns out to be the requirement rather
than the flaw. It stays rejected only on *where* the logic lives, not on what it computes.

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

1. Save As on a `.json` document offers `JSON files (*.json)` selected, plus `All files`; typing
   `foo` with no extension writes `foo.json`.
2. Save As on a `.csv` document offers `.csv` and **never** `.tsv` or `.tab`.
3. An extension the application does not recognize is carried through — `payload.abc` offers
   `.abc`.
4. A file with no extension yields All-files only.
5. `openDialogFilters()` equals the list main hardcodes today, derived — asserted against the
   registry so the label and the extensions both follow a newly registered format.
6. No extension string appears anywhere in `src/main/`.
7. `npm test`, `npm run typecheck`, `npm run lint` clean; `src/core/types.ts` unchanged.

**1–4 are unit-testable without a dialog** — they are pure functions of `(formatId, fileName)`.
What a test cannot drive is the native dialog itself, so the manual half is the same gesture R166
just performed: Save As on a JSON document, type a bare name, confirm `.json` on disk.

## 6. Version

**No bump** — 1.0.0 until first release, and this is a defect fix inside it.

---

## 7. Results

**Landed with one rule replaced** — § 4a — and including § 2's second half: the Open dialog's
hardcoded list is gone too, and **no file extension is named anywhere in `src/main`**.

| | |
|---|---|
| `src/formats/registry.ts` | `DialogFilter`, `openDialogFilters()`, `saveAsDialogFilters()` |
| `src/main/documents.ts` | both handlers take `filters: FileFilter[]`; the literal list removed |
| `src/preload/api.ts`, `index.ts` | both signatures widened |
| `src/renderer/session/documentSession.ts` | the two call sites supply them |
| `test/dialogFilters.test.ts` | new, 13 tests |
| `saveAsDialogFilters` | takes `fileName` only — **no `formatId`**, after § 4a |
| `test/documentSession.test.ts` | one test that the session actually sends them |
| `src/core/types.ts` | **unchanged** |

`npm test` 2014 passed / 5 skipped / 167 files. `npm run typecheck` and `npm run lint` clean.

### Acceptance

1–5 are covered by the 13 unit tests, including the two fallbacks (no extension, foreign
extension), the unknown-`formatId` degrade-to-All-files, a dotfile not being read as an extension,
a trailing dot, and case-insensitive matching. 6 is a grep. 7 is the suite.

**Acceptance 1's second clause — "typing `foo` writes `foo.json`" — is Electron's behaviour, not
this code's**, and is the manual half: the filters are asserted, what the OS dialog does with them
is not. That is the same boundary R166 hit and is stated here rather than implied by a green suite.

### Review

**Two findings, both mine, both in this round's own work.**

**`npm run lint` exited 1 and I read it as passing.** R54 ratchets it at `--max-warnings 3`; three
hand-written multi-line signatures added prettier warnings, taking it to 6. The check I had been
running — grepping the output for the `✖` summary line — printed `0 errors, 6 warnings` and looked
fine, because **I never read the exit code**. This is the shape `FINDINGS.md` records from R191: a
predicate that cannot fail loudly reports success. Fixed with `eslint --fix`; the lesson is that
`npm run lint` is checked by its exit status, not by grepping its output.

**A comment asserted something its own text falsified.** The new block in `main/documents.ts`
claimed *"no extension string appears anywhere in `src/main` now"* while quoting the removed
literal three lines above — so a grep for the property the comment claims would have hit the
comment. Rewritten to describe the old list rather than reproduce it. R182 had to fix a stale count
in a comment in this same file; a claim that is false about the file it sits in is the same defect
caught earlier.

Nothing else. The IPC widening was checked rather than assumed: `ipcMain.handle` catches a throw
inside the handler and rejects the caller's `invoke`, so a malformed filters array cannot crash the
main process — which matters because R171 exists for a main-process crash.

### Owed

**The native dialog itself**, once: Save As on a JSON document, type a bare name, confirm `.json`
on disk. One gesture, and the same manual boundary R164 § 10 describes.

### The rule changed after review, and that is § 4a

The Save As list originally came from `FormatCapabilities.extensions`. **The project lead's question
— does saving a CSV as `.tsv` actually change the separator? — is what undid it**, and the answer is
the finding: no, because invariant 6 writes the byte buffer verbatim, and `sniffDialect` takes only
bytes so nothing in this app is even confused by the mislabel. Everything outside it is.

The general form is worth more than the CSV case. **`FormatCapabilities.extensions` answers a
different question than Save As asks** — "what can this format open" versus "what may this document
be written as" — and the `.abc` case makes the cost plain: a file whose author chose an extension
this app has never heard of should be offered that extension, not a guess assembled from a format
the file never claimed.

**The correction made the code smaller in every direction**: no `formatId` parameter, no registry
lookup, no ordering rule, no foreign-extension branch. § 4's third rejected option had been
dismissed because "it offers exactly one extension" — which turned out to be the requirement.

**This is the second round running where a plan of mine was wrong about a rule and the correction
came from a question rather than a test** (R172's copyright was the first). Both were caught before
merging, both by someone asking what a value would actually be rather than reading what the plan
claimed.

### The fix did not reach the dialog, and the seam that swallowed it

**Reported from `npm run dev`: Save As still showed `*.*` only.** The filters were built correctly,
passed correctly by the session, and **dropped at the contextBridge**. `api.ts` declared
`saveAsDialog(defaultPath, filters)`; `preload/index.ts` implemented
`(defaultPath) => invoke('document:saveAsDialog', defaultPath)`. Main received `undefined` and
Electron rendered the dialog with no filters — the exact defect the round set out to remove,
surviving inside its own fix.

It was a partially-applied edit: `openDialog` was updated by hand after a scripted edit failed
halfway, `saveAsDialog` was not, and nothing said so.

**Three checks looked straight at it and none could see it:**

- **TypeScript cannot express this.** A function of fewer parameters is assignable where more are
  expected — ordinary, sound function subtyping. `(a: string) => P` **is** a valid
  `(a: string, b: F[]) => P`. The interface in `api.ts` was correct, the implementation satisfied
  it, and the argument vanished.
- **`documentSession.test.ts` mocks this layer away.** The wiring test added earlier in this round
  asserts `saveAsDialog` was called with the filters — but that `saveAsDialog` is a `vi.fn()`
  standing in for the bridge. It proves renderer → API. The defect was API → IPC. **A test written
  specifically to prove the two halves were connected did not reach the join.**
- **R51's exposed-surface test checks shape, not arity.** It asserts each key exists and is a
  function, which a one-argument implementation satisfies exactly.

So the bridge had a type system structurally unable to see it and tests on both sides of it.

**`test/preloadForwarding.test.ts`** closes it for every method rather than for the one that broke:
it mocks `electron`, imports the real preload, calls each forwarder with sentinel arguments, and
asserts `ipcRenderer.invoke` received all of them — plus that the declared arity matches. Verified
by reverting to the shipped defect, where **both assertions fail** (`expected 1 to be 2`). The
table is deliberately a literal rather than a walk of the object: a walk would have to guess each
method's argument count, and an argument count is precisely what was wrong.

Also verified on the built artifact, not only the source — `out/preload/index.js` now contains
`document:saveAsDialog", defaultPath, filters)`.

**This is the third defect in this round found by someone running the application.** The first was
the missing filters, the second was the rule being wrong (§ 4a), and this is the fix not reaching
the screen. `docs/FINDINGS.md` already opens its recurring-mistakes section with *"the suite tests
mechanisms; nobody was testing the application"* — that entry now has a fourth instance, and this
one is sharper than the others because the round had a passing test whose stated purpose was to
prove exactly the thing that was broken.

---

## 8. The manual confirmation (2026-09-12)

**Done, and it passes.** The project lead ran the one gesture no harness can: Save As on a JSON
document in the built application, confirming the dialog offers the document's own type and that a
bare typed name is written with its extension.

That closes the round's only owed item. The split was never about confidence in the filters — those
are asserted as data, and the session is asserted to send them — but about Electron's own rule that
it appends the selected filter's first extension, which lives on the far side of a boundary a test
cannot cross (R164 § 10).

Worth recording that **the owed entry was not this round's real risk.** The defect that actually
shipped was the preload bridge silently dropping the argument, and it was found by the project lead
running `npm run dev` — not by this check, and not by any test, including the one written in this
round specifically to prove the two halves were connected.
