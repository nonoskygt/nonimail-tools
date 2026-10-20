'use strict';
// NoniMail Cleaner — interfaz. Habla con el servidor local por JSON + SSE (/api/stream).
// En la app de escritorio y en Android existe window.NoniBridge (abrir enlaces, progreso en la barra de tareas / notificación).
const $ = (id) => document.getElementById(id);
const BRIDGE = window.NoniBridge || null;
const NF = new Intl.NumberFormat('es');
const fmt = (n) => NF.format(n || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const RANGES = [[7, '7 días'], [30, '30 días'], [90, '3 meses'], [180, '6 meses'], [365, '1 año'], [730, '2 años'], [1095, '3 años'], [1825, '5 años'], [0, 'Todo']];
const QUICK = [7, 30, 90, 180, 365, 730, 0];
const rangeLabel = (d) => (RANGES.find(r => r[0] === d) || [d, `${d} días`])[1];
const LEVELS = [35, 50, 70];
const KIND_TITLE = { scan: 'Analizando', execute: 'Limpiando', auto: 'Limpieza automática' };

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
function openExternal(url) {
  if (BRIDGE && BRIDGE.openExternal) BRIDGE.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-ext]');
  if (a) { e.preventDefault(); openExternal(a.href); }
});

// ---------- avisos y diálogos ----------
function toast(text, kind = 'info', ms = 4500) {
  const ic = kind === 'err' ? 'alert' : kind === 'warn' ? 'alert' : kind === 'ok' ? 'check' : 'info';
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.innerHTML = `${icon(ic)}<span>${esc(text)}</span>`;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function ask(title, text, okLabel = 'Aceptar', danger = false) {
  const d = $('dlg');
  $('dlg-t').textContent = title; $('dlg-p').textContent = text || '';
  $('dlg-ok').textContent = okLabel; $('dlg-ok').className = `btn ${danger ? 'danger' : 'primary'}`;
  return new Promise((resolve) => {
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.returnValue = ''; d.showModal(); $('dlg-ok').focus();
  });
}

// ---------- actividad y terminales ----------
const MAXLOG = 300, MAXTERM = 500;
function appendTo(box, ts, text, kind, max) {
  const div = document.createElement('div');
  div.innerHTML = `<span class="ts">${esc(ts)}</span><span class="k-${esc(kind)}">${esc(text)}</span>`;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(div);
  while (box.childElementCount > max) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function addLine(lane, text, kind, ts) {
  appendTo($('log'), ts, text, kind, MAXLOG);
  if (lane === 'heur') appendTo($('feed-heur'), ts, text, kind, MAXTERM);
  else if (lane === 'llm') appendTo($('feed-llm'), ts, text, kind, MAXTERM);
  else if (lane === 'sys') { const s = $('term-sys'); s.textContent = `[${ts}] ${text}`; s.className = `term-sys k-${kind}`; }
  if (lane === 'sys' && (kind === 'warn' || kind === 'err')) toast(text, kind);
}
function clearTerms() { $('feed-heur').innerHTML = ''; $('feed-llm').innerHTML = ''; $('log').innerHTML = ''; }

// vista técnica: se recuerda por equipo; de entrada, encendida en pantallas grandes
function termPref() {
  try { const v = localStorage.getItem('nm-term'); if (v === '1' || v === '0') return v === '1'; } catch (_) {}
  return window.matchMedia('(min-width: 1000px)').matches;
}
function setTerms(on, save) {
  $('terms').hidden = !on; $('activity').hidden = on;
  $('btnTerm').setAttribute('aria-pressed', String(on));
  if (save) { try { localStorage.setItem('nm-term', on ? '1' : '0'); } catch (_) {} }
  if (on) for (const id of ['feed-heur', 'feed-llm']) $(id).scrollTop = $(id).scrollHeight;
}
$('btnTerm').onclick = () => setTerms($('terms').hidden, true);

function setMeter(bar, label, pct) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  $(bar).style.width = v + '%';
  $(bar).style.background = v > 80 ? 'var(--t-del)' : v > 50 ? 'var(--t-warn)' : 'var(--t-ok)';
  $(label).textContent = v + '%';
}
function onMetrics(m) {
  if (typeof m.cpu === 'number') setMeter('m-cpu', 'm-cpu-v', m.cpu);
  if (typeof m.mem === 'number') setMeter('m-mem', 'm-mem-v', m.mem);
  $('m-gpu-w').hidden = !m.gpu;
  if (m.gpu) {
    setMeter('m-gpu', 'm-gpu-v', m.gpu.util);
    $('m-vram').textContent = m.gpu.vramTotal ? `${(m.gpu.vramUsed / 1024).toFixed(1)}/${(m.gpu.vramTotal / 1024).toFixed(1)} GB` : '';
  }
}

// ---------- estado ----------
let MAIN = null, JOB = { running: false }, RT = null, BAND = 12;
let DAYS = 30, LEVEL = 50, FILTER = 'delete', QUERY = '', SHOWN = 150;
let lastKind = null;

// ---------- controles de inicio ----------
function renderRanges() {
  const list = QUICK.includes(DAYS) ? QUICK : [...QUICK.slice(0, -1), DAYS, 0];
  $('ranges').innerHTML = list.map(d => `<button type="button" class="chip" role="radio" data-d="${d}" aria-checked="${d === DAYS}">${rangeLabel(d)}</button>`).join('');
}
$('ranges').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (!b) return; DAYS = +b.dataset.d; renderRanges(); });
function nearestLevel(v) { return LEVELS.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a, 50); }
function renderLevels() { for (const b of $('levels').children) b.setAttribute('aria-checked', String(+b.dataset.v === LEVEL)); }
$('levels').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; LEVEL = +b.dataset.v; renderLevels(); renderSenders(); });
$('autoUnsub').addEventListener('change', () => renderSenders());

