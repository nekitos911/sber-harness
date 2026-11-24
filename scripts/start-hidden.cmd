@echo off
rem Relaunch this file hidden and without noise. `Start-Process` cannot hide the console of a .cmd, so a PowerShell child
rem started with its own hidden window runs the launcher: nothing appears on screen, the app window is all there is.
setlocal
rem cwd stays the repository root: the launcher resolves its own folders from it, and %~dp0 keeps naming this folder
set "HARNESS_QUIET=1"
rem the script is a file, not -Command text: cmd pastes the path in as-is, and a drive letter's «:» after «$q» breaks the
rem PowerShell variable reference ($qC:\…), which used to fail the whole relaunch while the launcher reported success
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0start-hidden.ps1" -Launcher "%~dp0..\start-harness.cmd"
exit /b 0
