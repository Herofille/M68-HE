@echo off
rem ============================================================
rem  M68 HE - Keyboard RGB Controller & HID Protocol Analyzer
rem  Windows install script
rem ============================================================
setlocal

cd /d "%~dp0"

echo.
echo  === M68 HE Installer ===
echo  Working directory: %CD%
echo.

rem --- Check for Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on your PATH.
  echo         Please install Node.js 18+ from https://nodejs.org and re-run install.bat.
  exit /b 1
)

rem --- Report Node/npm versions ---
echo  Node:    & node -v
echo  npm:     & npm -v
echo.

rem --- Install dependencies (includes native node-hid build) ---
echo  Installing dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed. See output above.
  exit /b 1
)
echo  Dependencies installed.
echo.

rem --- Production build (optional, but recommended) ---
echo  Building production frontend...
call npm run build
if errorlevel 1 (
  echo [WARNING] npm run build failed. You can still run the dev server with: npm run dev
) else (
  echo  Build complete -^> dist\
)
echo.

echo  === Installation finished ===
echo.
echo  Next steps:
echo    Desktop app : npm start
echo    Web + bridge: npm run dev   (then open http://localhost:3000)
echo    Silent launch: start.bat
echo.
endlocal
