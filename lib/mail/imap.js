'use strict';
// Acceso IMAP con imapflow. Reglas de seguridad:
// - leer siempre con la carpeta abierta en solo lectura (EXAMINE) y PEEK: nunca marca como leído
// - borrar = MOVE a la Papelera; sin Papelera o sin MOVE/UIDPLUS, se niega
const { ImapFlow } = require('imapflow');
const { htmlToText } = require('../classify');
const { dayToDate } = require('../batches');

const TRASH_NAMES = /^(\[gmail\]\/|\[google mail\]\/|inbox[./])?(trash|papelera|deleted items|deleted messages|elementos eliminados|bin)$/i;

function parseHeaders(buf) {
  const out = {};
  for (const line of String(buf || '').split(/\r?\n(?![ \t])/)) {
    const i = line.indexOf(':'); if (i < 1) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
  }
  return out;
}

// Parte de texto para el LLM: text/plain, o text/html si no hay; nunca adjuntos
function pickTextPart(node) {
  let plain = null, html = null;
  (function walk(n) {
    if (!n) return;
    if (n.childNodes && n.childNodes.length) return n.childNodes.forEach(walk);
    if (n.disposition === 'attachment') return;
    if (n.type === 'text/plain' && !plain) plain = { part: n.part || '1', html: false };
    else if (n.type === 'text/html' && !html) html = { part: n.part || '1', html: true };
  })(node);
  return plain || html;
}

function addrOf(list) {
  const a = list && list[0];
  if (!a) return { from: '', email: '', name: '' };
  const email = String(a.address || '').toLowerCase();
  return { email, name: a.name || email, from: a.name ? `${a.name} <${email}>` : email };
}

class MailClient {
  constructor(imap, { inboxFolder = 'INBOX', trashFolder = '' } = {}) {
    this.opts = imap; this.inboxWanted = inboxFolder; this.trashWanted = trashFolder;
    this.client = null; this.lastError = null;
  }

  async connect() {
    const o = this.opts;
    this.client = new ImapFlow({
      host: o.host, port: o.port, secure: o.secure, auth: o.auth, tls: o.tls,
      logger: false, emitLogs: false, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 120000,
    });
    this.client.on('error', (e) => { this.lastError = e; });
    await this.client.connect();
    await this._resolveFolders();
    return this;
  }

  get usable() { return !!this.client && this.client.usable; }
  get isGmail() { return this.client.capabilities.has('X-GM-EXT-1'); }
  get canMove() { return this.client.capabilities.has('MOVE') || this.client.capabilities.has('UIDPLUS'); }

  async _resolveFolders() {
    const list = await this.client.list();
    this.folders = list.map(f => ({ path: f.path, specialUse: f.specialUse || '' }));
    const bySU = (su) => (list.find(f => f.specialUse === su) || {}).path || '';
    const exists = (p) => p && list.some(f => f.path === p);
    this.inbox = exists(this.inboxWanted) ? this.inboxWanted : (this.inboxWanted.toUpperCase() === 'INBOX' ? 'INBOX' : '');
    this.trash = exists(this.trashWanted) ? this.trashWanted : (bySU('\\Trash') || (list.find(f => TRASH_NAMES.test(f.path)) || {}).path || '');
    this.sent = bySU('\\Sent');
    this.all = bySU('\\All');
  }

  async _withBox(path, readOnly, fn) {
    const lock = await this.client.getMailboxLock(path, { readOnly });
    try { return await fn(); } finally { lock.release(); }
  }

  async info() {
    const st = this.inbox ? await this.client.status(this.inbox, { messages: true }) : { messages: 0 };
    return {
      capabilities: [...this.client.capabilities.keys()],
      folders: this.folders, inbox: this.inbox, trash: this.trash, sent: this.sent, all: this.all,
      isGmail: this.isGmail, canMove: this.canMove, inboxCount: st.messages,
    };
  }

