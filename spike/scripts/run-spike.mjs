// Phase 0 spike. Measures how far declarativeNetRequest stretches with one huge requestDomains rule.
// Safety: browsers only ever navigate to synthetic *.test hosts and a local server. Real listed
// domains are only checked with testMatchOutcome, which evaluates rules without any network request.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, rm, writeFile, stat, readdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, readList, compact } from './lib.mjs';

const OUT = join(ROOT, '.out');
const LOG = join(OUT, 'results.jsonl');
const RESOURCE_TYPES = ['main_frame', 'sub_frame'];
const T = { first: 'harmgate-first.test', mid: 'harmgate-mid.test', last: 'harmgate-last.test' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withProbes(domains) {
  const mid = Math.floor(domains.length / 2);
  return [T.first, ...domains.slice(0, mid), T.mid, ...domains.slice(mid), T.last];
}

const sb = await readList('stevenblack-gambling-porn');
const nsfw = await readList('hagezi-nsfw');
const mini = await readList('hagezi-gambling-mini');
const medium = await readList('hagezi-gambling-medium');
const full = await readList('hagezi-gambling-full');
const SIZES = {
  'stevenblack': compact(sb),
  'sb+nsfw+mini': compact([...sb, ...nsfw, ...mini]),
  'sb+nsfw+medium': compact([...sb, ...nsfw, ...medium]),
  'sb+nsfw+full': compact([...sb, ...nsfw, ...full]),
};

// Local stand-in for the page people browse and for a list hosted on GitHub.
const lists = Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, JSON.stringify(withProbes(v))]));
const server = createServer((req, res) => {
  const m = req.url.match(/^\/list\/(.+)\.json/);
  if (m) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(lists[decodeURIComponent(m[1])]);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>ok</title>ok');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const LOCAL = `http://127.0.0.1:${PORT}`;

function makeKey() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  return { key: der.toString('base64'), id };
}

async function buildExtension(dir, { hostPermissions = ['<all_urls>'], rule, key }) {
  await mkdir(dir, { recursive: true });
  const manifest = {
    manifest_version: 3, name: 'Harmgate spike', version: '0.0.1',
    permissions: ['declarativeNetRequest', 'declarativeNetRequestFeedback'],
    host_permissions: hostPermissions,
    background: { service_worker: 'sw.js' },
    web_accessible_resources: [{ resources: ['block.html'], matches: ['<all_urls>'] }],
  };
  if (key) manifest.key = key;
  if (rule) {
    manifest.declarative_net_request = { rule_resources: [{ id: 'core', enabled: true, path: 'rules.json' }] };
    await writeFile(join(dir, 'rules.json'), JSON.stringify([rule]));
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'sw.js'), '// spike: driven from the test runner\n');
  await writeFile(join(dir, 'block.html'), '<!doctype html><title>Harmgate blocked</title><h1>Blocked</h1>');
}

async function launch(profile, ext) {
  const started = Date.now();
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--host-resolver-rules=MAP *.test ~NOTFOUND'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 300000 });
  return { context, worker, started, id: new URL(worker.url()).host };
}

async function probe(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    return { url: page.url(), error: null };
  } catch (e) {
    return { url: page.url(), error: (e.message.match(/net::[A-Z_]+/) || [e.message.slice(0, 80)])[0] };
  } finally { await page.close(); }
}

const blocked = (r) => r.url.startsWith('chrome-extension://') || r.error === 'net::ERR_BLOCKED_BY_CLIENT';

async function timeToFirstBlock(context, started, maxMs = 240000) {
  while (Date.now() - started < maxMs) {
    if (blocked(await probe(context, `http://${T.mid}/`))) return Date.now() - started;
    await sleep(250);
  }
  return null;
}

function memory(profile) {
  const rows = execSync('ps -axo pid=,ppid=,rss=,command=', { maxBuffer: 1 << 26 }).toString().split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }));
  const root = rows.find((r) => r.cmd.includes(profile) && !r.cmd.includes('--type='));
  if (!root) return null;
  const ids = new Set([root.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) if (!ids.has(r.pid) && ids.has(r.ppid)) { ids.add(r.pid); changed = true; }
  }
  const total = rows.filter((r) => ids.has(r.pid)).reduce((a, r) => a + r.rss, 0);
  return { browserMB: +(root.rss / 1024).toFixed(1), totalMB: +(total / 1024).toFixed(1) };
}

