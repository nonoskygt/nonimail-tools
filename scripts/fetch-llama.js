'use strict';
// Descarga el motor de IA (llama-server de llama.cpp, binarios oficiales) y lo deja en vendor/llama/<plataforma>/.
//   node scripts/fetch-llama.js win32-x64     → para la app de Windows
//   node scripts/fetch-llama.js android-arm64 → para la app de Android (va a android/app/src/main/jniLibs)
// El archivo se verifica contra el sha256 publicado por GitHub antes de extraerlo.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TAG = 'b11748';
const ASSETS = {
  'win32-x64': { name: `llama-${TAG}-bin-win-cpu-x64.zip` },
  'android-arm64': { name: `llama-${TAG}-bin-android-arm64.tar.gz` },
};
const ROOT = path.join(__dirname, '..');

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nonimail-build', Accept: 'application/octet-stream, application/json' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 8) { res.resume(); return resolve(get(res.headers.location, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} en ${url}`)); }
      resolve(res);
    }).on('error', reject);
  });
}
async function getJson(url) { const r = await get(url); let b = ''; for await (const c of r) b += c; return JSON.parse(b); }

async function main() {
  const plat = process.argv[2] || `${process.platform}-${process.arch}`;
  const a = ASSETS[plat];
  if (!a) throw new Error(`plataforma sin binario: ${plat} (opciones: ${Object.keys(ASSETS).join(', ')})`);
  const rel = await getJson(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${TAG}`);
  const asset = rel.assets.find(x => x.name === a.name);
  if (!asset) throw new Error(`no está ${a.name} en ${TAG}`);
  const want = String(asset.digest || '').replace(/^sha256:/, '');
  const tmp = path.join(ROOT, 'vendor', '.dl'); fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, a.name);
  if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== want) {
    process.stdout.write(`descargando ${a.name} (${(asset.size / 1048576).toFixed(0)} MB)… `);
    const res = await get(asset.browser_download_url);
    await new Promise((ok, ko) => res.pipe(fs.createWriteStream(file)).on('finish', ok).on('error', ko));
    console.log('ok');
  }
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (want && got !== want) throw new Error(`sha256 no coincide (${got} ≠ ${want})`);
  const out = path.join(ROOT, 'vendor', 'llama', plat);
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const ex = path.join(tmp, `x-${plat}`); fs.rmSync(ex, { recursive: true, force: true }); fs.mkdirSync(ex, { recursive: true });
  execFileSync('tar', ['-xf', file, '-C', ex], { stdio: 'inherit' });
  // aplanar: el binario y sus bibliotecas quedan juntos
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(ex);
  const tools = /llama-(batched-bench|bench|cli|completion|fit-params|perplexity|quantize|mtmd-cli|tts|run|gguf-split|imatrix)/; // otras herramientas: no hacen falta
  const keep = (plat.startsWith('win')
    ? files.filter(f => /^llama-server\.exe$|\.dll$/i.test(path.basename(f)))
    : files.filter(f => /^llama-server$|\.so$/.test(path.basename(f)))).filter(f => !tools.test(path.basename(f)));
  for (const f of keep) fs.copyFileSync(f, path.join(out, path.basename(f)));
  fs.rmSync(ex, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'VERSION'), `llama.cpp ${TAG} (${a.name}, sha256 ${got})\n`);
  console.log(`${keep.length} archivos en vendor/llama/${plat}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
