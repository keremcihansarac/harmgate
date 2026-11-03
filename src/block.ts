import { CATEGORY_LABELS, REPO_URL, isCategory, isValidDomain } from './lib/constants';
import { send } from './lib/messages';

const params = new URLSearchParams(location.search);
const rawHost = params.get('host');
const host = isValidDomain(rawHost) ? rawHost : null;
const rawCategory = params.get('c');
const category = isCategory(rawCategory) ? rawCategory : null;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Anything framed stays blank: blocked ad frames must not clutter normal pages,
// and a site embedding this page must not be able to reach its buttons.
if (window.top === window) {
  el('content').hidden = false;
  if (category) el('reason').textContent = `Harmgate blocks this category: ${CATEGORY_LABELS[category]}.`;
  if (host) el('host').textContent = host;

  el('back').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else window.close();
  });

  if (host) {
    el('wrong').hidden = false;
    const report = el<HTMLAnchorElement>('report');
    const query = new URLSearchParams({ template: 'wrong-block.yml', title: `Wrong block: ${host}`, host, category: category ?? '' });
    report.href = `${REPO_URL}/issues/new?${query}`;

    const allow = el<HTMLButtonElement>('allow');
    let timer: ReturnType<typeof setInterval> | undefined;
    let ready = false;
    const start = async () => {
      const { readyAt, now } = await send<{ readyAt: number; now: number }>({ type: 'request-allow', host });
      const offset = Date.now() - now;
      allow.disabled = true;
      const tick = () => {
        const left = Math.ceil((readyAt + offset - Date.now()) / 1000);
        if (left > 0) {
          allow.textContent = `Allow this site (${left}s)`;
          return;
        }
        clearInterval(timer);
        ready = true;
        allow.disabled = false;
        allow.textContent = `Allow ${host} now`;
      };
      tick();
      timer = setInterval(tick, 1000);
    };
    allow.addEventListener('click', async () => {
      if (!ready) return start();
      await send({ type: 'confirm-allow', host });
      location.replace(`https://${host}/`);
    });
  }
}
