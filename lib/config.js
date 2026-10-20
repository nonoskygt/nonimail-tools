'use strict';
// Configuración (sin secretos): valores por defecto, migración del formato 1.x, validación y guardado.
const fs = require('fs');
const { readJson, writeJsonAtomic } = require('./jsonfile');
const { compileRules } = require('./classify');

const ACCOUNT_TYPES = ['none', 'gmail-oauth', 'gmail-password', 'imap'];
const DEFAULTS_V2_THINK = true; // en 2.0 "pensar los dudosos" venía activado; con Ollama se respeta
// sha256 de los prompts por defecto anteriores (1.x y 2.0)
const OLD_DEFAULT_PROMPTS = ['6500c3b2654180ecffdc1679aeea08602a74c674f151e632a0a64ef266978f76'];
const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8765,
  account: {
    type: 'none',
    email: '',
    username: '',          // usuario IMAP/SMTP si no es el correo
    provider: 'custom',    // preset para type 'imap'
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    inboxFolder: 'INBOX',
    trashFolder: '',       // vacío = detectar la carpeta \Trash
  },
  google: { clientId: '' },
  ollamaUrl: 'http://localhost:11434',
  model: '',
  // provider: 'local' = IA integrada (llama-server + modelo descargado) · 'ollama' = Ollama en ollamaUrl
  llm: { provider: 'local', numCtx: 4096, parallel: 1, think: false, thinkNumPredict: 2048, thinkNumCtx: 8192, doubtLow: 35, doubtHigh: 65 },
  local: { model: '', ctx: 4096, threads: 0 }, // model vacío = el recomendado para la RAM del equipo
  cleaning: {
    // 1000 caracteres de cuerpo alcanzan para decidir y en CPU (o en el celular) la IA va varias veces más rápido
    daysBack: 30, windowDays: 30, fetchChunk: 100, dureza: 50, band: 12, bodyMaxChars: 1000,
    protectConversations: true, myAddresses: [], autoUnsub: true, dryRun: true,
  },
  heuristics: { keepOverride: '', subject: '', from: '', body: '' },
  llmPrompt: '',
};

