import { CATEGORY_SENTENCES, GENERAL_SENTENCE, IDEAS, pickSome } from './lib/blockpage';
import { CATEGORY_LABELS, REPO_URL, isCategory, isValidDomain } from './lib/constants';
import { describeOpening, nextEncouragement, nextOpening } from './lib/limits';
import { loadState } from './lib/state';

const params = new URLSearchParams(location.search);
const rawHost = params.get('host');
const host = isValidDomain(rawHost) ? rawHost : null;
const rawCategory = params.get('c');
const category = isCategory(rawCategory) ? rawCategory : null;
const isLimit = params.has('limit');

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Anything framed stays blank: blocked ad frames must not clutter normal pages.
// This page deliberately offers no route to settings, so giving in takes real effort.
if (window.top === window) {
  el('content').hidden = false;
  if (host) el('host').textContent = host;
  if (category) el('reason').textContent = `Harmgate blocks this category: ${CATEGORY_LABELS[category]}.`;
  el('sentence').textContent = isLimit ? nextEncouragement(null) : pickSome(category ? CATEGORY_SENTENCES[category] : [GENERAL_SENTENCE], 1)[0]!;
  el('ideas').replaceChildren(...pickSome(IDEAS, 3).map((idea) => Object.assign(document.createElement('li'), { textContent: idea })));
  if (isLimit) {
    el('title').textContent = 'You closed this site';
    el('reason').textContent = 'It stays closed while your limit applies.';
    void loadState().then(({ limits }) => {
      const limit = limits.find((l) => l.id === params.get('limit'));
      const now = Date.now();
      const opening = limit ? nextOpening(limit, now) : null;
      if (opening) el('reason').textContent = `It opens again ${describeOpening(opening, now)}.`;
    });
  }

  // Going back from a limited site usually lands on the same site, so closing is the way out there.
  const back = el('back');
  if (isLimit) back.textContent = 'Close this tab';
  back.addEventListener('click', () => {
    if (isLimit) void chrome.tabs.getCurrent().then((tab) => (tab?.id === undefined ? window.close() : chrome.tabs.remove(tab.id)));
    else if (history.length > 1) history.back();
    else window.close();
  });

  if (host && !isLimit) {
    el('wrong').hidden = false;
    const query = new URLSearchParams({ template: 'wrong-block.yml', title: `Wrong block: ${host}`, host, category: category ?? '' });
    el<HTMLAnchorElement>('report').href = `${REPO_URL}/issues/new?${query}`;
  }
}
