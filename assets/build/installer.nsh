; Two additions to electron-builder's installer: R225's running-app check
; (`customCheckAppRunning`, below this comment) and R219's "Open with".
;
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

; R225 (`docs/plans/R225-winget-package.md` §3) - a running Klados is never
; killed. electron-builder's own check (`_CHECK_APP_RUNNING`,
; templates/nsis/include/allowOnlyOneInstallerInstance.nsh) asks "Klados is
; running. Click OK to close it" with `/SD IDOK`, then ends the process with
; PowerShell's `Stop-Process`. Klados's own unsaved-changes prompt never runs,
; and under `/S` (how winget runs this installer) nobody even sees the
; question: `winget upgrade` with an edited document open lost the edit.
;
; This replaces that check; electron-builder inserts `customCheckAppRunning`
; instead of its own when the macro exists. It is read only because this file
; is included ahead of the templates (`NsisTarget.js`,
; `computeCommonInstallerScriptHeader`). The installer and the uninstaller both
; go through it.
;
; - Silent: exit with `KLADOS_RUNNING_EXIT_CODE` without installing. The winget
;   manifest maps that code to `packageInUse`, so winget tells the user to close
;   the application first.
; - Interactive: ask the user to close Klados, which lets Klados ask about
;   unsaved changes, then Retry; Cancel exits with the same code.
;
; The prompt is electron-builder's own `appCannotBeClosed` ("Klados cannot be
; closed. Please close it manually and click Retry to continue."), translated
; in 46 languages (templates/nsis/messages.yml). An English sentence of our own
; was tried first: on a German Windows it sat in a German dialog with German
; buttons. "Cannot be closed" is looser than the truth, since the installer
; chooses not to, but the instruction it ends with is exactly the one wanted.
;
; Finding the process reuses the stock `FIND_PROCESS`: a process whose path is
; under `$INSTDIR` (PowerShell), or else a `Klados.exe` of the current user
; (`tasklist`). `$CmdPath` and `$PowerShellPath` are set by `CHECK_APP_RUNNING`
; before it inserts this.
;
; 3 because NSIS itself uses 1 (cancelled) and 2 (aborted), and the templates
; use 0 and 0x666666. **It is part of the winget manifest**; changing it means
; changing `ExpectedReturnCodes` there in the same release.
!define KLADOS_RUNNING_EXIT_CODE 3

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${Do}
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      ${Break}
    ${EndIf}
    ${If} ${Silent}
      SetErrorLevel ${KLADOS_RUNNING_EXIT_CODE}
      Quit
    ${EndIf}
    ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" IDCANCEL`
      SetErrorLevel ${KLADOS_RUNNING_EXIT_CODE}
      Quit
    ${EndIf}
  ${Loop}
!macroend

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
