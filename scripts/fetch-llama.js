'use strict';
// Descarga el motor de IA (llama-server de llama.cpp, binarios oficiales) y lo deja en vendor/llama/<plataforma>/.
//   node scripts/fetch-llama.js win32-x64     → para la app de Windows
//   node scripts/fetch-llama.js android-arm64 → para la app de Android (va a android/app/src/main/jniLibs)
// El archivo se verifica contra el sha256 fijado aquí (el que publica GitHub para ese release) antes de
// extraerlo. Sin consultar la API de GitHub: sin token, su límite de pedidos corta la compilación.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TAG = 'b11748';
const ASSETS = {
  'win32-x64': { name: `llama-${TAG}-bin-win-cpu-x64.zip`, sha256: '59083a1df768be176d851ddbab6bbde2d8a67a1ea7f1d42f770753d13dc74f60' },
  'android-arm64': { name: `llama-${TAG}-bin-android-arm64.tar.gz`, sha256: '4263dc508454d35959b7bee9bfdeacf6dc9bf759c1b239cd7648bba64ccadbf8' },
};
const ROOT = path.join(__dirname, '..');
// en Windows, el tar del sistema (bsdtar abre .zip); el de Git Bash toma "C:" por un servidor remoto
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nonimail-build', Accept: 'application/octet-stream, application/json' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 8) { res.resume(); return resolve(get(res.headers.location, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} en ${url}`)); }
      resolve(res);
    }).on('error', reject);
  });
}

async function main() {
  const plat = process.argv[2] || `${process.platform}-${process.arch}`;
  const a = ASSETS[plat];
  if (!a) throw new Error(`plataforma sin binario: ${plat} (opciones: ${Object.keys(ASSETS).join(', ')})`);
  const want = a.sha256;
  const tmp = path.join(ROOT, 'vendor', '.dl'); fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, a.name);
  if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== want) {
    process.stdout.write(`descargando ${a.name}… `);
    const res = await get(`https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${a.name}`);
    await new Promise((ok, ko) => res.pipe(fs.createWriteStream(file)).on('finish', ok).on('error', ko));
    console.log('ok');
  }
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (got !== want) throw new Error(`sha256 no coincide (${got} ≠ ${want})`);
  const out = path.join(ROOT, 'vendor', 'llama', plat);
  const ex = path.join(tmp, `x-${plat}`); fs.rmSync(ex, { recursive: true, force: true }); fs.mkdirSync(ex, { recursive: true });
  execFileSync(TAR, ['-xf', file, '-C', ex], { stdio: 'inherit' });
  // recién con todo extraído se reemplaza la carpeta anterior (si falla, la vieja queda)
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
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
