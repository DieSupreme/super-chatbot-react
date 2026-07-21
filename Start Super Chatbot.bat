@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo First run - installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo Dependency install FAILED. Fix the errors above and try again.
    pause
    exit /b 1
  )
)

if not exist dist\index.html (
  echo Building renderer...
  call npm run build
  if errorlevel 1 (
    echo.
    echo Renderer build FAILED. The app would launch against a missing/broken dist.
    pause
    exit /b 1
  )
)

REM Launch in this console (not minimized) so any startup error is visible
REM instead of a window that vanishes instantly.
npx electron .
if errorlevel 1 (
  echo.
  echo Electron exited with an error. See the output above.
  pause
  exit /b 1
)