// ---------- cuenta y primeros pasos ----------
function renderMain(c) {
  MAIN = c; BAND = c.cleaning.band;
  const a = c.account, el = $('acct');
  el.classList.toggle('off', !a.ready);
  el.querySelector('b').textContent = a.ready ? a.email : (a.type === 'none' ? 'Conectar correo' : 'Completar cuenta');
  $('term-model').textContent = c.model || 'sin modelo';
  renderSetup();
}
function aiOk() { return MAIN && (MAIN.provider === 'local' ? !!(RT && RT.ready) : MAIN.aiReady); }
function renderSetup() {
  if (!MAIN) return;
  const mailOk = MAIN.account.ready, ai = aiOk();
  $('setup').hidden = mailOk && ai;
  $('st-mail').classList.toggle('done', mailOk);
  $('st-mail').querySelector('.n').innerHTML = mailOk ? icon('check', 'sm') : '1';
  $('st-mail-sub').textContent = mailOk ? MAIN.account.email : 'Gmail, Yahoo, iCloud y más';
  $('st-mail-btn').hidden = mailOk;
  const st = $('st-ai'), sub = $('st-ai-sub'), btn = $('st-ai-btn'), bar = $('st-ai-bar');
  st.classList.toggle('done', ai);
  st.querySelector('.n').innerHTML = ai ? icon('check', 'sm') : '2';
  bar.hidden = true; btn.hidden = ai;
  if (MAIN.provider !== 'local') { sub.textContent = ai ? `Ollama · ${MAIN.model}` : 'Ollama sin modelo'; btn.textContent = 'Elegir'; return; }
  if (!RT) { sub.textContent = '…'; return; }
  const m = RT.models.find(x => x.id === RT.selected);
  if (!m) { sub.textContent = `Este equipo tiene ${RT.ram.totalGB} GB de RAM: no alcanza para la IA local`; btn.hidden = true; return; }
  if (RT.download && !RT.download.error) {
    const p = Math.floor(100 * RT.download.done / RT.download.total);
    sub.textContent = `Descargando ${p}% · ${fmtMB(RT.download.done)} de ${fmtMB(RT.download.total)}`;
    bar.hidden = false; bar.firstElementChild.style.width = p + '%'; btn.hidden = true;
  } else if (ai) sub.textContent = m.label;
  else if (!RT.binary) { sub.textContent = 'Falta el motor de IA'; btn.hidden = true; }
  else { sub.textContent = RT.download && RT.download.error ? `Descarga interrumpida: ${RT.download.error}` : `${m.label} · ${fmtMB(m.sizeMB * 1048576)}`; btn.textContent = RT.download ? 'Reintentar' : 'Descargar'; }
}
const fmtMB = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1).replace('.', ',')} GB` : `${Math.round(b / 1048576)} MB`;
$('acct').onclick = () => openSettings('cuenta');
$('st-mail-btn').onclick = () => openSettings('cuenta');
$('st-ai-btn').onclick = async () => {
  if (MAIN.provider !== 'local') return openSettings('ia');
  try { renderRuntime(await api('POST', '/api/runtime/download', { id: RT.selected })); } catch (e) { toast(e.message, 'err'); }
};

// ---------- progreso ----------
function fmtEta(s) {
  if (s == null) return '';
  if (s < 60) return 'Falta menos de 1 min';
  const m = Math.round(s / 60);
  return m < 60 ? `Faltan ~${m} min` : `Faltan ~${Math.floor(m / 60)} h ${m % 60} min`;
}
let lastBridge = 0;
function renderProgress(j) {
  JOB = j || { running: false };
  const busy = !!JOB.running;
  if (busy) {
    lastKind = JOB.kind;
    // "Mover" actúa sobre el mismo rango que se analizó
    if (JOB.kind === 'scan' && JOB.daysBack !== DAYS) { DAYS = JOB.daysBack; renderRanges(); }
    $('start').hidden = true; $('done').hidden = true; $('run').hidden = false; $('banner').hidden = true;
    $('run-title').textContent = KIND_TITLE[JOB.kind] || 'Trabajando';
    $('run-dry').hidden = !JOB.dryRun;
    const waiting = JOB.phase === 'ia' || JOB.phase === 'conectar' || !JOB.windowCount;
    $('run-bar').classList.toggle('indet', waiting);
    const p = waiting ? 0 : JOB.percent || 0;
    $('run-pct').textContent = p; $('run-bar').firstElementChild.style.width = waiting ? '' : p + '%';
    $('run-bar').setAttribute('aria-valuenow', String(p));
    $('run-count').textContent = JOB.emailsTotal ? `${fmt(JOB.emailsDone)} de ${fmt(JOB.emailsTotal)} correos` : '';
    $('run-eta').textContent = fmtEta(JOB.etaSec);
    $('run-win').textContent = JOB.windowCount > 1 ? `Lote ${JOB.windowIdx} de ${JOB.windowCount}` : '';
    $('run-now').textContent = JOB.phase === 'ia' ? 'Preparando la IA…' : JOB.phase === 'conectar' ? 'Conectando con tu correo…' : JOB.now ? `Revisando: ${JOB.now}` : (JOB.windowLabel || '');
    const t = JOB.totals || {};
    $('s-seen').textContent = fmt(t.seen);
    if (JOB.kind === 'scan') {
      const c = counts();
      $('s-del').textContent = fmt(c.delMails); $('s-del-l').textContent = 'A borrar';
      $('s-keep').textContent = fmt(c.keepMails); $('s-prot').textContent = fmt(c.prot);
    } else {
      $('s-del').textContent = fmt(t.deleted); $('s-del-l').textContent = JOB.dryRun ? 'Se borrarían' : 'Borrados';
      $('s-keep').textContent = fmt(t.kept); $('s-prot').textContent = fmt(t.protected);
    }
  } else {
    $('run').hidden = true;
    if (JOB.key && JOB.status === 'done' && JOB.kind !== 'scan' && lastKind === JOB.kind) showDone(JOB);
    else if ($('done').hidden) $('start').hidden = false;
    lastKind = null;
  }
  for (const id of ['btnScan', 'btnAuto', 'btnExec', 'btnSave', 'btnSaveRules']) $(id).disabled = busy;
  $('btnStop').disabled = !busy;
  const now = Date.now();
  if (BRIDGE && BRIDGE.progress && (!busy || now - lastBridge > 900)) {
    lastBridge = now;
    try { BRIDGE.progress(busy, busy ? (JOB.percent || 0) : 0, busy ? ($('run-title').textContent) : '', busy ? $('run-count').textContent : ''); } catch (_) {}
  }
}
function showDone(j) {
  const t = j.totals || {};
  $('start').hidden = true; $('done').hidden = false;
  $('done-title').textContent = j.dryRun ? 'Simulación lista' : 'Listo';
  $('done-sub').textContent = j.dryRun
    ? `Se moverían ${fmt(t.deleted)} correos a la papelera · ${fmt(t.kept)} se quedan`
    : `${fmt(t.deleted)} correos en la papelera · ${fmt(t.kept)} se quedan · ${fmt(t.protected)} protegidos`;
}
$('btnAgain').onclick = () => { $('done').hidden = true; $('start').hidden = false; };
$('btnStop').onclick = async () => { $('btnStop').disabled = true; try { await api('POST', '/api/stop', {}); } catch (e) { toast(e.message, 'err'); } };

// ---------- trabajo a medias ----------
async function refreshPending() { try { renderBanner((await api('GET', '/api/jobs')).pending); } catch (_) {} }
function renderBanner(pending) {
  const p = (pending || [])[0];
  if (!p || JOB.running) { $('banner').hidden = true; return; }
  $('banner').hidden = false;
  $('banner').classList.toggle('err', !!p.error);
  $('bn-title').textContent = p.error ? `${KIND_TITLE[p.kind] || 'Trabajo'}: se detuvo por un error` : `${KIND_TITLE[p.kind] || 'Trabajo'} a medias`;
  $('bn-sub').textContent = [rangeLabel(p.daysBack), p.emailsTotal ? `${p.percent}%` : `lote ${p.windowIdx} de ${p.windowCount}`, p.dryRun ? 'simulación' : '', p.error || ''].filter(Boolean).join(' · ');
  $('bn-go').onclick = async () => { try { await api('POST', '/api/jobs/resume', { key: p.key }); } catch (e) { toast(e.message, 'err'); } };
  $('bn-x').onclick = async () => {
    if (!(await ask('¿Descartar el progreso?', 'Lo que ya está en la papelera se queda ahí.', 'Descartar'))) return;
    renderBanner((await api('POST', '/api/jobs/discard', { key: p.key })).pending);
  };
}

// ---------- remitentes ----------
const senders = new Map();
const unsubChoice = new Map(); // email → true/false (lo que eligió la persona)
const unsubState = new Map();  // email → 'proc' | 'done' | 'err'
let renderTimer = null;
function upsertSenders(list) {
  for (const s of list) senders.set(s.email, s);
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderSenders(); }, 250);
}
function effDecision(s) {
  if (s.rule === 'protect') return 'keep';
  if (s.rule === 'delete') return 'delete';
  if (s.score == null) return 'duda';
  const T = 100 - LEVEL;
  if (s.score >= T + BAND) return 'delete';
  if (s.score <= T - BAND) return 'keep';
  return 'duda';
}
function wantsUnsub(s) {
  if (!s.canUnsub || s.unsubDone) return false;
  return unsubChoice.has(s.email) ? unsubChoice.get(s.email) : (effDecision(s) === 'delete' && $('autoUnsub').checked);
}
function counts() {
  const c = { del: 0, duda: 0, keep: 0, delMails: 0, keepMails: 0, prot: 0 };
  for (const s of senders.values()) {
    const e = effDecision(s);
    if (e === 'delete') { c.del++; c.delMails += s.count; } else if (e === 'keep') { c.keep++; c.keepMails += s.count; } else c.duda++;
    if (s.protected) c.prot++;
  }
  return c;
}
const AV = ['#1D4ED8', '#6D28D9', '#BE185D', '#C2410C', '#0F766E', '#15803D', '#475569', '#0E7490'];
function avColor(email) { let h = 0; for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AV[h % AV.length]; }
function initial(s) { const m = String(s.name || s.email).match(/[\p{L}\p{N}]/u); return m ? m[0] : '?'; }

function renderSenders() {
  const c = counts();
  $('c-del').textContent = fmt(c.del); $('c-duda').textContent = fmt(c.duda); $('c-keep').textContent = fmt(c.keep);
  for (const b of document.querySelectorAll('.sum')) b.setAttribute('aria-pressed', String(b.dataset.f === FILTER));
  const has = senders.size > 0;
  $('res-head').hidden = !has; $('empty').hidden = has;
  const q = QUERY.trim().toLowerCase();
  const arr = [...senders.values()]
    .filter(s => effDecision(s) === FILTER && (!q || s.email.includes(q) || String(s.name).toLowerCase().includes(q)))
    .sort((a, b) => b.count - a.count);
  const list = $('list');
  list.hidden = !has;
  if (!arr.length) list.innerHTML = has ? `<div class="empty">${icon('check')}<span>Nada por aquí</span></div>` : '';
  else {
    list.innerHTML = arr.slice(0, SHOWN).map(rowHtml).join('') + (arr.length > SHOWN ? `<div class="more"><button class="btn ghost sm" type="button" data-more>Ver ${fmt(arr.length - SHOWN)} más</button></div>` : '');
  }
  const unsubN = [...senders.values()].filter(wantsUnsub).length;
  const running = !!JOB.running;
  $('actionbar').hidden = !has || running || (c.delMails === 0 && unsubN === 0);
  const dry = $('dryRun').checked;
  $('exec-txt').textContent = c.delMails ? `${dry ? 'Simular: mover' : 'Mover'} ${fmt(c.delMails)} correos a la papelera` : `Darse de baja de ${fmt(unsubN)}`;
}
function rowHtml(s) {
  const e = effDecision(s), st = unsubState.get(s.email);
  const score = s.score == null ? '<span class="tag">Analizando</span>'
    : s.reason === 'protegido' ? `<span class="tag info">${icon('shield', 'sm')}Protegido</span>`
    : s.rule ? `<span class="tag ${e === 'delete' ? 'del' : 'keep'}">Tu regla</span>`
    : `<span class="tag ${e}">${s.score}</span>`;
  const ub = s.unsubDone || st === 'done' ? `<button class="unsub done" type="button" disabled aria-label="Baja hecha" title="Baja hecha">${icon('check', 'sm')}</button>`
    : `<button class="unsub${st === 'err' ? ' err' : ''}" type="button" data-unsub="${esc(s.email)}" aria-pressed="${wantsUnsub(s)}" ${s.canUnsub ? '' : 'disabled'} aria-label="Darse de baja de ${esc(s.name)}" title="${s.canUnsub ? 'Darse de baja' : 'Sin opción de baja'}">${icon(st === 'proc' ? 'rotate' : 'bell-off', 'sm')}</button>`;
  return `<div class="sender">
    <div class="avatar" style="background:${avColor(s.email)}" aria-hidden="true">${esc(initial(s))}</div>
    <div class="who">
      <div class="name">${esc(s.name)}</div>
      <div class="meta"><span class="num">${fmt(s.count)} correo${s.count === 1 ? '' : 's'}</span>${score}<span class="em">${esc(s.email)}</span></div>
      <div class="subj">${esc((s.samples || [])[0] || '')}</div>
    </div>
    <div class="acts">
      ${ub}
      <div class="verdict" role="group" aria-label="Decisión para ${esc(s.name)}">
        <button type="button" data-rule="protect" data-email="${esc(s.email)}" class="${e === 'keep' ? 'on-keep' : ''}" aria-pressed="${e === 'keep'}" aria-label="Conservar" title="Conservar">${icon('check', 'sm')}</button>
        <button type="button" data-rule="delete" data-email="${esc(s.email)}" class="${e === 'delete' ? 'on-del' : ''}" aria-pressed="${e === 'delete'}" aria-label="Borrar" title="Borrar">${icon('trash', 'sm')}</button>
      </div>
    </div>
  </div>`;
}
$('list').addEventListener('click', async (e) => {
  const more = e.target.closest('[data-more]');
  if (more) { SHOWN += 300; return renderSenders(); }
  const u = e.target.closest('[data-unsub]');
  if (u) { const s = senders.get(u.dataset.unsub); if (s) { unsubChoice.set(s.email, !wantsUnsub(s)); renderSenders(); } return; }
  const b = e.target.closest('[data-rule]');
  if (!b) return;
  const s = senders.get(b.dataset.email); if (!s) return;
  const rule = (b.dataset.rule === 'protect' && s.rule === 'protect') || (b.dataset.rule === 'delete' && s.rule === 'delete') ? 'none' : b.dataset.rule;
  try { const d = await api('POST', '/api/sender-rule', { email: s.email, rule }); s.rule = d.rule; s.protected = d.protected; renderSenders(); }
  catch (err) { toast(err.message, 'err'); }
});
document.querySelector('.summary').addEventListener('click', (e) => { const b = e.target.closest('.sum'); if (!b) return; FILTER = b.dataset.f; SHOWN = 150; renderSenders(); });
$('q').addEventListener('input', () => { QUERY = $('q').value; SHOWN = 150; renderSenders(); });
$('dryRun').addEventListener('change', () => renderSenders());

// bajas: de a una, después de Mover
let uqBusy = false;
async function processUnsubs() {
  if (uqBusy) return; uqBusy = true;
  try {
    for (const s of [...senders.values()].filter(wantsUnsub)) {
      unsubState.set(s.email, 'proc'); renderSenders();
      try { await api('POST', '/api/unsubscribe', { email: s.email }); unsubState.set(s.email, 'done'); s.unsubDone = true; }
      catch (e) { unsubState.set(s.email, 'err'); unsubChoice.set(s.email, false); }
      renderSenders();
    }
  } finally { uqBusy = false; }
}

// ---------- acciones ----------
function needSetup() {
  if (MAIN && MAIN.account.ready && aiOk()) return false;
  if (!MAIN || !MAIN.account.ready) { toast('Primero conecta tu correo', 'warn'); openSettings('cuenta'); }
  else { toast('Falta preparar la IA', 'warn'); openSettings('ia'); }
  return true;
}
async function startJob(url, body, kind) {
  try {
    const { pending } = await api('GET', '/api/jobs');
    const same = pending.find(p => p.kind === kind && p.daysBack === body.daysBack && p.dryRun === !!body.dryRun);
    if (same && !(await ask('Hay uno a medias', `Ese mismo trabajo quedó en ${same.emailsTotal ? same.percent + '%' : 'el lote ' + same.windowIdx}. Si empiezas de nuevo, se pierde ese avance.`, 'Empezar de nuevo'))) return false;
    await api('POST', url, body); return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}
$('btnScan').onclick = async () => {
  if (needSetup()) return;
  clearTerms();
  await startJob('/api/scan', { daysBack: DAYS }, 'scan');
};
$('btnAuto').onclick = async () => {
  if (needSetup()) return;
  const dry = $('dryRun').checked;
  const ok = await ask(dry ? 'Simular limpieza' : 'Limpiar sin revisar',
    `${rangeLabel(DAYS)} · ${MAIN.account.email}\nSolo se mueve a la papelera lo claramente promocional. Bancos, facturas y conversaciones se quedan.`,
    dry ? 'Simular' : 'Limpiar', !dry);
  if (!ok) return;
  clearTerms();
  await startJob('/api/autorun', { daysBack: DAYS, dureza: LEVEL, dryRun: dry, autoUnsub: $('autoUnsub').checked }, 'auto');
};
$('btnExec').onclick = async () => {
  if (needSetup()) return;
  const del = [...senders.values()].filter(s => effDecision(s) === 'delete');
  const mails = del.reduce((a, s) => a + s.count, 0);
  const uns = [...senders.values()].filter(wantsUnsub).length;
  const dry = $('dryRun').checked;
  const lines = [];
  if (mails) lines.push(`${fmt(mails)} correos de ${fmt(del.length)} remitentes a la papelera`);
  if (uns && !dry) lines.push(`Baja de ${fmt(uns)} listas`);
  if (!(await ask(dry ? 'Simular' : '¿Mover a la papelera?', lines.join('\n') + `\n${rangeLabel(DAYS)}`, dry ? 'Simular' : 'Mover', !dry))) return;
  if (del.length && !(await startJob('/api/execute', { daysBack: DAYS, emails: del.map(s => s.email), dryRun: dry }, 'execute'))) return;
  if (!dry) processUnsubs();
};

// ---------- SSE ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'line') addLine(m.lane, m.text, m.kind, m.ts);
    else if (m.t === 'metrics') onMetrics(m);
    else if (m.t === 'progress') { renderProgress(m.job); if (!m.job.running) { refreshPending(); renderSenders(); } }
    else if (m.t === 'senders') upsertSenders(m.list);
    else if (m.t === 'scanstart') { senders.clear(); unsubChoice.clear(); unsubState.clear(); FILTER = 'delete'; SHOWN = 150; upsertSenders(m.senders || []); renderSenders(); }
    else if (m.t === 'scandone') renderSenders();
    else if (m.t === 'config') { renderMain(m.config); }
    else if (m.t === 'runtime') renderRuntime(m.runtime);
  };
}

// ---------- ajustes ----------
let SET = null, PROV = 'gmail', GMODE = 'gmail-password';
const PASS_LINKS = { 'gmail-password': 'https://myaccount.google.com/apppasswords', yahoo: 'https://login.yahoo.com/account/security', icloud: 'https://account.apple.com/account/manage' };
function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.dataset.pane === name);
  $('sheetFoot').hidden = name === 'reglas';
  $('btnTest').hidden = name !== 'cuenta';
  if (name === 'reglas') loadRules().catch(e => toast(e.message, 'err'));
  if (name === 'ia') refreshRuntime();
}
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) selectTab(b.dataset.tab); });
function showKey() { return PROV === 'gmail' ? GMODE : PROV === 'custom' ? 'imap' : 'simple'; }
function renderAccountForm() {
  const prov = SET ? Object.entries(SET.presets) : [];
  $('providers').innerHTML = prov.map(([k, v]) => `<button type="button" class="prov" role="radio" data-p="${k}" aria-checked="${k === PROV}">${icon('mail')}${esc(k === 'custom' ? 'Otro' : v.label)}</button>`).join('');
  $('gmailMode').hidden = PROV !== 'gmail';
  for (const b of $('gmailMode').children) b.setAttribute('aria-checked', String(b.dataset.v === GMODE));
  const key = showKey();
  for (const el of document.querySelectorAll('[data-pane="cuenta"] [data-show]')) el.hidden = !el.dataset.show.split(' ').includes(key);
  $('f-pass-l').textContent = key === 'imap' ? 'Contraseña' : PROV === 'zoho' ? 'Contraseña' : 'Contraseña de aplicación';
  const link = PASS_LINKS[PROV === 'gmail' ? GMODE : PROV];
  $('f-pass-link').hidden = !link; if (link) $('f-pass-link').href = link;
}
$('f-pass-link').onclick = (e) => { e.preventDefault(); openExternal($('f-pass-link').href); };
$('providers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  PROV = b.dataset.p;
  const p = SET.presets[PROV];
  if (PROV !== 'gmail' && p && p.imap) { $('i-host').value = p.imap.host; $('i-port').value = p.imap.port; $('i-secure').checked = p.imap.secure; $('o-host').value = p.smtp.host; $('o-port').value = p.smtp.port; $('o-secure').checked = p.smtp.secure; }
  renderAccountForm();
});
$('gmailMode').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; GMODE = b.dataset.v; renderAccountForm(); });
function secretHint(id, has) { $(id).textContent = has ? 'Guardada · déjala vacía para no cambiarla' : ''; }

async function loadOllamaModels(selected) {
  const sel = $('l-model');
  try {
    const d = await api('GET', '/api/llm/models?url=' + encodeURIComponent($('l-url').value.trim()));
    const list = d.models.slice(); if (selected && !list.includes(selected)) list.unshift(selected);
    sel.innerHTML = list.length ? list.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('') : '<option value="">(sin modelos)</option>';
    sel.value = selected || list[0] || '';
  } catch (_) { sel.innerHTML = selected ? `<option>${esc(selected)}</option>` : ''; }
}
function renderProvider(p) {
  for (const b of $('provider').children) b.setAttribute('aria-checked', String(b.dataset.v === p));
  for (const el of document.querySelectorAll('[data-ollama]')) el.hidden = p !== 'ollama';
  $('models').hidden = p !== 'local';
  $('btnDl').hidden = p !== 'local' || !RT || !!(RT.models.find(m => m.id === RT.selected) || {}).installed;
}
$('provider').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  try {
    const d = await api('POST', '/api/runtime/use', { provider: b.dataset.v, model: $('l-model').value || undefined });
    SET.settings.llm.provider = b.dataset.v; renderMain(d.view); renderRuntime(d.runtime);
    if (b.dataset.v === 'ollama') loadOllamaModels(SET.settings.model);
  } catch (err) { toast(err.message, 'err'); }
});

async function loadSettings(keepTab) {
  SET = await api('GET', '/api/settings');
  const s = SET.settings, a = s.account, sec = SET.secrets;
  PROV = a.type === 'imap' ? (a.provider in SET.presets ? a.provider : 'custom') : 'gmail';
  GMODE = a.type === 'gmail-oauth' ? 'gmail-oauth' : 'gmail-password';
  $('f-email').value = a.email || ''; $('f-user').value = a.username || ''; $('f-pass').value = '';
  secretHint('f-pass-hint', sec.hasImapPassword && a.type !== 'gmail-oauth');
  $('i-host').value = a.imap.host; $('i-port').value = a.imap.port; $('i-secure').checked = a.imap.secure;
  $('o-host').value = a.smtp.host; $('o-port').value = a.smtp.port; $('o-secure').checked = a.smtp.secure;
  $('a-inbox').value = a.inboxFolder; $('a-trash').value = a.trashFolder;
  $('g-cid').value = s.google.clientId; $('g-secret').value = ''; secretHint('g-secret-hint', sec.hasGoogleClientSecret);
  const gOn = sec.googleConnected && a.type === 'gmail-oauth';
  $('g-status-t').textContent = gOn ? `Conectado como ${a.email}` : 'No conectado';
  $('btnGoogleOff').hidden = !sec.googleConnected;
  renderAccountForm();
  // IA
  $('l-url').value = s.ollamaUrl; $('l-think').checked = s.llm.think;
  $('l-dlow').value = s.llm.doubtLow; $('l-dhigh').value = s.llm.doubtHigh; $('l-tpred').value = s.llm.thinkNumPredict;
  $('l-ctx').value = s.llm.numCtx; $('l-par').value = s.llm.parallel; $('l-threads').value = s.local.threads;
  renderProvider(s.llm.provider);
  if (s.llm.provider === 'ollama') loadOllamaModels(s.model); else $('l-model').innerHTML = s.model ? `<option>${esc(s.model)}</option>` : '';
  // limpieza
  const c = s.cleaning;
  $('c-days').innerHTML = RANGES.map(([d, l]) => `<option value="${d}">${l}</option>`).join(''); $('c-days').value = String(c.daysBack);
  $('c-win').value = c.windowDays; $('c-chunk').value = c.fetchChunk; $('c-dureza').value = c.dureza; $('c-dureza-v').textContent = c.dureza;
  $('c-band').value = c.band; $('c-body').value = c.bodyMaxChars;
  $('c-conv').checked = c.protectConversations; $('c-unsub').checked = c.autoUnsub; $('c-dry').checked = c.dryRun; $('c-mine').value = c.myAddresses.join(', ');
  if (!keepTab) selectTab('cuenta');
}
$('c-dureza').oninput = () => { $('c-dureza-v').textContent = $('c-dureza').value; };
function collect() {
  const key = showKey(), s = SET.settings;
  const type = PROV === 'gmail' ? GMODE : 'imap';
  const email = type === 'gmail-oauth' ? s.account.email : $('f-email').value.trim();
  const settings = {
    port: s.port,
    account: {
      type, email, username: key === 'imap' ? $('f-user').value.trim() : '', provider: PROV === 'gmail' ? 'custom' : PROV,
      imap: { host: $('i-host').value.trim(), port: +$('i-port').value || 993, secure: $('i-secure').checked },
      smtp: { host: $('o-host').value.trim(), port: +$('o-port').value || 465, secure: $('o-secure').checked },
      inboxFolder: $('a-inbox').value.trim() || 'INBOX', trashFolder: $('a-trash').value.trim(),
    },
    google: { clientId: $('g-cid').value.trim() },
    ollamaUrl: $('l-url').value.trim(), model: $('l-model').value || s.model,
    llm: { provider: s.llm.provider, think: $('l-think').checked, doubtLow: +$('l-dlow').value, doubtHigh: +$('l-dhigh').value, thinkNumPredict: +$('l-tpred').value, numCtx: +$('l-ctx').value, thinkNumCtx: s.llm.thinkNumCtx, parallel: +$('l-par').value },
    local: { model: s.local.model, ctx: s.local.ctx, threads: +$('l-threads').value || 0 },
    cleaning: {
      daysBack: +$('c-days').value, windowDays: +$('c-win').value, fetchChunk: +$('c-chunk').value, dureza: +$('c-dureza').value, band: +$('c-band').value, bodyMaxChars: +$('c-body').value,
      protectConversations: $('c-conv').checked, autoUnsub: $('c-unsub').checked, dryRun: $('c-dry').checked, myAddresses: $('c-mine').value,
    },
  };
  if (PROV !== 'gmail' && PROV !== 'custom') {
    const p = SET.presets[PROV];
    if (p && p.imap) { settings.account.imap = { ...p.imap }; settings.account.smtp = { ...p.smtp }; }
  }
  const pass = type === 'gmail-oauth' ? '' : $('f-pass').value;
  return { settings, secrets: { imapPassword: pass, googleClientSecret: $('g-secret').value } };
}
async function testConnection() {
  const btn = $('btnTest'); btn.disabled = true;
  $('t-res').innerHTML = `<div>${icon('rotate', 'sm')}Probando…</div>`;
  try {
    const r = await api('POST', '/api/settings/test', collect());
    const line = (name, x, okText) => x ? `<div class="${x.ok ? (x.warning ? 'warn' : 'ok') : 'bad'}">${icon(x.ok ? (x.warning ? 'alert' : 'check') : 'x', 'sm')}<span><b>${name}</b> · ${esc(x.ok ? okText(x) : x.error)}${x.ok && x.warning ? ' · ' + esc(x.warning) : ''}</span></div>` : '';
    $('t-res').innerHTML = line('Correo', r.mail, x => `${fmt(x.inboxCount)} correos en ${x.inbox}`)
      + (r.mail && !r.mail.ok && r.mail.warning ? `<div class="bad">${icon('alert', 'sm')}<span>${esc(r.mail.warning)}</span></div>` : '')
      + line('Bajas por correo', r.smtp, () => 'listo')
      + line('IA', r.llm, x => x.local ? x.model : `Ollama ${x.version}`);
    if (r.mail && r.mail.folders) $('folders').innerHTML = r.mail.folders.map(f => `<option value="${esc(f)}">`).join('');
    return r;
  } catch (e) { $('t-res').innerHTML = `<div class="bad">${icon('x', 'sm')}<span>${esc(e.message)}</span></div>`; }
  finally { btn.disabled = false; }
}
$('btnTest').onclick = testConnection;
$('btnSave').onclick = async () => {
  const btn = $('btnSave'); btn.disabled = true;
  try {
    const onAccount = document.querySelector('.tabs [aria-selected="true"]').dataset.tab === 'cuenta';
    await api('POST', '/api/settings', collect());
    toast('Guardado', 'ok', 2500);
    await loadSettings(true); renderMain(await api('GET', '/api/config'));
    if (onAccount && SET.settings.account.type !== 'none') testConnection();
  } catch (e) { toast(e.message, 'err', 7000); }
  finally { btn.disabled = !!JOB.running; }
};
$('btnGoogle').onclick = async () => {
  try {
    const d = await api('POST', '/api/oauth/google/start', { clientId: $('g-cid').value.trim(), clientSecret: $('g-secret').value.trim() });
    openExternal(d.authUrl);
    $('g-status-t').textContent = 'Esperando que aceptes en Google…';
  } catch (e) { toast(e.message, 'err'); }
};
$('btnGoogleOff').onclick = async () => {
  if (!(await ask('¿Desconectar Google?', 'NoniMail pierde el acceso a tu correo.', 'Desconectar', true))) return;
  try { await api('POST', '/api/oauth/google/disconnect', {}); await loadSettings(true); renderMain(await api('GET', '/api/config')); } catch (e) { toast(e.message, 'err'); }
};

// IA integrada
async function refreshRuntime() { try { renderRuntime(await api('GET', '/api/runtime')); } catch (_) {} }
function renderRuntime(rt) {
  RT = rt; renderSetup();
  if (!SET) return;
  $('ram').textContent = `RAM ${String(rt.ram.totalGB).replace('.', ',')} GB`;
  $('models').innerHTML = rt.models.map(m => `<div class="model" role="radio" tabindex="0" data-m="${m.id}" aria-checked="${m.id === rt.selected}" aria-disabled="${!m.fits}">
      <span class="radio" aria-hidden="true"></span>
      <div><b>${esc(m.label)}</b>${m.id === rt.recommended ? ' <span class="tag info">Recomendado</span>' : ''}<div class="xs muted">${fmtMB(m.sizeMB * 1048576)}${m.fits ? '' : ` · necesita ${m.minRamGB} GB de RAM`}</div></div>
      ${m.installed ? `<span class="tag keep">${icon('check', 'sm')}Lista</span>` : ''}
    </div>`).join('');
  const dl = rt.download;
  $('dl').hidden = !dl;
  if (dl) {
    const p = Math.floor(100 * dl.done / dl.total);
    $('dl-txt').textContent = dl.error ? `Interrumpida: ${dl.error}` : `${p}% · ${fmtMB(dl.done)} de ${fmtMB(dl.total)}${dl.bps ? ` · ${fmtMB(dl.bps)}/s` : dl.retry ? ' · reconectando…' : ''}`;
    $('dl-bar').firstElementChild.style.width = p + '%'; $('dl-bar').setAttribute('aria-valuenow', String(p));
    $('dl-cancel').hidden = !!dl.error;
  }
  renderProvider(SET.settings.llm.provider);
  const sel = rt.models.find(m => m.id === rt.selected);
  $('btnDl').hidden = SET.settings.llm.provider !== 'local' || !sel || sel.installed || (dl && !dl.error);
  $('btnDl').lastChild.textContent = dl && dl.error ? 'Reintentar' : sel ? `Descargar ${fmtMB(sel.sizeMB * 1048576)}` : 'Descargar';
}
$('models').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-m]'); if (!el || el.getAttribute('aria-disabled') === 'true') return;
  try { const d = await api('POST', '/api/runtime/use', { provider: 'local', id: el.dataset.m }); SET.settings.local.model = el.dataset.m; renderMain(d.view); renderRuntime(d.runtime); } catch (err) { toast(err.message, 'err'); }
});
$('models').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.m) { e.preventDefault(); e.target.click(); } });
$('btnDl').onclick = async () => { try { renderRuntime(await api('POST', '/api/runtime/download', { id: RT.selected })); } catch (e) { toast(e.message, 'err'); } };
$('dl-cancel').onclick = async () => { try { renderRuntime(await api('POST', '/api/runtime/cancel', {})); } catch (e) { toast(e.message, 'err'); } };
$('btnRemoveModel').onclick = async () => {
  const m = RT && RT.models.find(x => x.id === RT.selected);
  if (!m || !m.installed) return toast('No hay modelo descargado', 'info');
  if (!(await ask(`¿Borrar ${m.label}?`, `Libera ${fmtMB(m.sizeMB * 1048576)}. Se puede volver a descargar.`, 'Borrar', true))) return;
  try { renderRuntime(await api('POST', '/api/runtime/remove', { id: m.id })); } catch (e) { toast(e.message, 'err'); }
};
$('btnLlmTest').onclick = async () => {
  const btn = $('btnLlmTest'); btn.disabled = true;
  $('l-test').innerHTML = `<div>${icon('rotate', 'sm')}Probando… la primera vez carga el modelo</div>`;
  try {
    const r = await api('POST', '/api/llm/test', { provider: SET.settings.llm.provider, ollamaUrl: $('l-url').value.trim(), model: $('l-model').value, think: $('l-think').checked, thinkNumPredict: +$('l-tpred').value });
    const rows = (r.results || []).map(x => `<div>${icon(x.expect === 'alto' ? 'trash' : 'check', 'sm')}<span>${x.expect === 'alto' ? 'Promoción' : 'Correo personal'}: <b class="num">${x.score ?? '?'}</b> · ${(x.ms / 1000).toFixed(1).replace('.', ',')} s</span></div>`).join('');
    $('l-test').innerHTML = rows + `<div class="${r.ok ? 'ok' : 'bad'}">${icon(r.ok ? 'check' : 'x', 'sm')}<span>${r.ok ? 'Distingue bien' : esc(r.error)}</span></div>`
      + (r.think ? `<div class="${r.think.ok ? 'ok' : 'bad'}">${icon(r.think.ok ? 'check' : 'x', 'sm')}<span>Pensando: ${r.think.ok ? `${r.think.score ?? '?'} en ${(r.think.ms / 1000).toFixed(1)} s` : esc(r.think.error)}</span></div>` : '');
  } catch (e) { $('l-test').innerHTML = `<div class="bad">${icon('x', 'sm')}<span>${esc(e.message)}</span></div>`; }
  btn.disabled = false;
};

// reglas
function regexToKeywords(p) {
  p = (p || '').trim().replace(/^\((.*)\)$/s, '$1');
  return p.split('|').map(t => t.replace(/\\b/g, '').replace(/\(\?:[^)]*\)/g, '').replace(/\\s\*/g, ' ').replace(/\\s/g, ' ').replace(/\\d\{[^}]*\}/g, '#').replace(/\\d/g, '#').replace(/\[[^\]]*\]/g, m => m.replace(/[[\]]/g, '')).replace(/\\/g, '').replace(/[()?*+]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const kwHtml = (arr) => [...new Set(arr)].map(k => `<span>${esc(k)}</span>`).join('');
async function loadRules() {
  const d = await api('GET', '/api/rules');
  $('kw-keep').innerHTML = kwHtml(regexToKeywords(d.keepOverride));
  $('kw-del').innerHTML = kwHtml([...regexToKeywords(d.subject), ...regexToKeywords(d.from), ...regexToKeywords(d.body)]);
  $('prompt-box').textContent = d.promptTemplate;
  $('ed-keep').value = d.keepOverride; $('ed-subj').value = d.subject; $('ed-from').value = d.from; $('ed-body').value = d.body; $('ed-prompt').value = d.llmPrompt;
}
function editRules(on) { $('rulesView').hidden = on; $('rulesEdit').hidden = !on; }
$('btnEditRules').onclick = () => editRules(true);
$('btnCancelRules').onclick = () => { editRules(false); loadRules(); };
$('btnSaveRules').onclick = async () => {
  try {
    await api('POST', '/api/rules', { keepOverride: $('ed-keep').value, subject: $('ed-subj').value, from: $('ed-from').value, body: $('ed-body').value, llmPrompt: $('ed-prompt').value });
    toast('Reglas guardadas', 'ok', 2500); editRules(false); loadRules();
  } catch (e) { toast(e.message, 'err', 7000); }
};

// hoja
let lastFocus = null;
async function openSettings(tab) {
  lastFocus = document.activeElement;
  $('t-res').innerHTML = ''; $('l-test').innerHTML = '';
  $('sheet').classList.add('open'); $('sheetBack').classList.add('open');
  try { await loadSettings(); await refreshRuntime(); if (tab) selectTab(tab); } catch (e) { toast(e.message, 'err'); }
  $('sheetClose').focus();
}
function closeSettings() { $('sheet').classList.remove('open'); $('sheetBack').classList.remove('open'); editRules(false); if (lastFocus) lastFocus.focus(); }
$('btnSettings').onclick = () => openSettings();
$('sheetClose').onclick = closeSettings;
$('sheetBack').onclick = closeSettings;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('sheet').classList.contains('open') && !$('dlg').open) closeSettings(); });
// botón Atrás de Android: true si la app lo usó
window.noniBack = () => {
  if ($('dlg').open) { $('dlg').close('no'); return true; }
  if ($('sheet').classList.contains('open')) { closeSettings(); return true; }
  return false;
};

// ---------- arranque ----------
(async function boot() {
  renderRanges(); renderLevels(); setTerms(termPref(), false);
  connect();
  try {
    const c = await api('GET', '/api/config');
    DAYS = QUICK.includes(c.cleaning.daysBack) ? c.cleaning.daysBack : 30; renderRanges();
    LEVEL = nearestLevel(c.cleaning.dureza); renderLevels();
    $('dryRun').checked = c.cleaning.dryRun; $('autoUnsub').checked = c.cleaning.autoUnsub;
    renderMain(c);
    await refreshRuntime();
    renderProgress(c.job); renderBanner(c.pending);
    const d = await api('GET', '/api/senders');
    if (d.senders.length) { upsertSenders(d.senders); if (d.daysBack != null) { DAYS = d.daysBack; renderRanges(); } }
    renderSenders();
    if (c.account.type === 'none') openSettings('cuenta');
  } catch (e) { toast(`No se pudo cargar: ${e.message}`, 'err', 10000); }
})();
