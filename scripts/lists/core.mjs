// Pure list logic, kept free of I/O so it can be unit tested.
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Parses hosts files and plain domain lists into a set of valid domains. */
export function parseList(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim().toLowerCase();
    if (!line) continue;
    const token = line.split(/\s+/).at(-1);
    if (DOMAIN_RE.test(token) && !token.endsWith('.localdomain')) out.add(token);
  }
  return out;
}

function* parents(domain) {
  let i = domain.indexOf('.');
  while (i !== -1) {
    const parent = domain.slice(i + 1);
    if (parent.includes('.')) yield parent;
    i = domain.indexOf('.', i + 1);
  }
}

/** Removes allowlisted domains and subdomains. A listed parent of an allowed domain is a conflict. */
export function applyAllowlist(domains, allowlist) {
  const allowed = new Set(allowlist);
  const kept = new Set();
  const removed = [];
  for (const d of domains) {
    if (allowed.has(d) || [...parents(d)].some((p) => allowed.has(p))) removed.push(d);
    else kept.add(d);
  }
  const conflicts = [];
  for (const a of allowed) for (const p of parents(a)) if (kept.has(p)) conflicts.push({ allowed: a, listed: p });
  return { kept, removed, conflicts };
}

/**
 * Gives each domain to the first category listing it, in priority order, then drops subdomains
 * already covered by a listed parent in any category. requestDomains matches subdomains.
 */
export function assignCategories(priority, setsByCategory) {
  const owner = new Map();
  for (const category of priority) {
    for (const d of setsByCategory[category] ?? []) if (!owner.has(d)) owner.set(d, category);
  }
  const result = Object.fromEntries(priority.map((c) => [c, []]));
  for (const [d, category] of owner) {
    if (![...parents(d)].some((p) => owner.has(p))) result[category].push(d);
  }
  for (const c of priority) result[c].sort();
  return result;
}

/** Returns the given domains that a category list would block, directly or through a parent. */
export function findCovered(domains, assigned) {
  const owner = new Map();
  for (const [category, list] of Object.entries(assigned)) for (const d of list) owner.set(d, category);
  const covered = [];
  for (const d of domains) {
    const by = [d, ...parents(d)].find((h) => owner.has(h));
    if (by) covered.push({ domain: d, listed: by, category: owner.get(by) });
  }
  return covered;
}

export function extensionIdFromKey(keyBase64, createHash) {
  const hex = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function buildBlockRule(category, domains, extensionId) {
  return {
    id: 1,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `chrome-extension://${extensionId}/block.html?c=${category}&host=\\1` } },
    condition: { regexFilter: '^https?://([^/:?#]+).*$', requestDomains: domains, resourceTypes: ['main_frame', 'sub_frame'] },
  };
}
