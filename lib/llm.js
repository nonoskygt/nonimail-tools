'use strict';
// Puntaje de "ruido" 0-100 por correo, rápido (sin pensar) o pensando (para los dudosos).
// Dos motores: la IA integrada (llama-server local, ver runtime.js) u Ollama.

function base(url) { return String(url || '').replace(/\/+$/, ''); }

let RUNTIME = null;
function useRuntime(rt) { RUNTIME = rt; }
const isLocal = (cfg) => cfg.llm.provider === 'local';
// nombre visible del modelo en uso
function modelLabel(cfg) {
  if (!isLocal(cfg)) return cfg.model || '';
  const m = RUNTIME && RUNTIME.selected();
  return m ? m.label : '';
}
// ¿hay con qué puntuar? (sin arrancar nada)
function configured(cfg) {
  if (!isLocal(cfg)) return !!cfg.model;
  return !!(RUNTIME && RUNTIME.status().ready);
}

// { ok:true, text } | { ok:true, text:null } (respuesta vacía) | { ok:false, error }
async function generate(cfg, prompt, opts = {}) {
  return isLocal(cfg) ? generateLocal(cfg, prompt, opts) : generateOllama(cfg, prompt, opts);
}

// IA integrada. Qwen 3.5 es un modelo híbrido: llama-server solo reutiliza el prompt desde un
// "checkpoint", así que se procesa una vez la parte fija (instrucciones, hasta "Email:") y cada
// correo solo procesa lo suyo. Pasa de ~4 s a <1 s por remitente en CPU.
const EMAIL_MARK = '\n\nEmail:\n';
const TPL = new Map();  // `${url}|${think}` → { head, tail } de la plantilla de chat del modelo
const WARM = new Map(); // url → { prefix, n, stale }

async function post(url, path, body, timeoutMs) {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && (j.error.message || j.error)) || `la IA respondió HTTP ${r.status}`);
  return j;
}
async function chatTemplate(url, think) {
  const k = `${url}|${think}`;
  if (TPL.has(k)) return TPL.get(k);
  const MARK = '\u0001NONIMAIL\u0001';
  const j = await post(url, '/apply-template', { messages: [{ role: 'user', content: MARK }], chat_template_kwargs: { enable_thinking: !!think } }, 10000);
  const i = String(j.prompt || '').indexOf(MARK);
  if (i < 0) throw new Error('la plantilla del modelo no es compatible');
  const t = { head: j.prompt.slice(0, i), tail: j.prompt.slice(i + MARK.length) };
  TPL.set(k, t);
  return t;
}
async function warm(url, prefix) {
  const w = WARM.get(url);
  if (w && w.prefix === prefix && !w.stale) return w;
  // la primera vez procesa ~450 tokens: en un celular o PC viejos puede tardar
  const j = await post(url, '/completion', { prompt: prefix, n_predict: 1, temperature: 0, cache_prompt: true }, 600000);
  const n = (j.timings ? (j.timings.prompt_n || 0) + (j.timings.cache_n || 0) : 0);
  const nw = { prefix, n, stale: false };
  WARM.set(url, nw);
  return nw;
}

