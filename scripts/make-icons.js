'use strict';
// Genera los íconos de la app desde public/assets/icon.svg:
//   build/icon.png (512) y build/icon.ico (16–256) para Windows, public/assets/icon-*.png,
//   y los mipmaps de Android (ícono clásico; el adaptativo es un vector en android/).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'icon.svg'));
const png = (size) => sharp(SVG, { density: 72 * size / 512 * 4 }).resize(size, size).png().toBuffer();

(async () => {
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), await png(512));
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), await pngToIco(await Promise.all(icoSizes.map(png))));
  for (const s of [32, 180, 192, 512]) fs.writeFileSync(path.join(ROOT, 'public', 'assets', `icon-${s}.png`), await png(s));
  const mip = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, s] of Object.entries(mip)) {
    const dir = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', `mipmap-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), await png(s));
  }
  console.log('íconos generados');
})().catch(e => { console.error(e); process.exit(1); });
