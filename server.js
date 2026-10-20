// NoniMail Cleaner 3.0 — servidor local de la app (Windows, Android o `node server.js`)
// Servidor HTTP + SSE: configuración, conexión IMAP (Gmail con Google o contraseña de app, u otro proveedor),
// trabajos por lotes de fechas con progreso guardado, reglas por remitente, bajas de listas e IA integrada.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const paths = require('./lib/paths');
const C = require('./lib/config');
const { Secrets } = require('./lib/secrets');
const { compileRules } = require('./lib/classify');
const llm = require('./lib/llm');
const { ProgressStore } = require('./lib/batches');
const { Engine } = require('./lib/engine');
const { readJson, writeJsonAtomic } = require('./lib/jsonfile');
const { MailClient } = require('./lib/mail/imap');
const smtp = require('./lib/mail/smtp');
const oauth = require('./lib/mail/google-oauth');
const { connectionOptions } = require('./lib/mail/account');
const { PRESETS } = require('./lib/mail/presets');
const { LocalRuntime } = require('./lib/runtime');

// ---------- estado persistente ----------
const CONFIG_FILE = paths.file('config.json');
const loaded = C.loadConfig(CONFIG_FILE, path.join(paths.ROOT, 'config.example.json'));
let CFG = loaded.cfg;
let RULES;
try { RULES = compileRules(CFG.heuristics); }
catch (e) { console.error(`Regla inválida en config.json (${e.message}); se ignoran las heurísticas hasta corregirla en "Reglas".`); RULES = compileRules({}); }
const SECRETS = new Secrets(paths.file('secrets.json'));
const TOKENS = new oauth.TokenCache();
const PROGRESS = new ProgressStore(paths.file('progress.json'));

// reglas por remitente: rules email->'delete'|'protect', unsub email->true
const SENDERS_FILE = paths.file('senders.json');
const SENDERS = readJson(SENDERS_FILE, {});
if (!SENDERS.rules) SENDERS.rules = {};
if (!SENDERS.unsub) SENDERS.unsub = {};
const saveSenders = () => writeJsonAtomic(SENDERS_FILE, SENDERS);

// ---------- SSE y logs ----------
const clients = new Set();
function sse(obj) { const data = `data: ${JSON.stringify(obj)}\n\n`; for (const res of clients) { try { res.write(data); } catch (_) {} } }
let logStream = null;
function emit(lane, text, kind) {
  const ev = { t: 'line', lane, text, kind, ts: new Date().toISOString().slice(11, 19) };
  sse(ev);
  if (logStream) { try { logStream.write(`[${ev.ts}][${lane}][${kind}] ${text}\n`); } catch (_) {} }
}

// ---------- métricas CPU/GPU en vivo ----------
let _lastCpu = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
function cpuPercent() {
  const now = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  let idleD = 0, totalD = 0;
  for (let i = 0; i < now.length; i++) { idleD += now[i].idle - _lastCpu[i].idle; totalD += now[i].total - _lastCpu[i].total; }
  _lastCpu = now;
  return totalD > 0 ? Math.round(100 * (1 - idleD / totalD)) : 0;
}
let gpuAvailable = true;
function gpuQuery() {
  if (!gpuAvailable) return Promise.resolve(null);
  return new Promise(res => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err && err.code === 'ENOENT') gpuAvailable = false; // sin GPU NVIDIA: no reintentar
      if (err || !out) return res(null);
      const p = out.trim().split('\n')[0].split(',').map(x => parseInt(x.trim(), 10));
      res({ util: p[0] || 0, vramUsed: p[1] || 0, vramTotal: p[2] || 0 });
    });
  });
}
setInterval(async () => { if (clients.size) sse({ t: 'metrics', cpu: cpuPercent(), gpu: await gpuQuery() }); }, 2500).unref();

