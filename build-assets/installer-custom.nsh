; Claude Terminal - Custom NSIS Installer Script
; Customizes the installer appearance and behavior
;
; NOTE: electron-builder already defines MUI_FINISHPAGE_RUN and related macros
; in assistedInstaller.nsh. Do NOT redefine them here to avoid conflicts.

; ============================================
; INSTALLER UI CUSTOMIZATION
; ============================================

; Welcome page
!define MUI_WELCOMEPAGE_TITLE "Welcome to Claude Terminal"
!define MUI_WELCOMEPAGE_TEXT "This wizard will install Claude Terminal on your computer.$\r$\n$\r$\nClaude Terminal is a premium terminal environment for managing Claude Code projects with integrated tools, Git management, and more.$\r$\n$\r$\nClick Next to continue."

; Finish page text (RUN options are handled by electron-builder)
!define MUI_FINISHPAGE_TITLE "Installation Complete"
!define MUI_FINISHPAGE_TEXT "Claude Terminal has been installed successfully.$\r$\n$\r$\nClick Finish to close this wizard."

; Abort warning
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Are you sure you want to cancel Claude Terminal installation?"

; Uninstaller
!define MUI_UNCONFIRMPAGE_TEXT_TOP "Claude Terminal will be uninstalled from your computer."

; ============================================
; CUSTOM MACROS
; ============================================

!macro customInit
  ; Deliberately empty.
  ;
  ; This used to be `SetSilent normal`, which was actively harmful. customInit
  ; runs from .onInit, before anything else, so it cancelled the /S that
  ; electron-updater passes when installing an update. The result was an
  ; assisted wizard popping up after the app had already quit for the update,
  ; and installSection.nsh only relaunches the app on ${isForceRun} && ${Silent}
  ; - so it never came back either. A user who closed that unexpected window
  ; after the install section had reached uninstallOldVersion was left with no
  ; $INSTDIR and no shortcuts.
  ;
  ; Someone launching Setup.exe by hand is already non-silent; this macro only
  ; ever affected the update path, and only by breaking it.
!macroend

!macro customInstall
  ; Safety-net: recreate the shortcuts if they were deleted by the old
  ; uninstaller during a transition update (old uninstaller had no ${isUpdated}
  ; guard, and --keep-shortcuts is only passed when the previous install wrote
  ; KeepShortcuts=true). electron-builder's own addDesktopLink/addStartMenuLink
  ; skip recreation entirely when $keepShortcuts is "true", which is exactly the
  ; upgrade path - so when the link is genuinely missing, nothing restores it.
  ;
  ; $newDesktopLink / $newStartMenuLink are set by setLinkVars at the top of
  ; installSection.nsh, so they already carry the MENU_FILENAME and
  ; SHORTCUT_NAME this build actually uses. SetLnkAUMI matters: a .lnk without
  ; the app id does not group with the running window and cannot hold a pin.
  ${ifNot} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}

  ${ifNot} ${FileExists} "$newStartMenuLink"
    !insertmacro createMenuDirectory
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  ; Only clean up desktop shortcut on actual uninstall, NOT during update runs
  ; During updates, preserving the shortcut prevents taskbar pin loss
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\Claude Terminal.lnk"
  ${endIf}
!macroend
