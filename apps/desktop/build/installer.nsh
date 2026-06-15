!macro customUnInstall
  IfFileExists "$INSTDIR\CodePulse.exe" 0 +2
    ExecWait '"$INSTDIR\CodePulse.exe" --cleanup-config'
!macroend
