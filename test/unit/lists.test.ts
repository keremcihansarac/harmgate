import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyAllowlist, assignCategories, buildBlockRule, extensionIdFromKey, findCovered, parseList } from '../../scripts/lists/core.mjs';

describe('parseList', () => {
  it('reads hosts files and plain lists, and skips comments and junk', () => {
    const text = '# header\n0.0.0.0 a.example.com\n127.0.0.1 B.Example.org # note\nplain.example.net\n\n0.0.0.0 localhost\nnot a domain!\n0.0.0.0 under_score.example.com\n1.2.3.4\n';
    expect([...parseList(text)].sort()).toEqual(['a.example.com', 'b.example.org', 'plain.example.net']);
  });
});

describe('applyAllowlist', () => {
  it('removes allowed domains and their subdomains only', () => {
    const { kept, removed, conflicts } = applyAllowlist(new Set(['news.dk', 'www.news.dk', 'notnews.dk', 'bad.dk']), ['news.dk']);
    expect([...kept].sort()).toEqual(['bad.dk', 'notnews.dk']);
    expect(removed.sort()).toEqual(['news.dk', 'www.news.dk']);
    expect(conflicts).toEqual([]);
  });

  it('reports a listed parent of an allowed domain, because the rule would still block it', () => {
    const { conflicts } = applyAllowlist(new Set(['host.com']), ['good.host.com']);
    expect(conflicts).toEqual([{ allowed: 'good.host.com', listed: 'host.com' }]);
  });
});

describe('assignCategories', () => {
  it('gives a shared domain to the first category in priority order', () => {
    const r = assignCategories(['gore', 'adult'], { gore: new Set(['both.com']), adult: new Set(['both.com', 'only.com']) });
    expect(r).toEqual({ gore: ['both.com'], adult: ['only.com'] });
  });

  it('drops subdomains covered by a parent, also across categories', () => {
    const r = assignCategories(['gambling', 'adult'], { gambling: new Set(['site.com']), adult: new Set(['a.b.site.com', 'other.com', 'x.other.com']) });
    expect(r).toEqual({ gambling: ['site.com'], adult: ['other.com'] });
  });

  it('keeps sibling names that merely share a suffix', () => {
    const r = assignCategories(['adult'], { adult: new Set(['badsite.com', 'site.com']) });
    expect(r.adult).toEqual(['badsite.com', 'site.com']);
  });
});

describe('findCovered', () => {
  it('finds canaries blocked directly or through a parent, and ignores the rest', () => {
    const covered = findCovered(new Set(['a.com', 'sub.b.com', 'safe.com']), { adult: ['a.com', 'b.com'] });
    expect(covered).toEqual([
      { domain: 'a.com', listed: 'a.com', category: 'adult' },
      { domain: 'sub.b.com', listed: 'b.com', category: 'adult' },
    ]);
  });
});

describe('rule generation', () => {
  it('derives a valid extension id and a rule that passes only the host', () => {
    const id = extensionIdFromKey(Buffer.from('key').toString('base64'), createHash);
    expect(id).toMatch(/^[a-p]{32}$/);
    const rule = buildBlockRule('adult', ['a.com'], id);
    expect(rule.action.redirect.regexSubstitution).toBe(`chrome-extension://${id}/block.html?c=adult&host=\\1`);
    expect(rule.condition.regexFilter.endsWith('.*$')).toBe(true);
  });
});
