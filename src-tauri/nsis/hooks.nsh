; Leggimi installer hooks (Tauri NSIS bundler, see tauri.conf.json
; bundle.windows.nsis.installerHooks).
;
; `leggimi file.md --line 40` from any terminal: instead of editing the user's
; PATH (fragile: NSIS strings are capped at 1024 characters and a long PATH
; would be truncated), a two-line launcher goes into the per-user
; WindowsApps folder, which Windows keeps on the PATH for the Store's own
; app execution aliases. The Store build gets the real alias from its manifest.
;
; New > Markdown document in File Explorer: Tauri's file associations
; (APP_ASSOCIATE, which runs before the post-install hook) register the
; `Markdown` ProgID for .md and the other extensions, but no ShellNew entry.
; The hook adds one, for .md only: an empty file (NullFile), with a marker
; value of ours. Tauri's uninstall deletes the ProgID but leaves the .md key
; and its subkeys behind, so the uninstall hook deletes the entry, and only
; when the marker says it is ours: an entry another app or the user made is
; never touched. Explorer names the menu item, and the new file, after the
; ProgID's display name, so that is written in the Windows display language.
; This file must stay ASCII (NSIS reads it in the ANSI code page): other
; characters are written as U+ escapes, like the Chinese name below.

!include LogicLib.nsh

; the ProgID is the `name` of the association in tauri.conf.json
!define LEGGIMI_PROGID "Software\Classes\Markdown"
!define LEGGIMI_SHELLNEW "Software\Classes\.md\ShellNew"
!define LEGGIMI_SHELLNEW_MARKER "LeggimiShellNew"

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$LOCALAPPDATA\Microsoft\WindowsApps"
  ClearErrors
  FileOpen $0 "$LOCALAPPDATA\Microsoft\WindowsApps\leggimi.cmd" w
  IfErrors leggimi_alias_done
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'start "" "$INSTDIR\leggimi.exe" %*$\r$\n'
  FileClose $0
leggimi_alias_done:

  ; the type's name in the Windows display language (its primary language)
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  StrCpy $3 $0 ; the whole LANGID, for Traditional Chinese
  IntOp $0 $0 & 0x3FF
  ${If} $0 = 16 ; LANG_ITALIAN
  ${OrIf} $0 = 10 ; LANG_SPANISH
    StrCpy $1 "Documento Markdown"
  ${ElseIf} $0 = 7 ; LANG_GERMAN
    StrCpy $1 "Markdown-Dokument"
  ${ElseIf} $0 = 12 ; LANG_FRENCH
    StrCpy $1 "Document Markdown"
  ${ElseIf} $0 = 4 ; LANG_CHINESE
    ; Taiwan, Hong Kong and Macao write Traditional Chinese
    ${If} $3 = 1028
    ${OrIf} $3 = 3076
    ${OrIf} $3 = 5124
      StrCpy $1 "Markdown ${U+6587}${U+4EF6}"
    ${Else}
      StrCpy $1 "Markdown ${U+6587}${U+6863}"
    ${EndIf}
  ${Else}
    StrCpy $1 "Markdown document"
  ${EndIf}
  WriteRegStr SHCTX "${LEGGIMI_PROGID}" "" "$1"

  ; the entry is written when there is none, or when it is ours (a reinstall)
  StrCpy $2 1
  ClearErrors
  ReadRegStr $0 SHCTX "${LEGGIMI_SHELLNEW}" "${LEGGIMI_SHELLNEW_MARKER}"
  ${If} ${Errors}
    ClearErrors
    EnumRegValue $0 SHCTX "${LEGGIMI_SHELLNEW}" 0
    ${IfNot} ${Errors}
    ${AndIf} $0 != ""
      StrCpy $2 0 ; someone else's
    ${EndIf}
  ${EndIf}
  ${If} $2 = 1
    WriteRegStr SHCTX "${LEGGIMI_SHELLNEW}" "NullFile" ""
    WriteRegStr SHCTX "${LEGGIMI_SHELLNEW}" "${LEGGIMI_SHELLNEW_MARKER}" "1"
  ${EndIf}
  ; SHCNE_ASSOCCHANGED: Explorer reads the associations and the New menu again
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\leggimi.cmd"

  ClearErrors
  ReadRegStr $0 SHCTX "${LEGGIMI_SHELLNEW}" "${LEGGIMI_SHELLNEW_MARKER}"
  ${IfNot} ${Errors}
    DeleteRegKey SHCTX "${LEGGIMI_SHELLNEW}"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
