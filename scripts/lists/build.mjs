// Downloads the source lists and generates the bundled rulesets and the files published for runtime refresh.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAllowlist, assignCategories, buildBlockRule, extensionIdFromKey, findCovered, parseList } from './core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_DIR = join(ROOT, 'public', 'rules');
const PUBLISH_DIR = join(ROOT, 'lists-out');

const { categories, sources } = JSON.parse(await readFile(join(ROOT, 'lists', 'sources.json'), 'utf8'));
const allowlist = parseList(await readFile(join(ROOT, 'lists', 'allowlist.txt'), 'utf8'));
const manifest = JSON.parse(await readFile(join(ROOT, 'public', 'manifest.json'), 'utf8'));
const extensionId = extensionIdFromKey(manifest.key, createHash);

const sets = Object.fromEntries(categories.map((c) => [c, new Set()]));
for (const source of sources) {
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`${source.id}: HTTP ${res.status}`);
  const domains = parseList(await res.text());
  if (domains.size < source.minDomains) throw new Error(`${source.id}: only ${domains.size} domains, expected at least ${source.minDomains}`);
  for (const d of domains) sets[source.category].add(d);
  console.log(`${source.id}: ${domains.size}`);
}
for (const d of parseList(await readFile(join(ROOT, 'lists', 'gore-extra.txt'), 'utf8'))) sets.gore.add(d);

const filtered = {};
for (const c of categories) {
  const { kept, removed, conflicts } = applyAllowlist(sets[c], allowlist);
  if (conflicts.length) throw new Error(`Allowlist conflict: ${JSON.stringify(conflicts)}`);
  if (removed.length) console.log(`${c}: allowlist removed ${removed.length}`);
  filtered[c] = kept;
}
const assigned = assignCategories(categories, filtered);

const covered = findCovered(parseList(await readFile(join(ROOT, 'lists', 'canaries.txt'), 'utf8')), assigned);
if (covered.length) throw new Error(`Canary sites would be blocked: ${JSON.stringify(covered)}`);

const version = new Date().toISOString();
await mkdir(RULES_DIR, { recursive: true });
await mkdir(PUBLISH_DIR, { recursive: true });
const meta = { version, categories: {} };
for (const c of categories) {
  const json = JSON.stringify(assigned[c]);
  await writeFile(join(RULES_DIR, `${c}.json`), JSON.stringify([buildBlockRule(c, assigned[c], extensionId)]));
  await writeFile(join(PUBLISH_DIR, `${c}.json`), json);
  meta.categories[c] = { count: assigned[c].length, sha256: createHash('sha256').update(json).digest('hex') };
  console.log(`=> ${c}: ${assigned[c].length} domains`);
}
await writeFile(join(PUBLISH_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
await writeFile(join(RULES_DIR, 'version.json'), JSON.stringify({ version, counts: Object.fromEntries(categories.map((c) => [c, assigned[c].length])) }));
console.log(`extension id: ${extensionId}, list version: ${version}`);