async function generateLocal(cfg, prompt, { think = false, timeoutMs } = {}) {
  const L = cfg.llm;
  let url;
  try { url = await RUNTIME.ensure(); } catch (e) { return { ok: false, error: e.message, fatal: !!e.fatal }; }
  let j;
  try {
    const t = await chatTemplate(url, think);
    const cut = prompt.indexOf(EMAIL_MARK);
    const w = cut > 0 ? await warm(url, t.head + prompt.slice(0, cut + EMAIL_MARK.length)) : null;
    j = await post(url, '/completion', { prompt: t.head + prompt + t.tail, n_predict: think ? L.thinkNumPredict : 6, temperature: 0, cache_prompt: true },
      timeoutMs || (think ? 300000 : 180000));
    if (w && j.timings && (j.timings.cache_n || 0) < w.n - 4) w.stale = true; // se perdió el checkpoint: recalentar en el próximo
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' || e.cause ? `la IA local no responde (${e.cause?.code || e.name})` : e.message };
  }
  let text = String(j.content || '');
  const limit = j.stop_type === 'limit' || j.stopped_limit === true;
  if (think) {
    const k = text.indexOf('</think>');
    if (k < 0) return limit ? { ok: true, text: null, truncated: true } : { ok: true, text: text.trim() || null };
    text = text.slice(k + 8);
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { ok: true, text: text || null };
}

async function generateOllama(cfg, prompt, { think = false, timeoutMs } = {}) {
  const L = cfg.llm;
  const body = think
    ? { model: cfg.model, prompt, stream: false, think: true, options: { temperature: 0, num_predict: L.thinkNumPredict, num_ctx: L.thinkNumCtx } }
    : { model: cfg.model, prompt: prompt + '\n/no_think', stream: false, think: false, options: { temperature: 0, num_predict: 16, num_ctx: L.numCtx } };
  let j;
  try {
    const r = await fetch(`${base(cfg.ollamaUrl)}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || (think ? 300000 : 120000)),
    });
    j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, error: j.error || `Ollama respondió HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: `Ollama no responde en ${cfg.ollamaUrl} (${e.cause?.code || e.name})` };
  }
  // la respuesta final manda; el razonamiento menciona "Puntaje (0-100)" y otros números que no son el veredicto
  const resp = (j.response || '').trim();
  if (resp) return { ok: true, text: resp };
  if (think && j.done_reason === 'length') return { ok: true, text: null, truncated: true }; // se cortó pensando: no adivinar
  return { ok: true, text: think ? (j.thinking || null) : null };
}

function parseScore(txt, fallback) {
  if (txt == null) return fallback;
  // 1) número tras "respuesta/puntaje/score"
  let m = txt.match(/(?:respuesta|puntaje|puntuaci[oó]n|score)\s*[:=]?\s*\**\s*(\d{1,3})\b/i);
  if (m) { const n = +m[1]; if (n >= 0 && n <= 100) return n; }
  // 2) número en negrita **N**
  m = txt.match(/\*\*\s*(\d{1,3})\s*\*\*/);
  if (m) { const n = +m[1]; if (n >= 0 && n <= 100) return n; }
  // 3) limpiar "sobre 100 / de 100 / /100 / (0-100) / 0 a 100" y tomar el último número
  const t2 = txt.replace(/(sobre|de)\s*100/gi, ' ').replace(/\/\s*100/g, ' ').replace(/\b0\s*(-|a|to)\s*100\b/gi, ' ');
  const all = [...t2.matchAll(/\b(\d{1,3})\b/g)].map(x => +x[1]).filter(n => n >= 0 && n <= 100);
  return all.length ? all[all.length - 1] : fallback;
}

// El mismo cierre con o sin pensamiento: el razonamiento va en el canal de "thinking" del modelo.
// Pedir "razona" aquí contradice el "devolvé SOLO un número" del prompt base, y modelos como
// qwen3.5 se quedan discutiendo esa contradicción hasta agotar los tokens sin responder.
function buildPrompt(llmPrompt, { from, subjects, bulk, body }) {
  return `${llmPrompt}\n\nEmail:\nFROM: ${from}\nSUBJECT: ${(subjects || []).join(' | ')}\nBULK: ${bulk ? 'si' : 'no'}\nBODY: ${body || ''}\n\nPuntaje (0-100):`;
}

async function listModels(ollamaUrl) {
  try {
    const r = await fetch(`${base(ollamaUrl)}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return { ok: true, models: (j.models || []).map(m => m.name).sort() };
  } catch (e) {
    return { ok: false, models: [], error: `Ollama no responde en ${ollamaUrl}` };
  }
}

async function version(ollamaUrl) {
  try {
    const r = await fetch(`${base(ollamaUrl)}/api/version`, { signal: AbortSignal.timeout(5000) });
    return { ok: true, version: (await r.json()).version };
  } catch (e) { return { ok: false, error: `Ollama no responde en ${ollamaUrl}` }; }
}

const SAMPLES = [
  { name: 'promoción', expect: 'alto', from: 'Tienda <promo@tienda.example>', subjects: ['¡90% OFF solo hoy! Ofertas relámpago'], bulk: true, body: 'Aprovecha descuentos increíbles. Compra ahora. Darse de baja aquí.' },
  { name: 'personal', expect: 'bajo', from: 'Carlos Pérez <carlos@example.com>', subjects: ['Re: reunión del jueves'], bulk: false, body: 'Hola, confirmo la reunión del jueves a las 10. ¿Llevas tú la propuesta impresa?' },
];
// Prueba el modelo con dos correos de ejemplo: la promoción debe puntuar más alto que el personal.
async function testModel(cfg) {
  const results = [];
  for (const s of SAMPLES) {
    const t = Date.now();
    const r = await generate(cfg, buildPrompt(cfg.llmPrompt, s), { timeoutMs: 180000 });
    if (!r.ok) return { ok: false, error: r.error, results };
    results.push({ name: s.name, expect: s.expect, raw: r.text, score: parseScore(r.text, null), ms: Date.now() - t });
  }
  const [promo, pers] = results;
  const ok = promo.score != null && pers.score != null && promo.score > pers.score;
  // pensamiento: se prueba con un caso dudoso de verdad (con uno fácil, los modelos que piensan de más igual responden)
  let think = null;
  if (cfg.llm.think) {
    const t = Date.now();
    const r = await generate(cfg, buildPrompt(cfg.llmPrompt, DOUBT_SAMPLE), { think: true, timeoutMs: 300000 });
    const ms = Date.now() - t;
    think = !r.ok ? { ok: false, ms, error: r.error }
      : r.truncated ? { ok: false, ms, error: `no termina de pensar con ${cfg.llm.thinkNumPredict} tokens: desactivá "Pensar los dudosos" o subí el límite` }
      : { ok: true, ms, score: parseScore(r.text, null) };
  }
  return { ok, results, think, error: ok ? null : 'el modelo no distinguió la promoción del correo personal' };
}
const DOUBT_SAMPLE = { from: 'Nube <billing@nube.example>', subjects: ['Tu factura se genera el 1 de octubre | Nuevo: servidores con GPU con 20% de descuento'], bulk: true, body: 'Hola, tu próxima factura se generará el 1 de octubre. Además, probá nuestros nuevos servidores con GPU con 20% de descuento el primer mes.' };

module.exports = { generate, parseScore, buildPrompt, listModels, version, testModel, useRuntime, isLocal, modelLabel, configured, SAMPLES, DOUBT_SAMPLE };
