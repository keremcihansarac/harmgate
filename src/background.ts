import { WAIT_MS, isCategory, isValidDomain } from './lib/constants';
import type { Message, Reply, Status } from './lib/messages';
import { bundledInfo, refreshLists } from './lib/refresh';
import { activeCategories, syncRules } from './lib/rules';
import { allowKey, disableKey, loadState, pendingStatus, saveState, startPending } from './lib/state';

const ALARM = 'lists-check';
const CHECK_MINUTES = 24 * 60;

// State changes run one at a time, so that overlapping messages cannot overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

const checkLists = () =>
  serial(async () => {
    const state = await loadState();
    try {
      await refreshLists(state);
      state.lastCheck = { at: Date.now(), ok: true };
    } catch (e) {
      state.lastCheck = { at: Date.now(), ok: false, error: String((e as Error).message) };
    }
    await saveState(state);
  });

const ensureAlarm = async () => {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: CHECK_MINUTES });
};

async function handle(message: Message): Promise<unknown> {
  const state = await loadState();
  const now = Date.now();
  const finish = async <T>(value?: T) => {
    await syncRules(state);
    await saveState(state);
    return value;
  };
  switch (message.type) {
    case 'status': {
      const bundled = await bundledInfo();
      return { state, active: await activeCategories(), counts: bundled.counts, bundledVersion: bundled.version, now } satisfies Status;
    }
    case 'request-disable': {
      if (!isCategory(message.category)) throw new Error('Unknown category');
      const startedAt = startPending(state, disableKey(message.category), now);
      await saveState(state);
      return { readyAt: startedAt + WAIT_MS, now };
    }
    case 'confirm-disable': {
      if (!isCategory(message.category)) throw new Error('Unknown category');
      const key = disableKey(message.category);
      if (pendingStatus(state.pending[key], now) !== 'ready') throw new Error('The wait has not finished');
      delete state.pending[key];
      state.enabled[message.category] = false;
      delete state.applied[message.category];
      return finish();
    }
    case 'cancel-disable':
      delete state.pending[disableKey(message.category)];
      return saveState(state);
    case 'enable': {
      if (!isCategory(message.category)) throw new Error('Unknown category');
      state.enabled[message.category] = true;
      delete state.pending[disableKey(message.category)];
      return finish();
    }
    case 'request-allow': {
      if (!isValidDomain(message.host)) throw new Error('Invalid site');
      const startedAt = startPending(state, allowKey(message.host), now);
      await saveState(state);
      return { readyAt: startedAt + WAIT_MS, now };
    }
    case 'confirm-allow': {
      if (!isValidDomain(message.host)) throw new Error('Invalid site');
      const key = allowKey(message.host);
      if (pendingStatus(state.pending[key], now) !== 'ready') throw new Error('The wait has not finished');
      delete state.pending[key];
      if (!state.allowlist.includes(message.host)) state.allowlist.push(message.host);
      return finish();
    }
    case 'cancel-allow':
      delete state.pending[allowKey(message.host)];
      return saveState(state);
    case 'remove-allow':
      state.allowlist = state.allowlist.filter((h) => h !== message.host);
      return finish();
    default:
      throw new Error('Unknown message');
  }
}

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse: (r: Reply) => void) => {
  if (sender.id !== chrome.runtime.id) return false;
  serial(() => handle(message)).then(
    (value) => sendResponse({ ok: true, value }),
    (e: Error) => sendResponse({ ok: false, error: e.message }),
  );
  if (message.type === 'enable') void checkLists();
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void serial(async () => {
    const state = await loadState();
    // Enabled rulesets reset when the extension updates, and a newer bundled list replaces a refreshed one.
    const { version } = await bundledInfo();
    for (const [c, applied] of Object.entries(state.applied)) {
      if (applied <= version) delete state.applied[c as keyof typeof state.applied];
    }
    await syncRules(state);
    await saveState(state);
    await ensureAlarm();
  });
  if (reason === 'install') void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void serial(async () => syncRules(await loadState()));
  void ensureAlarm();
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === ALARM) void checkLists();
});

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
