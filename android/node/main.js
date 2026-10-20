'use strict';
// Entrada de Node.js en Android (nodejs-mobile). La lanza NodeService:
//   node main.js <carpeta-de-datos> <puerto> <carpeta-de-bibliotecas-nativas> <token>
const path = require('path');
const http = require('http');
const [dataDir, port, libDir, token] = process.argv.slice(2);
// sin el token, otra app del celular podría usar el servidor por 127.0.0.1 (ver authorized() en server.js)
process.env.NONIMAIL_TOKEN = token;
process.env.NONIMAIL_DATA_DIR = dataDir;
process.env.NONIMAIL_PLATFORM = 'android';
// llama-server viaja dentro del APK como libllama-server.so; sus bibliotecas están en la misma carpeta
process.env.NONIMAIL_LLAMA_BIN = path.join(libDir, 'libllama-server.so');
process.env.LD_LIBRARY_PATH = libDir;
require('fs').mkdirSync(dataDir, { recursive: true });

// Si Node se cierra, se cierra la app entera: ante un error se muestra en pantalla y el proceso sigue vivo.
function showError(e) {
  console.error(`NoniMail no arrancó: ${e && e.stack || e}`);
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:24px">
<h2>NoniMail no pudo iniciar</h2><pre style="white-space:pre-wrap;font-size:12px">${esc(e && e.stack || e)}</pre></body>`;
  http.createServer((q, r) => { r.writeHead(q.url === '/api/config' ? 200 : 500, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(page); }).listen(+port, '127.0.0.1');
}
process.on('uncaughtException', (e) => console.error(`error no controlado: ${e && e.stack || e}`));
try {
  require('./server').start({ port: +port }).catch(showError);
} catch (e) { showError(e); }
