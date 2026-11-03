import { CATEGORY_LABELS, REPO_URL, isCategory, isValidDomain } from './lib/constants';

const params = new URLSearchParams(location.search);
const rawHost = params.get('host');
const host = isValidDomain(rawHost) ? rawHost : null;
const rawCategory = params.get('c');
const category = isCategory(rawCategory) ? rawCategory : null;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Anything framed stays blank: blocked ad frames must not clutter normal pages.
// This page deliberately offers no route to settings, so giving in takes real effort.
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
    const query = new URLSearchParams({ template: 'wrong-block.yml', title: `Wrong block: ${host}`, host, category: category ?? '' });
    el<HTMLAnchorElement>('report').href = `${REPO_URL}/issues/new?${query}`;
  }
}
