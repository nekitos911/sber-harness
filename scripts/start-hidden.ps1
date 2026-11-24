# Relaunches the harness launcher in a hidden window, so a double-click on the shortcut leaves no console behind.
# The launcher's own path arrives as an argument: in -Command text the path is pasted in after a $variable, and a drive
# letter's «:» turns the whole reference invalid.
param([Parameter(Mandatory = $true)][string]$Launcher)

# the launcher sits in the repository root (it arrives as scripts\..\start-harness.cmd): its folder is where it runs from
$Launcher = (Resolve-Path -LiteralPath $Launcher).Path
$root = Split-Path -Parent $Launcher
# a .cmd is not a process CreateProcess can start on its own: cmd runs it, with its own quoting for a path with spaces
# Nothing waits for it: the copy runs as long as the window is open, and a failed start shows its own message box.
Start-Process -WindowStyle Hidden -FilePath $env:ComSpec -ArgumentList '/d', '/c', "`"`"$Launcher`" --run`"" -WorkingDirectory $root