  // fecha del correo más viejo de la bandeja (para "Todo"). El primero suele serlo, pero el correo
  // importado puede tener fechas anteriores: se buscan también los anteriores a ese.
  async oldestDate() {
    return this._withBox(this.inbox, true, async () => {
      if (!this.client.mailbox.exists) return null;
      const first = await this.client.fetchOne('1', { internalDate: true });
      if (!first) return null;
      let oldest = first.internalDate;
      const older = await this.client.search({ before: dayToDate(oldest.toISOString().slice(0, 10)) }, { uid: true });
      if (older && older.length) {
        for await (const m of this.client.fetch(older, { uid: true, internalDate: true }, { uid: true })) if (m.internalDate < oldest) oldest = m.internalDate;
      }
      return oldest;
    });
  }

  async searchRange(sinceDay, beforeDay) {
    return this._withBox(this.inbox, true, async () => {
      const uids = await this.client.search({ since: dayToDate(sinceDay), before: dayToDate(beforeDay) }, { uid: true });
      return (uids || []).sort((a, b) => b - a); // más nuevos primero
    });
  }

  async fetchMeta(uids) {
    if (!uids.length) return [];
    return this._withBox(this.inbox, true, async () => {
      const out = [];
      const q = { uid: true, envelope: true, internalDate: true, bodyStructure: true, threadId: this.isGmail, headers: ['list-unsubscribe', 'list-unsubscribe-post', 'references'] };
      for await (const m of this.client.fetch(uids, q, { uid: true })) {
        const h = parseHeaders(m.headers);
        out.push({
          uid: m.uid, ...addrOf(m.envelope.from), subject: m.envelope.subject || '',
          date: m.internalDate, messageId: m.envelope.messageId || '', inReplyTo: m.envelope.inReplyTo || '',
          references: h.references || '', listUnsubscribe: h['list-unsubscribe'] || '', listUnsubscribePost: h['list-unsubscribe-post'] || '',
          threadId: m.threadId || '', part: pickTextPart(m.bodyStructure),
        });
      }
      return out;
    });
  }

  async bodyText(meta, maxChars) {
    if (!meta.part) return '';
    return this._withBox(this.inbox, true, async () => {
      const { content } = await this.client.download(String(meta.uid), meta.part.part, { uid: true, maxBytes: maxChars * 4 });
      const chunks = []; for await (const c of content) chunks.push(c);
      let t = Buffer.concat(chunks).toString('utf8');
      if (meta.part.html) t = htmlToText(t);
      return t.replace(/\s+/g, ' ').trim().slice(0, maxChars);
    });
  }

  // Gmail: remitentes de cada hilo (X-GM-THRID) buscando en "Todos" → Map threadId → [emails]
  async gmailThreadSenders(threadIds) {
    const out = new Map(); if (!this.all || !threadIds.length) return out;
    for (let i = 0; i < threadIds.length; i += 20) {
      const ids = threadIds.slice(i, i + 20);
      await this._withBox(this.all, true, async () => {
        const q = ids.length === 1 ? { threadId: ids[0] } : { or: ids.map(id => ({ threadId: id })) };
        const uids = await this.client.search(q, { uid: true });
        if (!uids || !uids.length) return;
        for await (const m of this.client.fetch(uids, { uid: true, envelope: true, threadId: true }, { uid: true })) {
          const list = out.get(m.threadId) || []; list.push(addrOf(m.envelope.from).email); out.set(m.threadId, list);
        }
      });
    }
    return out;
  }

  // Otros servidores: ¿cuáles de estos Message-ID tienen una respuesta mía en Enviados?
  async repliedMessageIds(messageIds) {
    const replied = new Set(); if (!this.sent || !messageIds.length) return replied;
    const wanted = new Set(messageIds);
    for (let i = 0; i < messageIds.length; i += 10) {
      const ids = messageIds.slice(i, i + 10);
      await this._withBox(this.sent, true, async () => {
        const terms = ids.flatMap(id => [{ header: { 'in-reply-to': id } }, { header: { references: id } }]);
        const uids = await this.client.search({ or: terms }, { uid: true });
        if (!uids || !uids.length) return;
        for await (const m of this.client.fetch(uids, { uid: true, envelope: true, headers: ['references'] }, { uid: true })) {
          const refs = `${m.envelope.inReplyTo || ''} ${parseHeaders(m.headers).references || ''}`;
          for (const id of refs.match(/<[^>]+>/g) || []) if (wanted.has(id)) replied.add(id);
        }
      });
    }
    return replied;
  }

