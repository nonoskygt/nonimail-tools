'use strict';
// Reporte de cada trabajo terminado: qué se movió (agrupado por remitente, correo por correo),
// qué se comprobó después en el servidor y qué falló. Se guarda en reports/ (los últimos KEEP).
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonfile');

const KEEP = 30;
const MAX_ITEMS = 20000; // correos guardados uno por uno por trabajo; los conteos siguen siendo exactos
const MAX_ISSUES = 300;
const KIND_TITLE = { scan: 'Análisis', execute: 'Limpieza', auto: 'Limpieza automática' };
// estado de cada correo tras la comprobación: ok/nc (movido), keep (sigue en la bandeja, como debía en una
// simulación o un protegido); inbox/lost/gone son problemas; pend = no se llegó a comprobar
const GOOD = new Set(['ok', 'nc', 'keep']);

// lo mínimo para reconocer un correo después: dónde estaba, dónde quedó y cómo se llama
function receipt(m, tuid = null) {
  return {
    uid: m.uid, tuid, email: m.email, name: m.name || m.email, subject: String(m.subject || '').slice(0, 90),
    date: m.date ? new Date(m.date).toISOString() : '', // completa: la app la muestra en la hora local mid: m.messageId || '', st: 'pend',
  };
}

function addItem(list, item, job, overflowKey) {
  if (list.length < MAX_ITEMS) list.push(item);
  else job[overflowKey] = (job[overflowKey] || 0) + 1;
}

function addIssue(job, stage, text, level = 'warn') {
  job.issues = job.issues || [];
  job.issueCount = (job.issueCount || 0) + 1;
  if (job.issues.length < MAX_ISSUES) job.issues.push({ at: new Date().toISOString(), stage, text: String(text).slice(0, 400), level });
}

const n = (x) => Number(x || 0).toLocaleString('es');
const plural = (k, one, many) => `${n(k)} ${k === 1 ? one : many}`;

// Comprobaciones legibles: cada una dice qué se miró y si dio bien
function checks(job) {
  const out = [], t = job.totals || {}, v = job.verify || {};
  const all = (job.windows || []).length;
  const add = (ok, text, level) => out.push({ ok: !!ok, level: ok ? 'ok' : (level || 'err'), text });
  add(job.doneIdx >= all, `${plural(all, 'lote revisado', 'lotes revisados')} de ${n(all)} · ${plural(t.seen, 'correo leído', 'correos leídos')}`);
  if (job.emailsTotal && t.seen < job.emailsTotal) add(false, `${plural(job.emailsTotal - t.seen, 'correo del rango ya no estaba', 'correos del rango ya no estaban')} al leerlos (se borraron o movieron por fuera)`, 'warn');
  if (job.kind === 'scan') {
    const S = Object.values(job.senders || {});
    const pend = S.filter(g => g.score == null).length;
    add(pend === 0, pend ? `${plural(pend, 'remitente quedó', 'remitentes quedaron')} sin veredicto de la IA` : `${plural(S.length, 'remitente', 'remitentes')} con veredicto`);
    const sum = S.reduce((a, g) => a + (g.count || 0), 0);
    add(sum === t.seen, sum === t.seen ? 'Cada correo quedó contado en su remitente' : `Conteo por remitente (${n(sum)}) distinto de lo leído (${n(t.seen)})`, 'warn');
    return out;
  }
  if (!v.ran) { add(false, v.error ? `No se pudo comprobar en el servidor: ${v.error}` : 'No se comprobó en el servidor'); return out; }
  if (!v.checked) add(true, job.dryRun ? 'No se movería nada: todo lo revisado se queda' : 'Nada para mover: todo lo revisado se queda');
  else if (job.dryRun) {
    add(v.gone === 0, v.gone ? `${plural(v.gone, 'candidato ya no está', 'candidatos ya no están')} en la bandeja (se movieron por fuera)` : `Nada se movió: los ${n(v.checked)} candidatos siguen en la bandeja`, 'warn');
  } else {
    add(v.inbox === 0, v.inbox ? `${plural(v.inbox, 'correo sigue', 'correos siguen')} en la bandeja` : `Ya no están en la bandeja: ${n(v.checked)} de ${n(v.checked)}`);
    add(v.lost === 0, v.lost ? `${plural(v.lost, 'correo no aparece', 'correos no aparecen')} en la Papelera` : `Están en la Papelera: ${n(v.trash)} de ${n(v.checked - v.unknown)}`, 'warn');
    if (v.unknown) add(true, `${plural(v.unknown, 'correo sin identificador', 'correos sin identificador')}: salió de la bandeja, no se puede buscar en la Papelera`);
    if (v.retried) add(true, `Se reintentó mover ${plural(v.retried, 'correo', 'correos')} que seguían en la bandeja`);
  }
  if (v.protChecked) add(v.protGone === 0, v.protGone ? `${plural(v.protGone, 'protegido ya no está', 'protegidos ya no están')} en la bandeja (lo movió otra app o la persona)` : `Protegidos intactos: ${n(v.protChecked)} siguen en tu bandeja`, 'warn');
  const U = Object.values(job.unsub || {});
  if (U.length) { const ok = U.filter(u => u.ok).length; add(ok === U.length, `Bajas: ${n(ok)} de ${n(U.length)} hechas`, 'warn'); }
  return out;
}

