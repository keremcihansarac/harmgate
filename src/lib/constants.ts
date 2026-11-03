export const CATEGORIES = ['adult', 'gambling', 'gore'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  adult: 'Adult content',
  gambling: 'Gambling and betting',
  gore: 'Gore and extreme violence',
};

export const WAIT_MS = 60_000;
/** A finished wait stays usable for this long, then the person has to wait again. */
export const CONFIRM_WINDOW_MS = 5 * 60_000;

export const REPO_URL = 'https://github.com/keremcihansarac/harmgate';
export const LISTS_BASE_URL = `${REPO_URL}/releases/download/lists`;

export const ALLOW_RULE_ID = 1;
export const DYNAMIC_RULE_IDS: Record<Category, number> = { adult: 11, gambling: 12, gore: 13 };
export const MAX_LIST_DOMAINS = 3_000_000;
/** A refreshed list smaller than this share of the bundled list is treated as broken. */
export const MIN_LIST_RATIO = 0.5;

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const isValidDomain = (value: unknown): value is string => typeof value === 'string' && DOMAIN_RE.test(value);
export const isCategory = (value: unknown): value is Category => CATEGORIES.includes(value as Category);
