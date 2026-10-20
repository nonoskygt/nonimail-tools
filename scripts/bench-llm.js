'use strict';
// Mide un modelo de la IA integrada con correos de ejemplo (sintéticos, sin datos reales).
//   NONIMAIL_DATA_DIR=<carpeta con models/> node scripts/bench-llm.js qwen3.5-2b [hilos]
// Error grave = un correo importante que quedaría para borrar (puntaje >= 60).
const path = require('path');
const fs = require('fs');
const C = require('../lib/config');
const llm = require('../lib/llm');
const { LocalRuntime } = require('../lib/runtime');

const { CASES } = require('../test/fixtures/emails');

async function main() {
  const id = process.argv[2] || 'qwen3.5-2b';
  const threads = +(process.argv[3] || 0);
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  const cfg = C.deepDefaults(C.DEFAULTS, { llmPrompt: example.llmPrompt, local: { model: id, threads, ctx: 4096 } });
  const rt = new LocalRuntime({ root: path.join(__dirname, '..'), dataDir: process.env.NONIMAIL_DATA_DIR, cfg: () => cfg, sse() {}, emit() {} });
  llm.useRuntime(rt);
  const t0 = Date.now(); await rt.ensure(); const load = Date.now() - t0;
  let ok = 0, n = 0, grave = 0; const lat = []; const rows = [];
  for (const c of CASES) {
    const t = Date.now();
    const r = await llm.generate(cfg, llm.buildPrompt(cfg.llmPrompt, { from: c.from, subjects: [c.subject], bulk: c.bulk, body: c.body }));
    const ms = Date.now() - t; lat.push(ms);
    const s = r.ok ? llm.parseScore(r.text, null) : null;
    const pass = c.want === 'promo' ? s >= 60 : c.want === 'keep' ? s <= 40 : true;
    if (c.want !== 'duda') { n++; if (pass) ok++; }
    if (c.want === 'keep' && s >= 60) grave++;
    rows.push(`${pass ? ' ' : 'X'} ${String(s).padStart(3)}  ${c.want.padEnd(5)} ${String(ms).padStart(5)}ms  ${c.subject.slice(0, 60)}`);
  }
  rt.stop();
  lat.sort((a, b) => a - b);
  console.log(rows.join('\n'));
  console.log(`\n${id}: acierto ${ok}/${n} (${Math.round(100 * ok / n)}%) · errores graves ${grave} · carga ${(load / 1000).toFixed(1)}s · mediana ${lat[lat.length >> 1]}ms · p90 ${lat[Math.floor(lat.length * 0.9)]}ms`);
}
main().catch(e => { console.error(e); process.exit(1); });

