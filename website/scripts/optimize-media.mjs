// Turns raw game captures into the responsive images the site serves.
//
//   node scripts/optimize-media.mjs <raw captures dir> [only-id]
//
// Reads media.config.json. For each image it crops (optional), then writes
// public/media/<id>-<width>.avif and .webp at each listed width, and records the
// size in src/content/media.json (used for width/height attributes and srcset).
// Videos are copied, and their poster is converted like an image. A video's "variants"
// are smaller H.264 cuts for small screens, made with ffmpeg (`brew install ffmpeg`):
// { suffix, vf (ffmpeg filter), crf } writes public/media/<id>-<suffix>.mp4.
// Also writes the social card (public/og.jpg) and the favicons from the app icon.
// Needs ImageMagick 7 with AVIF and WebP support (`brew install imagemagick`).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) {
  console.error('usage: node scripts/optimize-media.mjs <raw captures dir> [only-id]');
  process.exit(1);
}
const rawDir = resolve(process.argv[2]);
const only = process.argv[3];
const config = JSON.parse(readFileSync(join(root, 'media.config.json'), 'utf8'));
const outDir = join(root, 'public/media');
mkdirSync(outDir, { recursive: true });
const manifestPath = join(root, 'src/content/media.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

const magick = (...args) => execFileSync('magick', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const kb = (f) => Math.round(statSync(f).size / 1024);

function size(file, crop) {
  if (crop) {
    const m = /^(\d+)x(\d+)/.exec(crop);
    return { width: +m[1], height: +m[2] };
  }
  const [width, height] = magick('identify', '-format', '%w %h', file).split(' ').map(Number);
  return { width, height };
}

function encode(src, crop, w, base) {
  const pre = [src, ...(crop ? ['-crop', crop, '+repage'] : []), '-resize', `${w}x`, '-strip'];
  magick(...pre, '-define', 'heic:speed=4', '-quality', '58', `${base}.avif`);
  magick(...pre, '-define', 'webp:method=6', '-quality', '80', `${base}.webp`);
}

for (const item of config.images) {
  if (only && item.id !== only) continue;
  const src = join(rawDir, item.src);
  if (!existsSync(src)) {
    console.warn(`skip ${item.id}: missing ${src}`);
    continue;
  }
  const full = size(src, item.crop);
  const widths = item.widths.filter((w) => w <= full.width);
  if (!widths.length) widths.push(full.width);
  for (const w of widths) encode(src, item.crop, w, join(outDir, `${item.id}-${w}`));
  const top = widths.at(-1);
  manifest[item.id] = { width: top, height: Math.round((full.height * top) / full.width), widths };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${item.id}: ${widths.join(', ')} (largest avif ${kb(join(outDir, `${item.id}-${top}.avif`))} KB, webp ${kb(join(outDir, `${item.id}-${top}.webp`))} KB)`);
}

for (const v of config.videos ?? []) {
  if (only && v.id !== only) continue;
  for (const ext of ['mp4', 'webm']) {
    if (!v[ext]) continue;
    const src = join(rawDir, v[ext]);
    if (existsSync(src)) {
      copyFileSync(src, join(outDir, `${v.id}.${ext}`));
      console.log(`${v.id}.${ext}: ${kb(src)} KB`);
    }
  }
  const src = join(rawDir, v.mp4);
  for (const c of existsSync(src) ? (v.variants ?? []) : []) {
    const out = join(outDir, `${v.id}-${c.suffix}.mp4`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', c.vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(c.crf ?? 24), '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out]);
    console.log(`${v.id}-${c.suffix}.mp4: ${kb(out)} KB`);
  }
}

if (config.og && (!only || only === 'og')) {
  const src = join(rawDir, config.og.src);
  if (existsSync(src)) {
    magick(src, ...(config.og.crop ? ['-crop', config.og.crop, '+repage'] : []), '-resize', '1200x630^', '-gravity', 'center', '-extent', '1200x630', '-strip', '-quality', '84', join(root, 'public/og.jpg'));
    console.log(`og.jpg: ${kb(join(root, 'public/og.jpg'))} KB`);
  }
}

if (!only || only === 'icons') {
  const icon = join(root, '../src-tauri/icons/icon.png');
  magick(icon, '-resize', '32x32', join(root, 'public/favicon-32.png'));
  magick(icon, '-resize', '180x180', '-background', '#ebe8e0', '-flatten', join(root, 'public/apple-touch-icon.png'));
  magick(icon, '-resize', '96x96', join(root, 'public/mark-96.png'));
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
