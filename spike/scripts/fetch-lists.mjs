// Downloads candidate blocklists as plain text and normalises them to one domain per line.
// The files are treated purely as data: nothing from them is executed or visited.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const SOURCES = {
  'stevenblack-gambling-porn': 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-porn-only/hosts',
  'hagezi-nsfw': 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/nsfw-onlydomains.txt',
  'hagezi-gambling-mini': 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/gambling.mini-onlydomains.txt',
  'hagezi-gambling-medium': 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/gambling.medium-onlydomains.txt',
  'hagezi-gambling-full': 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/gambling-onlydomains.txt',
};
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function parse(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim().toLowerCase();
    if (!line) continue;
    const token = line.split(/\s+/).at(-1);
    if (DOMAIN.test(token)) out.add(token);
  }
  return out;
}

await mkdir(DATA, { recursive: true });
for (const [name, url] of Object.entries(SOURCES)) {
  const res = await fetch(url);
  if (!res.ok) { console.log(`${name}: HTTP ${res.status} ${url}`); continue; }
  const text = await res.text();
  const domains = parse(text);
  await writeFile(join(DATA, `${name}.txt`), [...domains].join('\n'));
  console.log(`${name}: ${domains.size} domains (${(text.length / 1e6).toFixed(1)} MB raw)`);
}
