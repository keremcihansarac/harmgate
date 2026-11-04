import { WAIT_MS, isValidDomain } from './lib/constants';
import { MAX_LIMITS, PRESETS, isLoosening, isValidSchedule, lowestFreeSlot, syncLimits, type Limit, type Schedule } from './lib/limits';
import type { GateTick, Message, Reply, Status } from './lib/messages';
import { bundledInfo, refreshLists } from './lib/refresh';
import { activeCategories, syncRules } from './lib/rules';
import { gatePhrase, loadState, parseGateKey, pendingStatus, saveState, touchPending, type State } from './lib/state';

const ALARM = 'lists-check';
const LIMITS_ALARM = 'limits-tick';
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

/** A schedule starts and ends with no message to announce it, so scheduled limits need a clock. */
const updateLimitsAlarm = async (state: State) => {
  if (!state.limits.some((l) => l.schedule)) await chrome.alarms.clear(LIMITS_ALARM);
  else if (!(await chrome.alarms.get(LIMITS_ALARM))) await chrome.alarms.create(LIMITS_ALARM, { periodInMinutes: 1 });
};

const applyLimits = async (state: State) => {
  await syncLimits(state.limits, Date.now());
  await updateLimitsAlarm(state);
};

const tickLimits = () => serial(async () => applyLimits(await loadState()));

const findLimit = (state: State, id: string) => {
  const limit = state.limits.find((l) => l.id === id);
  if (!limit) throw new Error('Unknown limit');
  return limit;
};

const checkedSchedule = (schedule: Schedule | null | undefined) => {
  if (schedule !== undefined && schedule !== null && !isValidSchedule(schedule)) throw new Error('Invalid schedule');
  return schedule ?? null;
};

const addLimit = (state: State, make: (slot: number) => Limit) => {
  const slot = lowestFreeSlot(state.limits);
  if (slot === null || state.limits.length >= MAX_LIMITS) throw new Error('Too many limits');
  state.limits.push(make(slot));
};

async function handle(message: Message): Promise<unknown> {
  const state = await loadState();
  const now = Date.now();
  const finish = async <T>(value?: T) => {
    await syncRules(state);
    await applyLimits(state);
    await saveState(state);
    return value;
  };
  switch (message.type) {
    case 'status': {
      const bundled = await bundledInfo();
      return { state, active: await activeCategories(), counts: bundled.counts, bundledVersion: bundled.version, now } satisfies Status;
    }
    case 'gate-tick': {
      if (!parseGateKey(message.key)) throw new Error('Unknown action');
      const wait = touchPending(state, message.key, now);
      await saveState(state);
      return { readyAt: wait.startedAt + WAIT_MS, now } satisfies GateTick;
    }
    case 'gate-cancel':
      delete state.pending[message.key];
      return saveState(state);
    case 'gate-confirm': {
      const gate = parseGateKey(message.key);
      if (!gate) throw new Error('Unknown action');
      if (pendingStatus(state.pending[message.key], now) !== 'ready') throw new Error('The wait has not finished');
      if (message.phrase !== gatePhrase(gate, state.limits)) throw new Error('The sentence does not match');
      delete state.pending[message.key];
      if (gate.kind === 'allow') {
        if (!state.allowlist.includes(gate.host)) state.allowlist.push(gate.host);
      } else if (gate.kind === 'limit-remove') {
        findLimit(state, gate.id);
        state.limits = state.limits.filter((l) => l.id !== gate.id);
      } else {
        findLimit(state, gate.id).schedule = gate.schedule;
      }
      return finish();
    }
    case 'remove-allow':
      state.allowlist = state.allowlist.filter((h) => h !== message.host);
      return finish();
    case 'limit-add-preset': {
      const preset = PRESETS.find((p) => p.id === message.id);
      if (!preset) throw new Error('Unknown limit');
      const schedule = checkedSchedule(message.schedule);
      if (state.limits.some((l) => l.id === preset.id)) return undefined;
      addLimit(state, (slot) => ({ id: preset.id, label: preset.label, domains: [...preset.domains], slot, schedule }));
      return finish();
    }
    case 'limit-add-site': {
      if (!isValidDomain(message.host)) throw new Error('Invalid site');
      if (state.limits.some((l) => l.domains.includes(message.host))) throw new Error('That site already has a limit');
      const schedule = checkedSchedule(message.schedule);
      addLimit(state, (slot) => ({ id: `site${slot}`, label: message.host, domains: [message.host], slot, schedule }));
      return finish();
    }
    // Only ever makes a limit stricter. Removing or loosening one goes through the gate.
    case 'limit-schedule': {
      const schedule = checkedSchedule(message.schedule);
      const limit = findLimit(state, message.id);
      if (isLoosening(limit.schedule, schedule)) throw new Error('Loosening a limit takes the wait');
      limit.schedule = schedule;
      return finish();
    }
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
    await applyLimits(state);
    await saveState(state);
    await ensureAlarm();
  });
  if (reason === 'install') void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void serial(async () => {
    const state = await loadState();
    await syncRules(state);
    await applyLimits(state);
    await saveState(state);
  });
  void ensureAlarm();
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === ALARM) void checkLists();
  else if (name === LIMITS_ALARM) void tickLimits();
});

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
