@echo off
rem ============================================================
rem  M68 HE - Keyboard RGB Controller & HID Protocol Analyzer
rem  Bootstrap installer for Windows
rem
rem  Installs prerequisites via winget if missing, then runs
rem  npm install + npm run build. Safe to re-run.
rem ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem --- Force admin (winget needs it for system-wide installs) ---
net session >nul 2>nul
if errorlevel 1 (
  echo  Requesting administrator privileges...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo  ============================================================
echo   M68 HE - Bootstrap Installer
echo  ============================================================
echo  Working directory: %CD%
echo.

rem --- winget is required (Windows 10 1809+ / Windows 11) ---
where winget >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] winget was not found.
  echo          winget ships with Windows 10 1809+ and Windows 11.
  echo          Update Windows or install "App Installer" from the
  echo          Microsoft Store, then re-run install.bat.
  echo.
  pause
  exit /b 1
)
echo  [OK] winget detected.
echo.

rem ------------------------------------------------------------
rem  Node.js LTS  (required)
rem ------------------------------------------------------------
call :CheckNode
if errorlevel 1 (
  echo  [INSTALL] Node.js not found. Installing via winget...
  call :WingetInstall OpenJS.NodeJS.LTS
  call :RefreshPath
  call :CheckNode
  if errorlevel 1 (
    echo  [ERROR] Node.js installation failed or is not on PATH.
    echo          Close this window, open a NEW terminal, and re-run
    echo          install.bat. If it keeps failing, install Node.js LTS
    echo          manually from https://nodejs.org
    echo.
    pause
    exit /b 1
  )
) else (
  echo  [OK] Node.js already installed.
)
echo  [OK] Node: & node -v
echo  [OK] npm:  & call npm -v
echo.

rem ------------------------------------------------------------
rem  Python 3  (only needed for native module build fallbacks)
rem ------------------------------------------------------------
call :CheckPython
if errorlevel 1 (
  echo  [INSTALL] Python 3 not found. Installing via winget...
  call :WingetInstall Python.Python.3.12
  call :RefreshPath
  call :CheckPython
  if errorlevel 1 (
    echo  [WARNING] Python could not be installed. It is only needed if a
    echo           native module has to compile from source. If npm install
    echo           fails below, install Python from https://python.org
  ) else (
    echo  [OK] Python installed.
  )
) else (
  echo  [OK] Python already installed.
)
echo.

rem ------------------------------------------------------------
rem  npm install  (tries prebuilt binaries first; installs
rem  Visual Studio Build Tools only if a native build fails)
rem ------------------------------------------------------------
echo  ============================================================
echo   Installing npm dependencies...
echo  ============================================================
call npm install
if errorlevel 1 (
  echo.
  echo  [INFO] npm install failed - a native module probably needs a C++
  echo         compiler. Installing Visual Studio Build Tools via winget
  echo         and retrying ^(large download, several minutes^)...
  echo.
  call :WingetInstall Microsoft.VisualStudio.2022.BuildTools "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  call :RefreshPath
  echo.
  echo  [RETRY] npm install...
  call npm install
  if errorlevel 1 (
    echo  [ERROR] npm install failed. See output above.
    echo          Try installing Visual Studio Build Tools manually:
    echo          https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo.
    pause
    exit /b 1
  )
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
  echo  [WARNING] npm run build failed. The dev server still works:
  echo           npm run dev
) else (
  echo  [OK] Build complete -^> dist\
)
echo.

echo  ============================================================
echo   Installation finished
echo  ============================================================
echo.
echo  Next steps:
echo    Desktop app : npm start
echo    Web + bridge: npm run dev   ^(then open http://localhost:3000^)
echo    Silent launch: start.bat
echo.
pause
exit /b 0

rem ============================================================
rem  Helpers
rem ============================================================

:CheckNode
rem Real check: runs node -v. Exit code 0 only if node actually works.
node -v >nul 2>nul
exit /b %errorlevel%

:CheckPython
rem Real check: matches "Python 3.x" output. This filters out the
rem Microsoft Store alias stub, which prints "Python was not found".
python --version 2>nul | findstr /r /c:"Python 3\." >nul
exit /b %errorlevel%

:WingetInstall
rem %1 = package id, %2 = optional --override args.
rem Retries once on transient failures (e.g. 0x80070020 file locked).
rem NOTE: check for ==0, not "errorlevel 1" - winget can return NEGATIVE
rem exit codes like 0x80070020, which "errorlevel 1" treats as success.
set "WI_ARGS="
if not "%~2"=="" set "WI_ARGS=--override %~2"
winget install --id "%~1" -e --accept-source-agreements --accept-package-agreements %WI_ARGS%
if "!errorlevel!"=="0" exit /b 0
echo  [RETRY] First attempt failed ^(exit code !errorlevel!^). Retrying in 3s...
timeout /t 3 /nobreak >nul
winget install --id "%~1" -e --accept-source-agreements --accept-package-agreements %WI_ARGS%
if "!errorlevel!"=="0" exit /b 0
exit /b 1

:RefreshPath
rem Rebuild PATH from the registry so newly installed tools are visible,
rem then add well-known install dirs as a fallback.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"
if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
for /d %%D in ("%LocalAppData%\Programs\Python\Python3*") do set "PATH=%%~fD;%%~fD\Scripts;%PATH%"
exit /b 0
