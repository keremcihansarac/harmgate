import { CATEGORIES, DYNAMIC_RULE_IDS, LISTS_BASE_URL, MAX_LIST_DOMAINS, MIN_LIST_RATIO, isValidDomain, type Category } from './constants';
import { dynamicBlockRule } from './rules';
import type { State } from './state';

interface Bundled { version: string; counts: Record<Category, number> }
interface Meta { version: string; categories: Record<Category, { count: number; sha256: string }> }

export const bundledInfo = async (): Promise<Bundled> =>
  (await fetch(chrome.runtime.getURL('rules/version.json'))).json();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function assertMeta(value: unknown): asserts value is Meta {
  const m = value as Meta;
  if (typeof m?.version !== 'string' || typeof m.categories !== 'object' || m.categories === null) throw new Error('Malformed list metadata');
}

/** Rejects anything that is not exactly the published list, or that looks implausible for it. */
export function validateList(text: string, expectedSha: string, actualSha: string, bundledCount: number): string[] {
  if (actualSha !== expectedSha) throw new Error('Checksum mismatch');
  const domains: unknown = JSON.parse(text);
  if (!Array.isArray(domains) || !domains.every(isValidDomain)) throw new Error('List contains invalid entries');
  if (domains.length < bundledCount * MIN_LIST_RATIO) throw new Error(`List too small: ${domains.length}`);
  if (domains.length > MAX_LIST_DOMAINS) throw new Error(`List too large: ${domains.length}`);
  return domains;
}

/**
 * Lists are fetched as data only: they can change which domains are blocked, and nothing else.
 * The refreshed rule goes in before the bundled ruleset goes off, so there is no unprotected gap.
 */
export async function refreshLists(state: State, base = LISTS_BASE_URL): Promise<void> {
  const res = await fetch(`${base}/meta.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`List metadata: HTTP ${res.status}`);
  const meta: unknown = await res.json();
  assertMeta(meta);
  const bundled = await bundledInfo();
  for (const c of CATEGORIES) {
    const current = state.applied[c] ?? bundled.version;
    const entry = meta.categories[c];
    if (!entry || meta.version <= current) continue;
    const listRes = await fetch(`${base}/${c}.json`, { cache: 'no-store' });
    if (!listRes.ok) throw new Error(`${c} list: HTTP ${listRes.status}`);
    const text = await listRes.text();
    const domains = validateList(text, entry.sha256, await sha256(text), bundled.counts[c]);
    const id = DYNAMIC_RULE_IDS[c];
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [id], addRules: [dynamicBlockRule(c, domains, chrome.runtime.id)] });
    await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [c] });
    state.applied[c] = meta.version;
  }
}