// agrupa recibos por remitente; con unsub, suma las bajas (solo para lo movido)
function groups(job, list = job.moved, withUnsub = true) {
  const by = new Map();
  for (const r of list || []) {
    let g = by.get(r.email);
    if (!g) by.set(r.email, g = { email: r.email, name: r.name, count: 0, ok: 0, bad: 0, unsub: null, items: [] });
    g.count++;
    if (GOOD.has(r.st)) g.ok++; else g.bad++; // sin comprobar también cuenta como problema
    g.items.push({ subject: r.subject, date: r.date, st: r.st });
  }
  if (withUnsub) for (const [email, u] of Object.entries(job.unsub || {})) {
    let g = by.get(email);
    if (!g) by.set(email, g = { email, name: u.name || email, count: 0, ok: 0, bad: 0, unsub: null, items: [] });
    g.unsub = { ok: !!u.ok, method: u.method || '', error: u.error || '' };
  }
  const arr = [...by.values()];
  for (const g of arr) g.items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return arr.sort((a, b) => b.bad - a.bad || b.count - a.count);
}

function build(job, extra = {}) {
  const C = checks(job);
  const issues = job.issues || [];
  const bad = C.some(c => c.level === 'err') || issues.some(i => i.level === 'err');
  const warn = bad || C.some(c => c.level === 'warn') || issues.length > 0;
  const finished = new Date();
  const started = job.createdAt ? new Date(job.createdAt) : finished;
  const S = job.kind === 'scan' ? Object.values(job.senders || {}) : [];
  return {
    id: `${finished.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${job.kind}${job.dryRun ? '-sim' : ''}`,
    kind: job.kind, title: KIND_TITLE[job.kind] || job.kind, dryRun: !!job.dryRun, account: job.account,
    daysBack: job.daysBack, startedAt: started.toISOString(), finishedAt: finished.toISOString(),
    seconds: Math.max(0, Math.round((finished - started) / 1000)),
    status: bad ? 'error' : warn ? 'warn' : 'ok',
    totals: { ...job.totals }, emailsTotal: job.emailsTotal || 0,
    moved: (job.moved || []).length + (job.movedOverflow || 0), listed: (job.moved || []).length,
    verify: job.verify || { ran: false }, checks: C,
    senders: job.kind === 'scan' ? S.length : undefined,
    unsubOk: Object.values(job.unsub || {}).filter(u => u.ok).length, unsubTotal: Object.keys(job.unsub || {}).length,
    groups: job.kind === 'scan' ? [] : groups(job),
    protGroups: job.kind === 'scan' ? [] : groups(job, job.prot, false), // lo que se quiso borrar y se salvó
    issues, issueCount: job.issueCount || issues.length,
    ...extra,
  };
}

