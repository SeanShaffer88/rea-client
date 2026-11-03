!include "${BUILD_RESOURCES_DIR}\offline-pins.nsh"

!macro customInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\verify-offline.ps1 "${BUILD_RESOURCES_DIR}\verify-offline.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\verify-offline.ps1" -Root "$EXEDIR\offline" -ExpectedHash "${OFFLINE_MANIFEST_SHA256}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Offline dependencies are missing or damaged. Extract the complete offline kit, keeping Setup beside the offline folder.$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro customInstall
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\verify-offline.ps1" -Root "$EXEDIR\offline" -ExpectedHash "${OFFLINE_MANIFEST_SHA256}" -Destination "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Installation is incomplete: offline dependencies cannot be installed.$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
  CreateDirectory "$INSTDIR\resources\offline"
  ClearErrors
  CopyFiles /SILENT "$EXEDIR\offline\*.*" "$INSTDIR\resources\offline"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Installation is incomplete: copying offline dependencies failed. Check free disk space and run Setup again." /SD IDOK
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\verify-offline.ps1" -Root "$INSTDIR\resources\offline" -ExpectedHash "${OFFLINE_MANIFEST_SHA256}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Installation is incomplete: installed offline dependencies did not verify.$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  RMDir /r "$INSTDIR\resources\offline"
!macroend
