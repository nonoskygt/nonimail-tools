'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ImapFlow } = require('imapflow');
const { Engine } = require('../lib/engine');
const { ProgressStore, addDays, toDay } = require('../lib/batches');
const { MailClient } = require('../lib/mail/imap');
const { compileRules } = require('../lib/classify');
const C = require('../lib/config');
const S = require('./helpers/servers');

const today = toDay(Date.now());
const ago = (n) => addDays(today, -n);

// Ollama falso: puntúa según el remitente; "dudoso" da 50 rápido y 85 pensando
function fakeOllama() {
  const st = { down: false, calls: 0, think: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (st.down) { res.writeHead(500); return res.end('{"error":"caído"}'); }
      const p = JSON.parse(b || '{}'); st.calls++;
      const pr = p.prompt || '';
      let score = '3';
      if (/FROM: .*ofertas@/.test(pr)) score = '95';
      if (/FROM: .*(dudoso@|otro-dudoso@)/.test(pr)) { score = p.think ? '85' : '50'; if (p.think) st.think++; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (p.think && st.truncateThink) return res.end(JSON.stringify({ response: '', thinking: 'pienso y pienso… Puntaje (0-100) 30 70', done_reason: 'length' }));
      res.end(JSON.stringify({ response: score, done_reason: 'stop' }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(x => srv.close(x)) })));
}

function mailbox() {
  const inbox = [], sent = [];
  for (const d of [3, 40, 100, 200, 300]) {
    inbox.push(S.msg({ from: 'Tienda <ofertas@tienda.com>', subject: `Gran OFERTA ${d}`, day: ago(d), unsub: '<mailto:baja@tienda.com?subject=baja>' }));
    inbox.push(S.msg({ from: 'Ana <ana@amiga.com>', subject: `hola ${d}`, day: ago(d) }));
  }
  inbox.push(S.msg({ from: 'Tienda <ofertas@tienda.com>', subject: 'Tu factura de compra', day: ago(50) }));             // protegido por keepOverride
  inbox.push(S.msg({ from: 'Tienda <ofertas@tienda.com>', subject: 'Re: mi pedido', day: ago(60), inReplyTo: '<p@x>' })); // conversación por cabecera
  inbox.push(S.msg({ from: 'Tienda <ofertas@tienda.com>', subject: 'Cotización especial', day: ago(70), id: '<cot@t>' }));  // le respondí (Enviados)
  sent.push(S.msg({ from: 'yo@test.local', subject: 'Re: Cotización especial', day: ago(69), inReplyTo: '<cot@t>' }));
  inbox.push(S.msg({ from: 'Club <dudoso@club.com>', subject: 'Novedades del club', day: ago(10) }));
  inbox.push(S.msg({ from: 'Revista <revista@r.com>', subject: 'Edición de marzo', day: ago(250) }));                  // remitente nuevo en un lote viejo
  inbox.push(S.msg({ from: 'Viejo <ofertas@tienda.com>', subject: 'OFERTA vieja', day: ago(500) }));                     // fuera de 1 año
  return { inbox, sent };
}

