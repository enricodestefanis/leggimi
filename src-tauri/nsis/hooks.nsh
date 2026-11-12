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
;
; A clean uninstall of the associations. For every extension, APP_ASSOCIATE
; copies the key's default value into `Markdown_backup` and then writes
; `Markdown` there; APP_UNASSOCIATE (before the post-uninstall hook) writes
; the backup back as the default and deletes the ProgID. So a reinstall over
; Leggimi backs up `Markdown` itself, and an uninstall after it leaves the
; extension pointing to a ProgID that is gone, with `Markdown_backup` left
; behind. Hence:
; - before the install, a true backup (another app's ProgID, or empty: there
;   was none) is put aside in `LeggimiPrevious`, and after the install it
;   goes back; a backup of `Markdown` itself becomes empty;
; - before the uninstall, the ProgID of an app that took the extension over
;   after the install (a default value neither `Markdown` nor empty) is put
;   aside in `LeggimiOther`, and after APP_UNASSOCIATE it goes back, since
;   APP_UNASSOCIATE writes our old backup over it;
; - after the uninstall, an extension key keeps only what others wrote: its
;   default value goes when it is `Markdown` or empty, our values go, and
;   the key itself goes when nothing is left in it; `Markdown` leaves
;   Explorer's list for Open with (FileExts\.ext\OpenWithProgids). The user's
;   choice of default app (FileExts\.ext\UserChoice) is never touched.
; Leggimi still running stops an install or an uninstall right after its
; pre-hook: a value put aside then is no longer true later, so each pre-hook
; deletes any such value first.
; The extensions are those of bundle.fileAssociations in tauri.conf.json:
; LEGGIMI_FOR_EACH_EXT must list the same ones. The macros take the key that
; holds the extension keys (ROOT, Software\Classes of SHCTX: HKCU, as
; installMode is currentUser), so that a test can run them on fake extensions.
;
; This file must stay ASCII (NSIS reads it in the ANSI code page): other
; characters are written as U+ escapes, like the Chinese name below.

!include LogicLib.nsh

; the ProgID is the `name` of the association in tauri.conf.json
!define LEGGIMI_CLASS "Markdown"
!define LEGGIMI_PROGID "Software\Classes\${LEGGIMI_CLASS}"
!define LEGGIMI_SHELLNEW "Software\Classes\.md\ShellNew"
!define LEGGIMI_SHELLNEW_MARKER "LeggimiShellNew"
; the value APP_ASSOCIATE backs the extension's default value up in
!define LEGGIMI_BACKUP "${LEGGIMI_CLASS}_backup"
; a true backup, put aside while APP_ASSOCIATE overwrites it
!define LEGGIMI_PREVIOUS "LeggimiPrevious"
; another app's ProgID, put aside while APP_UNASSOCIATE overwrites it
!define LEGGIMI_OTHER "LeggimiOther"
!define LEGGIMI_FILEEXTS "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts"

; PER_EXT for every extension of bundle.fileAssociations in tauri.conf.json,
; in its order
!macro LEGGIMI_FOR_EACH_EXT PER_EXT
  !insertmacro ${PER_EXT} "Software\Classes" "md"
  !insertmacro ${PER_EXT} "Software\Classes" "markdown"
  !insertmacro ${PER_EXT} "Software\Classes" "mdown"
  !insertmacro ${PER_EXT} "Software\Classes" "mkd"
  !insertmacro ${PER_EXT} "Software\Classes" "mkdn"
  !insertmacro ${PER_EXT} "Software\Classes" "mdwn"
  !insertmacro ${PER_EXT} "Software\Classes" "markdn"
  !insertmacro ${PER_EXT} "Software\Classes" "mdtxt"
!macroend

; Before APP_ASSOCIATE: the extension's true backup is put aside, when
; Leggimi is its default already (a reinstall), so that APP_ASSOCIATE cannot
; replace it with `Markdown` itself.
!macro LEGGIMI_KEEP_BACKUP ROOT EXT
  ; what an install or an uninstall that stopped half-way put aside is no
  ; longer true
  DeleteRegValue SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_PREVIOUS}"
  DeleteRegValue SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_OTHER}"
  ClearErrors
  ReadRegStr $0 SHCTX "${ROOT}\.${EXT}" ""
  ${If} $0 == "${LEGGIMI_CLASS}"
    ClearErrors
    ReadRegStr $1 SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_BACKUP}"
    ${IfNot} ${Errors}
    ${AndIf} $1 != "${LEGGIMI_CLASS}"
      WriteRegStr SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_PREVIOUS}" "$1"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

