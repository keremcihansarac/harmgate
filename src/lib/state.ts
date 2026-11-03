import { CATEGORIES, CATEGORY_LABELS, HEARTBEAT_GAP_MS, WAIT_MS, isCategory, isValidDomain, type Category } from './constants';

export interface PendingWait {
  startedAt: number;
  lastSeen: number;
}

export interface State {
  enabled: Record<Category, boolean>;
  allowlist: string[];
  /** Waits in progress, keyed by gate key. */
  pending: Record<string, PendingWait>;
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

export type PendingStatus = 'none' | 'waiting' | 'ready';

/** A wait only counts while the tab keeps reporting in. A silence or a clock jump in either direction ends it. */
export function pendingStatus(wait: PendingWait | undefined, now: number): PendingStatus {
  if (!wait || typeof wait.lastSeen !== 'number') return 'none';
  const silence = now - wait.lastSeen;
  if (silence < 0 || silence > HEARTBEAT_GAP_MS || now < wait.startedAt) return 'none';
  return now - wait.startedAt < WAIT_MS ? 'waiting' : 'ready';
}

/** Records that the tab is still here, or starts over if the wait was broken. */
export function touchPending(state: State, key: string, now: number): PendingWait {
  const current = state.pending[key];
  const wait: PendingWait = current && pendingStatus(current, now) !== 'none' ? { ...current, lastSeen: now } : { startedAt: now, lastSeen: now };
  state.pending[key] = wait;
  return wait;
}

export type Gate = { kind: 'disable'; category: Category } | { kind: 'allow'; host: string };

export const disableKey = (category: Category) => `disable:${category}`;
export const allowKey = (host: string) => `allow:${host}`;

export function parseGateKey(key: unknown): Gate | null {
  if (typeof key !== 'string') return null;
  const [kind, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'disable' && isCategory(value)) return { kind, category: value };
  if (kind === 'allow' && isValidDomain(value)) return { kind, host: value };
  return null;
}

/** The sentence a person has to type by hand before the action goes through. */
export function gatePhrase(gate: Gate): string {
  return gate.kind === 'disable'
    ? `I choose to turn off the filter for ${CATEGORY_LABELS[gate.category].toLowerCase()}.`
    : `I choose to allow ${gate.host}.`;
}
