'use strict';
// Trabajos por lotes sobre la bandeja:
//   scan    → agrupa por remitente y puntúa con el LLM (no borra nada)
//   execute → mueve a la Papelera los correos de los remitentes elegidos
//   auto    → clasifica y borra lo claramente promocional de corrido
// El rango se recorre en ventanas de fecha; el progreso se guarda al terminar cada ventana
// (y al pausar), así que un corte de Ollama, de la red o de la app se retoma con "Continuar".
const { makeWindows, jobKey } = require('./batches');
const C = require('./classify');
const llm = require('./llm');
const { unsubscribe } = require('./unsub');

const KIND_LABEL = { scan: 'Escanear', execute: 'Ejecutar', auto: 'Limpiar TODO' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clampInt = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };

class Paused extends Error {}

async function pMap(items, fn, n) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

class Engine {
  // o: { cfg(), rules(), senderRules(), isUnsubDone(email), markUnsub(email), progress, openMail(), smtpOptions(),
  //      emit(lane, text, kind), sse(obj), onRunStart(job), onRunEnd(job), retryDelays? }
  constructor(o) {
    Object.assign(this, o);
    this.retryDelays = o.retryDelays || [3000, 10000, 30000];
    this.job = null; this.abort = false; this.lastScan = null; this._lastProgress = 0;
  }

  busy() { return !!this.job; }
  stop() { if (this.job) { this.abort = true; this.emit('sys', 'Parando al terminar el bloque actual…', 'warn'); } }

  // ---------- crear / continuar ----------
  buildJob(kind, p) {
    const cfg = this.cfg();
    const job = {
      kind, account: cfg.account.email, folder: cfg.account.inboxFolder,
      daysBack: clampInt(p.daysBack, 0, 36500, cfg.cleaning.daysBack), windowDays: cfg.cleaning.windowDays,
      dryRun: !!p.dryRun,
      params: { dureza: clampInt(p.dureza, 0, 100, cfg.cleaning.dureza), autoUnsub: !!p.autoUnsub, emails: (p.emails || []).map(e => String(e).toLowerCase()) },
      windows: null, doneIdx: 0, partial: null, totals: { seen: 0, deleted: 0, kept: 0, protected: 0 }, senders: {},
      createdAt: new Date().toISOString(), status: 'running', error: null,
    };
    if (kind === 'scan') job.dryRun = false; // escanear nunca borra: una sola clave
    job.key = jobKey(job);
    return job;
  }

  // Arranca (o continúa, con p.resume) y devuelve enseguida; el trabajo corre en segundo plano.
  start(kind, p = {}) {
    if (this.job) throw Object.assign(new Error('Ya hay un trabajo en curso'), { code: 409 });
    if (kind === 'execute' && !(p.emails || []).length && !p.resume) throw Object.assign(new Error('No hay remitentes marcados para borrar'), { code: 400 });
    let job = this.buildJob(kind, p);
    const saved = this.progress.get(job.key);
    if (p.resume) {
      const byKey = p.key ? this.progress.get(p.key) : saved;
      if (!byKey) throw Object.assign(new Error('No hay un trabajo para continuar'), { code: 404 });
      job = byKey; job.status = 'running'; job.error = null;
    } else if (saved) this.progress.remove(saved.key);
    this.job = job; this.abort = false;
    this._run(job).catch(e => this.emit('sys', `ERROR inesperado: ${e.message}`, 'err'));
    return this.view();
  }

  discard(key) { if (this.job && this.job.key === key) throw Object.assign(new Error('Ese trabajo está corriendo'), { code: 409 }); this.progress.remove(key); }

  pendingJobs() {
    return this.progress.list().filter(j => !this.job || j.key !== this.job.key).map(j => this.view(j));
  }