// ---------- correo ----------
async function openMail(cfg = CFG, secrets = SECRETS) {
  const conn = await connectionOptions(cfg, secrets, TOKENS);
  return new MailClient(conn.imap, { inboxFolder: cfg.account.inboxFolder, trashFolder: cfg.account.trashFolder }).connect();
}

const engine = new Engine({
  cfg: () => CFG, rules: () => RULES, senderRules: () => SENDERS.rules,
  isUnsubDone: (e) => !!SENDERS.unsub[e], markUnsub: (e) => { SENDERS.unsub[e] = true; saveSenders(); },
  progress: PROGRESS, openMail: () => openMail(),
  smtpOptions: async () => (await connectionOptions(CFG, SECRETS, TOKENS)).smtp,
  emit, sse,
  onRunStart(job) {
    try {
      fs.mkdirSync(paths.file('logs'), { recursive: true });
      logStream = fs.createWriteStream(paths.file(path.join('logs', `${job.kind}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`)), { flags: 'a' });
    } catch (_) { logStream = null; }
  },
  onRunEnd() { if (logStream) { try { logStream.end(); } catch (_) {} logStream = null; } },
});

const runtime = new LocalRuntime({ root: paths.ROOT, dataDir: paths.DATA_DIR, cfg: () => CFG, sse, emit, busy: () => engine.busy() });
llm.useRuntime(runtime);
let listenPort = CFG.port; // el real (Electron/Android pueden pedir uno libre)

// ---------- vistas para la UI (nunca incluyen secretos) ----------
function accountView() {
  const a = CFG.account, s = SECRETS.status();
  const ready = a.type === 'gmail-oauth' ? s.googleConnected && s.hasGoogleClientSecret && !!CFG.google.clientId
    : a.type === 'none' ? false : s.hasImapPassword && (a.type !== 'imap' || !!a.imap.host);
  return { type: a.type, email: a.email, ready, folder: a.inboxFolder };
}
function settingsView() {
  const { heuristics, llmPrompt, ...settings } = CFG;
  return { settings, secrets: SECRETS.status(), presets: PRESETS, accountTypes: C.ACCOUNT_TYPES, redirectUri: redirectUri() };
}
const redirectUri = () => `http://127.0.0.1:${listenPort}/oauth/google/callback`;
function mainView() {
  return {
    model: llm.modelLabel(CFG), provider: CFG.llm.provider, aiReady: llm.configured(CFG),
    cleaning: CFG.cleaning, account: accountView(), platform: process.env.NONIMAIL_PLATFORM || process.platform,
    job: engine.view(), pending: engine.pendingJobs(), migratedFrom: loaded.migratedFrom, created: loaded.created,
  };
}

// borrador de configuración + secretos (para "Probar conexión" sin guardar)
function draftOf(body) {
  const cfg = C.mergeKnown(C.SETTINGS_SHAPE, CFG, body.settings || {});
  const sec = body.secrets || {};
  return { cfg, secrets: { get: (k) => (typeof sec[k] === 'string' && sec[k].trim()) ? sec[k].trim() : SECRETS.get(k) } };
}

