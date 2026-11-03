// End-to-end tests against the built extension in Chromium.
// Safety: browsers only navigate to synthetic *.test hosts and a local server. Real listed domains
// are only evaluated with testMatchOutcome, which sends no network request.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Worker } from 'playwright';

const DIST = join(__dirname, '..', '..', 'dist');
const PROBES = { adult: 'harmgate-adult.test', gambling: 'harmgate-gambling.test', gore: 'harmgate-gore.test' } as const;
type Cat = keyof typeof PROBES;
const CATS = Object.keys(PROBES) as Cat[];
const UNLISTED = 'harmgate-unlisted.test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Server;
let base: string;
let served: Record<string, string> = {};
let realSample: string[] = [];

/** Copies the build, adds synthetic probes, and points refresh at the local server. Product code is unchanged. */
async function prepareExtension(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harmgate-ext-'));
  await cp(DIST, dir, { recursive: true });
  for (const c of CATS) {
    const path = join(dir, 'rules', `${c}.json`);
    const rules = JSON.parse(await readFile(path, 'utf8'));
    rules[0].condition.requestDomains.push(PROBES[c]);
    await writeFile(path, JSON.stringify(rules));
  }
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  manifest.permissions.push('declarativeNetRequestFeedback');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const files = [join(dir, 'background.js'), ...(await readdir(join(dir, 'chunks'))).map((f) => join(dir, 'chunks', f))];
  let patched = 0;
  for (const f of files) {
    const js = await readFile(f, 'utf8');
    if (!js.includes('/releases/download/lists')) continue;
    await writeFile(f, js.replace(/`\$\{[^}]+\}\/releases\/download\/lists`|"https:\/\/github\.com\/keremcihansarac\/harmgate\/releases\/download\/lists"/, JSON.stringify(`${base}/lists`)));
    patched++;
  }
  if (!patched) throw new Error('Could not find the list URL to patch');
  return dir;
}

interface Session { context: BrowserContext; worker: Worker; id: string; extDir: string; profile: string }

async function launch(extDir: string, profile: string): Promise<Session> {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--host-resolver-rules=MAP *.test ~NOTFOUND'],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker, id: new URL(worker.url()).host, extDir, profile };
}

async function visit(s: Session, url: string) {
  const page = await s.context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 15000 }).catch(() => undefined);
    return page.url();
  } finally {
    await page.close();
  }
}

/** The rule system applies shortly after a change, so poll for the expected outcome. */
async function expectBlocked(s: Session, host: string, want: boolean) {
  const deadline = Date.now() + 15000;
  let url = '';
  while (Date.now() < deadline) {
    url = await visit(s, `http://${host}/`);
    if (url.includes('/block.html') === want) return url;
    await sleep(200);
  }
  throw new Error(`${host}: expected blocked=${want}, last url ${url}`);
}

async function message(s: Session, msg: unknown): Promise<{ ok: boolean; error?: string; value?: any }> {
  const page = await s.context.newPage();
  await page.goto(`chrome-extension://${s.id}/options.html`);
  const reply = await page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await page.close();
  return reply;
}

/** Shifts a running wait into the past, so tests need not sit through 60 real seconds. */
async function finishWait(s: Session, key: string) {
  await s.worker.evaluate(async (k) => {
    const { state } = (await chrome.storage.local.get('state')) as { state: { pending: Record<string, number> } };
    state.pending[k] = Date.now() - 61_000;
    await chrome.storage.local.set({ state });
  }, key);
}

interface LastCheck { at: number; ok: boolean; error?: string }

/** Fires the real daily alarm and waits for the check it starts to finish. */
async function refreshNow(s: Session): Promise<LastCheck> {
  const before = Date.now();
  await s.worker.evaluate(() => chrome.alarms.create('lists-check', { when: Date.now() + 50 }));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const check = await s.worker.evaluate(async () => {
      const { state } = (await chrome.storage.local.get('state')) as { state?: { lastCheck: LastCheck | null } };
      return state?.lastCheck ?? null;
    });
    if (check && check.at >= before) return check;
    await sleep(100);
  }
  throw new Error('List check did not finish');
}

const enabledRulesets = (s: Session) => s.worker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());

/** A plausible list: large enough to pass the size check, using synthetic hosts only. */
const syntheticList = (...extra: string[]) => [...extra, ...Array.from({ length: 70_000 }, (_, i) => `d${i}.harmgate-list.test`)];

