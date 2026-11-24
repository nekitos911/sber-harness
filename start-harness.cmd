@echo off
rem Harness in its own window (Desktop shortcut). Close the window to stop what it started.
rem Nothing has to be installed by hand: a half-finished node_modules is put right, whatever is really missing is
rem installed, and an unbuilt UI is built - all by itself. The starting console closes on its own, because the app
rem itself is the window. Run without arguments to hide the console, or pass `--console` to watch what happens.
setlocal
cd /d "%~dp0"

if /i "%~1"=="--run" goto :run
rem relaunch hidden: the console a double-click opened goes away, and the app keeps running without one
call "scripts\start-hidden.cmd"
exit /b 0

:run
rem the console here is the hidden one the relaunch gave us: nothing shows, so prepare quietly and say why only in the log
set "HARNESS_CONSOLE="

where node >nul 2>nul
if errorlevel 1 goto :node-missing

rem repairs what a killed install leaves behind: node_modules\.bin, the Electron package, a half-downloaded binary
node scripts\ensure-bin.js
if not exist "node_modules\.bin\vite.cmd" goto :install
node -e "require('electron')" >nul 2>nul
if errorlevel 1 goto :install
goto :build

:install
if defined HARNESS_CONSOLE echo Ставлю зависимости...
call npm install --no-audit --no-fund
if errorlevel 1 goto :error

:build
if exist "web\dist\index.html" goto :desktop

:build-ui
if defined HARNESS_CONSOLE echo Собираю интерфейс...
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
if not defined HARNESS_CONSOLE goto :desktop-quiet
rem a console is there to read: keep what the shell prints (a start that fails has to say why)
node scripts\desktop.js --ui
exit /b %errorlevel%

:desktop-quiet
rem started hidden: stdout has nowhere to go (the window is still there), stderr goes to a file that also catches a crash
set "HARNESS_LOG=%TEMP%\sber-harness-desktop.log"
node scripts\desktop.js --ui >nul 2>"%HARNESS_LOG%"
exit /b %errorlevel%

:node-missing
if defined HARNESS_CONSOLE echo Не найден Node.js 22 или новее - без него харнес не запустить.
if defined HARNESS_CONSOLE echo Установите его с https://nodejs.org и запустите ярлык снова.
if defined HARNESS_CONSOLE pause
exit /b 1

:error
if defined HARNESS_CONSOLE echo Не удалось подготовить запуск: смотрите сообщения выше.
if defined HARNESS_CONSOLE pause
exit /b 1