// Lo que se edita desde el panel de Configuración (heurísticas y prompt van por "Reglas")
const SETTINGS_SHAPE = (({ heuristics, llmPrompt, ...rest }) => rest)(DEFAULTS);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// Copia de patch sobre target SOLO de las claves que existen en shape, convirtiendo al tipo de shape
function mergeKnown(shape, target, patch) {
  const out = clone(target);
  if (!isObj(patch)) return out;
  for (const k of Object.keys(shape)) {
    if (!(k in patch)) continue;
    const s = shape[k], v = patch[k];
    if (isObj(s)) out[k] = mergeKnown(s, isObj(out[k]) ? out[k] : clone(s), v);
    else if (Array.isArray(s)) out[k] = (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean);
    else if (typeof s === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    else if (typeof s === 'boolean') out[k] = v === true || v === 'true' || v === 1 || v === 'on';
    else out[k] = String(v ?? '').trim();
  }
  return out;
}

// Formato 1.x: claves sueltas, "defaults" y el puente de Apps Script (eliminado en 2.0)
function isLegacy(raw) {
  return isObj(raw) && ('gmailBridge' in raw || 'gmailKey' in raw || 'defaults' in raw || 'models' in raw || 'myAddresses' in raw);
}
function migrate(raw) {
  const out = {};
  for (const k of ['port', 'ollamaUrl', 'model', 'heuristics', 'llmPrompt']) if (k in raw) out[k] = raw[k];
  out.cleaning = {};
  if ('protectConversations' in raw) out.cleaning.protectConversations = raw.protectConversations;
  if (Array.isArray(raw.myAddresses)) out.cleaning.myAddresses = raw.myAddresses;
  if (raw.defaults && raw.defaults.bodyMaxChars) out.cleaning.bodyMaxChars = raw.defaults.bodyMaxChars;
  return out;
}

function deepDefaults(defaults, value) {
  if (!isObj(defaults)) return value === undefined ? clone(defaults) : value;
  const v = isObj(value) ? value : {}, out = {};
  for (const k of Object.keys(defaults)) out[k] = deepDefaults(defaults[k], v[k]); // orden estable de las claves
  for (const k of Object.keys(v)) if (!(k in out)) out[k] = v[k];
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validate(cfg) {
  const e = [];
  const int = (v, lo, hi, name) => { if (!Number.isInteger(v) || v < lo || v > hi) e.push(`${name} debe ser un entero entre ${lo} y ${hi}`); };
  int(cfg.port, 1024, 65535, 'Puerto');
  const a = cfg.account;
  if (!ACCOUNT_TYPES.includes(a.type)) e.push(`Tipo de cuenta inválido: ${a.type}`);
  if (a.type !== 'none' && !EMAIL.test(a.email)) e.push('Correo de la cuenta inválido');
  if (a.type === 'imap' && !a.imap.host) e.push('Falta el servidor IMAP');
  int(a.imap.port, 1, 65535, 'Puerto IMAP');
  int(a.smtp.port, 1, 65535, 'Puerto SMTP');
  if (!a.inboxFolder) e.push('Falta la carpeta a limpiar');
  if (!/^https?:\/\/[^\s]+$/i.test(cfg.ollamaUrl)) e.push('La dirección de Ollama debe empezar con http:// o https://');
  const L = cfg.llm;
  if (!['local', 'ollama'].includes(L.provider)) e.push(`Motor de IA inválido: ${L.provider}`);
  int(cfg.local.ctx, 1024, 32768, 'Contexto de la IA integrada'); int(cfg.local.threads, 0, 64, 'Hilos de la IA integrada');
  int(L.numCtx, 512, 262144, 'Contexto'); int(L.parallel, 1, 8, 'LLM en paralelo');
  int(L.thinkNumPredict, 64, 32768, 'Tokens de pensamiento'); int(L.thinkNumCtx, 512, 262144, 'Contexto al pensar');
  int(L.doubtLow, 0, 100, 'Duda desde'); int(L.doubtHigh, 0, 100, 'Duda hasta');
  if (L.doubtLow >= L.doubtHigh) e.push('El rango de duda debe ir de menor a mayor');
  const C = cfg.cleaning;
  int(C.daysBack, 0, 36500, 'Días hacia atrás'); int(C.windowDays, 1, 3650, 'Días por lote');
  int(C.fetchChunk, 10, 1000, 'Correos por bloque de lectura'); int(C.dureza, 0, 100, 'Dureza');
  int(C.band, 0, 50, 'Margen de duda'); int(C.bodyMaxChars, 100, 50000, 'Caracteres de cuerpo');
  for (const m of C.myAddresses) if (!EMAIL.test(m)) e.push(`Dirección inválida en "mis direcciones": ${m}`);
  try { compileRules(cfg.heuristics); } catch (err) { e.push(`Regla inválida: ${err.message}`); }
  return e;
}

// { cfg, created, migratedFrom } — si no hay config.json lo crea desde el ejemplo; si es 1.x lo migra con respaldo
function loadConfig(file, exampleFile) {
  const example = readJson(exampleFile, {});
  let raw = readJson(file, null), created = false, migratedFrom = null;
  if (!raw) { raw = example; created = true; }
  if (isLegacy(raw)) {
    migratedFrom = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    if (!created) fs.copyFileSync(file, migratedFrom); else migratedFrom = null;
    raw = migrate(raw);
  }
  // Las protecciones y el prompt que faltan salen de la plantilla: un config.json parcial
  // NO puede quedarse sin protección financiera ni sin prompt
  const base = deepDefaults(DEFAULTS, { heuristics: example.heuristics, llmPrompt: example.llmPrompt });
  // config de antes de la IA integrada con un modelo de Ollama elegido: sigue con Ollama (y con su "pensar")
  if (!created && isObj(raw) && raw.model && !(isObj(raw.llm) && raw.llm.provider)) {
    raw = { ...raw, llm: { think: DEFAULTS_V2_THINK, ...(isObj(raw.llm) ? raw.llm : {}), provider: 'ollama' } };
  }
  const cfg = deepDefaults(base, raw);
  if (!String(cfg.llmPrompt || '').trim()) cfg.llmPrompt = example.llmPrompt || ''; // un prompt vacío nunca es válido
  // el prompt por defecto de una versión anterior, sin editar, se actualiza al de ahora (uno editado no se toca)
  let promptUpgraded = false;
  if (example.llmPrompt && OLD_DEFAULT_PROMPTS.includes(sha256(cfg.llmPrompt.trim()))) { cfg.llmPrompt = example.llmPrompt; promptUpgraded = true; }
  if (created || migratedFrom || promptUpgraded) saveConfig(file, cfg);
  return { cfg, created, migratedFrom };
}
function saveConfig(file, cfg) { writeJsonAtomic(file, cfg); }

module.exports = { DEFAULTS, SETTINGS_SHAPE, ACCOUNT_TYPES, mergeKnown, migrate, isLegacy, deepDefaults, validate, loadConfig, saveConfig };
