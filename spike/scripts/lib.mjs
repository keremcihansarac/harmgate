import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');

export async function readList(name) {
  const text = await readFile(join(DATA, `${name}.txt`), 'utf8');
  return text.split('\n').filter(Boolean);
}

// requestDomains also matches subdomains, so a.b.com is redundant when b.com is listed.
export function compact(domains) {
  const set = new Set(domains);
  return [...set].filter((d) => {
    let i = d.indexOf('.');
    while (i !== -1) {
      const parent = d.slice(i + 1);
      if (parent.includes('.') && set.has(parent)) return false;
      i = d.indexOf('.', i + 1);
    }
    return true;
  });
}
