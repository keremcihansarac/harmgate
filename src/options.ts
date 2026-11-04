import { CATEGORIES, CATEGORY_LABELS, HEARTBEAT_MS, RELEASES_URL, isValidDomain, type Category } from './lib/constants';
import {
  DEFAULT_SCHEDULE,
  ENCOURAGEMENT_MS,
  PRESETS,
  isLimitingNow,
  isLoosening,
  isValidSchedule,
  nextEncouragement,
  type Limit,
  type Schedule,
} from './lib/limits';
import { send, type GateTick, type Status } from './lib/messages';
import { allowKey, gatePhrase, limitChangeKey, limitRemoveKey, parseGateKey } from './lib/state';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag) as HTMLElementTagNameMap[K] & HTMLElement;
  Object.assign(node as object, props);
  node.append(...children);
  return node;
}

/** Open gates survive re-renders, so a refresh of the page content cannot disturb a wait or a half-typed sentence. */
const gates = new Map<string, { node: HTMLElement; close: () => void }>();

/** The saved limits as of the last render, for the sentence a limit's gate asks for. */
let savedLimits: Limit[] = [];

function openGate(key: string, cancelLabel: string, onEnd?: () => void) {
  const gate = parseGateKey(key);
  if (!gate || gates.has(key)) return;
  const phrase = gatePhrase(gate, savedLimits);
  const aboutLimit = gate.kind === 'limit-remove' || gate.kind === 'limit-change';

  const message = make('p', { className: 'small muted' });
  const notice = make('p', { className: 'small warn', hidden: true });
  const phraseLine = make('p', { className: 'small phrase', textContent: phrase, hidden: true });
  const input = make('input', { type: 'text', autocomplete: 'off', spellcheck: false, hidden: true, placeholder: 'Type the sentence above' });
  input.setAttribute('aria-label', phrase);
  const confirm = make('button', { type: 'button', textContent: 'Confirm', disabled: true, hidden: true });
  const cancel = make('button', { type: 'button', className: 'primary', textContent: cancelLabel });
  const encouragement = make('p', { className: 'small encouragement', hidden: !aboutLimit, textContent: aboutLimit ? nextEncouragement(null) : '' });
  const node = make('div', { className: 'gate' }, encouragement, message, notice, phraseLine, input, make('div', { className: 'actions' }, confirm, cancel));

  let readyAt = 0;
  let offset = 0;

  const paint = () => {
    const left = Math.ceil((readyAt + offset - Date.now()) / 1000);
    const waiting = left > 0;
    if (waiting) {
      const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      message.textContent = `Keep this tab open and in front. Time left: ${clock}. Leaving starts the wait over.`;
    } else {
      message.textContent = 'Type this sentence by hand. Leaving this tab now starts the wait over.';
    }
    phraseLine.hidden = input.hidden = confirm.hidden = waiting;
    confirm.disabled = input.value !== phrase;
  };

  const sync = async () => {
    const tick = await send<GateTick>({ type: 'gate-tick', key });
    if (readyAt && tick.readyAt > readyAt) {
      notice.textContent = 'The wait started over because you left this tab.';
      notice.hidden = false;
      input.value = '';
    }
    readyAt = tick.readyAt;
    offset = Date.now() - tick.now;
    paint();
  };

  const heartbeat = setInterval(() => {
    if (document.visibilityState === 'visible') void sync();
  }, HEARTBEAT_MS);
  const painter = setInterval(paint, 1000);
  const rotator = aboutLimit
    ? setInterval(() => {
        encouragement.textContent = nextEncouragement(encouragement.textContent);
      }, ENCOURAGEMENT_MS)
    : undefined;
  const onVisible = () => {
    if (document.visibilityState === 'visible') void sync();
  };
  document.addEventListener('visibilitychange', onVisible);

  const close = () => {
    clearInterval(heartbeat);
    clearInterval(painter);
    clearInterval(rotator);
    document.removeEventListener('visibilitychange', onVisible);
    gates.delete(key);
    node.remove();
  };

  for (const type of ['paste', 'drop'] as const) input.addEventListener(type, (e) => e.preventDefault());
  input.addEventListener('input', paint);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
  cancel.addEventListener('click', async () => {
    close();
    onEnd?.();
    await send({ type: 'gate-cancel', key });
    await render();
  });
  confirm.addEventListener('click', async () => {
    try {
      await send({ type: 'gate-confirm', key, phrase: input.value });
      close();
      onEnd?.();
      await render();
    } catch (e) {
      notice.textContent = (e as Error).message;
      notice.hidden = false;
      await sync();
    }
  });

  gates.set(key, { node, close });
  void sync();
}

function renderCategory(status: Status, category: Category): HTMLElement {
  const { active, counts } = status;
  return make('div', { className: 'card' },
    make('strong', { textContent: CATEGORY_LABELS[category] }),
    make('div', { className: `small ${active[category] ? 'muted' : 'warn'}`, textContent: `${active[category] ? 'On' : 'Problem: not active in the browser'} · ${counts[category].toLocaleString('en')} sites` }),
  );
}

