; Установщик Overvoice: программа, портативный Node.js, виртуальный кабель VB-Cable и (по желанию) скачивание движка.
Unicode true
!include "MUI2.nsh"
!include "Sections.nsh"
!include "LogicLib.nsh"
!ifndef VERSION
  !define VERSION "0.2.0"
!endif
!ifndef STAGE
  !define STAGE "stage"
!endif
Name "Overvoice"
!ifndef OUT
  !define OUT "Overvoice-Setup-${VERSION}.exe"
!endif
OutFile "${OUT}"
InstallDir "C:\Overvoice"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "Overvoice ${VERSION} · создано на основе VCClient (MIT)"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\start.bat"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить Overvoice"
!define MUI_FINISHPAGE_RUN_PARAMETERS ""
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE-VCCLIENT"
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_DIRECTORYPAGE_TEXT_TOP "Выбери диск и папку. Движок голоса занимает около 8 ГБ, поэтому выбирай диск со свободным местом."
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Section "Overvoice (обязательно)" SecApp
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
  CreateDirectory "$SMPROGRAMS\Overvoice"
  CreateShortCut "$SMPROGRAMS\Overvoice\Overvoice.lnk" "$INSTDIR\start.bat" "" "$INSTDIR\overvoice.ico" 0 SW_SHOWMINIMIZED
  CreateShortCut "$DESKTOP\Overvoice.lnk" "$INSTDIR\start.bat" "" "$INSTDIR\overvoice.ico" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\Overvoice\Удалить Overvoice.lnk" "$INSTDIR\uninstall.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Overvoice" "DisplayName" "Overvoice"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Overvoice" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Overvoice" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Overvoice" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Overvoice" "Publisher" "Starikov"
SectionEnd

Section "Виртуальный аудиокабель VB-Cable" SecCable
  DetailPrint "Скачиваю VB-Cable с vb-audio.com…"
  InitPluginsDir
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"Stop\"; $$d=\"$PLUGINSDIR\vbc\"; New-Item -ItemType Directory -Force $$d | Out-Null; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip -OutFile \"$$d\c.zip\"; Expand-Archive -Force \"$$d\c.zip\" $$d"'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Устанавливаю драйвер (Windows может спросить подтверждение)…"
    ExecWait '"$PLUGINSDIR\vbc\VBCABLE_Setup_x64.exe" -i -h' $1
  ${Else}
    DetailPrint "Не удалось скачать VB-Cable. Его можно поставить позже кнопкой в Overvoice."
  ${EndIf}
SectionEnd

SectionGroup /e "Движок голоса (скачивается после установки, около 3 ГБ)" SecEng
  Section "Видеокарта NVIDIA (CUDA)" SecCuda
    FileOpen $0 "$INSTDIR\nv_settings.json" w
    FileWrite $0 '{"variant":"cuda"}'
    FileClose $0
    FileOpen $0 "$INSTDIR\autoinstall.flag" w
    FileClose $0
  SectionEnd
  Section /o "Другая видеокарта (DirectML)" SecDml
    FileOpen $0 "$INSTDIR\nv_settings.json" w
    FileWrite $0 '{"variant":"dml"}'
    FileClose $0
    FileOpen $0 "$INSTDIR\autoinstall.flag" w
    FileClose $0
  SectionEnd
  Section /o "Скачаю позже сам" SecLater
  SectionEnd
SectionGroupEnd

Function .onInit
  StrCpy $1 ${SecCuda}
FunctionEnd
Function .onSelChange
  !insertmacro StartRadioButtons $1
    !insertmacro RadioButton ${SecCuda}
    !insertmacro RadioButton ${SecDml}
    !insertmacro RadioButton ${SecLater}
  !insertmacro EndRadioButtons
FunctionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM MMVCServerSIO.exe'
  Delete "$DESKTOP\Overvoice.lnk"
  RMDir /r "$SMPROGRAMS\Overvoice"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Overvoice"
  RMDir /r "$INSTDIR"
SectionEnd
