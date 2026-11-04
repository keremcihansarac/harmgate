import { HEARTBEAT_GAP_MS, WAIT_MS, isValidDomain, type Category } from './constants';
import { isValidSchedule, type Limit, type Schedule } from './limits';

export interface PendingWait {
  startedAt: number;
  lastSeen: number;
}

export interface State {
  allowlist: string[];
  /** Waits in progress, keyed by gate key. */
  pending: Record<string, PendingWait>;
  /** List version of the refreshed rule in use, per category. Absent means the bundled ruleset. */
  applied: Partial<Record<Category, string>>;
  lastCheck: { at: number; ok: boolean; error?: string } | null;
  /** The newest published version of Harmgate, as of the last check. */
  latestVersion: string | null;
  /** Personal limits. A site being here means the limit is on. */
  limits: Limit[];
}

export const defaultState = (): State => ({
  allowlist: [],
  pending: {},
  applied: {},
  lastCheck: null,
  latestVersion: null,
  limits: [],
});

export async function loadState(): Promise<State> {
  const { state } = await chrome.storage.local.get('state');
  if (!state) return defaultState();
  // Older versions could turn categories off. That choice is dropped, so the next sync turns them back on.
  const { enabled: _dropped, ...saved } = state as Partial<State> & { enabled?: unknown };
  return { ...defaultState(), ...saved };
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

export type Gate =
  | { kind: 'allow'; host: string }
  | { kind: 'limit-remove'; id: string }
  | { kind: 'limit-change'; id: string; schedule: Schedule };

export const allowKey = (host: string) => `allow:${host}`;
export const limitRemoveKey = (id: string) => `limit-remove:${id}`;
/** The new schedule is part of the key, so a finished wait only ever applies the change it was for. */
export const limitChangeKey = (id: string, schedule: Schedule) => `limit-change:${id}:${JSON.stringify(schedule)}`;

const LIMIT_ID = /^[a-z0-9]+$/;

function parseSchedule(text: string): Schedule | null {
  try {
    const value: unknown = JSON.parse(text);
    return isValidSchedule(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseGateKey(key: unknown): Gate | null {
  if (typeof key !== 'string') return null;
  const [kind, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'allow' && isValidDomain(value)) return { kind, host: value };
  if (kind === 'limit-remove' && LIMIT_ID.test(value)) return { kind, id: value };
  if (kind === 'limit-change') {
    const split = value.indexOf(':');
    const id = value.slice(0, split);
    const schedule = parseSchedule(value.slice(split + 1));
    if (split > 0 && LIMIT_ID.test(id) && schedule) return { kind, id, schedule };
  }
  return null;
}

/** The sentence a person has to type by hand before the action goes through. */
export function gatePhrase(gate: Gate, limits: Limit[] = []): string {
  switch (gate.kind) {
    case 'allow':
      return `I choose to allow ${gate.host}.`;
    case 'limit-remove':
    case 'limit-change': {
      const label = limits.find((l) => l.id === gate.id)?.label ?? 'this site';
      return gate.kind === 'limit-remove' ? `I choose to remove my limit on ${label}.` : `I choose to loosen my limit on ${label}.`;
    }
  }
}