async function testConnection(body) {
  const { cfg, secrets } = draftOf(body);
  const out = { mail: null, smtp: null, llm: null };
  let conn = null;
  try { conn = await connectionOptions(cfg, secrets, TOKENS); }
  catch (e) { out.mail = { ok: false, error: e.message }; }
  if (conn) {
    let mc = null;
    try {
      mc = await new MailClient(conn.imap, { inboxFolder: cfg.account.inboxFolder, trashFolder: cfg.account.trashFolder }).connect();
      const i = await mc.info();
      const problems = [];
      if (!i.inbox) problems.push(`no existe la carpeta "${cfg.account.inboxFolder}"`);
      if (!i.trash) problems.push('no se encontró la Papelera (elegila abajo): sin ella no se borra nada');
      if (!i.canMove) problems.push('el servidor no soporta MOVE ni UIDPLUS: no se podrá borrar');
      out.mail = { ok: !problems.length, warning: problems.join('; ') || null, inboxCount: i.inboxCount, inbox: i.inbox, trash: i.trash, sent: i.sent, isGmail: i.isGmail, folders: i.folders.map(f => f.path) };
    } catch (e) { out.mail = { ok: false, error: e.authenticationFailed ? 'usuario o contraseña incorrectos (o falta habilitar IMAP)' : (e.responseText || e.message) }; }
    finally { if (mc) await mc.close().catch(() => {}); }
    out.smtp = conn.smtp ? await smtp.verify(conn.smtp) : { ok: false, error: 'sin servidor SMTP: las bajas por correo no funcionarán' };
  }
  if (llm.isLocal(cfg)) {
    const s = runtime.status();
    out.llm = { ok: s.ready, local: true, model: llm.modelLabel(cfg), error: s.ready ? null : (s.binary ? 'falta descargar el modelo' : 'falta el motor de IA') };
    return out;
  }
  const v = await llm.version(cfg.ollamaUrl);
  if (!v.ok) out.llm = { ok: false, error: v.error };
  else {
    const m = await llm.listModels(cfg.ollamaUrl);
    const installed = m.models.includes(cfg.model);
    out.llm = { ok: installed, version: v.version, error: installed ? null : (cfg.model ? `el modelo "${cfg.model}" no está instalado (ollama pull ${cfg.model})` : 'elegí un modelo') };
  }
  return out;
}

// ---------- OAuth de Google ----------
const PENDING_OAUTH = new Map(); // state → { verifier, clientId, clientSecret, at }
function oauthPage(ok, msg) {
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>NoniMail · Google</title>
<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:grid;place-items:center;height:100vh;margin:0}div{max-width:460px;padding:24px;border:1px solid #30363d;border-radius:10px;background:#161b22}h1{font-size:18px;color:${ok ? '#3fb950' : '#f85149'}}</style></head>
<body><div><h1>${ok ? '✓ Cuenta conectada' : '✗ No se pudo conectar'}</h1><p>${esc(msg)}</p><p>Podés cerrar esta pestaña y volver a NoniMail.</p></div><script>setTimeout(()=>window.close(),2500)</script></body></html>`;
}

// ---------- HTTP ----------
function readBody(req, limit = 1e6) {
  return new Promise((res, rej) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > limit) { rej(new Error('cuerpo demasiado grande')); req.destroy(); } });
    req.on('end', () => res(b)); req.on('error', rej);
  });
}
// Solo esta PC: Host local (contra DNS rebinding) y, en POST, JSON del mismo origen (contra CSRF)
function allowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const okHosts = [`127.0.0.1:${listenPort}`, `localhost:${listenPort}`, `[::1]:${listenPort}`];
  if (!okHosts.includes(host)) return 'host no permitido';
  if (req.method === 'POST') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return 'se requiere Content-Type: application/json';
    const origin = req.headers.origin;
    if (origin && !okHosts.map(h => `http://${h}`).includes(origin.toLowerCase())) return 'origen no permitido';
  }
  return null;
}

