@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run - installing dependencies...
  call npm install
)
if not exist dist\index.html (
  echo Building renderer...
  call npm run build
)
start "" /min cmd /c "npx electron ."