function renderAllowlist(status: Status) {
  el('allowlist').replaceChildren(...status.state.allowlist.map((host) =>
    make('li', { className: 'card row' },
      make('code', { textContent: host }),
      make('button', { type: 'button', textContent: 'Remove', onclick: () => act({ type: 'remove-allow', host }) }),
    )));
  el('allowlist-empty').hidden = status.state.allowlist.length > 0;
  const allowGates = [...gates.entries()].filter(([k]) => k.startsWith('allow:')).map(([k, g]) => make('div', {}, make('p', { className: 'small gate-host', textContent: k.slice('allow:'.length) }), g.node));
  el('allow-gates').replaceChildren(...allowGates);
}

const DAY_NAMES: [number, string][] = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const toClock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const fromClock = (clock: string) => {
  const [h, m] = clock.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const limitStatus = (limit: Limit, now: number) => (isLimitingNow(limit, now) ? 'Closed now' : 'Open right now');

const describeSchedule = (schedule: Schedule) =>
  `${DAY_NAMES.filter(([day]) => schedule.days.includes(day)).map(([, name]) => name).join(', ')}, ${toClock(schedule.start)} to ${toClock(schedule.end)}`;

/** Unsaved choices, by limit id, so that a re-render of the page does not throw away what someone was setting up. */
const drafts = new Map<string, Schedule | null>();
const NEW_SITE = 'new-site';
const draftFor = (id: string, saved: Schedule | null) => (drafts.has(id) ? drafts.get(id)! : saved);

/** The "when" controls. Changes stay in the draft until the caller saves them. */
function renderWhen(id: string, label: string, saved: Schedule | null, onChange: () => void): { node: HTMLElement; check: () => boolean } {
  const initial = draftFor(id, saved);
  const shown = initial ?? DEFAULT_SCHEDULE;
  const mode = make('select', {},
    make('option', { value: 'always', textContent: 'All the time', selected: initial === null }),
    make('option', { value: 'schedule', textContent: 'On a schedule', selected: initial !== null }),
  );
  mode.setAttribute('aria-label', `When to limit ${label}`);
  const boxes = DAY_NAMES.map(([day, name]) => {
    const box = make('input', { type: 'checkbox', checked: shown.days.includes(day) });
    box.dataset.day = String(day);
    return { box, label: make('label', { className: 'day' }, box, name) };
  });
  const start = make('input', { type: 'time', value: toClock(shown.start) });
  start.setAttribute('aria-label', 'From');
  const end = make('input', { type: 'time', value: toClock(shown.end) });
  end.setAttribute('aria-label', 'Until');
  const problem = make('p', { className: 'small warn', hidden: true, textContent: 'Pick at least one day, and two different times.' });
  const times = make('div', {},
    make('div', { className: 'days' }, ...boxes.map((b) => b.label)),
    make('div', { className: 'field small limit-times' }, 'From ', start, ' until ', end),
    problem,
  );
  times.hidden = initial === null;

  const update = () => {
    times.hidden = mode.value === 'always';
    drafts.set(id, mode.value === 'always' ? null : {
      days: boxes.filter((b) => b.box.checked).map((b) => Number(b.box.dataset.day)),
      start: fromClock(start.value),
      end: fromClock(end.value),
    });
    const draft = drafts.get(id)!;
    problem.hidden = draft === null || isValidSchedule(draft);
    onChange();
  };
  for (const input of [mode, start, end, ...boxes.map((b) => b.box)]) input.addEventListener('change', update);

  return {
    node: make('div', { className: 'limit-body' }, make('label', { className: 'field small' }, 'When ', mode), times),
    check: () => {
      const draft = draftFor(id, saved);
      const valid = draft === null || isValidSchedule(draft);
      problem.hidden = valid;
      return valid;
    },
  };
}

const sameSchedule = (a: Schedule | null, b: Schedule | null) => JSON.stringify(a) === JSON.stringify(b);

function renderSavedLimit(status: Status, limit: Limit): HTMLElement {
  const head = (action?: HTMLElement) => make('div', { className: 'row limit-head' },
    make('div', {}, make('strong', { textContent: limit.label }), make('div', { className: 'small muted', textContent: limitStatus(limit, status.now) })),
    ...(action ? [action] : []),
  );
  const card = make('div', { className: 'card row' });
  card.dataset.limit = limit.label;

  const openKey = [...gates.keys()].find((key) => {
    const gate = parseGateKey(key);
    return (gate?.kind === 'limit-remove' || gate?.kind === 'limit-change') && gate.id === limit.id;
  });
  if (openKey) {
    const gate = parseGateKey(openKey)!;
    const what = gate.kind === 'limit-change' ? `New schedule: ${describeSchedule(gate.schedule)}.` : 'Removing this limit.';
    card.append(head(), make('p', { className: 'small limit-head', textContent: what }), gates.get(openKey)!.node);
    return card;
  }

  const removeButton = make('button', {
    type: 'button',
    textContent: 'Remove limit…',
    onclick: () => {
      openGate(limitRemoveKey(limit.id), 'Keep my limit', () => drafts.delete(limit.id));
      void render();
    },
  });
  const save = make('button', { type: 'button', textContent: 'Save changes' });
  const when = renderWhen(limit.id, limit.label, limit.schedule, () => {
    save.hidden = sameSchedule(drafts.get(limit.id) ?? null, limit.schedule);
  });
  save.hidden = sameSchedule(draftFor(limit.id, limit.schedule), limit.schedule);
  save.addEventListener('click', () => {
    if (!when.check()) return;
    const next = draftFor(limit.id, limit.schedule);
    if (next !== null && isLoosening(limit.schedule, next)) {
      openGate(limitChangeKey(limit.id, next), 'Keep my limit', () => drafts.delete(limit.id));
      void render();
      return;
    }
    drafts.delete(limit.id);
    void act({ type: 'limit-schedule', id: limit.id, schedule: next });
  });
  when.node.append(make('div', {}, save));
  card.append(head(removeButton), when.node);
  return card;
}

function renderPreset(preset: (typeof PRESETS)[number]): HTMLElement {
  const when = renderWhen(preset.id, preset.label, null, () => undefined);
  const add = make('button', {
    type: 'button',
    textContent: 'Add limit',
    onclick: () => {
      if (!when.check()) return;
      const schedule = draftFor(preset.id, null);
      drafts.delete(preset.id);
      void act({ type: 'limit-add-preset', id: preset.id, schedule });
    },
  });
  const card = make('div', { className: 'card row' },
    make('div', { className: 'row limit-head' },
      make('div', {}, make('strong', { textContent: preset.label }), make('div', { className: 'small muted', textContent: preset.domains.join(', ') })),
      add,
    ),
    when.node,
  );
  card.dataset.limit = preset.label;
  return card;
}

let checkNewSite: () => boolean = () => true;

function renderLimits(status: Status) {
  const { limits } = status.state;
  savedLimits = limits;
  const presetIds = new Set<string>(PRESETS.map((p) => p.id));
  el('limits').replaceChildren(
    ...PRESETS.map((p) => {
      const limit = limits.find((l) => l.id === p.id);
      return limit ? renderSavedLimit(status, limit) : renderPreset(p);
    }),
    ...limits.filter((l) => !presetIds.has(l.id)).map((l) => renderSavedLimit(status, l)),
  );
  const when = renderWhen(NEW_SITE, 'this site', null, () => undefined);
  checkNewSite = when.check;
  el('limit-when').replaceChildren(when.node);
}

function renderLists(status: Status) {
  const versions = CATEGORIES.map((c) => status.state.applied[c]).filter((v): v is string => Boolean(v));
  const newest = [status.bundledVersion, ...versions].sort().at(-1)!;
  const check = status.state.lastCheck;
  const checked = check ? ` Last check: ${new Date(check.at).toLocaleString()}${check.ok ? '.' : ' (failed).'}` : '';
  el('lists').textContent = `List version: ${newest.slice(0, 10)}.${checked}`;
  el('version').textContent = `Harmgate ${chrome.runtime.getManifest().version}.`;
  el('update').hidden = !status.state.latestVersion;
  el('update-version').textContent = status.state.latestVersion ?? '';
  el<HTMLAnchorElement>('update-link').href = RELEASES_URL;
}

async function render() {
  const status = await send<Status>({ type: 'status' });
  el('categories').replaceChildren(...CATEGORIES.map((c) => renderCategory(status, c)));
  renderLimits(status);
  renderAllowlist(status);
  renderLists(status);
  el('incognito').hidden = await chrome.extension.isAllowedIncognitoAccess();
}

async function act(message: Parameters<typeof send>[0]) {
  await send(message);
  await render();
}

/** Accepts a pasted address as well as a bare domain, and keeps only the host. */
function hostFrom(value: string): string | null {
  const text = value.trim().toLowerCase();
  try {
    const host = new URL(text.includes('://') ? text : `https://${text}`).hostname;
    return isValidDomain(host) ? host : null;
  } catch {
    return null;
  }
}

el('allow-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = el<HTMLInputElement>('allow-host');
  const host = hostFrom(input.value);
  el('allow-error').hidden = host !== null;
  if (!host) {
    el('allow-error').textContent = 'That does not look like a site address.';
    return;
  }
  input.value = '';
  openGate(allowKey(host), 'Cancel');
  void render();
});

el('limit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el<HTMLInputElement>('limit-host');
  const error = el('limit-error');
  const host = hostFrom(input.value);
  error.hidden = host !== null;
  if (!host) {
    error.textContent = 'That does not look like a site address.';
    return;
  }
  if (!checkNewSite()) return;
  try {
    await send({ type: 'limit-add-site', host, schedule: draftFor(NEW_SITE, null) });
    input.value = '';
    drafts.delete(NEW_SITE);
    await render();
  } catch (err) {
    error.textContent = (err as Error).message;
    error.hidden = false;
  }
});

void render();
