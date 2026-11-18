// The system's own «choose a folder» window, opened by the harness on the person's machine (the browser never gives a
// folder's path). Windows: the Explorer dialog (IFileOpenDialog, FOS_PICKFOLDERS) through Windows PowerShell; macOS:
// osascript; Linux: zenity. → the chosen path, null when cancelled; throws { status: 501 } when there is no such window.
import { spawn } from 'node:child_process';

// C#: only the vtable slots up to GetResult / GetDisplayName are declared in order (the others are never called)
const WIN = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HarnessFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi); void SetFolder(IShellItem psi); void GetFolder(); void GetCurrentSelection();
    void SetFileName(); void GetFileName(); void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel(); void SetFileNameLabel(); void GetResult(out IShellItem psi);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem { void BindToHandler(); void GetParent(); void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name); }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
  public static string Pick(string title, string initial, IntPtr owner) {
    var d = (IFileOpenDialog)new FileOpenDialog();
    uint o; d.GetOptions(out o); d.SetOptions(o | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    d.SetTitle(title);
    if (!String.IsNullOrEmpty(initial)) { try { IShellItem f; SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out f); d.SetFolder(f); } catch {} }
    if (d.Show(owner) != 0) return null;
    IShellItem r; d.GetResult(out r); string p; r.GetDisplayName(0x80058000, out p); return p; // SIGDN_FILESYSPATH
  }
}
'@
# an invisible topmost owner: the window opens in front of the browser, not behind it
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }
$owner.Show()
$p = [HarnessFolderPicker]::Pick($env:HARNESS_PICK_TITLE, $env:HARNESS_PICK_INITIAL, $owner.Handle)
$owner.Close()
if ($p) { [Console]::Out.Write($p) }
`;

function command(title, initial) {
  if (process.platform === 'win32') return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', WIN]];
  if (process.platform === 'darwin') {
    const at = initial ? ` default location (POSIX file ${JSON.stringify(initial)})` : '';
    return ['osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(title)}${at})`]];
  }
  return ['zenity', ['--file-selection', '--directory', `--title=${title}`, ...(initial ? [`--filename=${initial.replace(/\/?$/, '/')}`] : [])]];
}

let open = null; // one window at a time

export function pickFolder({ title = 'Выбор папки', initial = null } = {}) {
  if (open) return Promise.reject(Object.assign(new Error('окно выбора папки уже открыто'), { status: 409 }));
  const [exe, args] = command(title, initial);
  open = new Promise((resolve, reject) => {
    // shell: false; title and folder go through the environment, never into the script text
    const p = spawn(exe, args, { shell: false, windowsHide: true, env: { ...process.env, HARNESS_PICK_TITLE: title, HARNESS_PICK_INITIAL: initial || '' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(Object.assign(new Error(`на этом компьютере нет системного окна выбора папки (${e.code || e.message})`), { status: 501 })));
    p.on('close', (code) => {
      const t = out.trim();
      const path = t.length > 1 && t.endsWith('/') ? t.slice(0, -1) : t; // osascript ends a folder with «/»
      if (path) return resolve(path);
      // cancelled: osascript says so with code 1 («User canceled»), zenity with 1, Windows prints nothing
      if (code === 0 || /cancel/i.test(err) || code === 1) return resolve(null);
      reject(Object.assign(new Error(`окно выбора папки не открылось: ${err.trim().split('\n').slice(-2).join(' ') || `код ${code}`}`), { status: 501 }));
    });
  }).finally(() => { open = null; });
  return open;
}
