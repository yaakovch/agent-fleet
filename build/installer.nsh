!macro customUnInstall
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    Goto keepUserData
  ${EndIf}

  IfFileExists "$INSTDIR\Agent Fleet.exe" 0 legacyCleanup
    ExecWait '"$INSTDIR\Agent Fleet.exe" --uninstall-cleanup'
    Goto cleanupDone
  legacyCleanup:
  IfFileExists "$INSTDIR\AI Limits Widget.exe" 0 cleanupDone
    ExecWait '"$INSTDIR\AI Limits Widget.exe" --uninstall-cleanup'
  cleanupDone:

  ${If} ${Silent}
    Goto keepUserData
  ${EndIf}

  MessageBox MB_YESNO|MB_DEFBUTTON2 "Remove Agent Fleet settings, caches, backups, and logs?" IDNO keepUserData
    RMDir /r "$APPDATA\AI Limits Widget"
  keepUserData:
!macroend
