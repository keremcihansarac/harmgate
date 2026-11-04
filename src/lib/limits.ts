export interface Schedule {
  /** 0 is Sunday, matching Date.getDay. */
  days: number[];
  /** Minutes after midnight. An end before the start means the range runs past midnight. */
  start: number;
  end: number;
}

export interface Limit {
  id: string;
  label: string;
  domains: string[];
  /** Fixes this limit's rule id. */
  slot: number;
  /** Null means the limit applies at all times. */
  schedule: Schedule | null;
}

export const PRESETS = [
  { id: 'x', label: 'X', domains: ['x.com', 'twitter.com'] },
  { id: 'reddit', label: 'Reddit', domains: ['reddit.com'] },
  { id: 'instagram', label: 'Instagram', domains: ['instagram.com'] },
  { id: 'tiktok', label: 'TikTok', domains: ['tiktok.com'] },
] as const;

export const DEFAULT_SCHEDULE: Schedule = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 };

export const LIMIT_RULE_BASE = 1000;
export const MAX_LIMITS = 200;
/** Above the allowlist, because an allowed site can still be one a person wants to limit. */
const LIMIT_PRIORITY = 150;
const ALL_SLOTS = Array.from({ length: MAX_LIMITS }, (_, i) => LIMIT_RULE_BASE + i);

export function isValidSchedule(value: unknown): value is Schedule {
  const s = value as Schedule;
  const minute = (m: unknown) => Number.isInteger(m) && (m as number) >= 0 && (m as number) < 1440;
  return (
    Boolean(s) && Array.isArray(s.days) && s.days.length > 0 &&
    s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
    minute(s.start) && minute(s.end) && s.start !== s.end
  );
}

export function isScheduled(schedule: Schedule, date: Date): boolean {
  const minute = date.getHours() * 60 + date.getMinutes();
  const day = date.getDay();
  if (schedule.start < schedule.end) return schedule.days.includes(day) && minute >= schedule.start && minute < schedule.end;
  // Past midnight, the early hours belong to the day the range started on.
  return (schedule.days.includes(day) && minute >= schedule.start) || (schedule.days.includes((day + 6) % 7) && minute < schedule.end);
}

export const isLimitingNow = (limit: Limit, now: number) =>
  limit.schedule === null || isScheduled(limit.schedule, new Date(now));

const MINUTES_IN_DAY = 1440;

/** Every minute of the week a schedule covers, numbered from Sunday midnight. */
function coveredMinutes(schedule: Schedule): Set<number> {
  const covered = new Set<number>();
  const mark = (day: number, from: number, to: number) => {
    for (let m = from; m < to; m++) covered.add(day * MINUTES_IN_DAY + m);
  };
  for (const day of schedule.days) {
    if (schedule.start < schedule.end) mark(day, schedule.start, schedule.end);
    else {
      mark(day, schedule.start, MINUTES_IN_DAY);
      mark((day + 1) % 7, 0, schedule.end);
    }
  }
  return covered;
}

/** True when the change would leave the site open at any moment it is closed today. */
export function isLoosening(current: Schedule | null, next: Schedule | null): boolean {
  if (next === null) return false;
  if (current === null) return true;
  const after = coveredMinutes(next);
  for (const minute of coveredMinutes(current)) if (!after.has(minute)) return true;
  return false;
}

/** Shown on the block page of a limited site, and while someone waits to remove or loosen a limit. */
export const ENCOURAGEMENTS = [
  'You set this limit for a reason. That reason is still true.',
  'An urge usually fades if you give it a few minutes.',
  'Nothing on that site needs you right now.',
  'You made this choice on a clearer day. Trust that person.',
  'What would you do with the next hour if this site did not exist?',
  'The feed will still be there tomorrow. So will your reasons for leaving it.',
  'Feeling bored is fine. It passes on its own.',
  'You can walk away from this at any moment. Nothing is lost.',
  'Future you will be glad you kept this.',
  'What did you want to get done today?',
] as const;

/** The first minute a limited site opens again. Null if it is open now or never opens. */
export function nextOpening(limit: Limit, now: number): Date | null {
  if (limit.schedule === null || !isLimitingNow(limit, now)) return null;
  const date = new Date(now);
  date.setSeconds(0, 0);
  for (let i = 0; i <= 7 * MINUTES_IN_DAY; i++) {
    date.setMinutes(date.getMinutes() + 1);
    if (!isScheduled(limit.schedule, date)) return date;
  }
  return null;
}

/** "today at 17:00", "tomorrow at 09:30", "on Saturday at 08:00". */
export function describeOpening(opening: Date, now: number): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(opening) - startOfDay(new Date(now))) / 86_400_000);
  const clock = `${String(opening.getHours()).padStart(2, '0')}:${String(opening.getMinutes()).padStart(2, '0')}`;
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `on ${opening.toLocaleDateString('en', { weekday: 'long' })}`;
  return `${when} at ${clock}`;
}

export const ENCOURAGEMENT_MS = 30_000;

/** A random sentence, never the one on screen right now. */
export function nextEncouragement(current: string | null, random: () => number = Math.random): string {
  const choices = ENCOURAGEMENTS.filter((e) => e !== current);
  return choices[Math.floor(random() * choices.length)]!;
}

export const lowestFreeSlot = (limits: Limit[]) => {
  const used = new Set(limits.map((l) => l.slot));
  for (let slot = 0; slot < MAX_LIMITS; slot++) if (!used.has(slot)) return slot;
  return null;
};

export const limitRuleId = (limit: Limit) => LIMIT_RULE_BASE + limit.slot;

export function limitRule(limit: Limit, extensionId: string): chrome.declarativeNetRequest.Rule {
  return {
    id: limitRuleId(limit),
    priority: LIMIT_PRIORITY,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { regexSubstitution: `chrome-extension://${extensionId}/block.html?limit=${limit.id}&host=\\1` },
    },
    // Top-level pages only: an embedded post on a news site is not what a person set out to limit.
    condition: {
      regexFilter: '^https?://([^/:?#]+).*$',
      requestDomains: limit.domains,
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

// Rules only catch new page loads, and these sites mostly navigate without one. So a tab that is
// already open has to be reloaded for a limit to reach it.
async function reloadOpenTabs(limit: Limit) {
  const tabs = await chrome.tabs.query({ url: limit.domains.map((d) => `*://*.${d}/*`) });
  await Promise.allSettled(tabs.map((tab) => (tab.id === undefined ? undefined : chrome.tabs.reload(tab.id))));
}

/** Makes the browser's limit rules match the saved limits at this moment. Safe to call repeatedly. */
export async function syncLimits(limits: Limit[], now: number): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules({ ruleIds: ALL_SLOTS });
  const existingIds = new Set(existing.map((r) => r.id));
  const active = limits.filter((l) => isLimitingNow(l, now));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [...existingIds],
    addRules: active.map((l) => limitRule(l, chrome.runtime.id)),
  });
  await Promise.all(active.filter((l) => !existingIds.has(limitRuleId(l))).map(reloadOpenTabs));
}
