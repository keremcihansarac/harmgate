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
import { CATEGORY_SENTENCES } from '../../src/lib/blockpage';
import { ENCOURAGEMENTS } from '../../src/lib/limits';

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

/**
 * Several browser calls have no timeout of their own. Without this, a hang only shows up as the
 * whole test running out of time, with nothing to say which call never came back.
 */
async function step<T>(label: string, work: Promise<T>, ms = 45000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

const closeSession = (s: Session) => step('Closing the browser', s.context.close());

async function launch(extDir: string, profile: string): Promise<Session> {
  const context = await step('Launching the browser', chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--host-resolver-rules=MAP harmgate-open.test 127.0.0.1,MAP *.test ~NOTFOUND'],
  }));
  // The worker can register before a listener attaches, so poll rather than wait for the event.
  const deadline = Date.now() + 30000;
  while (!context.serviceWorkers()[0] && Date.now() < deadline) await sleep(50);
  const started = context.serviceWorkers()[0];
  if (!started) throw new Error('Service worker did not start');
  const worker = new Proxy(started, {
    get(target, name) {
      if (name === 'evaluate') return (fn: never, arg: never) => step('Running code in the service worker', target.evaluate(fn, arg));
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { context, worker, id: new URL(started.url()).host, extDir, profile };
}

async function visit(s: Session, url: string) {
  const page = await step('Opening a page', s.context.newPage());
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 15000 }).catch(() => undefined);
    return page.url();
  } finally {
    await step('Closing a page', page.close());
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
  const page = await step('Opening a page', s.context.newPage());
  await page.goto(`chrome-extension://${s.id}/options.html`);
  const reply = await step(`Reply to ${JSON.stringify(msg).slice(0, 60)}`, page.evaluate((m) => chrome.runtime.sendMessage(m), msg));
  await step('Closing a page', page.close());
  return reply;
}

/** Shifts a running wait into the past, so tests need not sit through five real minutes. */
async function finishWait(s: Session, key: string) {
  await s.worker.evaluate(async (k) => {
    const { state } = (await chrome.storage.local.get('state')) as { state: { pending: Record<string, unknown> } };
    state.pending[k] = { startedAt: Date.now() - 301_000, lastSeen: Date.now() };
    await chrome.storage.local.set({ state });
  }, key);
}

/** Goes through a whole gate at the message level. */
async function passGate(s: Session, key: string, phrase: string) {
  expect((await message(s, { type: 'gate-tick', key })).ok).toBe(true);
  await finishWait(s, key);
  const reply = await message(s, { type: 'gate-confirm', key, phrase });
  expect(reply).toMatchObject({ ok: true });
}


interface LastCheck { at: number; ok: boolean; error?: string }