async function setup({ daysBack = 365, windowDays = 30, retry = [20, 20, 20], fetchChunk = 100 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-eng-'));
  const ol = await fakeOllama();
  const imap = await S.startImap(mailbox());
  const smtpSrv = await S.startSmtp();
  const cfg = C.deepDefaults(C.DEFAULTS, {
    model: 'm', ollamaUrl: ol.url, llmPrompt: 'P', llm: { provider: 'ollama', think: true },
    account: { type: 'imap', email: 'yo@test.local' },
    cleaning: { daysBack, windowDays, fetchChunk, dryRun: false },
    heuristics: { keepOverride: 'factura' },
  });
  const rules = compileRules(cfg.heuristics), senderRules = {}, unsub = {};
  const lines = [], events = [];
  const progress = new ProgressStore(path.join(dir, 'progress.json'));
  const eng = new Engine({
    cfg: () => cfg, rules: () => rules, senderRules: () => senderRules,
    isUnsubDone: (e) => !!unsub[e], markUnsub: (e) => { unsub[e] = true; },
    progress, retryDelays: retry,
    openMail: () => new MailClient(S.imapOpts(imap.port)).connect(),
    smtpOptions: async () => ({ host: '127.0.0.1', port: smtpSrv.port, secure: false, requireTLS: false, auth: { user: 'smtpuser', pass: 'smtppass' } }),
    emit: (lane, text, kind) => lines.push(`[${lane}] ${text}`), sse: (o) => events.push(o),
  });
  const done = () => new Promise(r => { const t = setInterval(() => { if (!eng.busy()) { clearInterval(t); r(); } }, 20); });
  const subjects = async (box) => {
    const c = new ImapFlow({ ...S.imapOpts(imap.port), logger: false }); await c.connect();
    const lock = await c.getMailboxLock(box, { readOnly: true }); const out = [];
    try { for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope.subject); } catch (_) {} finally { lock.release(); }
    await c.logout(); return out.sort();
  };
  const cleanup = async () => { await imap.close(); await smtpSrv.close(); await ol.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { eng, cfg, ol, imap, smtpSrv, lines, events, progress, unsub, done, subjects, cleanup };
}

test('auto dry-run: no mueve nada y cuenta lo que borraría', async () => {
  const t = await setup();
  try {
    t.eng.start('auto', { daysBack: 365, dureza: 50, dryRun: true });
    await t.done();
    assert.deepEqual((await t.subjects('Papelera')), []);
    const ev = t.events.filter(e => e.t === 'progress').pop().job;
    assert.equal(ev.status, 'done');
    assert.equal(ev.windowCount, 13);
    assert.equal(ev.totals.deleted, 6, '5 ofertas + el dudoso (85 al pensar)');
    assert.equal(t.smtpSrv.messages.length, 0, 'dry-run no da de baja');
    // barra de progreso: por correos reales, nunca retrocede y termina en 100 %
    const prog = t.events.filter(e => e.t === 'progress' && e.job.running && e.job.emailsTotal).map(e => e.job);
    assert.ok(prog.length > 3, 'hubo avances intermedios');
    const pcts = prog.map(j => j.percent);
    assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), `el porcentaje no retrocede: ${pcts.join(',')}`);
    assert.equal(ev.percent, 100);
    assert.equal(ev.emailsDone, ev.emailsTotal);
    assert.equal(ev.emailsTotal, ev.totals.seen, 'el total contado al inicio coincide con lo revisado');
  } finally { await t.cleanup(); }
});

test('auto real: borra solo lo promocional del rango y protege banco, respuestas y conversaciones', async () => {
  const t = await setup();
  try {
    t.eng.start('auto', { daysBack: 365, dureza: 50, dryRun: false, autoUnsub: true });
    await t.done();
    const trash = await t.subjects('Papelera');
    assert.deepEqual(trash, ['Gran OFERTA 100', 'Gran OFERTA 200', 'Gran OFERTA 3', 'Gran OFERTA 300', 'Gran OFERTA 40', 'Novedades del club']);
    const inbox = await t.subjects('INBOX');
    for (const s of ['Tu factura de compra', 'Re: mi pedido', 'Cotización especial', 'OFERTA vieja', 'hola 3']) assert.ok(inbox.includes(s), `debía quedar: ${s}`);
    assert.equal(t.ol.st.think, 1, 'pensó solo el dudoso');
    assert.equal(t.smtpSrv.messages.length, 1, 'una sola baja por correo para la tienda');
    assert.deepEqual(t.smtpSrv.messages[0].to, ['baja@tienda.com']);
    assert.equal(t.unsub['ofertas@tienda.com'], true);
    assert.equal(t.progress.list().length, 0, 'terminado: no queda trabajo pendiente');
  } finally { await t.cleanup(); }
});

test('scan: agrupa por remitente en todos los lotes, Parar pausa y Continuar termina sin contar doble', async () => {
  const t = await setup({ windowDays: 30 });
  try {
    let stopped = false;
    const origSse = t.eng.sse;
    t.eng.sse = (o) => { origSse(o); if (!stopped && o.t === 'progress' && o.job.running && o.job.windowIdx >= 3) { stopped = true; t.eng.stop(); } };
    t.eng.start('scan', { daysBack: 365 });
    await t.done();
    const saved = t.progress.list();
    assert.equal(saved.length, 1); assert.equal(saved[0].status, 'paused');
    assert.ok(saved[0].doneIdx >= 2 && saved[0].doneIdx < 13, `pausado a mitad (doneIdx=${saved[0].doneIdx})`);
    t.eng.start('scan', { resume: true, key: saved[0].key });
    await t.done();
    const list = t.eng.scanSenders();
    const by = Object.fromEntries(list.map(s => [s.email, s]));
    assert.equal(by['ofertas@tienda.com'].count, 8, 'las 5 ofertas + factura + Re: + cotización dentro del año');
    assert.equal(by['ana@amiga.com'].count, 5);
    assert.equal(by['ofertas@tienda.com'].score, 95);
    assert.equal(by['dudoso@club.com'].score, 85); assert.equal(by['dudoso@club.com'].reason, 'llm-think');
    assert.equal(by['ofertas@tienda.com'].canUnsub, true);
    assert.equal(t.progress.list().length, 0);
    assert.deepEqual(await t.subjects('Papelera'), [], 'escanear nunca borra');
  } finally { await t.cleanup(); }
});

