'use strict';
// NoniMail Cleaner para Windows: el servidor corre dentro de la app (sin consola ni navegador aparte)
// y la ventana muestra la interfaz. Los datos van a %APPDATA%\NoniMail Cleaner.
const { app, BrowserWindow, shell, Menu, ipcMain, dialog, nativeTheme, session } = require('electron');
const path = require('path');
const crypto = require('crypto');

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.setAppUserModelId('com.nonosky.nonimail');
process.env.NONIMAIL_DATA_DIR = app.getPath('userData');
process.env.NONIMAIL_PLATFORM = 'windows';
// token por arranque: solo esta ventana puede usar el servidor local (ver authorized() en server.js)
const TOKEN = crypto.randomBytes(32).toString('hex');
process.env.NONIMAIL_TOKEN = TOKEN;

let win = null, srv = null, server = null, quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 380, minHeight: 560,
    title: 'NoniMail Cleaner', icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0A1020' : '#F8FAFC',
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  // todo lo que no es la app se abre en el navegador del sistema (Google, contraseñas de app)
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(srv.url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (quitting || !server.engine.busy()) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Seguir trabajando', 'Cerrar'], defaultId: 0, cancelId: 0,
      title: 'NoniMail Cleaner', message: 'Hay una limpieza en curso', detail: 'El avance queda guardado y podrás continuar después.',
    });
    if (r === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  win.loadURL(srv.url);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    server = require('../server');
    srv = await server.start({ port: 0 });
    await session.defaultSession.cookies.set({ url: srv.url, name: 'noni', value: TOKEN, httpOnly: true, sameSite: 'strict' });
  } catch (e) {
    dialog.showErrorBox('NoniMail Cleaner', `No se pudo iniciar: ${e.message}`);
    app.quit(); return;
  }
  createWindow();
});

ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//i.test(String(url))) shell.openExternal(String(url)); });
ipcMain.on('progress', (_e, busy, pct) => { if (win) win.setProgressBar(busy ? Math.max(0.01, Math.min(1, pct / 100)) : -1); });

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { quitting = true; if (server) server.close(); });
app.on('window-all-closed', () => app.quit());
