import { CATEGORIES, CONFIRM_WINDOW_MS, WAIT_MS, type Category } from './constants';

export interface State {
  enabled: Record<Category, boolean>;
  allowlist: string[];
  /** When each waiting action started, keyed by action, in epoch milliseconds. */
  pending: Record<string, number>;
  /** List version of the refreshed rule in use, per category. Absent means the bundled ruleset. */
  applied: Partial<Record<Category, string>>;
  lastCheck: { at: number; ok: boolean; error?: string } | null;
}

export const defaultState = (): State => ({
  enabled: Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<Category, boolean>,
  allowlist: [],
  pending: {},
  applied: {},
  lastCheck: null,
});

export async function loadState(): Promise<State> {
  const { state } = await chrome.storage.local.get('state');
  const base = defaultState();
  return state ? { ...base, ...(state as Partial<State>), enabled: { ...base.enabled, ...(state as State).enabled } } : base;
}

export const saveState = (state: State): Promise<void> => chrome.storage.local.set({ state });

export type PendingStatus = 'none' | 'waiting' | 'ready' | 'expired';

export function pendingStatus(startedAt: number | undefined, now: number): PendingStatus {
  if (startedAt === undefined) return 'none';
  const elapsed = now - startedAt;
  if (elapsed < 0) return 'expired';
  if (elapsed < WAIT_MS) return 'waiting';
  return elapsed <= WAIT_MS + CONFIRM_WINDOW_MS ? 'ready' : 'expired';
}

/** Starts a wait, keeping one already running so that retrying cannot change it. */
export function startPending(state: State, key: string, now: number): number {
  const status = pendingStatus(state.pending[key], now);
  if (status === 'waiting' || status === 'ready') return state.pending[key]!;
  state.pending[key] = now;
  return now;
}

export const disableKey = (category: Category) => `disable:${category}`;
export const allowKey = (host: string) => `allow:${host}`;