async function latency(context, n = 30) {
  const page = await context.newPage();
  const times = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await page.goto(`${LOCAL}/?i=${i}`, { waitUntil: 'commit' });
    times.push(performance.now() - t);
  }
  await page.close();
  times.sort((a, b) => a - b);
  return { medianMs: +times[Math.floor(n / 2)].toFixed(1), p95Ms: +times[Math.floor(n * 0.95)].toFixed(1) };
}

async function indexedSize(...dirs) {
  let size = 0;
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.startsWith('_ruleset') || e.name.includes('rules_ruleset')) size += (await stat(p)).size;
    }
  }
  for (const d of dirs) await walk(d);
  return +(size / 1e6).toFixed(2);
}

// Real listed domains: rule evaluation only, never navigated.
async function matchCheck(worker, sample) {
  return worker.evaluate(async (domains) => {
    let hit = 0; const misses = [];
    for (const d of domains) {
      const r = await chrome.declarativeNetRequest.testMatchOutcome({ url: `https://${d}/`, type: 'main_frame' });
      if (r.matchedRules.length) hit++; else misses.push(d);
    }
    const control = await chrome.declarativeNetRequest.testMatchOutcome({ url: 'https://example.com/', type: 'main_frame' });
    return { hit, total: domains.length, misses: misses.slice(0, 5), controlMatched: control.matchedRules.length };
  }, sample);
}

function sampleOf(list, n = 40) {
  const step = Math.max(1, Math.floor(list.length / n));
  return list.filter((_, i) => i % step === 0).slice(0, n);
}

async function record(obj) {
  console.log(JSON.stringify(obj));
  await appendFile(LOG, JSON.stringify(obj) + '\n');
}

async function scenario(name, fn) {
  const dir = join(OUT, name.replace(/[^a-z0-9.-]+/gi, '_'));
  await rm(dir, { recursive: true, force: true });
  const ext = join(dir, 'ext'); const profile = join(dir, 'profile');
  const t = Date.now();
  try { await record({ name, ...(await fn(ext, profile)), wallMs: Date.now() - t }); }
  catch (e) { await record({ name, failed: e.message.slice(0, 300), wallMs: Date.now() - t }); }
  await rm(dir, { recursive: true, force: true });
}

const redirectRule = (domains) => ({
  id: 1, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
  condition: { requestDomains: domains, resourceTypes: RESOURCE_TYPES },
});

await rm(LOG, { force: true });
await mkdir(OUT, { recursive: true });
const only = process.argv[2];
const want = (group) => !only || only === group;

// 1. Which permissions does the block page need?
if (want('perm')) {
  const small = [T.mid];
  const cases = [
    ['perm: redirect + <all_urls>', { hostPermissions: ['<all_urls>'], rule: redirectRule(small) }],
    ['perm: redirect, no host permission', { hostPermissions: [], rule: redirectRule(small) }],
    ['perm: block, no host permission', { hostPermissions: [], rule: { id: 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: small, resourceTypes: RESOURCE_TYPES } } }],
  ];
  for (const [name, cfg] of cases) {
    await scenario(name, async (ext, profile) => {
      await buildExtension(ext, cfg);
      const { context } = await launch(profile, ext);
      await sleep(1500);
      const r = await probe(context, `http://${T.mid}/`);
      const sub = await probe(context, `http://deep.sub.${T.mid}/`);
      const control = await probe(context, 'http://harmgate-unlisted.test/');
      await context.close();
      return { result: r, subdomain: sub, control };
    });
  }
}