  async moveToTrash(uids) { return (await this.moveToTrashMap(uids)).count; }

  // como moveToTrash, y además el UID que recibió cada correo en la Papelera (si el servidor lo dice)
  async moveToTrashMap(uids) {
    if (!uids.length) return { count: 0, uidMap: new Map() };
    if (!this.trash) throw new Error('No se encontró la carpeta Papelera: configurala en ⚙ Configuración → Cuenta. Por seguridad no se borra nada.');
    if (this.trash === this.inbox) throw new Error('La carpeta a limpiar es la Papelera: no se mueve nada.');
    if (!this.canMove) throw new Error('El servidor no soporta MOVE ni UIDPLUS: por seguridad no se borra nada.');
    return this._withBox(this.inbox, false, async () => {
      const r = await this.client.messageMove(uids, this.trash, { uid: true });
      if (!r) throw new Error('El servidor rechazó mover a la Papelera');
      return { count: r.uidMap ? r.uidMap.size : uids.length, uidMap: r.uidMap || new Map() };
    });
  }

  // ---------- comprobación posterior ----------
  // de estos UIDs, cuáles siguen en la bandeja
  async inboxHas(uids) {
    const found = new Set(); if (!uids.length) return found;
    await this._withBox(this.inbox, true, async () => {
      for (let i = 0; i < uids.length; i += 500) {
        const r = await this.client.search({ uid: uids.slice(i, i + 500).join(',') }, { uid: true });
        for (const u of r || []) found.add(u);
      }
    });
    return found;
  }

  // items [{ tuid, mid }] → Set de índices que están en la Papelera. Con el UID nuevo se mira ese
  // correo (y que el Message-ID coincida); sin él, se busca por Message-ID.
  async trashHas(items) {
    const found = new Set(); if (!this.trash || !items.length) return found;
    await this._withBox(this.trash, true, async () => {
      const byTuid = new Map(), byMid = new Map();
      items.forEach((it, i) => { if (it.tuid) byTuid.set(it.tuid, i); else if (it.mid) byMid.set(it.mid, i); });
      const tuids = [...byTuid.keys()];
      for (let i = 0; i < tuids.length; i += 500) {
        for await (const m of this.client.fetch(tuids.slice(i, i + 500), { uid: true, envelope: true }, { uid: true })) {
          const k = byTuid.get(m.uid); if (k == null) continue;
          const want = items[k].mid, got = m.envelope && m.envelope.messageId;
          if (!want || !got || want === got) found.add(k);
          else byMid.set(want, k); // el UID no corresponde: se busca por Message-ID
        }
      }
      for (const k of byTuid.values()) if (!found.has(k) && items[k].mid && !byMid.has(items[k].mid)) byMid.set(items[k].mid, k);
      const mids = [...byMid.keys()];
      for (let i = 0; i < mids.length; i += 10) {
        const ids = mids.slice(i, i + 10);
        const terms = ids.map(id => ({ header: { 'message-id': id } }));
        const uids = await this.client.search(terms.length === 1 ? terms[0] : { or: terms }, { uid: true });
        if (!uids || !uids.length) continue;
        for await (const m of this.client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          const k = byMid.get(m.envelope && m.envelope.messageId); if (k != null) found.add(k);
        }
      }
    });
    return found;
  }

  // el correo más reciente de un remitente (para leer su List-Unsubscribe)
  async latestFrom(email) {
    const uids = await this._withBox(this.inbox, true, () => this.client.search({ from: email }, { uid: true }));
    if (!uids || !uids.length) return null;
    const [m] = await this.fetchMeta([Math.max(...uids)]);
    return m || null;
  }

  async close() {
    if (!this.client) return;
    try { await this.client.logout(); } catch (_) { try { this.client.close(); } catch (__) {} }
    this.client = null;
  }
}

module.exports = { MailClient, parseHeaders, pickTextPart };
