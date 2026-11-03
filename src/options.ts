import { CATEGORIES, CATEGORY_LABELS, WAIT_MS, type Category } from './lib/constants';
import { send, type Status } from './lib/messages';
import { disableKey, pendingStatus } from './lib/state';

const el = (id: string) => document.getElementById(id)!;
const timers = new Map<Category, ReturnType<typeof setInterval>>();

function make<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function renderCategory(status: Status, category: Category): HTMLElement {
  const { state, active, counts, now } = status;
  const enabled = state.enabled[category];
  const startedAt = state.pending[disableKey(category)];
  const pending = pendingStatus(startedAt, now);
  const stateText = enabled
    ? active[category] ? 'On' : 'Problem: not active in the browser'
    : 'Off';
  const info = make('div', {},
    make('strong', { textContent: CATEGORY_LABELS[category] }),
    make('div', { className: `small ${enabled && !active[category] ? 'warn' : 'muted'}`, textContent: `${stateText} · ${counts[category].toLocaleString('en')} sites` }),
  );
  const buttons = make('div', { className: 'row' });

  if (!enabled) {
    buttons.append(make('button', { className: 'primary', type: 'button', textContent: 'Turn on', onclick: () => act({ type: 'enable', category }) }));
  } else if (pending === 'waiting' || pending === 'ready') {
    const confirm = make('button', { type: 'button', disabled: true, onclick: () => act({ type: 'confirm-disable', category }) });
    const offset = Date.now() - now;
    const tick = () => {
      const left = Math.ceil((startedAt! + WAIT_MS + offset - Date.now()) / 1000);
      confirm.disabled = left > 0;
      confirm.textContent = left > 0 ? `Turn off (${left}s)` : 'Turn off now';
      if (left <= 0) clearInterval(timers.get(category));
    };
    tick();
    timers.set(category, setInterval(tick, 1000));
    buttons.append(confirm, make('button', { className: 'primary', type: 'button', textContent: 'Keep on', onclick: () => act({ type: 'cancel-disable', category }) }));
  } else {
    buttons.append(make('button', { type: 'button', textContent: 'Turn off…', onclick: () => act({ type: 'request-disable', category }) }));
  }
  return make('div', { className: 'card row' }, info, buttons);
}

function renderAllowlist(status: Status) {
  const list = el('allowlist');
  list.replaceChildren(...status.state.allowlist.map((host) =>
    make('li', { className: 'card row' },
      make('code', { textContent: host }),
      make('button', { type: 'button', textContent: 'Remove', onclick: () => act({ type: 'remove-allow', host }) }),
    )));
  el('allowlist-empty').hidden = status.state.allowlist.length > 0;
}

function renderLists(status: Status) {
  const versions = CATEGORIES.map((c) => status.state.applied[c]).filter((v): v is string => Boolean(v));
  const newest = [status.bundledVersion, ...versions].sort().at(-1)!;
  const check = status.state.lastCheck;
  const checked = check ? ` Last check: ${new Date(check.at).toLocaleString()}${check.ok ? '.' : ' (failed).'}` : '';
  el('lists').textContent = `List version: ${newest.slice(0, 10)}.${checked}`;
}

async function render() {
  const status = await send<Status>({ type: 'status' });
  timers.forEach(clearInterval);
  timers.clear();
  el('categories').replaceChildren(...CATEGORIES.map((c) => renderCategory(status, c)));
  renderAllowlist(status);
  renderLists(status);
  el('incognito').hidden = await chrome.extension.isAllowedIncognitoAccess();
}

async function act(message: Parameters<typeof send>[0]) {
  await send(message);
  await render();
}

void render();