  view(job = this.job) {
    if (!job) return { running: false };
    const done = job.doneIdx, total = job.windows ? job.windows.length : 0;
    const cur = job.cur || {};
    // avance global: por correos si ya se contaron, si no por lotes
    const winFrac = total ? (done + (cur.total ? cur.done / cur.total : 0)) / total : 0;
    // dentro de un bloque, la IA puntúa remitente por remitente: el avance se reparte entre ellos
    const sub = cur.sub && cur.sub.n ? Math.floor(cur.sub.size * Math.min(cur.sub.k, cur.sub.n) / cur.sub.n) : 0;
    const emailsDone = (job.emailsDone || 0) + sub;
    const percent = job.status === 'done' ? 100
      : Math.floor(100 * Math.min(1, job.emailsTotal ? emailsDone / job.emailsTotal : winFrac));
    let etaSec = null;
    if (job === this.job && job.runStart && total) {
      const el = (Date.now() - job.runStart) / 1000;
      if (job.emailsTotal) {
        const did = emailsDone - (job.runStartDone || 0);
        if (did > 0 && el > 5) etaSec = Math.round(el / did * Math.max(0, job.emailsTotal - emailsDone));
      } else {
        const frac = (done - (job.runStartIdx || 0)) + (cur.total ? cur.done / cur.total : 0);
        if (frac > 0.05) etaSec = Math.round(el / frac * (total - done - (cur.total ? cur.done / cur.total : 0)));
      }
    }
    return {
      running: job === this.job, key: job.key, kind: job.kind, label: KIND_LABEL[job.kind], status: job.status, error: job.error,
      account: job.account, daysBack: job.daysBack, windowDays: job.windowDays, dryRun: job.dryRun,
      // número del lote en curso (o el próximo, si está pausado); el total si terminó
      windowIdx: job.status === 'done' ? total : Math.min(done + 1, total), windowCount: total,
      windowLabel: cur.label || (job.windows && job.windows[done] ? job.windows[done].label : ''),
      windowDone: cur.done || 0, windowTotal: cur.total || 0, totals: job.totals, etaSec, updatedAt: job.updatedAt,
      emailsDone: Math.min(emailsDone, job.emailsTotal || Infinity), emailsTotal: job.emailsTotal || 0, percent,
      phase: job.phase || null, now: cur.now || null,
    };
  }

  _progress(force) {
    const now = Date.now();
    if (!force && now - this._lastProgress < 500) return;
    this._lastProgress = now;
    this.sse({ t: 'progress', job: this.view() });
  }

  // ---------- ciclo principal ----------
  async _run(job) {
    const cfg = this.cfg();
    let mail = null;
    this.onRunStart && this.onRunStart(job);
    job.runStart = Date.now(); job.runStartIdx = job.doneIdx; job.runStartDone = job.emailsDone || 0;
    job.noThink = false; // al continuar se vuelve a intentar (pudo cambiar el modelo o el límite)
    const mine = new Set([...cfg.cleaning.myAddresses, cfg.account.email].map(a => String(a).toLowerCase()).filter(Boolean));
    const ctx = { cfg, mine, rules: this.rules(), senderRules: this.senderRules() };
    try {
      this.emit('sys', `${KIND_LABEL[job.kind]}: ${job.daysBack ? `últimos ${job.daysBack} días` : 'todo'} en lotes de ${job.windowDays} días${job.dryRun ? ' [DRY-RUN]' : ''}`, 'info');
      if (job.kind !== 'execute') { job.phase = 'ia'; this._progress(true); await this._checkLlm(cfg); }
      job.phase = 'conectar'; this._progress(true);
      mail = await this._retry(() => this._open(), 'conectar');
      if (!job.windows) {
        const oldest = job.daysBack ? null : await mail.oldestDate();
        job.windows = makeWindows({ daysBack: job.daysBack, windowDays: job.windowDays, oldest });
      }
      if (!job.emailsTotal) {
        // un solo SEARCH sobre todo el rango: la barra de progreso avanza por correos reales
        const W = job.windows;
        job.emailsTotal = W.length ? (await mail.searchRange(W[W.length - 1].since, W[0].before)).length : 0;
        job.emailsDone = job.emailsDone || 0;
      }
      job.phase = 'lotes';
      if (job.kind === 'scan') { this.lastScan = { key: job.key, senders: job.senders, daysBack: job.daysBack }; this.sse({ t: 'scanstart', senders: this._senderList(job) }); }
      this.progress.put(job); this._progress(true);
      if (job.kind !== 'execute') await this._scorePending(job, ctx, mail);
      for (let i = job.doneIdx; i < job.windows.length; i++) {
        if (this.abort) throw new Paused();
        const w = job.windows[i];
        if (!job.partial || job.partial.idx !== i) job.partial = { idx: i, uids: [] };
        job.cur = { idx: i, label: w.label, done: job.partial.uids.length, total: 0 };
        this.emit('heur', `── Lote ${i + 1}/${job.windows.length}: ${w.label}`, 'info');
        let attempt = 0;
        for (;;) {
          try { mail = await this._ensure(mail); await this._window(job, ctx, mail, w); break; }
          catch (e) {
            if (e instanceof Paused || e.fatal) throw e;
            if (attempt >= this.retryDelays.length) throw e;
            this.emit('sys', `Falló el lote (${e.message}); reintento ${attempt + 1}/${this.retryDelays.length}…`, 'warn');
            await mail?.close().catch(() => {}); mail = null;
            await sleep(this.retryDelays[attempt++]);
          }
        }
        if (job.kind === 'scan') await this._thinkDoubtful(job, ctx);
        job.doneIdx = i + 1; job.partial = null; job.cur = null;
        this.progress.put(job); this._progress(true);
      }
      job.status = 'done';
      this.progress.remove(job.key);
      const t = job.totals;
      this.emit('sys', `${KIND_LABEL[job.kind]} terminado: revisados ${t.seen}` + (job.kind === 'scan' ? `, ${Object.keys(job.senders).length} remitentes` : `, ${job.dryRun ? 'se borrarían' : 'borrados'} ${t.deleted}, conservados ${t.kept}`), 'info');
    } catch (e) {
      job.status = 'paused';
      job.error = e instanceof Paused ? null : e.message;
      this.progress.put(job);
      this.emit('sys', e instanceof Paused ? `Pausado en el lote ${job.doneIdx + 1}/${(job.windows || []).length}. Tocá "Continuar" para seguir.` : `Pausado por error: ${e.message}. El progreso quedó guardado.`, e instanceof Paused ? 'warn' : 'err');
    } finally {
      if (job.kind === 'scan') this.sse({ t: 'scandone', total: Object.keys(job.senders).length, sampled: job.totals.seen, status: job.status });
      await mail?.close().catch(() => {});
      this.job = null; this.abort = false;
      this.sse({ t: 'progress', job: { ...this.view(job), running: false } });
      this.onRunEnd && this.onRunEnd(job);
    }
  }