// 2. Baseline, then static rulesets of growing size.
if (want('static')) {
  await scenario('static: baseline (no rules)', async (ext, profile) => {
    await buildExtension(ext, {});
    const { context } = await launch(profile, ext);
    await sleep(5000);
    const mem = memory(profile); const lat = await latency(context);
    await context.close();
    return { mem, lat };
  });
  for (const [label, domains] of Object.entries(SIZES)) {
    await scenario(`static: ${label} (${domains.length})`, async (ext, profile) => {
      const withP = withProbes(domains);
      await buildExtension(ext, { rule: redirectRule(withP) });
      const jsonMB = +((await stat(join(ext, 'rules.json'))).size / 1e6).toFixed(2);
      const first = await launch(profile, ext);
      const firstBlockMs = await timeToFirstBlock(first.context, first.started);
      const probes = {};
      for (const [k, host] of Object.entries(T)) probes[k] = blocked(await probe(first.context, `http://${host}/`));
      probes.subdomain = blocked(await probe(first.context, `http://a.b.${T.last}/`));
      probes.unlistedAllowed = !blocked(await probe(first.context, 'http://harmgate-unlisted.test/'));
      const match = await matchCheck(first.worker, sampleOf(domains));
      const avail = await first.worker.evaluate(() => chrome.declarativeNetRequest.getAvailableStaticRuleCount());
      const enabled = await first.worker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
      await sleep(5000);
      const mem = memory(profile); const lat = await latency(first.context);
      const indexedMB = await indexedSize(ext, profile);
      await first.context.close();
      const second = await launch(profile, ext);
      const restartBlockMs = await timeToFirstBlock(second.context, second.started);
      await sleep(3000);
      const memRestart = memory(profile);
      await second.context.close();
      return { jsonMB, indexedMB, firstBlockMs, restartBlockMs, probes, match, avail, enabled, mem, memRestart, lat };
    });
  }
}

// 3. Updating the list at runtime: fetch JSON as data, install it as a dynamic rule.
if (want('dynamic')) {
  for (const [label, domains] of Object.entries(SIZES)) {
    await scenario(`dynamic: ${label} (${domains.length})`, async (ext, profile) => {
      await buildExtension(ext, {});
      const a = await launch(profile, ext);
      const update = await a.worker.evaluate(async ({ url, types }) => {
        const t0 = performance.now();
        const domains = await (await fetch(url)).json();
        const t1 = performance.now();
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [{
            id: 1, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/block.html' } },
            condition: { requestDomains: domains, resourceTypes: types } }] });
          return { ok: true, fetchMs: Math.round(t1 - t0), updateMs: Math.round(performance.now() - t1) };
        } catch (e) { return { ok: false, error: String(e.message).slice(0, 200) }; }
      }, { url: `${LOCAL}/list/${encodeURIComponent(label)}.json`, types: RESOURCE_TYPES });
      if (!update.ok) { await a.context.close(); return { update }; }
      await sleep(1000);
      const blocksNow = blocked(await probe(a.context, `http://${T.last}/`));
      const match = await matchCheck(a.worker, sampleOf(domains));
      await sleep(5000);
      const mem = memory(profile); const lat = await latency(a.context);
      await a.context.close();
      const b = await launch(profile, ext);
      const restartBlockMs = await timeToFirstBlock(b.context, b.started, 60000);
      const kept = await b.worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.condition.requestDomains.length));
      await sleep(3000);
      const memRestart = memory(profile);
      await b.context.close();
      return { update, blocksNow, match, restartBlockMs, kept, mem, memRestart, lat };
    });
  }
}

// 4. Can the block page learn which site was blocked? Needed for "continue" and wrong-block reports.
if (want('regex')) {
  await scenario('regex: static, host passed to block page', async (ext, profile) => {
    const { key, id } = makeKey();
    const domains = withProbes(SIZES['sb+nsfw+mini']);
    await buildExtension(ext, { key, rule: {
      id: 1, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `chrome-extension://${id}/block.html?host=\\1` } },
      condition: { regexFilter: '^https?://([^/:?#]+).*$', requestDomains: domains, resourceTypes: RESOURCE_TYPES },
    } });
    const a = await launch(profile, ext);
    const firstBlockMs = await timeToFirstBlock(a.context, a.started);
    const r = await probe(a.context, `http://sub.${T.last}/path?x=1`);
    await sleep(3000);
    const mem = memory(profile); const lat = await latency(a.context);
    await a.context.close();
    return { idMatches: a.id === id, firstBlockMs, url: r.url.replace(id, '<id>'), error: r.error, mem, lat };
  });
}

server.close();
console.log('DONE');