function publishList(version: string, lists: Partial<Record<Cat, string[]>>, tamper = false) {
  const categories: Record<string, { count: number; sha256: string }> = {};
  served = {};
  for (const [c, domains] of Object.entries(lists)) {
    const json = JSON.stringify(domains);
    served[`/lists/${c}.json`] = json;
    categories[c] = { count: domains.length, sha256: tamper ? '0'.repeat(64) : createHash('sha256').update(json).digest('hex') };
  }
  served['/lists/meta.json'] = JSON.stringify({ version, categories });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = served[req.url ?? ''];
    if (req.url?.startsWith('/lists/')) {
      res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
      return res.end(body ?? '');
    }
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>host</title><iframe id="f" src="http://${PROBES.adult}/"></iframe>`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>ok</title>ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const adult: string[] = JSON.parse(await readFile(join(DIST, 'rules', 'adult.json'), 'utf8'))[0].condition.requestDomains;
  const step = Math.floor(adult.length / 25);
  realSample = adult.filter((_, i) => i % step === 0).slice(0, 25);
});

afterAll(() => server.close());

describe('Harmgate extension', () => {
  const sessions: Session[] = [];
  const dirs: string[] = [];
  async function fresh() {
    const extDir = await prepareExtension();
    const profile = await mkdtemp(join(tmpdir(), 'harmgate-prof-'));
    dirs.push(extDir, profile);
    const s = await launch(extDir, profile);
    sessions.push(s);
    return s;
  }
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.context.close().catch(() => undefined);
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('blocks each category after install, passes host and category, and leaves other sites alone', async () => {
    const s = await fresh();
    for (const c of CATS) {
      const url = await expectBlocked(s, PROBES[c], true);
      expect(new URL(url).searchParams.get('c')).toBe(c);
      expect(new URL(url).searchParams.get('host')).toBe(PROBES[c]);
    }
    const sub = await expectBlocked(s, `deep.sub.${PROBES.gore}`, true);
    expect(new URL(sub).searchParams.get('host')).toBe(`deep.sub.${PROBES.gore}`);
    expect(await visit(s, `http://${UNLISTED}/`)).not.toContain('/block.html');
    expect(await visit(s, `${base}/`)).toBe(`${base}/`);
  });

  it('matches real listed domains without any network request', async () => {
    const s = await fresh();
    const result = await s.worker.evaluate(async (domains) => {
      let hits = 0;
      for (const d of domains) {
        const r = await chrome.declarativeNetRequest.testMatchOutcome({ url: `https://${d}/`, type: 'main_frame' as chrome.declarativeNetRequest.ResourceType });
        if (r.matchedRules.length) hits++;
      }
      const control = await chrome.declarativeNetRequest.testMatchOutcome({ url: 'https://wikipedia.org/', type: 'main_frame' as chrome.declarativeNetRequest.ResourceType });
      return { hits, control: control.matchedRules.length };
    }, realSample);
    expect(result).toEqual({ hits: realSample.length, control: 0 });
  });

  it('opens settings on install and reports every category as on', async () => {
    const s = await fresh();
    const deadline = Date.now() + 10000;
    while (!s.context.pages().some((p) => p.url().includes('options.html')) && Date.now() < deadline) await sleep(100);
    const page = s.context.pages().find((p) => p.url().includes('options.html'));
    expect(page).toBeDefined();
    await page!.locator('.card').first().waitFor();
    const text = await page!.locator('#categories').innerText();
    expect(text.match(/On ·/g)?.length).toBe(3);
    expect(text).not.toContain('Problem');
  });

  it('renders the block page in English with the host, and removes its buttons when framed', async () => {
    const s = await fresh();
    await expectBlocked(s, PROBES.gambling, true);
    const page = await s.context.newPage();
    await page.goto(`http://${PROBES.gambling}/`).catch(() => undefined);
    await page.locator('h1').waitFor();
    expect(await page.locator('h1').innerText()).toBe('This page is blocked');
    expect(await page.locator('#host').innerText()).toBe(PROBES.gambling);
    expect(await page.locator('#reason').innerText()).toContain('Gambling and betting');
    expect(await page.locator('#report').getAttribute('href')).toContain(`host=${PROBES.gambling}`);
    // Settings must stay out of reach from here, so that giving in takes more than one click.
    expect(await page.getByRole('button', { name: /settings/i }).count()).toBe(0);
    expect(await page.locator('a[href*="options.html"]').count()).toBe(0);
    await page.close();

    const host = await s.context.newPage();
    await host.goto(`${base}/frame`);
    const frame = host.frames().find((f) => f.url().includes('/block.html'));
    await sleep(500);
    const framed = frame ?? host.frames().find((f) => f.url().includes('/block.html'));
    expect(framed).toBeDefined();
    expect(await framed!.locator('#content').isVisible()).toBe(false);
    await host.close();
  });

  it('ignores a forged host on the block page', async () => {
    const s = await fresh();
    const page = await s.context.newPage();
    await page.goto(`chrome-extension://${s.id}/block.html?c=evil&host=${encodeURIComponent('<img src=x onerror=alert(1)>.com')}`);
    await page.locator('h1').waitFor();
    expect(await page.locator('#host').innerText()).toBe('');
    expect(await page.locator('#wrong').isVisible()).toBe(false);
    await page.close();
  });

  it('requires the wait to turn a category off, then keeps it off through restarts and reloads', async () => {
    const s = await fresh();
    await expectBlocked(s, PROBES.adult, true);
    expect((await message(s, { type: 'confirm-disable', category: 'adult' })).ok).toBe(false);
    const started = await message(s, { type: 'request-disable', category: 'adult' });
    expect(started.ok).toBe(true);
    expect(started.value.readyAt - started.value.now).toBeGreaterThan(55_000);
    const early = await message(s, { type: 'confirm-disable', category: 'adult' });
    expect(early.ok).toBe(false);
    expect(early.error).toContain('wait');
    await expectBlocked(s, PROBES.adult, true);

    await finishWait(s, 'disable:adult');
    expect((await message(s, { type: 'confirm-disable', category: 'adult' })).ok).toBe(true);
    await expectBlocked(s, PROBES.adult, false);
    await expectBlocked(s, PROBES.gambling, true);

    await s.context.close();
    const again = await launch(s.extDir, s.profile);
    sessions.push(again);
    await expectBlocked(again, PROBES.adult, false);
    await expectBlocked(again, PROBES.gambling, true);

    // An update: enabled rulesets go back to manifest defaults, so the saved choice has to be re-applied.
    await again.context.close();
    const manifestPath = join(s.extDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '9.9.9' }));
    const updated = await launch(s.extDir, s.profile);
    sessions.push(updated);
    expect(await updated.worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('9.9.9');
    await expectBlocked(updated, PROBES.adult, false);
    await expectBlocked(updated, PROBES.gambling, true);
    expect(await enabledRulesets(updated)).not.toContain('adult');

    expect((await message(updated, { type: 'enable', category: 'adult' })).ok).toBe(true);
    await expectBlocked(updated, PROBES.adult, true);
  });

  it('turns a category off through the settings page buttons', async () => {
    const s = await fresh();
    const page = await s.context.newPage();
    await page.goto(`chrome-extension://${s.id}/options.html`);
    const card = page.locator('.card', { hasText: 'Gambling and betting' });
    await card.getByRole('button', { name: 'Turn off…' }).click();
    await expect.poll(() => card.getByRole('button', { name: /^Turn off \(\d+s\)$/ }).isDisabled()).toBe(true);
    await card.getByRole('button', { name: 'Keep on' }).click();
    await card.getByRole('button', { name: 'Turn off…' }).waitFor();

    await card.getByRole('button', { name: 'Turn off…' }).click();
    await card.getByRole('button', { name: /^Turn off \(\d+s\)$/ }).waitFor();
    await finishWait(s, 'disable:gambling');
    await page.reload();
    await card.getByRole('button', { name: 'Turn off now' }).click();
    await card.getByRole('button', { name: 'Turn on' }).waitFor();
    await expectBlocked(s, PROBES.gambling, false);
    await card.getByRole('button', { name: 'Turn on' }).click();
    await expectBlocked(s, PROBES.gambling, true);
    await page.close();
  });

  it('allows a blocked site only after the wait, and can undo it', async () => {
    const s = await fresh();
    await expectBlocked(s, PROBES.adult, true);
    expect((await message(s, { type: 'confirm-allow', host: PROBES.adult })).ok).toBe(false);
    expect((await message(s, { type: 'request-allow', host: 'not a domain' })).ok).toBe(false);
    expect((await message(s, { type: 'request-allow', host: PROBES.adult })).ok).toBe(true);
    await finishWait(s, `allow:${PROBES.adult}`);
    expect((await message(s, { type: 'confirm-allow', host: PROBES.adult })).ok).toBe(true);
    await expectBlocked(s, PROBES.adult, false);
    await expectBlocked(s, PROBES.gambling, true);
    expect((await message(s, { type: 'remove-allow', host: PROBES.adult })).ok).toBe(true);
    await expectBlocked(s, PROBES.adult, true);
  });

  it('allows a site through the block page buttons', async () => {
    const s = await fresh();
    await expectBlocked(s, PROBES.gore, true);
    const page = await s.context.newPage();
    await page.clock.install();
    await page.goto(`http://${PROBES.gore}/`).catch(() => undefined);
    const allow = page.locator('#allow');
    await allow.waitFor();
    await allow.click();
    await expect.poll(() => allow.isDisabled()).toBe(true);
    expect(await allow.innerText()).toMatch(/\(\d+s\)/);
    await finishWait(s, `allow:${PROBES.gore}`);
    await page.clock.fastForward(61_000);
    await expect.poll(() => allow.innerText()).toBe(`Allow ${PROBES.gore} now`);
    await allow.click();
    await expectBlocked(s, PROBES.gore, false);
    await page.close();
  });

  it('refreshes a list at runtime, replaces the bundled one, and keeps it after a restart', async () => {
    const s = await fresh();
    await expectBlocked(s, PROBES.adult, true);
    publishList('2999-01-01T00:00:00.000Z', { adult: syntheticList('harmgate-new.test') });
    const check = await refreshNow(s);
    expect(check).toMatchObject({ ok: true });
    await expectBlocked(s, 'harmgate-new.test', true);
    await expectBlocked(s, PROBES.adult, false);
    await expectBlocked(s, PROBES.gambling, true);
    expect(await enabledRulesets(s)).not.toContain('adult');

    await s.context.close();
    const again = await launch(s.extDir, s.profile);
    sessions.push(again);
    await expectBlocked(again, 'harmgate-new.test', true);
    await expectBlocked(again, PROBES.adult, false);
    expect(await enabledRulesets(again)).not.toContain('adult');

    // Allowed sites outrank refreshed rules too.
    await message(again, { type: 'request-allow', host: 'harmgate-new.test' });
    await finishWait(again, 'allow:harmgate-new.test');
    expect((await message(again, { type: 'confirm-allow', host: 'harmgate-new.test' })).ok).toBe(true);
    await expectBlocked(again, 'harmgate-new.test', false);
    await message(again, { type: 'remove-allow', host: 'harmgate-new.test' });

    // Off removes the refreshed rule. On falls back to the bundled list at once.
    served = {};
    await message(again, { type: 'request-disable', category: 'adult' });
    await finishWait(again, 'disable:adult');
    expect((await message(again, { type: 'confirm-disable', category: 'adult' })).ok).toBe(true);
    await expectBlocked(again, 'harmgate-new.test', false);
    expect((await message(again, { type: 'enable', category: 'adult' })).ok).toBe(true);
    await expectBlocked(again, PROBES.adult, true);
    expect(await enabledRulesets(again)).toContain('adult');
  });

  it.each([
    ['a missing release', () => { served = {}; }, 'HTTP 404'],
    ['a tampered list', () => publishList('2999-01-01T00:00:00.000Z', { adult: syntheticList('harmgate-new.test') }, true), 'Checksum'],
    ['a list that is far too small', () => publishList('2999-01-01T00:00:00.000Z', { adult: ['harmgate-new.test'] }), 'too small'],
    ['a list with invalid entries', () => publishList('2999-01-01T00:00:00.000Z', { adult: [...syntheticList(), 'not a domain'] }), 'invalid'],
  ])('keeps the current protection when refresh meets %s', async (_name, arrange, error) => {
    const s = await fresh();
    await expectBlocked(s, PROBES.adult, true);
    arrange();
    const check = await refreshNow(s);
    expect(check.ok).toBe(false);
    expect(check.error).toContain(error);
    await expectBlocked(s, PROBES.adult, true);
    await expectBlocked(s, 'harmgate-new.test', false);
    expect(await enabledRulesets(s)).toEqual(expect.arrayContaining(['adult', 'gambling', 'gore']));
  });

  it('ignores a published list that is not newer than the bundled one', async () => {
    const s = await fresh();
    publishList('2000-01-01T00:00:00.000Z', { adult: syntheticList('harmgate-new.test') });
    expect(await refreshNow(s)).toMatchObject({ ok: true });
    await expectBlocked(s, 'harmgate-new.test', false);
    await expectBlocked(s, PROBES.adult, true);
  });
});