test('Ollama se cae a mitad: pausa con error, y al volver Continuar termina', async () => {
  const t = await setup({ windowDays: 30, fetchChunk: 10 });
  try {
    let tripped = false;
    const origSse = t.eng.sse;
    t.eng.sse = (o) => { origSse(o); if (!tripped && o.t === 'progress' && o.job.running && o.job.windowIdx >= 4) { tripped = true; t.ol.st.down = true; } };
    t.eng.start('auto', { daysBack: 365, dureza: 50, dryRun: false });
    await t.done();
    const [saved] = t.progress.list();
    assert.equal(saved.status, 'paused'); assert.match(saved.error, /caído|Ollama/);
    t.ol.st.down = false;
    t.eng.start('auto', { resume: true, key: saved.key });
    await t.done();
    assert.equal((await t.subjects('Papelera')).length, 6);
    assert.equal(t.progress.list().length, 0);
  } finally { await t.cleanup(); }
});

test('execute: borra solo los remitentes elegidos dentro del rango, respetando protecciones', async () => {
  const t = await setup();
  try {
    t.eng.start('execute', { daysBack: 365, emails: ['ofertas@tienda.com'], dryRun: false });
    await t.done();
    assert.deepEqual(await t.subjects('Papelera'), ['Gran OFERTA 100', 'Gran OFERTA 200', 'Gran OFERTA 3', 'Gran OFERTA 300', 'Gran OFERTA 40']);
    assert.ok((await t.subjects('INBOX')).includes('OFERTA vieja'), 'fuera del rango no se toca');
    assert.equal(t.ol.st.calls, 0, 'ejecutar no usa el LLM');
  } finally { await t.cleanup(); }
});

test('después de mover, el remitente sale de los resultados; después de simular, se queda', async () => {
  const t = await setup();
  try {
    t.eng.start('scan', { daysBack: 365 });
    await t.done();
    const has = () => t.eng.scanSenders().some(s => s.email === 'ofertas@tienda.com');
    assert.ok(has(), 'el análisis lo encontró');
    t.eng.start('execute', { daysBack: 365, emails: ['ofertas@tienda.com'], dryRun: true });
    await t.done();
    assert.ok(has(), 'simular no saca nada de la lista');
    t.eng.start('execute', { daysBack: 365, emails: ['ofertas@tienda.com'], dryRun: false });
    await t.done();
    assert.ok(!has(), 'ya está en la papelera: no vuelve a aparecer');
    assert.ok(t.eng.scanSenders().length > 0, 'el resto de los resultados sigue');
  } finally { await t.cleanup(); }
});

test('si el modelo se corta pensando, deja de pensar en ese trabajo y conserva el puntaje rápido', async () => {
  const t = await setup();
  try {
    t.ol.st.truncateThink = true;
    t.eng.start('scan', { daysBack: 365 });
    await t.done();
    const by = Object.fromEntries(t.eng.scanSenders().map(s => [s.email, s]));
    assert.equal(by['dudoso@club.com'].score, 50, 'no adivina con los números del razonamiento cortado');
    assert.equal(by['dudoso@club.com'].reason, 'llm');
    assert.equal(t.ol.st.think, 1, 'un solo intento de pensar en todo el trabajo');
    assert.ok(t.lines.some(l => /no termina de pensar/.test(l)));
  } finally { await t.cleanup(); }
});

test('un trabajo nuevo con la misma clave descarta el pausado; dos a la vez no se permiten', async () => {
  const t = await setup();
  try {
    t.eng.start('auto', { daysBack: 365, dryRun: true });
    assert.throws(() => t.eng.start('scan', {}), /en curso/);
    await t.done();
  } finally { await t.cleanup(); }
});