; After APP_ASSOCIATE: the backup put aside goes back; a backup of
; `Markdown` itself (a reinstall's, also one made before this fix) becomes
; empty, so that an uninstall leaves no default pointing to a ProgID that is
; gone.
!macro LEGGIMI_FIX_BACKUP ROOT EXT
  ClearErrors
  ReadRegStr $0 SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_PREVIOUS}"
  ${IfNot} ${Errors}
    WriteRegStr SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_BACKUP}" "$0"
    DeleteRegValue SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_PREVIOUS}"
  ${Else}
    ClearErrors
    ReadRegStr $0 SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_BACKUP}"
    ${IfNot} ${Errors}
    ${AndIf} $0 == "${LEGGIMI_CLASS}"
      WriteRegStr SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_BACKUP}" ""
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

; Before APP_UNASSOCIATE: the ProgID of an app that took the extension over
; after the install (a default value that reads as a string, neither
; `Markdown` nor empty) is put aside: APP_UNASSOCIATE writes our old backup
; over it.
!macro LEGGIMI_KEEP_OTHER ROOT EXT
  ; one left by an uninstall that stopped half-way is no longer true
  DeleteRegValue SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_OTHER}"
  ClearErrors
  ReadRegStr $0 SHCTX "${ROOT}\.${EXT}" ""
  ${IfNot} ${Errors}
  ${AndIf} $0 != "${LEGGIMI_CLASS}"
  ${AndIf} $0 != ""
    WriteRegStr SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_OTHER}" "$0"
  ${EndIf}
  ClearErrors
!macroend

; After APP_UNASSOCIATE, before LEGGIMI_CLEAN_EXT: the other app's ProgID
; put aside is the default value again.
!macro LEGGIMI_RESTORE_OTHER ROOT EXT
  ClearErrors
  ReadRegStr $0 SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_OTHER}"
  ${IfNot} ${Errors}
    WriteRegStr SHCTX "${ROOT}\.${EXT}" "" "$0"
    DeleteRegValue SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_OTHER}"
  ${EndIf}
  ClearErrors
!macroend

; After APP_UNASSOCIATE: the extension key keeps only what others wrote.
!macro LEGGIMI_CLEAN_EXT ROOT EXT
  ; the default value, only when it reads as a string (ReadRegStr fails on
  ; any other kind): `Markdown`, or empty (no app)
  ClearErrors
  ReadRegStr $0 SHCTX "${ROOT}\.${EXT}" ""
  ${IfNot} ${Errors}
    ${If} $0 == "${LEGGIMI_CLASS}"
    ${OrIf} $0 == ""
      DeleteRegValue SHCTX "${ROOT}\.${EXT}" ""
    ${EndIf}
  ${EndIf}
  DeleteRegValue SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_BACKUP}"
  DeleteRegValue SHCTX "${ROOT}\.${EXT}" "${LEGGIMI_PREVIOUS}"
  ; only with no value and no subkey left (another app's OpenWithProgids, say)
  DeleteRegKey /ifempty SHCTX "${ROOT}\.${EXT}"
  DeleteRegValue HKCU "${LEGGIMI_FILEEXTS}\.${EXT}\OpenWithProgids" "${LEGGIMI_CLASS}"
  ClearErrors
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LEGGIMI_FOR_EACH_EXT LEGGIMI_KEEP_BACKUP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LEGGIMI_FOR_EACH_EXT LEGGIMI_KEEP_OTHER
!macroend

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

  !insertmacro LEGGIMI_FOR_EACH_EXT LEGGIMI_FIX_BACKUP
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
  ; the other apps' ProgIDs back first, then the clean-up, after the ShellNew
  ; entry: .md itself can go when nothing else is in it
  !insertmacro LEGGIMI_FOR_EACH_EXT LEGGIMI_RESTORE_OTHER
  !insertmacro LEGGIMI_FOR_EACH_EXT LEGGIMI_CLEAN_EXT
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
