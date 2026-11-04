import type { Category } from './constants';
import type { Schedule } from './limits';

export type Message =
  | { type: 'status' }
  | { type: 'gate-tick'; key: string }
  | { type: 'gate-cancel'; key: string }
  | { type: 'gate-confirm'; key: string; phrase: string }
  | { type: 'remove-allow'; host: string }
  | { type: 'limit-add-preset'; id: string; schedule?: Schedule | null }
  | { type: 'limit-add-site'; host: string; schedule?: Schedule | null }
  | { type: 'limit-schedule'; id: string; schedule: Schedule | null };

export interface Status {
  state: import('./state').State;
  active: Record<Category, boolean>;
  counts: Record<Category, number>;
  bundledVersion: string;
  now: number;
}

export interface GateTick { readyAt: number; now: number }

export interface Reply<T = unknown> { ok: boolean; error?: string; value?: T }

export async function send<T = unknown>(message: Message): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(message)) as Reply<T>;
  if (!reply?.ok) throw new Error(reply?.error ?? 'No reply from Harmgate');
  return reply.value as T;
}
