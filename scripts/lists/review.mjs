// Prints listed domains that also rank among popular sites, for a person to read through.
// Usage: node scripts/lists/review.mjs <tranco-csv> [topN]. The ranking is an input only and is not redistributed.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [csv, top = '50000'] = process.argv.slice(2);
if (!csv) throw new Error('Usage: review.mjs <tranco-csv> [topN]');
const { categories } = JSON.parse(await readFile(join(ROOT, 'lists', 'sources.json'), 'utf8'));
const owner = new Map();
for (const c of categories) for (const d of JSON.parse(await readFile(join(ROOT, 'lists-out', `${c}.json`), 'utf8'))) owner.set(d, c);

function match(host) {
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (owner.has(h)) return { listed: h, category: owner.get(h) };
  return null;
}
const lines = (await readFile(csv, 'utf8')).split('\n').slice(0, Number(top));
const hits = [];
for (const line of lines) {
  const [rank, host] = line.trim().split(',');
  if (!host) continue;
  const m = match(host);
  if (m) hits.push({ rank: Number(rank), host, ...m });
}
for (const c of categories) console.log(`${c}: ${hits.filter((h) => h.category === c).length} of top ${top}`);
for (const h of hits) console.log(`${h.rank}\t${h.category}\t${h.host}${h.host === h.listed ? '' : ` (via ${h.listed})`}`);