// La app de Windows y la de Android ponen un token secreto por arranque (NONIMAIL_TOKEN) y la ventana lo
// manda como cookie. Sin él, cualquier otra app del celular (o de la PC) podría usar la API por 127.0.0.1:
// el chequeo de Host/Origin solo frena a páginas web. `npm start` en el navegador no lo usa.
function authorized(req, pathname) {
  const token = process.env.NONIMAIL_TOKEN;
  if (!token) return true;
  if (req.method === 'GET' && pathname === '/oauth/google/callback') return true; // lo abre el navegador externo; lo protege `state`
  const m = /(?:^|;\s*)noni=([0-9a-f]+)/.exec(String(req.headers.cookie || ''));
  const got = String(req.headers['x-noni-token'] || (m && m[1]) || '');
  return got.length === token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const deny = allowed(req);
  if (deny) return json(403, { error: deny });
  if (!authorized(req, u.pathname)) return json(401, { error: 'no autorizado' });
  let body = {};
  if (req.method === 'POST') { try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { return json(400, { error: 'JSON inválido' }); } }
  const route = `${req.method} ${u.pathname}`;
  try {
    switch (route) {
      case 'GET /': case 'GET /index.html':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(paths.ROOT, 'public', 'index.html')));

      // ----- IA integrada -----
      case 'GET /api/runtime': return json(200, runtime.status());
      case 'POST /api/runtime/download': return json(200, runtime.download(body.id));
      case 'POST /api/runtime/cancel': runtime.cancelDownload(); return json(200, runtime.status());
      case 'POST /api/runtime/remove': return json(200, runtime.removeModel(body.id));
      case 'POST /api/runtime/use': {
        if (engine.busy()) return json(409, { error: 'Hay un trabajo corriendo' });
        const provider = body.provider === 'ollama' ? 'ollama' : 'local';
        const next = JSON.parse(JSON.stringify(CFG));
        next.llm.provider = provider;
        if (typeof body.id === 'string') next.local.model = body.id;
        if (typeof body.model === 'string') next.model = body.model;
        C.saveConfig(CONFIG_FILE, next); CFG = next;
        runtime.stop();
        sse({ t: 'config', config: mainView() });
        return json(200, { ok: true, runtime: runtime.status(), view: mainView() });
      }
      case 'GET /api/stream':
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n'); clients.add(res);
        res.write(`data: ${JSON.stringify({ t: 'progress', job: engine.view() })}\n\n`);
        req.on('close', () => clients.delete(res));
        return;

      // ----- principal -----
      case 'GET /api/config': return json(200, mainView());
      case 'GET /api/senders': return json(200, { senders: engine.scanSenders(), daysBack: engine.lastScan ? engine.lastScan.daysBack : null });
      case 'POST /api/scan': return json(200, engine.start('scan', body));
      case 'POST /api/autorun': return json(200, engine.start('auto', body));
      case 'POST /api/execute': return json(200, engine.start('execute', body));
      case 'POST /api/stop': engine.stop(); return json(200, { ok: true });
      case 'GET /api/jobs': return json(200, { current: engine.view(), pending: engine.pendingJobs() });
      case 'POST /api/jobs/resume': {
        const saved = PROGRESS.get(body.key);
        if (!saved) return json(404, { error: 'No hay un trabajo para continuar' });
        return json(200, engine.start(saved.kind, { resume: true, key: saved.key }));
      }
      case 'POST /api/jobs/discard': engine.discard(body.key); return json(200, { ok: true, pending: engine.pendingJobs() });
      case 'POST /api/sender-rule': {
        const email = String(body.email || '').trim().toLowerCase(), rule = body.rule;
        if (!email) return json(400, { error: 'falta email' });
        if (rule === 'none' || rule == null) delete SENDERS.rules[email];
        else if (['delete', 'protect'].includes(rule)) SENDERS.rules[email] = rule;
        else return json(400, { error: 'regla inválida' });
        saveSenders();
        return json(200, { ok: true, email, rule: SENDERS.rules[email] || null, protected: rule === 'protect' });
      }
      case 'POST /api/unsubscribe': {
        const email = String(body.email || '').trim().toLowerCase();
        if (!email) return json(400, { error: 'falta email' });
        emit('sys', `Dando de baja ${email}…`, 'info');
        const r = await engine.unsubscribeSender(email);
        emit('sys', r.ok ? `Baja OK (${r.method}): ${email}` : `Baja no posible (${email}): ${r.error}`, r.ok ? 'info' : 'warn');
        return json(r.ok ? 200 : 400, r);
      }

      // ----- reglas (heurísticas + prompt) -----
      case 'GET /api/rules': {
        const promptTemplate = llm.buildPrompt(CFG.llmPrompt, { from: '{remitente}', subjects: ['{asuntos del remitente}'], bulk: true, body: `{cuerpo, máx. ${CFG.cleaning.bodyMaxChars} caracteres}` });
        return json(200, { model: llm.modelLabel(CFG), ...CFG.heuristics, llmPrompt: CFG.llmPrompt, promptTemplate });
      }
      case 'POST /api/rules': {
        if (engine.busy()) return json(409, { error: 'No se puede editar mientras corre un trabajo' });
        const h = { ...CFG.heuristics };
        for (const f of ['keepOverride', 'subject', 'from', 'body']) if (typeof body[f] === 'string') h[f] = body[f].trim();
        let rules; try { rules = compileRules(h); } catch (e) { return json(400, { error: `Regla inválida: ${e.message}` }); }
        CFG.heuristics = h; RULES = rules;
        if (typeof body.llmPrompt === 'string' && body.llmPrompt.trim()) CFG.llmPrompt = body.llmPrompt.trim();
        C.saveConfig(CONFIG_FILE, CFG);
        emit('sys', 'Reglas actualizadas', 'info');
        return json(200, { ok: true });
      }

      // ----- configuración -----
      case 'GET /api/settings': return json(200, settingsView());
      case 'POST /api/settings': {
        if (engine.busy()) return json(409, { error: 'No se puede cambiar la configuración mientras corre un trabajo' });
        const next = C.mergeKnown(C.SETTINGS_SHAPE, CFG, body.settings || {});
        const errors = C.validate(next);
        if (errors.length) return json(400, { error: errors.join(' · '), errors });
        const restartNeeded = next.port !== CFG.port || next.host !== CFG.host;
        const accountChanged = JSON.stringify(next.account) !== JSON.stringify(CFG.account) || next.google.clientId !== CFG.google.clientId;
        C.saveConfig(CONFIG_FILE, next);
        CFG = next;
        if (body.secrets) SECRETS.set(body.secrets);
        if (accountChanged) TOKENS.clear();
        sse({ t: 'config', config: mainView() });
        emit('sys', 'Configuración guardada' + (restartNeeded ? ' — reiniciá la app para usar el puerto nuevo' : ''), 'info');
        return json(200, { ok: true, restartNeeded, view: settingsView() });
      }
      case 'POST /api/settings/test': return json(200, await testConnection(body));
      case 'GET /api/llm/models': return json(200, await llm.listModels(u.searchParams.get('url') || CFG.ollamaUrl));
      case 'POST /api/llm/test': {
        const cfg = { ...CFG, ollamaUrl: body.ollamaUrl || CFG.ollamaUrl, model: body.model || CFG.model, llm: { ...CFG.llm } };
        if (typeof body.think === 'boolean') cfg.llm.think = body.think;
        const tp = parseInt(body.thinkNumPredict, 10);
        if (tp >= 64 && tp <= 32768) cfg.llm.thinkNumPredict = tp;
        if (typeof body.provider === 'string') cfg.llm.provider = body.provider === 'ollama' ? 'ollama' : 'local';
        if (!llm.isLocal(cfg) && !cfg.model) return json(400, { error: 'Elegí un modelo' });
        return json(200, await llm.testModel(cfg));
      }

      // ----- Google -----
      case 'POST /api/oauth/google/start': {
        const clientId = String(body.clientId || CFG.google.clientId || '').trim();
        const clientSecret = String(body.clientSecret || '').trim() || SECRETS.get('googleClientSecret');
        if (!clientId || !clientSecret) return json(400, { error: 'Poné el Client ID y el Client Secret de tu cliente de Google' });
        for (const [k, v] of PENDING_OAUTH) if (Date.now() - v.at > 15 * 60000) PENDING_OAUTH.delete(k);
        const state = crypto.randomBytes(16).toString('hex');
        const { verifier, challenge } = oauth.createPkce();
        PENDING_OAUTH.set(state, { verifier, clientId, clientSecret, at: Date.now() });
        return json(200, { authUrl: oauth.buildAuthUrl({ clientId, redirectUri: redirectUri(), state, challenge, loginHint: body.email || undefined }) });
      }
      case 'GET /oauth/google/callback': {
        const send = (code, ok, msg) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(oauthPage(ok, msg)); };
        const p = PENDING_OAUTH.get(u.searchParams.get('state') || '');
        if (!p) return send(400, false, 'La solicitud expiró o no la inició esta app. Volvé a tocar "Conectar con Google".');
        PENDING_OAUTH.delete(u.searchParams.get('state'));
        if (u.searchParams.get('error')) return send(400, false, `Google respondió: ${u.searchParams.get('error')}`);
        if (engine.busy()) return send(409, false, 'Hay un trabajo corriendo; esperá a que termine y volvé a conectar.');
        try {
          const t = await oauth.exchangeCode({ clientId: p.clientId, clientSecret: p.clientSecret, code: u.searchParams.get('code'), verifier: p.verifier, redirectUri: redirectUri() });
          const next = JSON.parse(JSON.stringify(CFG));
          next.google.clientId = p.clientId; next.account.type = 'gmail-oauth'; next.account.email = t.email || next.account.email;
          C.saveConfig(CONFIG_FILE, next); CFG = next;
          SECRETS.set({ googleClientSecret: p.clientSecret, googleRefreshToken: t.refreshToken });
          TOKENS.clear(); TOKENS.seed(t.refreshToken, t.accessToken, t.expiresAt);
          sse({ t: 'config', config: mainView() });
          emit('sys', `Cuenta de Google conectada: ${t.email}`, 'info');
          return send(200, true, `Conectado como ${t.email}.`);
        } catch (e) { return send(400, false, e.message); }
      }
      case 'POST /api/oauth/google/disconnect': {
        if (engine.busy()) return json(409, { error: 'Hay un trabajo corriendo' });
        const rt = SECRETS.get('googleRefreshToken');
        if (rt) await oauth.revoke(rt);
        SECRETS.set({ googleRefreshToken: null }); TOKENS.clear();
        sse({ t: 'config', config: mainView() });
        return json(200, { ok: true, view: settingsView() });
      }
    }
    if (req.method === 'GET' && u.pathname.startsWith('/assets/')) return serveAsset(u.pathname, res);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    return json(e.code && Number.isInteger(e.code) ? e.code : 500, { error: e.message });
  }
});