// lo que se manda por SSE y se lista en el historial (sin los correos uno por uno)
function summary(r) {
  const { groups: G, protGroups: P, ...rest } = r;
  return { ...rest, groupCount: (G || []).length, issueCount: r.issueCount };
}

const ST_TXT = { ok: 'en la papelera', nc: 'fuera de la bandeja', inbox: 'SIGUE EN LA BANDEJA', lost: 'NO APARECE EN LA PAPELERA', gone: 'ya no estaba', keep: 'sigue en la bandeja', pend: 'sin comprobar' };

// texto plano para copiar o adjuntar en un reporte de error
function toText(r) {
  const L = [];
  L.push(`NoniMail Cleaner · reporte ${r.id}`);
  if (r.app) L.push(`App ${r.app.version} · ${r.app.platform}`);
  L.push(`${r.title}${r.dryRun ? ' (simulación)' : ''} · ${r.account || ''} · ${r.daysBack ? `últimos ${r.daysBack} días` : 'todo'}`);
  L.push(`Inicio ${r.startedAt} · fin ${r.finishedAt} · ${r.seconds} s · estado ${r.status.toUpperCase()}`);
  const t = r.totals || {};
  L.push(`Leídos ${t.seen || 0} · ${r.dryRun ? 'se moverían' : 'movidos'} ${t.deleted || 0} · se quedan ${Math.max(0, (t.seen || 0) - (t.deleted || 0))} · protegidos ${t.protected || 0}`);
  L.push('', 'Comprobaciones:');
  for (const c of r.checks || []) L.push(`  [${c.ok ? 'OK' : c.level === 'warn' ? 'AVISO' : 'ERROR'}] ${c.text}`);
  if ((r.issues || []).length) {
    L.push('', `Errores y avisos (${r.issueCount}):`);
    for (const i of r.issues) L.push(`  ${i.at.slice(11, 19)} [${i.level}] ${i.stage}: ${i.text}`);
  }
  if ((r.groups || []).length) {
    L.push('', 'Detalle por remitente:');
    for (const g of r.groups) {
      L.push(`  ${g.name} <${g.email}> · ${g.count} correo(s)${g.bad ? ` · ${g.bad} con problema` : ''}${g.unsub ? ` · baja ${g.unsub.ok ? 'hecha' : `no posible: ${g.unsub.error}`}` : ''}`);
      for (const it of g.items) L.push(`    ${(it.date || '').slice(0, 10)}  ${it.subject}  — ${ST_TXT[it.st] || it.st}`);
    }
    if (r.moved > r.listed) L.push(`  … y ${r.moved - r.listed} correos más (no se guardan uno por uno)`);
  }
  if ((r.protGroups || []).length) {
    L.push('', 'Protegidos (se quedan en la bandeja):');
    for (const g of r.protGroups) {
      L.push(`  ${g.name} <${g.email}> · ${g.count} correo(s)`);
      for (const it of g.items) L.push(`    ${(it.date || '').slice(0, 10)}  ${it.subject}  — ${ST_TXT[it.st] || it.st}`);
    }
  }
  return L.join('\n');
}

class ReportStore {
  constructor(dir, keep = KEEP) { this.dir = dir; this.keep = keep; }
  _file(id) {
    if (!/^[0-9]{8}-[0-9]{6}-[a-z]+(-sim)?$/.test(String(id))) return null;
    return path.join(this.dir, `${id}.json`);
  }
  save(r) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeJsonAtomic(this._file(r.id), r);
    const all = this._ids();
    for (const id of all.slice(this.keep)) { try { fs.unlinkSync(path.join(this.dir, `${id}.json`)); } catch (_) {} }
    return r;
  }
  _ids() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) {}
    return names.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(id => this._file(id)).sort().reverse();
  }
  get(id) { const f = this._file(id); return f ? readJson(f, null) : null; }
  list() { return this._ids().map(id => this.get(id)).filter(Boolean).map(summary); }
}

module.exports = { receipt, addItem, addIssue, build, summary, toText, checks, groups, ReportStore, MAX_ITEMS, ST_TXT };