  async _open() { return this.openMail(); }
  async _ensure(mail) { return mail && mail.usable ? mail : this._retry(() => this._open(), 'reconectar'); }

  async _retry(fn, what) {
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        const authFail = e.authenticationFailed || /AUTHENTICATIONFAILED|invalid credentials|authenticat/i.test(`${e.message} ${e.responseText || ''}`);
        if (e.fatal || authFail || /no hay cuenta|falta|no está conectada|rechazó el acceso/i.test(e.message || '') || a >= this.retryDelays.length) {
          throw Object.assign(new Error(`No se pudo ${what}: ${e.responseText || e.message}`), { fatal: true });
        }
        this.emit('sys', `No se pudo ${what} (${e.message}); reintento ${a + 1}…`, 'warn');
        await sleep(this.retryDelays[a]);
      }
    }
  }

  async _checkLlm(cfg) {
    if (!llm.isLocal(cfg) && !cfg.model) throw Object.assign(new Error('No hay modelo elegido. Abrí Ajustes → IA.'), { fatal: true });
    const r = await this._llm(cfg, 'Responde solo: 0', false);
    if (r == null) throw Object.assign(new Error('La IA no respondió'), { fatal: true });
  }

  // LLM con reintentos: la IA caída o reiniciándose no debe perder el trabajo. Devuelve { text, truncated }
  async _llmRaw(cfg, prompt, think) {
    for (let a = 0; ; a++) {
      const r = await llm.generate(cfg, prompt, { think });
      if (r.ok) return r;
      if (r.fatal || a >= this.retryDelays.length) throw Object.assign(new Error(r.error), { fatal: true });
      this.emit('llm', `IA: ${r.error}; reintento ${a + 1}…`, 'warn');
      await sleep(this.retryDelays[a]);
    }
  }
  async _llm(cfg, prompt, think) { return (await this._llmRaw(cfg, prompt, think)).text ?? ''; }

  // Re-evalúa un dudoso pensando. Si el modelo se corta sin responder (qwen3.5:9b piensa más de
  // 2000 tokens), deja de pensar en este trabajo: cada intento costaría más de un minuto para nada.
  async _think(job, cfg, g) {
    if (job.noThink) return;
    const r = await this._llmRaw(cfg, llm.buildPrompt(cfg.llmPrompt, { from: `${g.name} <${g.email}>`, subjects: g.samples, bulk: !!g.lu, body: g.body || '' }), true);
    if (r.truncated) {
      if (!job.noThink) {
        job.noThink = true;
        this.emit('sys', `${cfg.model} no termina de pensar dentro de ${cfg.llm.thinkNumPredict} tokens: en este trabajo los dudosos quedan con el puntaje rápido. Subí "Tokens de pensamiento" o usá otro modelo.`, 'warn');
      }
      return;
    }
    const prev = g.score; g.score = llm.parseScore(r.text, g.score); g.reason = 'llm-think';
    this.emit('llm', `🧠 ruido=${g.score} (era ${prev}) → ${g.name.slice(0, 30)}`, g.score >= 60 ? 'delete' : g.score <= 40 ? 'keep' : 'dry');
  }

  // ---------- una ventana ----------
  async _window(job, ctx, mail, w) {
    const uids = await mail.searchRange(w.since, w.before);
    const skip = new Set(job.partial.uids);
    const todo = uids.filter(u => !skip.has(u));
    job.cur.total = uids.length; job.cur.done = uids.length - todo.length;
    this._progress(true);
    for (let i = 0; i < todo.length; i += ctx.cfg.cleaning.fetchChunk) {
      if (this.abort) throw new Paused();
      const chunk = todo.slice(i, i + ctx.cfg.cleaning.fetchChunk);
      const metas = await mail.fetchMeta(chunk);
      if (job.kind === 'scan') {
        // contar y marcar el bloque como hecho ANTES de puntuar: si Ollama se cae, los remitentes
        // sin puntaje se retoman con _scorePending y el bloque no se cuenta dos veces
        const pending = this._scanChunk(job, ctx, metas);
        job.partial.uids.push(...chunk); job.cur.done += chunk.length;
        job.cur.sub = { size: chunk.length, n: pending.length, k: 0 };
        await this._scoreSenders(job, ctx, mail, pending);
      } else {
        job.cur.sub = { size: chunk.length, n: 0, k: 0 };
        await this._cleanChunk(job, ctx, mail, metas);
        job.partial.uids.push(...chunk); job.cur.done += chunk.length;
      }
      job.cur.sub = null;
      job.emailsDone = (job.emailsDone || 0) + chunk.length;
      this._progress();
    }
  }

  // ---------- scan ----------
  _senderView(g) {
    return {
      email: g.email, name: g.name, count: g.count, samples: g.samples, canUnsub: !!g.lu,
      unsubDone: this.isUnsubDone(g.email), protected: g.prot, rule: this.senderRules()[g.email] || null, score: g.score, reason: g.reason,
    };
  }
  _senderList(job) { return Object.values(job.senders).map(g => this._senderView(g)); }

  _initialScore(g, ctx, meta) {
    const rule = ctx.senderRules[g.email];
    g.prot = C.isProtected(ctx.rules, ctx.senderRules, g.email, meta.subject, meta.from);
    if (rule === 'delete') { g.score = 100; g.reason = 'regla-usuario'; }
    else if (rule === 'protect') { g.score = 0; g.reason = 'regla-usuario'; }
    else if (g.prot) { g.score = 0; g.reason = 'protegido'; }
    else if (ctx.mine.has(g.email)) { g.score = 0; g.reason = 'mío'; }
    else { g.score = null; g.reason = 'pendiente-llm'; }
  }

  _scanChunk(job, ctx, metas) {
    const changed = new Set(), pending = [];
    for (const m of metas) {
      job.totals.seen++;
      let g = job.senders[m.email];
      if (!g) {
        g = job.senders[m.email] = { email: m.email, name: m.name, count: 0, samples: [], lu: '', luPost: '', sample: { uid: m.uid, part: m.part }, score: null, reason: null, prot: false };
        this._initialScore(g, ctx, m);
        if (g.score == null) pending.push(g);
        this.emit('heur', `${g.score === 0 ? '✓ protegido' : g.score === 100 ? '🗑️ regla' : '→ LLM'}: ${g.name.slice(0, 34)}`, g.score === 100 ? 'delete' : g.score === 0 ? 'keep' : 'info');
      }
      g.count++;
      if (g.samples.length < 3) g.samples.push(C.shortSubj(m.subject, 48));
      if (!g.lu && m.listUnsubscribe) { g.lu = m.listUnsubscribe; g.luPost = m.listUnsubscribePost; }
      changed.add(g);
    }
    if (changed.size) this.sse({ t: 'senders', list: [...changed].map(g => this._senderView(g)) });
    return pending;
  }

  // puntúa (rápido) remitentes sin puntaje, con el cuerpo de su primer correo
  async _scoreSenders(job, ctx, mail, list) {
    if (!list.length) return;
    const cfg = ctx.cfg;
    await pMap(list, async (g) => {
      if (this.abort && job.kind === 'scan') return;
      const body = await mail.bodyText({ uid: g.sample.uid, part: g.sample.part }, cfg.cleaning.bodyMaxChars).catch(() => '');
      if (job.cur) { job.cur.now = g.name; this._progress(); }
      this.emit('llm', `🔍 ${g.name.slice(0, 30)} — "${(g.samples[0] || '').slice(0, 38)}"`, 'info');
      const txt = await this._llm(cfg, llm.buildPrompt(cfg.llmPrompt, { from: `${g.name} <${g.email}>`, subjects: g.samples, bulk: !!g.lu, body }), false);
      g.score = llm.parseScore(txt, 50); g.reason = 'llm';
      if (job.cur && job.cur.sub) { job.cur.sub.k++; this._progress(); }
      if (cfg.llm.think && g.score >= cfg.llm.doubtLow && g.score <= cfg.llm.doubtHigh) g.body = body; // solo los dudosos lo vuelven a necesitar
      this.emit('llm', `ruido=${g.score} → ${g.name.slice(0, 32)}`, g.score >= 60 ? 'delete' : g.score <= 40 ? 'keep' : 'dry');
      if (job.kind === 'scan') this.sse({ t: 'senders', list: [this._senderView(g)] });
    }, llm.isLocal(cfg) ? 1 : cfg.llm.parallel); // la IA integrada atiende de a uno (y así conserva su caché)
  }

  // al continuar: los que quedaron sin puntaje cuando se cortó Ollama
  async _scorePending(job, ctx, mail) {
    const pend = Object.values(job.senders).filter(g => g.score == null && g.sample);
    if (pend.length) { this.emit('sys', `Puntuando ${pend.length} remitentes pendientes…`, 'info'); await this._scoreSenders(job, ctx, mail, pend); }
  }

  // re-evalúa con pensamiento los dudosos del lote (más lento, más preciso)
  async _thinkDoubtful(job, ctx) {
    const L = ctx.cfg.llm;
    if (!L.think || job.noThink) return;
    const list = Object.values(job.senders).filter(g => g.reason === 'llm' && g.score >= L.doubtLow && g.score <= L.doubtHigh);
    if (!list.length) return;
    this.emit('sys', `🧠 Pensando ${list.length} dudosos…`, 'info');
    await pMap(list, async (g) => {
      if (this.abort || job.noThink) return;
      if (job.cur) { job.cur.now = g.name; this._progress(); }
      await this._think(job, ctx.cfg, g);
      delete g.body;
      this.sse({ t: 'senders', list: [this._senderView(g)] });
    }, llm.isLocal(ctx.cfg) ? 1 : L.parallel);
  }

  // ---------- execute / auto ----------
  async _cleanChunk(job, ctx, mail, metas) {
    const { cfg } = ctx;
    if (job.kind === 'auto') {
      const nuevos = [];
      for (const m of metas) if (!job.senders[m.email]) {
        const g = job.senders[m.email] = { email: m.email, name: m.name, samples: [C.shortSubj(m.subject, 48)], lu: m.listUnsubscribe, luPost: m.listUnsubscribePost, sample: { uid: m.uid, part: m.part }, score: null, reason: null };
        this._initialScore(g, ctx, m);
        if (g.score == null) nuevos.push(g);
      }
      if (job.cur && job.cur.sub) job.cur.sub.n = nuevos.length;
      await this._scoreSenders(job, ctx, mail, nuevos);
      for (const g of nuevos) {
        if (cfg.llm.think && g.score >= cfg.llm.doubtLow && g.score <= cfg.llm.doubtHigh) await this._think(job, cfg, g);
        delete g.body;
      }
    }
    // decisión por correo
    const cands = [];
    for (const m of metas) {
      job.totals.seen++;
      const ss = C.shortSubj(m.subject, 42);
      const rule = ctx.senderRules[m.email];
      let del = false, why = '', noted = false;
      if (job.kind === 'execute') del = job.params.emails.includes(m.email);
      else { const g = job.senders[m.email]; del = C.decide(g.score, job.params.dureza, cfg.cleaning.band) === 'delete'; why = `${g.score}`; }
      if (del && rule !== 'delete' && C.isProtected(ctx.rules, ctx.senderRules, m.email, m.subject, m.from)) { del = false; noted = true; job.totals.protected++; this.emit('heur', `🛡️ protegido: ${ss}`, 'keep'); }
      else if (del && ctx.mine.has(m.email)) { del = false; noted = true; this.emit('heur', `✓ enviado por vos: ${ss}`, 'keep'); }
      if (del) cands.push(m);
      else if (job.kind === 'auto') { job.totals.kept++; if (!noted) this.emit('heur', `✓ (${why}) ${ss}`, 'keep'); }
    }
    // guardia de conversación (solo sobre los candidatos a borrar)
    const keep = cfg.cleaning.protectConversations ? await this._conversationGuard(ctx, mail, cands) : new Set();
    const toMove = cands.filter(m => !keep.has(m.uid));
    for (const m of cands) if (keep.has(m.uid)) { job.totals.protected++; job.totals.kept++; this.emit('heur', `💬 conversación protegida: ${C.shortSubj(m.subject, 42)}`, 'keep'); }
    if (!toMove.length) return;
    if (job.dryRun) {
      for (const m of toMove) this.emit('heur', `[DRY] borraría: ${m.name.slice(0, 20)} · ${C.shortSubj(m.subject, 38)}`, 'dry');
      job.totals.deleted += toMove.length;
    } else {
      const n = await mail.moveToTrash(toMove.map(m => m.uid));
      job.totals.deleted += n;
      for (const m of toMove) this.emit('heur', `🗑️ ${m.name.slice(0, 20)} · ${C.shortSubj(m.subject, 38)}`, 'delete');
    }
    if (job.kind === 'auto' && job.params.autoUnsub && !job.dryRun) {
      for (const email of new Set(toMove.map(m => m.email))) {
        const g = job.senders[email];
        if (!g || !g.lu || g.unsubTried || this.isUnsubDone(email)) continue;
        g.unsubTried = true;
        const r = await this.unsubscribeWith(email, g.lu, g.luPost);
        this.emit('heur', r.ok ? `✉️ baja OK (${r.method}): ${g.name.slice(0, 24)}` : `✉️ baja no posible (${g.name.slice(0, 20)}): ${r.error}`, r.ok ? 'keep' : 'warn');
      }
    }
  }

  // uids de candidatos que son parte de una conversación (no se borran)
  async _conversationGuard(ctx, mail, cands) {
    const keep = new Set();
    const rest = [];
    for (const m of cands) (C.looksLikeReply(m) ? keep.add(m.uid) : rest.push(m));
    if (!rest.length) return keep;
    if (mail.isGmail) {
      const ids = [...new Set(rest.map(m => m.threadId).filter(Boolean))];
      const threads = await mail.gmailThreadSenders(ids);
      for (const m of rest) { const s = threads.get(m.threadId); if (s && C.isConversation(s, ctx.mine)) keep.add(m.uid); }
    } else {
      const replied = await mail.repliedMessageIds(rest.map(m => m.messageId).filter(Boolean));
      for (const m of rest) if (replied.has(m.messageId)) keep.add(m.uid);
    }
    return keep;
  }

  // ---------- bajas ----------
  async unsubscribeWith(email, lu, luPost) {
    const smtpOptions = lu && /mailto:/i.test(lu) ? await this.smtpOptions().catch(() => null) : null;
    const r = await unsubscribe({ lu, luPost, smtpOptions, from: this.cfg().account.email });
    if (r.ok) this.markUnsub(email);
    return r;
  }

  // baja pedida desde la UI: usa la cabecera del escaneo o lee el último correo del remitente
  async unsubscribeSender(email) {
    email = String(email).toLowerCase();
    let g = this.lastScan && this.lastScan.senders[email];
    let lu = g && g.lu, luPost = g && g.luPost;
    if (!lu) {
      const mail = await this.openMail();
      try { const m = await mail.latestFrom(email); lu = m && m.listUnsubscribe; luPost = m && m.listUnsubscribePost; }
      finally { await mail.close().catch(() => {}); }
    }
    return this.unsubscribeWith(email, lu, luPost);
  }

  scanSenders() { return this.lastScan ? Object.values(this.lastScan.senders).map(g => this._senderView(g)) : []; }
}

module.exports = { Engine, KIND_LABEL };
