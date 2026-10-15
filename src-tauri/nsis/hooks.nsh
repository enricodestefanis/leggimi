; Leggimi installer hooks (Tauri NSIS bundler, see tauri.conf.json
; bundle.windows.nsis.installerHooks).
;
; `leggimi file.md --line 40` from any terminal: instead of editing the user's
; PATH (fragile: NSIS strings are capped at 1024 characters and a long PATH
; would be truncated), a two-line launcher goes into the per-user
; WindowsApps folder, which Windows keeps on the PATH for the Store's own
; app execution aliases. The Store build gets the real alias from its manifest.

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$LOCALAPPDATA\Microsoft\WindowsApps"
  ClearErrors
  FileOpen $0 "$LOCALAPPDATA\Microsoft\WindowsApps\leggimi.cmd" w
  IfErrors leggimi_alias_done
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'start "" "$INSTDIR\leggimi.exe" %*$\r$\n'
  FileClose $0
leggimi_alias_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\leggimi.cmd"
!macroend
