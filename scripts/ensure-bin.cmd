@echo off
rem Rebuild node_modules\.bin from the installed packages. `npm install` creates that folder, but it goes missing in
rem practice (a copy that skipped dot-paths, an interrupted install) and then every `npm run` fails with
rem «'vite' is not recognized». Each file made here is npm's own shim shape: it hands the package's script to node.
setlocal
cd /d "%~dp0"

if not exist "node_modules\vite\bin\vite.js" exit /b 0
if exist "node_modules\.bin\vite.cmd" if exist "node_modules\.bin\vite" exit /b 0

echo Восстанавливаю node_modules\.bin...
mkdir "node_modules\.bin" 2>nul

call :link vite vite bin/vite.js
call :link electron electron cli.js
call :link install-electron electron install.js
call :link tsc typescript bin/tsc
exit /b 0

:link
rem %1 = executable name, %2 = package folder, %3 = script inside the package
if not exist "node_modules\%2\%3" exit /b 0
set "TARGET=..\%2\%3"
>"node_modules\.bin\%1.cmd" echo @ECHO off
>>"node_modules\.bin\%1.cmd" echo GOTO start
>>"node_modules\.bin\%1.cmd" echo :find_dp0
>>"node_modules\.bin\%1.cmd" echo SET dp0=%%~dp0
>>"node_modules\.bin\%1.cmd" echo EXIT /b
>>"node_modules\.bin\%1.cmd" echo :start
>>"node_modules\.bin\%1.cmd" echo SETLOCAL
>>"node_modules\.bin\%1.cmd" echo CALL :find_dp0
>>"node_modules\.bin\%1.cmd" echo.
>>"node_modules\.bin\%1.cmd" echo IF EXIST "%%dp0%%\node.exe" ^(
>>"node_modules\.bin\%1.cmd" echo   SET "_prog=%%dp0%%\node.exe"
>>"node_modules\.bin\%1.cmd" echo ^) ELSE ^(
>>"node_modules\.bin\%1.cmd" echo   SET "_prog=node"
>>"node_modules\.bin\%1.cmd" echo   SET PATHEXT=%%PATHEXT:;.JS;=;%%
>>"node_modules\.bin\%1.cmd" echo ^)
>>"node_modules\.bin\%1.cmd" echo.
>>"node_modules\.bin\%1.cmd" echo endLocal ^& goto #_undefined_# 2^>NUL ^|^| title %%COMSPEC%% ^& "%%_prog%%"  "%%dp0%%\%TARGET%" %%*
>"node_modules\.bin\%1" echo #!/bin/sh
>>"node_modules\.bin\%1" echo basedir=$^(dirname "$^(echo "$0" ^| sed -e 's#\\#/#g'^)"^)
>>"node_modules\.bin\%1" echo exec node "$basedir/%TARGET%" "$@"
exit /b 0
