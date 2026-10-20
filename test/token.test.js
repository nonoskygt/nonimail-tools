'use strict';
// Con NONIMAIL_TOKEN (apps de Windows y Android) el servidor rechaza a quien no lo traiga: otras apps del equipo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const TOKEN = 'ab'.repeat(32);
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let dir, port, proc, out = '';

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-tok-'));
  port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port }));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, NONIMAIL_DATA_DIR: dir, NONIMAIL_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  for (let i = 0; i < 100 && !out.includes('NoniMail Limpieza en'); i++) await new Promise(r => setTimeout(r, 50));
  assert.match(out, /NoniMail Limpieza en/);
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('sin token: la interfaz, la API y los archivos responden 401', async () => {
  for (const p of ['/', '/api/config', '/api/stream', '/assets/app.js']) assert.equal(await get(p), 401, p);
  assert.equal(await get('/api/config', { 'X-Noni-Token': 'cd'.repeat(32) }), 401, 'token equivocado');
  assert.equal(await get('/api/config', { Cookie: `noni=${TOKEN.slice(0, 10)}` }), 401, 'token incompleto');
});

test('con el token por cabecera o por cookie, responde', async () => {
  assert.equal(await get('/api/config', { 'X-Noni-Token': TOKEN }), 200);
  assert.equal(await get('/', { Cookie: `otra=1; noni=${TOKEN}` }), 200);
  assert.equal(await get('/assets/app.js', { Cookie: `noni=${TOKEN}` }), 200);
});

test('el regreso de Google (navegador externo, sin cookie) llega al servidor y lo valida el state', async () => {
  assert.equal(await get('/oauth/google/callback?state=inventado&code=x'), 400);
});
