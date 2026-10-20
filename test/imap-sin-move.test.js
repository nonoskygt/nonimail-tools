'use strict';
// Servidor como correo.nonosky.com: UIDPLUS sin MOVE, y la Papelera se llama "Trash" sin la marca \Trash.
// De punta a punta con el motor: "Mover" de verdad (como lo usó el usuario con info@nonosky.com).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const hoodiecrow = require('hoodiecrow-imap');
const { msg } = require('./helpers/servers');
const { MailClient } = require('../lib/mail/imap');
const { Engine } = require('../lib/engine');
const { ProgressStore } = require('../lib/batches');
const { compileRules } = require('../lib/classify');
const C = require('../lib/config');

const today = new Date().toISOString().slice(0, 10);
function server() {
  const inbox = [
    msg({ from: 'Temu <deals@temu.example>', subject: 'Cupón 1', day: today }),
    msg({ from: 'Temu <deals@temu.example>', subject: 'Cupón 2', day: today }),
    msg({ from: 'Ana <ana@amiga.example>', subject: 'hola', day: today }),
  ];
  const srv = hoodiecrow({
    plugins: ['UIDPLUS', 'ENABLE', 'SASL-IR', 'AUTH-PLAIN'], // sin MOVE ni SPECIAL-USE
    storage: { INBOX: { messages: inbox }, '': { separator: '/', folders: { Trash: { messages: [] }, Sent: { messages: [] } } } },
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ port: srv.server ? srv.server.address().port : srv.address().port, close: () => new Promise(x => srv.close(x)) })));
}
const opts = (port) => ({ host: '127.0.0.1', port, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false });

test('sin MOVE, con UIDPLUS y Papelera llamada "Trash": Mover deja los correos en la Papelera', async () => {
  const s = await server();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-nonosky-'));
  try {
    const probe = await new MailClient(opts(s.port)).connect();
    const info = await probe.info();
    await probe.close();
    assert.equal(info.trash, 'Trash', 'detecta la Papelera por el nombre');
    assert.equal(info.canMove, true, 'UIDPLUS alcanza para mover');

    const cfg = C.deepDefaults(C.DEFAULTS, { account: { type: 'imap', email: 'yo@test.local' }, llm: { provider: 'ollama' }, model: 'm', cleaning: { daysBack: 7, windowDays: 7, dryRun: false } });
    const lines = [];
    let done;
    const finished = new Promise(r => { done = r; });
    const eng = new Engine({
      cfg: () => cfg, rules: () => compileRules({}), senderRules: () => ({}), isUnsubDone: () => false, markUnsub: () => {},
      progress: new ProgressStore(path.join(dir, 'progress.json')), openMail: () => new MailClient(opts(s.port)).connect(),
      smtpOptions: async () => null, emit: (lane, text) => lines.push(text), sse: (o) => { if (o.t === 'progress' && !o.job.running) done(o.job); },
      retryDelays: [10],
    });
    eng.start('execute', { daysBack: 7, emails: ['deals@temu.example'], dryRun: false });
    const job = await finished;
    assert.equal(job.status, 'done', `terminó: ${job.error || ''} ${lines.slice(-3).join(' | ')}`);
    assert.equal(job.totals.deleted, 2);

    const check = await new MailClient(opts(s.port)).connect();
    const inbox = await check.searchRange(today, '2999-01-01');
    const metas = await check.fetchMeta(inbox);
    await check.close();
    assert.deepEqual(metas.map(m => m.email), ['ana@amiga.example'], 'en la bandeja solo queda lo personal');
    const raw = await new MailClient(opts(s.port)).connect();
    let inTrash = 0;
    await raw.client.mailboxOpen('Trash'); inTrash = raw.client.mailbox.exists; await raw.close();
    assert.equal(inTrash, 2, 'los 2 correos de Temu están en la Papelera');
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
