'use strict';
// Puente mínimo entre la interfaz y Windows: abrir enlaces en el navegador y progreso en la barra de tareas.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('NoniBridge', {
  openExternal: (url) => ipcRenderer.send('open-external', String(url)),
  progress: (busy, pct) => ipcRenderer.send('progress', !!busy, Number(pct) || 0),
});
