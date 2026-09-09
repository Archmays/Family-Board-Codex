@echo off
setlocal
cd /d "%~dp0"
set "EDITOR_URL=http://127.0.0.1:4173/editor.html"

rem If the editor is already running, open it instead of starting a second
rem server that would fail because port 4173 is in use.
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "try { $state = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/revision' -TimeoutSec 2; if ($state.revision) { Start-Process '%EDITOR_URL%'; exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  endlocal
  exit /b 0
)

call npm run editor
set "EDITOR_EXIT=%ERRORLEVEL%"
if not "%EDITOR_EXIT%"=="0" (
  echo.
  echo Family Board editor failed to start. Review the error above.
  pause
)
endlocal & exit /b %EDITOR_EXIT%
