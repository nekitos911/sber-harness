# Relaunches the harness launcher in a hidden window, so a double-click on the shortcut leaves no console behind.
# The launcher's own path arrives as an argument: in -Command text the path is pasted in after a $variable, and a drive
# letter's «:» turns the whole reference invalid.
param([Parameter(Mandatory = $true)][string]$Launcher)

# one folder up is the repository root, the folder the shortcut's launcher is meant to run from
$root = Split-Path -Parent (Split-Path -Parent $Launcher)
# a .cmd is not a process CreateProcess can start on its own: cmd runs it, with its own quoting for a path with spaces
$relaunch = Start-Process -WindowStyle Hidden -PassThru -FilePath $env:ComSpec -ArgumentList '/d', '/c', "`"`"$Launcher`" --run`"" -WorkingDirectory $root

# Start-Process answers as soon as the copy is started, the copy returns as soon as the server is up (or has failed).
# A failure exit is the only answer the caller can still see: the console was hidden, and no window was opened
try {
  $exited = $relaunch.WaitForExit(120000)
} catch {
  exit 1
}
if (-not $exited) { exit 0 }
if ($relaunch.ExitCode -ne 0) { exit 1 }
exit 0
