'use strict';
// Prepara lo que el proyecto Android necesita y no va en git:
//   app/libnode/                    cabeceras y libnode.so de nodejs-mobile (Node 18) para compilar el puente JNI
//   app/src/main/jniLibs/arm64-v8a  libnode.so + llama-server (como libllama-server.so) y sus bibliotecas
//   app/src/main/assets/nodejs-project.zip  el servidor de NoniMail con sus dependencias de producción
// Requiere: vendor/.dl/nodejs-mobile-v18.20.4-android.zip y `node scripts/fetch-llama.js android-arm64`.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'android', 'app');
const NODEJS_MOBILE = { file: path.join(ROOT, 'vendor', '.dl', 'nodejs-mobile-v18.20.4-android.zip'), size: 57287354, sha256: 'bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af',
  url: 'https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip' };
const LLAMA = path.join(ROOT, 'vendor', 'llama', 'android-arm64');
const ABI = 'arm64-v8a';

function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function fresh(d) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

// zip mínimo (deflate) sin dependencias
function writeZip(out, entries) {
  const parts = [], central = [];
  let off = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8'), body = zlib.deflateRawSync(data, { level: 9 }), crc = zlib.crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    parts.push(h, n, body);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, n);
    off += h.length + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  fs.writeFileSync(out, Buffer.concat([...parts, cd, e]));
}
// nodejs-mobile viene sin ICU completo: las regex con propiedades Unicode (\p{...}) no compilan y Node
// no arranca. imapflow usa \p{Diacritic} para quitar tildes de su nombre de cliente: con NFD alcanza con
// el bloque de marcas combinantes.
function patchForSmallIcu(rel, buf) {
  if (!/imap-flow\.js$/.test(rel)) return buf;
  const src = buf.toString('utf8'), out = src.split('/\\p{Diacritic}/gu').join('/[\\u0300-\\u036f]/g');
  if (out === src) throw new Error(`${rel}: no se encontró \\p{Diacritic} (¿cambió imapflow?); revisar el parche`);
  return Buffer.from(out, 'utf8');
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]);

function main() {
  // 1) nodejs-mobile
  const z = NODEJS_MOBILE;
  if (!fs.existsSync(z.file)) throw new Error(`falta ${path.relative(ROOT, z.file)} (bajalo de ${z.url})`);
  if (fs.statSync(z.file).size !== z.size || sha256(z.file) !== z.sha256) throw new Error('nodejs-mobile no coincide con el sha256 esperado');
  const libnode = path.join(APP, 'libnode'); fresh(libnode);
  execFileSync('tar', ['-xf', z.file, '-C', libnode, 'include', `bin/${ABI}/libnode.so`], { stdio: 'inherit' });

  // 2) bibliotecas nativas
  const jni = path.join(APP, 'src', 'main', 'jniLibs', ABI); fresh(jni);
  fs.copyFileSync(path.join(libnode, 'bin', ABI, 'libnode.so'), path.join(jni, 'libnode.so'));
  if (!fs.existsSync(path.join(LLAMA, 'llama-server'))) throw new Error('falta llama-server: corré node scripts/fetch-llama.js android-arm64');
  for (const f of fs.readdirSync(LLAMA)) {
    if (f === 'VERSION' || f === 'libggml-rpc.so') continue;
    fs.copyFileSync(path.join(LLAMA, f), path.join(jni, f === 'llama-server' ? 'libllama-server.so' : f));
  }

  // 3) proyecto de Node
  const files = [];
  const add = (abs, rel) => files.push({ name: rel.split(path.sep).join('/'), data: patchForSmallIcu(rel, fs.readFileSync(abs)) });
  for (const f of ['server.js', 'config.example.json', 'package.json']) add(path.join(ROOT, f), f);
  add(path.join(ROOT, 'android', 'node', 'main.js'), 'main.js');
  for (const d of ['lib', 'public']) for (const f of walk(path.join(ROOT, d))) add(f, path.relative(ROOT, f));
  const mods = execSync('npm ls --omit=dev --all --parseable', { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter(p => p && p !== ROOT && p.includes('node_modules'));
  const skip = /[\\/](test|tests|docs?|examples?|\.github|benchmarks?)[\\/]|\.(md|map|ts)$|[\\/]LICENSE-?docs/i;
  for (const m of new Set(mods)) for (const f of walk(m)) { const rel = path.relative(ROOT, f); if (!skip.test(rel)) add(f, rel); }
  const assets = path.join(APP, 'src', 'main', 'assets'); fs.mkdirSync(assets, { recursive: true });
  writeZip(path.join(assets, 'nodejs-project.zip'), files);

  const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1);
  console.log(`listo: ${files.length} archivos en nodejs-project.zip (${mb(path.join(assets, 'nodejs-project.zip'))} MB), ${fs.readdirSync(jni).length} bibliotecas en jniLibs/${ABI}`);
}

try { main(); } catch (e) { console.error(e.message); process.exit(1); }
