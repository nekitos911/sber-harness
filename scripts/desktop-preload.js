// The window has no native title bar, so the page draws the buttons itself. This preload is the only channel it has:
// no Node, no file system — just the three window actions and the current maximised state.
const { contextBridge, ipcRenderer } = require('electron');

const maximized = () => {
  let value = false;
  try {
    value = ipcRenderer.sendSync('desktop:maximized') === true;
  } catch {}
  return value;
};

contextBridge.exposeInMainWorld('harnessDesktop', {
  platform: process.platform,
  maximizable: process.platform !== 'darwin', // macOS keeps its own traffic lights at the left
  closable: process.platform !== 'darwin',
  maximized: maximized(),
  minimize: () => ipcRenderer.send('desktop:minimize'),
  toggleMaximize: () => ipcRenderer.send('desktop:toggle-maximize'),
  close: () => ipcRenderer.send('desktop:close'),
  // a double click on the title bar maximises the window, as a system one does
  doubleClick: () => ipcRenderer.send('desktop:double-click'),
  // the shell says when the window became maximised, so the button shows the right icon
  onMaximized: (fn) => {
    const listener = (_event, value) => fn(Boolean(value));
    ipcRenderer.on('desktop:maximized-changed', listener);
    return () => ipcRenderer.removeListener('desktop:maximized-changed', listener);
  },
});
