// Generates the extension icons from assets/icon.svg. Run this after changing the logo.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Share of each icon the art may fill. Chrome recommends a margin at large sizes, none at small ones.
const SIZES = { 16: 1, 32: 1, 48: 0.96, 128: 0.92 };

const svg = (await readFile(join(ROOT, 'assets', 'icon.svg'))).toString('base64');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
const icons = await page.evaluate(async ({ svg, sizes }) => {
  const image = new Image();
  image.src = `data:image/svg+xml;base64,${svg}`;
  await image.decode();
  const out = {};
  for (const [size, fill] of Object.entries(sizes)) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Number(size);
    const art = Number(size) * fill;
    const offset = (Number(size) - art) / 2;
    canvas.getContext('2d').drawImage(image, offset, offset, art, art);
    out[size] = canvas.toDataURL('image/png').split(',')[1];
  }
  return out;
}, { svg, sizes: SIZES });
await browser.close();
for (const [size, b64] of Object.entries(icons)) await writeFile(join(ROOT, 'public', 'icons', `icon-${size}.png`), Buffer.from(b64, 'base64'));
console.log(`icons written: ${Object.keys(icons).join(', ')}`);