/** Fires the real daily alarm and waits for the check it starts to finish. */
async function refreshNow(s: Session): Promise<LastCheck> {
  // Install sets up the daily alarm under this same name. If that lands after ours, it replaces ours.
  await expect.poll(() => s.worker.evaluate(async () => Boolean(await chrome.alarms.get('lists-check'))), { timeout: 10000 }).toBe(true);
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
    // Not just '.card': the forms further down are cards too, and exist before the page has rendered.
    await page!.locator('#categories .card').first().waitFor();
    const text = await page!.locator('#categories').innerText();
    expect(text.match(/On ·/g)?.length).toBe(3);
    expect(text).not.toContain('Problem');
  });

  it('ships every icon the manifest names, and uses one as the page icon', async () => {
    const s = await fresh();
    const page = await s.context.newPage();
    await page.goto(`chrome-extension://${s.id}/options.html`);
    const result = await page.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const paths = [...Object.values(manifest.icons ?? {}), ...Object.values((manifest.action?.default_icon ?? {}) as Record<string, string>)];
      const sizes = await Promise.all(paths.map(async (path) => {
        const image = new Image();
        image.src = chrome.runtime.getURL(path);
        await image.decode();
        // A clear corner means the icon has no white box around it on dark browser themes.
        const ctx = new OffscreenCanvas(image.naturalWidth, image.naturalHeight).getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        return [path, image.naturalWidth, ctx.getImageData(0, 0, 1, 1).data[3]] as const;
      }));
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
      const icon = await fetch(link.href);
      return { sizes, pageIcon: icon.ok };
    });
    expect(result.sizes.length).toBe(7);
    for (const [path, width, cornerAlpha] of result.sizes) {
      expect(path).toContain(`icon-${width}.png`);
      expect(cornerAlpha).toBe(0);
    }
    expect(result.pageIcon).toBe(true);
    await page.close();
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
    expect(CATEGORY_SENTENCES.gambling).toContain(await page.locator('#sentence').innerText());
    expect(await page.locator('#ideas li').count()).toBe(3);
    expect(await page.locator('.block-mark').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    // Nothing on this page may make giving in easy: no route to settings, no way to allow the site.
    expect(await page.getByRole('button').allInnerTexts()).toEqual(['Go back']);
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

  it('offers no way to turn the core filter off', async () => {
    const s = await fresh();
    const page = await s.context.newPage();
    await page.goto(`chrome-extension://${s.id}/options.html`);
    await page.locator('#categories .card').first().waitFor();
    expect(await page.locator('#categories button').count()).toBe(0);
    await page.close();

    for (const key of ['disable:adult', 'disable:gambling', 'disable:gore']) {
      expect((await message(s, { type: 'gate-tick', key })).ok).toBe(false);
      await finishWait(s, key);
      const reply = await message(s, { type: 'gate-confirm', key, phrase: 'I choose to turn off the filter for adult content.' });
      expect(reply).toMatchObject({ ok: false, error: 'Unknown action' });
    }
    expect((await message(s, { type: 'enable', category: 'adult' })).ok).toBe(false);
    await expectBlocked(s, PROBES.adult, true);
  });

  it('turns back on a category that an older version had turned off, on restart and on update', async () => {
    const s = await fresh();
    /** What an older version left behind after someone passed its gate. */
    const leaveOff = (session: Session) =>
      session.worker.evaluate(async () => {
        const { state } = (await chrome.storage.local.get('state')) as { state: Record<string, unknown> };
        state.enabled = { adult: false, gambling: true, gore: true };
        await chrome.storage.local.set({ state });
        await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['adult'] });
      });

    // The alarm is the last thing install sets up, so install cannot overwrite what comes next.
    await expect.poll(() => s.worker.evaluate(async () => Boolean(await chrome.alarms.get('lists-check'))), { timeout: 10000 }).toBe(true);
    await leaveOff(s);
    await expectBlocked(s, PROBES.adult, false);
    await closeSession(s);
    const again = await launch(s.extDir, s.profile);
    sessions.push(again);
    await expect.poll(async () => enabledRulesets(again), { timeout: 10000 }).toContain('adult');
    await expectBlocked(again, PROBES.adult, true);

    await leaveOff(again);
    await closeSession(again);
    const manifestPath = join(s.extDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '9.9.9' }));
    const updated = await launch(s.extDir, s.profile);
    sessions.push(updated);
    expect(await updated.worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('9.9.9');
    await expect.poll(async () => enabledRulesets(updated), { timeout: 10000 }).toContain('adult');
    await expectBlocked(updated, PROBES.adult, true);
    expect((await message(updated, { type: 'status' })).value.state.enabled).toBeUndefined();
  });

  it('keeps a limit through the settings page gate, with no pasting', async () => {
    const s = await fresh();
    const host = 'harmgate-gated.test';
    const id = await limitSite(s, host);
    const key = `limit-remove:${id}`;
    const phrase = `I choose to remove my limit on ${host}.`;
    const page = await s.context.newPage();
    await page.goto(`chrome-extension://${s.id}/options.html`);
    const card = page.locator(`[data-limit="${host}"]`);

    await card.getByRole('button', { name: 'Remove limit…' }).click();
    await expect.poll(() => card.locator('.gate').innerText()).toContain('Time left: 5:00');
    expect(await card.getByRole('textbox').isVisible()).toBe(false);
    expect(await card.getByRole('button', { name: 'Confirm' }).isVisible()).toBe(false);
    expect(await card.locator('.phrase').isVisible()).toBe(false);
    await card.getByRole('button', { name: 'Keep my limit' }).click();
    await card.getByRole('button', { name: 'Remove limit…' }).waitFor();

    await card.getByRole('button', { name: 'Remove limit…' }).click();
    await card.locator('.gate').waitFor();
    await finishWait(s, key);
    const input = card.getByRole('textbox');
    await input.waitFor({ timeout: 10000 });
    const confirm = card.getByRole('button', { name: 'Confirm' });
    expect(await confirm.isDisabled()).toBe(true);

    const pasteAllowed = await input.evaluate((node) =>
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true })));
    expect(pasteAllowed).toBe(false);

    await input.pressSequentially(phrase.slice(0, -1));
    expect(await confirm.isDisabled()).toBe(true);
    await input.pressSequentially('.');
    await confirm.click();
    await card.waitFor({ state: 'detached' });
    await expectBlocked(s, host, false);
    await page.close();
  });

  it('starts the wait over when the tab stops reporting in', async () => {
    const s = await fresh();
    const key = `allow:${PROBES.adult}`;
    const phrase = `I choose to allow ${PROBES.adult}.`;
    const first = await message(s, { type: 'gate-tick', key });
    await s.worker.evaluate(async (k) => {
      const { state } = (await chrome.storage.local.get('state')) as { state: { pending: Record<string, unknown> } };
      state.pending[k] = { startedAt: Date.now() - 301_000, lastSeen: Date.now() - 25_000 };
      await chrome.storage.local.set({ state });
    }, key);
    expect(await message(s, { type: 'gate-confirm', key, phrase })).toMatchObject({ ok: false, error: 'The wait has not finished' });
    const restarted = await message(s, { type: 'gate-tick', key });
    expect(restarted.value.readyAt).toBeGreaterThan(first.value.readyAt);
    expect(restarted.value.readyAt - restarted.value.now).toBeGreaterThan(295_000);
  });

  it('allows a blocked site only after the wait and the sentence, and can undo it', async () => {
    const s = await fresh();
    const key = `allow:${PROBES.adult}`;
    const phrase = `I choose to allow ${PROBES.adult}.`;
    await expectBlocked(s, PROBES.adult, true);
    expect((await message(s, { type: 'gate-confirm', key, phrase })).ok).toBe(false);
    expect((await message(s, { type: 'gate-tick', key: 'allow:not a domain' })).ok).toBe(false);
    await passGate(s, key, phrase);
    await expectBlocked(s, PROBES.adult, false);
    await expectBlocked(s, PROBES.gambling, true);
    expect((await message(s, { type: 'remove-allow', host: PROBES.adult })).ok).toBe(true);
    await expectBlocked(s, PROBES.adult, true);
  });

  it('allows a site through the settings form, keeping only the host of a pasted address', async () => {
    const s = await fresh();
    await expectBlocked(s, PROBES.gore, true);
    const page = await s.context.newPage();
    await page.goto(`chrome-extension://${s.id}/options.html`);
    const form = page.locator('#allow-form');
    await page.locator('#allow-host').fill('not a site');
    await form.getByRole('button', { name: 'Allow a site…' }).click();
    await page.locator('#allow-error').waitFor();

    await page.locator('#allow-host').fill(`https://${PROBES.gore}/some/page?x=1`);
    await form.getByRole('button', { name: 'Allow a site…' }).click();
    await form.locator('.gate').waitFor();
    expect(await page.locator('#allow-error').isVisible()).toBe(false);
    await finishWait(s, `allow:${PROBES.gore}`);
    const input = form.locator('.gate input');
    await input.waitFor({ timeout: 10000 });
    await input.pressSequentially(`I choose to allow ${PROBES.gore}.`);
    await form.getByRole('button', { name: 'Confirm' }).click();
    await page.locator('#allowlist').getByText(PROBES.gore).waitFor();
    await expectBlocked(s, PROBES.gore, false);

    await page.locator('#allowlist').getByRole('button', { name: 'Remove' }).click();
    await expectBlocked(s, PROBES.gore, true);
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

    await closeSession(s);
    const again = await launch(s.extDir, s.profile);
    sessions.push(again);
    await expectBlocked(again, 'harmgate-new.test', true);
    await expectBlocked(again, PROBES.adult, false);
    expect(await enabledRulesets(again)).not.toContain('adult');

    // Allowed sites outrank refreshed rules too.
    await passGate(again, 'allow:harmgate-new.test', 'I choose to allow harmgate-new.test.');
    await expectBlocked(again, 'harmgate-new.test', false);
    await message(again, { type: 'remove-allow', host: 'harmgate-new.test' });
    await expectBlocked(again, 'harmgate-new.test', true);
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

  const LIMITED = 'harmgate-limited.test';

  /** Adds a limit for a synthetic site and returns its id. */
  async function limitSite(s: Session, host: string, schedule: unknown = null): Promise<string> {
    expect(await message(s, { type: 'limit-add-site', host, schedule })).toMatchObject({ ok: true });
    const status = await message(s, { type: 'status' });
    return status.value.state.limits.find((l: { domains: string[] }) => l.domains.includes(host)).id;
  }

  /** Fires the limits clock. */
  const tick = (s: Session) => s.worker.evaluate(() => chrome.alarms.create('limits-tick', { when: Date.now() + 50 }));

  /** A schedule that includes or excludes the current minute, whatever time the tests run. */
  const scheduleAround = (active: boolean) => {
    const now = new Date();
    const minute = now.getHours() * 60 + now.getMinutes();
    const today = now.getDay();
    return active
      ? { days: [0, 1, 2, 3, 4, 5, 6], start: (minute + 1438) % 1440, end: (minute + 3) % 1440 }
      : { days: [(today + 3) % 7], start: 60, end: 120 };
  };

  const removeLimit = (s: Session, id: string, label: string) => passGate(s, `limit-remove:${id}`, `I choose to remove my limit on ${label}.`);
  const loosenLimit = (s: Session, id: string, label: string, schedule: unknown) =>
    passGate(s, `limit-change:${id}:${JSON.stringify(schedule)}`, `I choose to loosen my limit on ${label}.`);

  const setStoredSchedule = (s: Session, id: string, schedule: unknown) =>
    s.worker.evaluate(async ({ limitId, value }) => {
      const { state } = (await chrome.storage.local.get('state')) as { state: { limits: { id: string; schedule: unknown }[] } };
      state.limits.find((l) => l.id === limitId)!.schedule = value;
      await chrome.storage.local.set({ state });
    }, { limitId: id, value: schedule });

  it('closes a limited site outright: no way through from the block page', async () => {
    const s = await fresh();
    const id = await limitSite(s, LIMITED);
    const page = await s.context.newPage();
    await page.goto(`http://sub.${LIMITED}/path?x=1&y=2#frag`).catch(() => undefined);
    await page.locator('h1').waitFor();
    const url = new URL(page.url());
    expect(url.pathname).toBe('/block.html');
    expect(url.searchParams.get('limit')).toBe(id);
    expect(url.searchParams.get('host')).toBe(`sub.${LIMITED}`);
    expect(await page.locator('h1').innerText()).toBe('You closed this site');
    expect(await page.locator('#reason').innerText()).toBe('It stays closed while your limit applies.');
    expect(ENCOURAGEMENTS).toContain(await page.locator('#sentence').innerText());
    expect(await page.locator('#ideas li').count()).toBe(3);
    expect(await page.locator('#host').innerText()).toBe(`sub.${LIMITED}`);
    expect(await page.getByRole('button').allInnerTexts()).toEqual(['Close this tab']);
    expect(await page.getByRole('link').count()).toBe(0);
    await page.close();
    expect(await visit(s, `http://${UNLISTED}/`)).not.toContain('/block.html');
    await expectBlocked(s, PROBES.adult, true);
    expect((await message(s, { type: 'limit-pass', id })).ok).toBe(false);
  });

  it('says when a scheduled limit opens again, and offers no way through in the meantime', async () => {
    const s = await fresh();
    await limitSite(s, LIMITED, scheduleAround(true));
    const page = await s.context.newPage();
    await page.goto(`http://${LIMITED}/`).catch(() => undefined);
    await expect.poll(() => page.locator('#reason').innerText()).toMatch(/^It opens again (today|tomorrow) at \d\d:\d\d\.$/);
    expect(await page.getByRole('button').allInnerTexts()).toEqual(['Close this tab']);
    expect(await page.getByRole('link').count()).toBe(0);
    await page.close();
  });

  it('closes the tab from the block page of a limited site', async () => {
    const s = await fresh();
    await limitSite(s, LIMITED);
    const page = await s.context.newPage();
    await page.goto(`http://${LIMITED}/`).catch(() => undefined);
    await page.getByRole('button', { name: 'Close this tab' }).click();
    await expect.poll(() => page.isClosed()).toBe(true);
  });

  it('reaches a tab already open on the site, when a limit is added and when a schedule starts', async () => {
    const s = await fresh();
    const host = 'harmgate-open.test';
    const address = `http://${host}:${new URL(base).port}/feed`;
    const page = await s.context.newPage();
    await page.goto(address);
    expect(page.url()).toBe(address);

    const id = await limitSite(s, host);
    await page.waitForURL(/block\.html\?limit=/, { timeout: 10000 });

    await loosenLimit(s, id, host, scheduleAround(false));
    await page.goto(address);
    expect(page.url()).toBe(address);

    await setStoredSchedule(s, id, scheduleAround(true));
    await tick(s);
    await page.waitForURL(/block\.html\?limit=/, { timeout: 10000 });
    await page.close();
  });

  it('follows the schedule, in both directions', async () => {
    const s = await fresh();
    const id = await limitSite(s, LIMITED, scheduleAround(false));
    await expectBlocked(s, LIMITED, false);
    expect(await message(s, { type: 'limit-schedule', id, schedule: null })).toMatchObject({ ok: true });
    await expectBlocked(s, LIMITED, true);
    await loosenLimit(s, id, LIMITED, scheduleAround(true));
    await expectBlocked(s, LIMITED, true);
    expect(await message(s, { type: 'limit-schedule', id, schedule: { days: [], start: 1, end: 2 } })).toMatchObject({ ok: false });
    expect(await message(s, { type: 'limit-schedule', id: 'nope', schedule: null })).toMatchObject({ ok: false });
    expect(await message(s, { type: 'limit-add-site', host: 'harmgate-bad.test', schedule: { days: [], start: 1, end: 2 } })).toMatchObject({ ok: false });
  });

  it('will not remove or loosen a limit without the wait and the sentence', async () => {
    const s = await fresh();
    const week = { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 1439 };
    const id = await limitSite(s, LIMITED);
    const removeKey = `limit-remove:${id}`;
    const removePhrase = `I choose to remove my limit on ${LIMITED}.`;

    // The old direct route is gone, and a schedule cannot stand in for removing the limit.
    expect((await message(s, { type: 'limit-remove', id })).ok).toBe(false);
    expect(await message(s, { type: 'limit-schedule', id, schedule: week })).toMatchObject({ ok: false, error: 'Loosening a limit takes the wait' });
    await expectBlocked(s, LIMITED, true);

    // Each step of the gate holds on its own.
    expect((await message(s, { type: 'gate-confirm', key: removeKey, phrase: removePhrase })).ok).toBe(false);
    await message(s, { type: 'gate-tick', key: removeKey });
    expect(await message(s, { type: 'gate-confirm', key: removeKey, phrase: removePhrase })).toMatchObject({ ok: false, error: 'The wait has not finished' });
    await finishWait(s, removeKey);
    expect(await message(s, { type: 'gate-confirm', key: removeKey, phrase: 'yes' })).toMatchObject({ ok: false, error: 'The sentence does not match' });
    await expectBlocked(s, LIMITED, true);
    expect(await message(s, { type: 'gate-confirm', key: removeKey, phrase: removePhrase })).toMatchObject({ ok: true });
    await expectBlocked(s, LIMITED, false);

    // A finished wait for one schedule does not pay for another.
    const id2 = await limitSite(s, LIMITED);
    const paidFor = scheduleAround(true);
    const key = `limit-change:${id2}:${JSON.stringify(paidFor)}`;
    await message(s, { type: 'gate-tick', key });
    await finishWait(s, key);
    const other = `limit-change:${id2}:${JSON.stringify(scheduleAround(false))}`;
    expect((await message(s, { type: 'gate-confirm', key: other, phrase: `I choose to loosen my limit on ${LIMITED}.` })).ok).toBe(false);
    await expectBlocked(s, LIMITED, true);

    // Making a limit stricter never waits.
    const narrow = { days: [1], start: 600, end: 660 };
    const id3 = await limitSite(s, 'harmgate-strict.test', narrow);
    expect(await message(s, { type: 'limit-schedule', id: id3, schedule: { days: [1, 2], start: 540, end: 720 } })).toMatchObject({ ok: true });
    expect(await message(s, { type: 'limit-schedule', id: id3, schedule: null })).toMatchObject({ ok: true });
  });

  it('starts and ends a schedule on the clock, with nobody touching the settings', async () => {
    const s = await fresh();
    const id = await limitSite(s, LIMITED, scheduleAround(false));
    await expectBlocked(s, LIMITED, false);
    await setStoredSchedule(s, id, scheduleAround(true));
    await tick(s);
    await expectBlocked(s, LIMITED, true);
    await setStoredSchedule(s, id, scheduleAround(false));
    await tick(s);
    await expectBlocked(s, LIMITED, false);
    const alarms = await s.worker.evaluate(async () => (await chrome.alarms.getAll()).map((a) => a.name));
    expect(alarms).toContain('limits-tick');
  });

  it('keeps limits through a restart, and removing one takes effect once the gate is passed', async () => {
    const s = await fresh();
    const id = await limitSite(s, LIMITED);
    await closeSession(s);
    const again = await launch(s.extDir, s.profile);
    sessions.push(again);
    await expectBlocked(again, LIMITED, true);
    await removeLimit(again, id, LIMITED);
    await expectBlocked(again, LIMITED, false);
    const alarms = await again.worker.evaluate(async () => (await chrome.alarms.getAll()).map((a) => a.name));
    expect(alarms).not.toContain('limits-tick');
  });

  it('replaces rules left by an older version when the extension updates', async () => {
    const s = await fresh();
    const id = await limitSite(s, LIMITED);
    await s.worker.evaluate(async (limitId) => {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1000],
        addRules: [{
          id: 1000,
          priority: 150,
          action: { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: `/pause.html?limit=${limitId}` } },
          condition: { requestDomains: ['harmgate-limited.test'], resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] },
        }],
      });
    }, id);
    await closeSession(s);
    const manifestPath = join(s.extDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '9.9.9' }));
    const updated = await launch(s.extDir, s.profile);
    sessions.push(updated);
    await expect.poll(() => visit(updated, `http://${LIMITED}/`), { timeout: 10000 }).toContain('/block.html?limit=');
  });

  it('applies limits to allowed sites, and removing a limit never opens the core filter', async () => {
    const s = await fresh();
    await passGate(s, `allow:${LIMITED}`, `I choose to allow ${LIMITED}.`);
    await limitSite(s, LIMITED);
    await expectBlocked(s, LIMITED, true);

    const id = await limitSite(s, PROBES.gambling);
    await expectBlocked(s, PROBES.gambling, true);
    await removeLimit(s, id, PROBES.gambling);
    await expectBlocked(s, PROBES.gambling, true);
  });

  it('covers every domain of a preset, and does not limit anything until asked', async () => {
    const s = await fresh();
    const match = (url: string) =>
      s.worker.evaluate(async (u) => {
        const r = await chrome.declarativeNetRequest.testMatchOutcome({ url: u, type: 'main_frame' as chrome.declarativeNetRequest.ResourceType });
        return r.matchedRules.length;
      }, url);
    expect(await match('https://x.com/home')).toBe(0);
    expect(await message(s, { type: 'limit-add-preset', id: 'x' })).toMatchObject({ ok: true });
    expect(await match('https://x.com/home')).toBe(1);
    expect(await match('https://twitter.com/home')).toBe(1);
    expect(await match('https://www.reddit.com/')).toBe(0);
    expect(await message(s, { type: 'limit-add-preset', id: 'nope' })).toMatchObject({ ok: false });
  });

  it('sets up limits through the settings page', async () => {
    const s = await fresh();
    const page = await s.context.newPage();
    await page.goto(`chrome-extension://${s.id}/options.html`);
    const reddit = page.locator('[data-limit="Reddit"]');

    // The schedule is picked before the limit exists, so setting one up never hits the wait.
    await reddit.getByRole('combobox').selectOption('schedule');
    expect(await reddit.getByLabel('Mon').isChecked()).toBe(true);
    expect(await reddit.getByLabel('Sat').isChecked()).toBe(false);
    expect(await reddit.getByLabel('From').inputValue()).toBe('09:00');
    expect((await message(s, { type: 'status' })).value.state.limits).toHaveLength(0);
    await reddit.getByLabel('Sat').check();
    await reddit.getByLabel('From').fill('10:30');
    // A re-render caused by another card keeps what was being set up.
    await page.locator('[data-limit="X"]').getByRole('button', { name: 'Add limit' }).click();
    await page.locator('[data-limit="X"]').getByRole('button', { name: 'Remove limit…' }).waitFor();
    expect(await reddit.getByLabel('From').inputValue()).toBe('10:30');
    await reddit.getByRole('button', { name: 'Add limit' }).click();
    await reddit.getByRole('button', { name: 'Remove limit…' }).waitFor();
    const redditSchedule = async () => (await message(s, { type: 'status' })).value.state.limits.find((l: { id: string }) => l.id === 'reddit').schedule;
    expect(await redditSchedule()).toEqual({ days: [1, 2, 3, 4, 5, 6], start: 630, end: 1020 });

    // Stricter saves at once.
    const save = reddit.getByRole('button', { name: 'Save changes' });
    expect(await save.isVisible()).toBe(false);
    await reddit.getByLabel('Sun').check();
    await save.click();
    await expect.poll(redditSchedule).toEqual({ days: [1, 2, 3, 4, 5, 6, 0], start: 630, end: 1020 });
    expect(await reddit.locator('.gate').count()).toBe(0);

    // Looser waits, and backing out restores what was saved.
    await reddit.getByLabel('Sat').uncheck();
    await reddit.getByRole('button', { name: 'Save changes' }).click();
    await reddit.locator('.gate').waitFor();
    expect(await reddit.locator('.encouragement').innerText()).not.toBe('');
    expect(await reddit.innerText()).toContain('New schedule: Mon, Tue, Wed, Thu, Fri, Sun, 10:30 to 17:00');
    expect(await reddit.getByRole('button', { name: 'Remove limit…' }).count()).toBe(0);
    await reddit.getByRole('button', { name: 'Keep my limit' }).click();
    await reddit.getByRole('button', { name: 'Remove limit…' }).waitFor();
    expect(await reddit.getByLabel('Sat').isChecked()).toBe(true);
    expect(await redditSchedule()).toEqual({ days: [1, 2, 3, 4, 5, 6, 0], start: 630, end: 1020 });

    // Going through with it.
    await reddit.getByLabel('Sat').uncheck();
    await reddit.getByRole('button', { name: 'Save changes' }).click();
    await reddit.locator('.gate').waitFor();
    const changed = { days: [1, 2, 3, 4, 5, 0], start: 630, end: 1020 };
    await finishWait(s, `limit-change:reddit:${JSON.stringify(changed)}`);
    await reddit.getByRole('textbox').waitFor({ timeout: 10000 });
    await reddit.getByRole('textbox').pressSequentially('I choose to loosen my limit on Reddit.');
    await reddit.getByRole('button', { name: 'Confirm' }).click();
    await reddit.getByRole('button', { name: 'Remove limit…' }).waitFor();
    expect(await redditSchedule()).toEqual(changed);

    // A schedule that cannot work is refused before anything is saved.
    await reddit.getByLabel('Until').fill('10:30');
    await reddit.locator('.warn').waitFor();
    await reddit.getByRole('button', { name: 'Save changes' }).click();
    expect(await redditSchedule()).toEqual(changed);
    expect(await reddit.locator('.gate').count()).toBe(0);

    // Other buttons on this page must not leave extra listeners on the form: one click, one limit.
    const x = page.locator('[data-limit="X"]');
    await x.getByRole('button', { name: 'Remove limit…' }).click();
    await x.getByRole('button', { name: 'Keep my limit' }).click();
    await page.locator('#allow-host').fill('harmgate-other.test');
    await page.locator('#allow-form').getByRole('button', { name: 'Allow a site…' }).click();
    await page.locator('#allow-form').getByRole('button', { name: 'Cancel' }).click();

    await page.locator('#limit-host').fill('nonsense');
    await page.locator('#limit-form').getByRole('button', { name: 'Add limit' }).click();
    await page.locator('#limit-error').waitFor();
    await page.locator('#limit-host').fill(`https://${LIMITED}/page`);
    await page.locator('#limit-form').getByRole('button', { name: 'Add limit' }).click();
    await page.locator(`[data-limit="${LIMITED}"]`).waitFor();
    expect(await page.locator('#limit-error').isVisible()).toBe(false);
    await sleep(300);
    expect(await page.locator('#limit-error').isVisible()).toBe(false);
    expect((await message(s, { type: 'status' })).value.state.limits.filter((l: { domains: string[] }) => l.domains.includes(LIMITED))).toHaveLength(1);
    await page.locator('#limit-host').fill(LIMITED);
    await page.locator('#limit-form').getByRole('button', { name: 'Add limit' }).click();
    await page.getByText('That site already has a limit').waitFor();
    await expectBlocked(s, LIMITED, true);

    // Removing goes through the gate too, with sentences to read during the wait.
    const card = page.locator(`[data-limit="${LIMITED}"]`);
    await card.getByRole('button', { name: 'Remove limit…' }).click();
    await card.locator('.gate').waitFor();
    expect(await card.locator('.encouragement').innerText()).not.toBe('');
    const id = (await message(s, { type: 'status' })).value.state.limits.find((l: { domains: string[] }) => l.domains.includes(LIMITED)).id;
    await finishWait(s, `limit-remove:${id}`);
    await card.getByRole('textbox').waitFor({ timeout: 10000 });
    await card.getByRole('textbox').pressSequentially(`I choose to remove my limit on ${LIMITED}.`);
    await card.getByRole('button', { name: 'Confirm' }).click();
    await card.waitFor({ state: 'detached' });
    await expectBlocked(s, LIMITED, false);
    await page.close();
  });

  it('ignores a published list that is not newer than the bundled one', async () => {
    const s = await fresh();
    publishList('2000-01-01T00:00:00.000Z', { adult: syntheticList('harmgate-new.test') });
    expect(await refreshNow(s)).toMatchObject({ ok: true });
    await expectBlocked(s, 'harmgate-new.test', false);
    await expectBlocked(s, PROBES.adult, true);
  });
});
