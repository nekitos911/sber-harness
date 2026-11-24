@echo off
rem Harness in its own window (Desktop shortcut). Close the window to stop what it started.
rem Nothing has to be installed by hand: a half-finished node_modules is put right, whatever is really missing is
rem installed, and an unbuilt UI is built - all by itself. The starting console closes on its own, because the app
rem itself is the window. Run without arguments to hide the console, or pass `--console` to watch what happens.
setlocal
cd /d "%~dp0"

if /i "%~1"=="--run" goto :run
if /i "%~1"=="--console" goto :console
rem relaunch hidden: the console a double-click opened goes away, and the app keeps running without one
call "scripts\start-hidden.cmd"
exit /b 0

:run
rem the console here is the hidden one the relaunch gave us: nobody reads it, so everything goes to the log - the
rem install and build steps too, which are the ones that fail on a new machine
set "HARNESS_CONSOLE="
set "HARNESS_LOG=%TEMP%\sber-harness-desktop.log"
rem a window that is still open holds its log: a second start must not die on the redirect, it writes another one
(type nul >"%HARNESS_LOG%") 2>nul || set "HARNESS_LOG=%TEMP%\sber-harness-desktop-%RANDOM%.log"
call :prepare >"%HARNESS_LOG%" 2>&1
if not errorlevel 1 exit /b 0
rem a start that failed before any window: the end of the log, where it says why, in a message box
powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show(((Get-Content -Encoding UTF8 -Tail 15 -LiteralPath $env:HARNESS_LOG) -join [char]10) + [char]10 + [char]10 + $env:HARNESS_LOG, 'sber-harness')"
exit /b 1

:console
set "HARNESS_CONSOLE=1"
chcp 65001 >nul
call :prepare
exit /b %errorlevel%

:prepare
where node >nul 2>nul
if errorlevel 1 goto :node-missing

rem repairs what a killed install leaves behind: node_modules\.bin, the Electron package, a half-downloaded binary
node scripts\ensure-bin.js
if not exist "node_modules\.bin\vite.cmd" goto :install
node -e "require('electron')" >nul 2>nul
if errorlevel 1 goto :install
goto :build

:install
echo Ставлю зависимости...
call npm install --no-audit --no-fund
if errorlevel 1 goto :error
rem npm keeps an installed package as it is: an Electron binary an earlier download lost is fetched here
node -e "require('electron')" >nul 2>nul
if errorlevel 1 node node_modules\electron\install.js
if errorlevel 1 goto :error

:build
if exist "web\dist\index.html" goto :desktop
echo Собираю интерфейс...
node scripts\ensure-bin.js
if exist "node_modules\.bin\vite.cmd" goto :vite
rem npm's `vite build` needs the shim npm itself puts in .bin, so the build is asked of npm in that case
call npm run build
if errorlevel 1 goto :error
goto :desktop

:vite
call "node_modules\.bin\vite.cmd" build
if errorlevel 1 goto :error

:desktop
node scripts\desktop.js --ui
exit /b %errorlevel%

:node-missing
echo Не найден Node.js 22 или новее - без него харнес не запустить.
echo Установите его с https://nodejs.org и запустите ярлык снова.
if defined HARNESS_CONSOLE pause
exit /b 1

:error
echo Не удалось подготовить запуск: смотрите сообщения выше.
if defined HARNESS_CONSOLE pause
exit /b 1
