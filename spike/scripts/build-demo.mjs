// Builds a loadable demo so the spike can be checked by hand in a real Chrome install.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, readList, compact } from './lib.mjs';

const dir = join(ROOT, 'demo');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const domains = compact([
  ...(await readList('stevenblack-gambling-porn')),
  ...(await readList('hagezi-nsfw')),
  ...(await readList('hagezi-gambling-mini')),
]);
await writeFile(join(dir, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Harmgate demo', version: '0.0.1',
  description: 'Phase 0 demo: not a release.',
  permissions: ['declarativeNetRequest'],
  host_permissions: ['<all_urls>'],
  web_accessible_resources: [{ resources: ['block.html'], matches: ['<all_urls>'] }],
  declarative_net_request: { rule_resources: [{ id: 'core', enabled: true, path: 'rules.json' }] },
}, null, 2));
await writeFile(join(dir, 'rules.json'), JSON.stringify([{
  id: 1, priority: 1,
  action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
  condition: { requestDomains: ['harmgate-demo.test', ...domains], resourceTypes: ['main_frame', 'sub_frame'] },
}]));
await writeFile(join(dir, 'block.html'), `<!doctype html><html lang="tr"><meta charset="utf-8"><title>Harmgate</title>
<style>body{font:18px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f4f4f2;color:#222}
main{max-width:30rem;padding:16px;text-align:center}h1{font-size:1.6rem}</style>
<main><h1>Harmgate bu sayfayı engelledi</h1><p>Faz 0 demosu: engelleme çalışıyor.</p></main></html>`);
console.log(`demo built: ${domains.length + 1} domains in ${dir}`);
