@echo off
rem ============================================================
rem  M68 HE - Keyboard RGB Controller & HID Protocol Analyzer
rem  Bootstrap installer for Windows
rem
rem  Installs all prerequisites if missing, then installs npm
rem  dependencies and builds the frontend. Safe to re-run.
rem ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem --- Force admin (winget needs it for system-wide installs) ---
net session >nul 2>nul
if errorlevel 1 (
  echo  Requesting administrator privileges...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs -ArgumentList 'elevated'"
  exit /b
)

echo.
echo  ============================================================
echo   M68 HE - Bootstrap Installer
echo  ============================================================
echo  Working directory: %CD%
echo.

rem --- Check for winget (Windows 10 1809+ / Windows 11) ---
where winget >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] winget was not found.
  echo          winget ships with Windows 10 1809+ and Windows 11.
  echo          Update Windows or install winget from the Microsoft Store
  echo          ^(App Installer^), then re-run install.bat.
  echo.
  pause
  exit /b 1
)

echo  [OK] winget detected.
echo.

rem ------------------------------------------------------------
rem  Node.js LTS
rem ------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [INSTALL] Node.js LTS not found. Installing via winget...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
  if errorlevel 1 (
    echo  [ERROR] Node.js install failed. Install manually from https://nodejs.org
    pause
    exit /b 1
  )
  echo  [OK] Node.js installed.
) else (
  echo  [OK] Node.js already installed: & node -v
)
echo.

rem ------------------------------------------------------------
rem  Python 3 (needed for some native module build fallbacks)
rem ------------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
  echo  [INSTALL] Python not found. Installing via winget...
  winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements --silent
  if errorlevel 1 (
    echo  [WARNING] Python install failed. It is only needed for some native
    echo           module builds. Install manually from https://python.org if needed.
  ) else (
    echo  [OK] Python installed.
  )
) else (
  echo  [OK] Python already installed: & python --version
)
echo.

rem ------------------------------------------------------------
rem  Visual Studio Build Tools (fallback for node-hid native build)
rem ------------------------------------------------------------
echo  [CHECK] Visual Studio Build Tools ^(for native module compilation^)...
winget list --id Microsoft.VisualStudio.2022.BuildTools >nul 2>nul
if errorlevel 1 (
  echo  [INSTALL] Build Tools not found. Installing via winget...
  echo           This is a large download and may take several minutes.
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --silent --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  if errorlevel 1 (
    echo  [WARNING] Build Tools install failed. node-hid usually ships prebuilt
    echo           binaries, so this is only needed as a fallback. If npm install
    echo           fails below with a node-hid build error, install Build Tools
    echo           from https://visualstudio.microsoft.com/visual-cpp-build-tools/
  ) else (
    echo  [OK] Build Tools installed.
  )
) else (
  echo  [OK] Build Tools already installed.
)
echo.

rem ------------------------------------------------------------
rem  Refresh PATH so newly installed tools are visible this session
rem ------------------------------------------------------------
echo  [INFO] Refreshing PATH for this session...
for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "SYS_PATH=%%B"
for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "USR_PATH=%%B"
set "PATH=%USR_PATH%;%SYS_PATH%;%PATH%"

rem ------------------------------------------------------------
rem  Verify Node is now reachable
rem ------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js is still not on PATH after install.
  echo           Close this window, open a NEW terminal, and re-run install.bat.
  pause
  exit /b 1
)
echo  [OK] Node reachable: & node -v
echo  [OK] npm reachable:  & npm -v
echo.

rem ------------------------------------------------------------
rem  Install npm dependencies (incl. native node-hid build)
rem ------------------------------------------------------------
echo  ============================================================
echo   Installing npm dependencies...
echo  ============================================================
call npm install
if errorlevel 1 (
  echo  [ERROR] npm install failed. See output above.
  echo           If it is a node-hid build error, install Visual Studio Build
  echo           Tools from https://visualstudio.microsoft.com/visual-cpp-build-tools/
  pause
  exit /b 1
)
echo  [OK] Dependencies installed.
echo.

rem ------------------------------------------------------------
rem  Production build
rem ------------------------------------------------------------
echo  ============================================================
echo   Building production frontend...
echo  ============================================================
call npm run build
if errorlevel 1 (
  echo  [WARNING] npm run build failed. You can still run the dev server with:
  echo           npm run dev
) else (
  echo  [OK] Build complete -^> dist\
)
echo.

echo  ============================================================
echo   Installation finished successfully
echo  ============================================================
echo.
echo  Next steps:
echo    Desktop app : npm start
echo    Web + bridge: npm run dev   ^(then open http://localhost:3000^)
echo    Silent launch: start.bat
echo.
pause
endlocal
