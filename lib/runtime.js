'use strict';
// IA integrada: descarga el modelo GGUF y mantiene un llama-server local (sin Ollama).
// El proceso arranca al primer uso y se apaga solo tras unos minutos sin trabajo, para liberar RAM.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { MODELS, byId, recommend } = require('./models');

const GB = 1024 ** 3;
const IDLE_MS = 10 * 60000;
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const binName = () => (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
function findBinary(root) {
  const cands = [
    process.env.NONIMAIL_LLAMA_BIN,
    process.resourcesPath && path.join(process.resourcesPath, 'llama', binName()),
    path.join(root, 'vendor', 'llama', `${process.platform}-${process.arch}`, binName()),
  ].filter(Boolean);
  return cands.find(p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
}

// GET con redirecciones (Hugging Face redirige a su CDN)
function get(url, headers, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'NoniMail', ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops > 8) return reject(new Error('demasiadas redirecciones'));
        return resolve(get(new URL(res.headers.location, url).toString(), headers, hops + 1));
      }
      resolve({ res, req });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('el servidor de descarga no responde')));
  });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h)).on('error', reject);
  });
}

class LocalRuntime {
  // o: { root, dataDir, cfg(), sse(obj), emit(lane, text, kind) }
  constructor(o) {
    Object.assign(this, o);
    this.dir = path.join(this.dataDir, 'models');
    this.dl = null;          // { id, done, total, bps, error }
    this.proc = null; this.url = null; this.procModel = null;
    this.state = 'stopped'; this.error = null; this.starting = null; this.idleTimer = null; this.log = [];
    this.pidFile = path.join(this.dataDir, 'llama.pid');
    this._killStale();
    process.once('exit', () => { try { this.proc && this.proc.kill(); } catch (_) {} });
  }

