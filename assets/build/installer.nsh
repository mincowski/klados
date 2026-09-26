; R219 (`docs/plans/R219-open-with.md` §2) - Klados in Explorer's "Open with",
; and nothing more. electron-builder includes this file from `buildResources`
; and calls `customInstall` after installing and `customUnInstall` when
; uninstalling (templates/nsis/installSection.nsh, uninstaller.nsh).
;
; **Why not electron-builder's own `fileAssociations` on Windows.** Its
; `APP_ASSOCIATE` (templates/nsis/include/FileAssociation.nsh) also writes each
; extension's default value (`Software\Classes\.json` = its class), and that
; per-user value outranks whatever an extension falls back to when nobody ever
; chose. Measured on a real machine before this was written: `.json`, `.toml`
; and `.csv` opened in VS Code with no choice ever made, and would all have
; switched to Klados on install; `.tsv` and `.tab` would have too. Its uninstall
; then leaves that value naming a class it has deleted. The project lead's
; rule: appear in "Open with", never change what a double-click does - the same
; as macOS (`rank: Alternate`) and Linux (a `MimeType=` line) get.
;
; So this writes exactly what "Open with" needs, which is also what VS Code's
; per-user install writes: a class per extension, `Klados.<ext>`, with its open
; command, and that class's name in the extension's `OpenWithProgids`. Never
; the extension's default value, never `UserChoice`.
;
; `SHELL_CONTEXT` is `HKCU` for this per-user installer. The extension list is
; the format modules' own (`src/formats/*/index.ts`), held together by
; `test/fileAssociations.test.ts`.

!macro kladosOpenWith EXT DESCRIPTION
  WriteRegStr SHELL_CONTEXT "Software\Classes\Klados.${EXT}" "" "${DESCRIPTION}"
  ; A page with the mark, not the app tile (`tools/generate.py`, `win.extraResources`).
  WriteRegStr SHELL_CONTEXT "Software\Classes\Klados.${EXT}\DefaultIcon" "" "$INSTDIR\resources\document.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Klados.${EXT}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "Klados.${EXT}"
!macroend

; Only Klados's own value and class. **No key is deleted**, even one left empty:
; `DeleteRegKey /ifempty` checks for subkeys only, not values, so on
; `OpenWithProgids` it would delete every other application's entry too. An
; empty `OpenWithProgids` key changes nothing.
!macro kladosNoOpenWith EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "Klados.${EXT}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Klados.${EXT}"
!macroend

!macro customInstall
  !insertmacro kladosOpenWith "xml" "XML document"
  !insertmacro kladosOpenWith "json" "JSON document"
  !insertmacro kladosOpenWith "toml" "TOML document"
  !insertmacro kladosOpenWith "csv" "CSV document"
  !insertmacro kladosOpenWith "tsv" "TSV document"
  !insertmacro kladosOpenWith "tab" "Tab-separated text"
  ; SHCNE_ASSOCCHANGED, so Explorer rereads the associations now.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro kladosNoOpenWith "xml"
  !insertmacro kladosNoOpenWith "json"
  !insertmacro kladosNoOpenWith "toml"
  !insertmacro kladosNoOpenWith "csv"
  !insertmacro kladosNoOpenWith "tsv"
  !insertmacro kladosNoOpenWith "tab"
!macroend
