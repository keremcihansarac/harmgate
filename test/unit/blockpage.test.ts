import { describe, expect, it } from 'vitest';
import { CATEGORY_SENTENCES, IDEAS, pickSome } from '../../src/lib/blockpage';
import { CATEGORIES } from '../../src/lib/constants';

describe('pickSome', () => {
  it('returns different items, whatever the random numbers', () => {
    for (const r of [0, 0.5, 0.999]) {
      const picked = pickSome(IDEAS, 3, () => r);
      expect(picked).toHaveLength(3);
      expect(new Set(picked).size).toBe(3);
    }
  });

  it('stops when the list runs out, and leaves the list as it was', () => {
    const items = ['a', 'b'];
    expect(pickSome(items, 5).sort()).toEqual(['a', 'b']);
    expect(items).toEqual(['a', 'b']);
  });
});

it('has something to say for every category', () => {
  for (const c of CATEGORIES) expect(CATEGORY_SENTENCES[c].length).toBeGreaterThan(0);
});