  // si la app se cerró de golpe, su llama-server pudo quedar vivo ocupando RAM: se cierra al arrancar
  _killStale() {
    let pid = 0; try { pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'), 10); } catch (_) { return; }
    fs.rmSync(this.pidFile, { force: true });
    if (!(pid > 0)) return;
    // solo si ese PID sigue siendo un llama-server (tras reiniciar el equipo el número puede ser de otro programa)
    let name = '';
    try {
      name = process.platform === 'win32'
        ? require('child_process').execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' })
        : fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch (_) { return; }
    if (/llama-server/i.test(name)) { try { process.kill(pid); } catch (_) {} }
  }

  file(m) { return path.join(this.dir, m.file); }
  installed(m) { try { return fs.statSync(this.file(m)).size === m.size; } catch (_) { return false; } }
  ram() { return { totalGB: +(os.totalmem() / GB).toFixed(1), freeGB: +(os.freemem() / GB).toFixed(1) }; }
  selected() {
    const id = this.cfg().local.model;
    return byId(id) || recommend(os.totalmem() / GB);
  }

  status() {
    const sel = this.selected(), ram = this.ram();
    return {
      ram, recommended: recommend(os.totalmem() / GB)?.id || null, selected: sel ? sel.id : null,
      ready: !!sel && this.installed(sel) && !!findBinary(this.root),
      binary: !!findBinary(this.root),
      models: MODELS.map(m => ({ id: m.id, label: m.label, sizeMB: Math.round(m.size / 1048576), minRamGB: m.minRamGB, installed: this.installed(m), fits: ram.totalGB >= m.minRamGB })),
      download: this.dl ? { ...this.dl } : null,
      server: { state: this.state, error: this.error },
    };
  }
  _push(force) {
    const now = Date.now();
    if (!force && now - (this._lastPush || 0) < 300) return;
    this._lastPush = now;
    this.sse({ t: 'runtime', runtime: this.status() });
  }

  // ---------- descarga ----------
  download(id) {
    const m = byId(id) || this.selected();
    if (!m) throw Object.assign(new Error('Modelo desconocido'), { code: 400 });
    if (this.dl && !this.dl.error) throw Object.assign(new Error('Ya hay una descarga en curso'), { code: 409 });
    if (this.installed(m)) return this.status();
    this.dl = { id: m.id, done: 0, total: m.size, bps: 0, error: null };
    this._abortDl = false;
    this._downloadRetrying(m).then(() => {
      this.dl = null; this._push(true);
      this.emit('sys', `Modelo listo: ${m.label}`, 'info');
    }).catch(e => {
      if (this.dl) this.dl.error = this._abortDl ? 'cancelada' : e.message;
      this._push(true);
      if (!this._abortDl) this.emit('sys', `No se pudo descargar el modelo: ${e.message}`, 'err');
    });
    this._push(true);
    return this.status();
  }
  cancelDownload() { this._abortDl = true; if (this._dlReq) this._dlReq.destroy(new Error('cancelada')); }

  // Internet inestable: se reintenta solo y se sigue desde lo ya bajado (el .part queda en disco)
  async _downloadRetrying(m) {
    const waits = [2000, 5000, 10000, 20000, 30000, 60000];
    for (let a = 0; ; a++) {
      try { return await this._download(m); }
      catch (e) {
        if (this._abortDl || a >= waits.length) throw e;
        this.dl.retry = a + 1; this.dl.bps = 0; this._push(true);
        this.emit('sys', `Descarga del modelo: ${e.message}; reintento ${a + 1}…`, 'info');
        await new Promise(r => setTimeout(r, waits[a]));
        if (this._abortDl) throw new Error('cancelada');
      }
    }
  }

  async _download(m) {
    fs.mkdirSync(this.dir, { recursive: true });
    const part = this.file(m) + '.part';
    let have = 0; try { have = fs.statSync(part).size; } catch (_) {}
    if (have > m.size) { fs.rmSync(part); have = 0; }
    const hash = have ? await hashFile(part) : crypto.createHash('sha256');
    const { res, req } = await get(m.url, have ? { Range: `bytes=${have}-` } : {});
    this._dlReq = req;
    if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
    // 200 con un .part a medias = el servidor ignoró el Range: se empieza de cero
    const h = res.statusCode === 206 ? hash : crypto.createHash('sha256');
    const out = fs.createWriteStream(part, { flags: res.statusCode === 206 ? 'a' : 'w' });
    this.dl.done = res.statusCode === 206 ? have : 0;
    let win = { t: Date.now(), b: this.dl.done };
    await new Promise((resolve, reject) => {
      res.on('data', (c) => {
        h.update(c); this.dl.done += c.length;
        const now = Date.now();
        if (now - win.t >= 1000) { this.dl.bps = Math.round((this.dl.done - win.b) * 1000 / (now - win.t)); win = { t: now, b: this.dl.done }; }
        this._push();
      });
      // ante cualquier error se cierra el archivo (en Windows un archivo abierto no se puede renombrar)
      const fail = (e) => { res.unpipe(out); out.destroy(); reject(e); };
      res.on('error', fail); req.on('error', fail); out.on('error', fail);
      res.on('aborted', () => fail(new Error('se cortó la conexión')));
      res.pipe(out);
      out.on('finish', resolve);
    });
    this._dlReq = null;
    if (this._abortDl) throw new Error('cancelada');
    const size = fs.statSync(part).size;
    if (size !== m.size) throw new Error(`descarga incompleta (${size} de ${m.size} bytes); tocá Descargar para seguir`);
    const digest = h.digest('hex');
    if (m.sha256 && digest !== m.sha256) { fs.rmSync(part); throw new Error('el archivo descargado está dañado; se borró, volvé a intentar'); }
    fs.renameSync(part, this.file(m));
  }

  removeModel(id) {
    const m = byId(id);
    if (!m) throw Object.assign(new Error('Modelo desconocido'), { code: 400 });
    if (this.procModel === m.id) this.stop();
    for (const f of [this.file(m), this.file(m) + '.part']) fs.rmSync(f, { force: true });
    return this.status();
  }

  // ---------- llama-server ----------
  // Devuelve la URL del servidor listo, arrancándolo si hace falta.
  async ensure() {
    const m = this.selected();
    if (!m) throw fatal('Este equipo no tiene RAM suficiente para la IA local');
    if (!this.installed(m)) throw fatal(`Falta descargar el modelo (${m.label}). Abrí Ajustes → IA.`);
    this._touch();
    if (this.proc && this.procModel === m.id && this.state === 'ready') return this.url;
    if (!this.starting) this.starting = this._start(m).finally(() => { this.starting = null; });
    return this.starting;
  }

  _touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.busy || !this.busy()) this.stop(); else this._touch(); }, IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async _start(m) {
    this.stop();
    const bin = findBinary(this.root);
    if (!bin) throw fatal('No se encontró el motor de IA (llama-server)');
    const L = this.cfg().local;
    const port = await freePort();
    // -cms 0: checkpoints sin espaciado mínimo, para reutilizar la parte fija del prompt (ver llm.js)
    const args = ['-m', this.file(m), '--host', '127.0.0.1', '--port', String(port), '-c', String(L.ctx), '--parallel', '1', '--jinja', '--no-webui', '--no-mmproj', '-cms', '0'];
    // en Android os.cpus() puede venir vacío; ahí se usan los núcleos grandes y se deja aire al sistema
    const android = process.platform === 'android';
    const cores = os.cpus().length || 8;
    const threads = L.threads > 0 ? L.threads : Math.max(2, Math.min(android ? 6 : 8, cores - (android ? 2 : 1)));
    args.push('-t', String(threads));
    this.state = 'starting'; this.error = null; this.log = []; this._push(true);
    const p = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p; this.procModel = m.id;
    try { fs.writeFileSync(this.pidFile, String(p.pid)); } catch (_) {}
    const keep = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) { this.log.push(l); if (this.log.length > 40) this.log.shift(); } };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    let exited = null;
    p.on('exit', (code) => {
      exited = code;
      if (this.proc === p) { this.proc = null; this.url = null; this.procModel = null; if (this.state !== 'stopped') { this.state = 'error'; this.error = `el motor de IA se cerró (código ${code})`; } this._push(true); }
    });
    p.on('error', (e) => { exited = -1; this.error = e.message; });
    const url = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      if (exited !== null) {
        this.state = 'error'; this.error = `el motor de IA no arrancó: ${this.log.slice(-3).join(' / ') || exited}`; this._push(true);
        throw fatal(this.error);
      }
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) { this.url = url; this.state = 'ready'; this._push(true); this.emit('sys', `IA lista: ${m.label}`, 'info'); return url; }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 400));
    }
    this.stop();
    throw fatal('el motor de IA tardó demasiado en cargar el modelo');
  }

  stop() {
    clearTimeout(this.idleTimer);
    const p = this.proc;
    this.proc = null; this.url = null; this.procModel = null;
    if (this.state !== 'error') this.state = 'stopped';
    if (p) { try { p.kill(); } catch (_) {} fs.rmSync(this.pidFile, { force: true }); this._push(true); }
  }
}

module.exports = { LocalRuntime, findBinary, freePort };
