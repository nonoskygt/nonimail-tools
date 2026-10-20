'use strict';
// IA integrada sin modelo real: catálogo por RAM y llm.generate contra un llama-server falso.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MODELS, recommend, byId } = require('../lib/models');
const llm = require('../lib/llm');
const C = require('../lib/config');

test('el modelo recomendado depende de la RAM y el 4B nunca se elige solo', () => {
  assert.equal(recommend(3), null);
  assert.equal(recommend(3.8).id, 'qwen3.5-0.8b');
  assert.equal(recommend(7.7).id, 'qwen3.5-2b');
  assert.equal(recommend(64).id, 'qwen3.5-2b');
  assert.equal(byId('qwen3.5-4b').auto, false);
  for (const m of MODELS) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.match(m.url, /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//, 'URL fijada a un commit');
    assert.ok(m.size > 1e8);
  }
});

// llama-server falso: /apply-template y /completion con timings de caché
function fakeLlama() {
  const calls = [];
  const srv = http.createServer((q, r) => {
    let b = ''; q.on('data', c => b += c); q.on('end', () => {
      const j = b ? JSON.parse(b) : {};
      calls.push({ url: q.url, body: j });
      r.writeHead(200, { 'Content-Type': 'application/json' });
      if (q.url === '/apply-template') {
        const think = j.chat_template_kwargs && j.chat_template_kwargs.enable_thinking;
        return r.end(JSON.stringify({ prompt: `<|im_start|>user\n${j.messages[0].content}<|im_end|>\n<|im_start|>assistant\n${think ? '<think>\n' : '<think>\n\n</think>\n\n'}` }));
      }
      if (q.url === '/completion') {
        const warmup = j.n_predict === 1;
        const content = warmup ? 'X' : (/ofertas@/.test(j.prompt) ? '<think></think>92' : '3');
        return r.end(JSON.stringify({ content, stop_type: 'eos', timings: { prompt_n: warmup ? 400 : 40, cache_n: warmup ? 0 : 400 } }));
      }
      r.end('{}');
    });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() })));
}

test('generate local: aplica la plantilla del modelo, calienta la parte fija una vez y lee el puntaje', async () => {
  const f = await fakeLlama();
  llm.useRuntime({ ensure: async () => f.url, selected: () => byId('qwen3.5-2b'), status: () => ({ ready: true }) });
  try {
    const cfg = C.deepDefaults(C.DEFAULTS, { llmPrompt: 'Instrucciones fijas' });
    const p = (from) => llm.buildPrompt(cfg.llmPrompt, { from, subjects: ['x'], bulk: true, body: 'y' });
    const a = await llm.generate(cfg, p('Tienda <ofertas@t.com>'));
    const b = await llm.generate(cfg, p('Ana <ana@a.com>'));
    assert.deepEqual([a.text, b.text], ['92', '3']);
    assert.equal(llm.parseScore(a.text, null), 92);
    const warm = f.calls.filter(c => c.url === '/completion' && c.body.n_predict === 1);
    assert.equal(warm.length, 1, 'la parte fija se procesa una sola vez');
    assert.ok(warm[0].body.prompt.endsWith('\n\nEmail:\n'));
    const real = f.calls.filter(c => c.url === '/completion' && c.body.n_predict !== 1);
    assert.ok(real.every(c => c.body.prompt.startsWith(warm[0].body.prompt) && c.body.cache_prompt === true && c.body.temperature === 0));
    assert.ok(real[0].body.prompt.endsWith('<think>\n\n</think>\n\n'), 'sin pensar: plantilla con el bloque de pensamiento vacío');
    assert.equal(llm.modelLabel({ llm: { provider: 'local' } }), 'Qwen 3.5 · 2B');
  } finally { f.close(); llm.useRuntime(null); }
});

test('generate local: si el motor no arranca, el error es fatal y no se reintenta', async () => {
  llm.useRuntime({ ensure: async () => { throw Object.assign(new Error('Falta descargar el modelo'), { fatal: true }); } });
  const r = await llm.generate(C.deepDefaults(C.DEFAULTS, {}), 'hola');
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.match(r.error, /descargar/);
  llm.useRuntime(null);
});

test('config: la IA integrada es el motor por defecto y una config vieja con Ollama lo conserva', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-cfg-'));
  const ex = path.join(__dirname, '..', 'config.example.json');
  try {
    const fresh = C.loadConfig(path.join(dir, 'nuevo.json'), ex).cfg;
    assert.equal(fresh.llm.provider, 'local');
    assert.equal(fresh.llm.think, false);
    fs.writeFileSync(path.join(dir, 'viejo.json'), JSON.stringify({ model: 'qwen3.5:9b', ollamaUrl: 'http://localhost:11434' }));
    const old = C.loadConfig(path.join(dir, 'viejo.json'), ex).cfg;
    assert.equal(old.llm.provider, 'ollama');
    assert.equal(old.llm.think, true);
    // prompt por defecto de la 2.0 sin editar → se actualiza; uno editado se respeta
    const { execFileSync } = require('child_process');
    let v2 = null;
    try { v2 = JSON.parse(execFileSync('git', ['show', 'd10b7ef:config.example.json'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })).llmPrompt; } catch (_) {}
    if (v2) {
      fs.writeFileSync(path.join(dir, 'v2.json'), JSON.stringify({ model: 'm', llmPrompt: v2 }));
      assert.equal(C.loadConfig(path.join(dir, 'v2.json'), ex).cfg.llmPrompt, require(ex).llmPrompt);
      fs.writeFileSync(path.join(dir, 'mio.json'), JSON.stringify({ model: 'm', llmPrompt: v2 + '\nMi regla.' }));
      assert.match(C.loadConfig(path.join(dir, 'mio.json'), ex).cfg.llmPrompt, /Mi regla\.$/);
    }
    assert.deepEqual(C.validate(fresh), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