// archivos de public/assets (íconos, fuentes): solo lectura y sin salir de la carpeta
const TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveAsset(pathname, res) {
  const dir = path.join(paths.ROOT, 'public', 'assets');
  const f = path.normalize(path.join(dir, decodeURIComponent(pathname.slice('/assets/'.length))));
  if (!f.startsWith(dir + path.sep) || !TYPES[path.extname(f)] || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  // css/js sin caché: una actualización de la app se ve al instante; fuentes e íconos sí se guardan
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)], 'Cache-Control': /\.(css|js)$/.test(f) ? 'no-cache' : 'max-age=86400' });
  fs.createReadStream(f).pipe(res);
}

// Arranca el servidor. port 0 = uno libre (la app de escritorio y la de Android lo usan así).
function start({ port = CFG.port, host = CFG.host } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      listenPort = server.address().port;
      console.log(`NoniMail Limpieza en http://localhost:${listenPort}`);
      if (loaded.created) console.log('Se creó config.json: abrí Ajustes para conectar tu correo.');
      if (loaded.migratedFrom) console.log(`Configuración 1.x migrada (el puente de Apps Script ya no se usa). Respaldo: ${loaded.migratedFrom}`);
      resolve({ port: listenPort, url: `http://127.0.0.1:${listenPort}`, close });
    });
  });
}
function close() { runtime.stop(); engine.stop(); return new Promise(r => server.close(() => r())); }

module.exports = { start, close, runtime, engine };
if (require.main === module) {
  const p = process.env.NONIMAIL_PORT;
  start(p != null && p !== '' ? { port: +p } : {}).catch(e => { console.error(`No se pudo abrir el puerto: ${e.message}`); process.exit(1); });
}
