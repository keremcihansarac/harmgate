import { CATEGORIES, CATEGORY_LABELS, HEARTBEAT_MS, isValidDomain, type Category } from './lib/constants';
import { send, type GateTick, type Status } from './lib/messages';
import { allowKey, disableKey, gatePhrase, parseGateKey } from './lib/state';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag) as HTMLElementTagNameMap[K] & HTMLElement;
  Object.assign(node as object, props);
  node.append(...children);
  return node;
}

/** Open gates survive re-renders, so a refresh of the page content cannot disturb a wait or a half-typed sentence. */
const gates = new Map<string, { node: HTMLElement; close: () => void }>();

function openGate(key: string, cancelLabel: string) {
  const gate = parseGateKey(key);
  if (!gate || gates.has(key)) return;
  const phrase = gatePhrase(gate);

  const message = make('p', { className: 'small muted' });
  const notice = make('p', { className: 'small warn', hidden: true });
  const phraseLine = make('p', { className: 'small phrase', textContent: phrase, hidden: true });
  const input = make('input', { type: 'text', autocomplete: 'off', spellcheck: false, hidden: true, placeholder: 'Type the sentence above' });
  input.setAttribute('aria-label', phrase);
  const confirm = make('button', { type: 'button', textContent: 'Confirm', disabled: true, hidden: true });
  const cancel = make('button', { type: 'button', className: 'primary', textContent: cancelLabel });
  const node = make('div', { className: 'gate' }, message, notice, phraseLine, input, make('div', { className: 'actions' }, confirm, cancel));

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
  const onVisible = () => {
    if (document.visibilityState === 'visible') void sync();
  };
  document.addEventListener('visibilitychange', onVisible);

  const close = () => {
    clearInterval(heartbeat);
    clearInterval(painter);
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
    await send({ type: 'gate-cancel', key });
    await render();
  });
  confirm.addEventListener('click', async () => {
    try {
      await send({ type: 'gate-confirm', key, phrase: input.value });
      close();
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
  const { state, active, counts } = status;
  const enabled = state.enabled[category];
  const key = disableKey(category);
  const stateText = enabled ? (active[category] ? 'On' : 'Problem: not active in the browser') : 'Off';
  const info = make('div', {},
    make('strong', { textContent: CATEGORY_LABELS[category] }),
    make('div', { className: `small ${enabled && !active[category] ? 'warn' : 'muted'}`, textContent: `${stateText} · ${counts[category].toLocaleString('en')} sites` }),
  );
  const card = make('div', { className: 'card row' }, info);
  if (!enabled) {
    card.append(make('button', { className: 'primary', type: 'button', textContent: 'Turn on', onclick: () => act({ type: 'enable', category }) }));
  } else if (gates.has(key)) {
    card.append(gates.get(key)!.node);
  } else {
    card.append(make('button', {
      type: 'button',
      textContent: 'Turn off…',
      onclick: () => {
        openGate(key, 'Keep on');
        void render();
      },
    }));
  }
  return card;
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

function renderLists(status: Status) {
  const versions = CATEGORIES.map((c) => status.state.applied[c]).filter((v): v is string => Boolean(v));
  const newest = [status.bundledVersion, ...versions].sort().at(-1)!;
  const check = status.state.lastCheck;
  const checked = check ? ` Last check: ${new Date(check.at).toLocaleString()}${check.ok ? '.' : ' (failed).'}` : '';
  el('lists').textContent = `List version: ${newest.slice(0, 10)}.${checked}`;
}

async function render() {
  const status = await send<Status>({ type: 'status' });
  el('categories').replaceChildren(...CATEGORIES.map((c) => renderCategory(status, c)));
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

void render();
