import { describe, expect, it } from 'vitest';
import { CONFIRM_WINDOW_MS, WAIT_MS, isValidDomain } from '../../src/lib/constants';
import { validateList } from '../../src/lib/refresh';
import { desiredRules } from '../../src/lib/rules';
import { defaultState, pendingStatus, startPending } from '../../src/lib/state';

describe('pendingStatus', () => {
  const t = 1_000_000;
  it.each([
    [undefined, t, 'none'],
    [t, t, 'waiting'],
    [t, t + WAIT_MS - 1, 'waiting'],
    [t, t + WAIT_MS, 'ready'],
    [t, t + WAIT_MS + CONFIRM_WINDOW_MS, 'ready'],
    [t, t + WAIT_MS + CONFIRM_WINDOW_MS + 1, 'expired'],
    [t, t - 1, 'expired'],
  ])('started %s, now %s is %s', (startedAt, now, expected) => {
    expect(pendingStatus(startedAt, now)).toBe(expected);
  });
});

describe('startPending', () => {
  it('does not restart a running wait, so that it cannot be moved', () => {
    const state = defaultState();
    expect(startPending(state, 'k', 1000)).toBe(1000);
    expect(startPending(state, 'k', 2000)).toBe(1000);
  });

  it('starts over once the previous wait has expired', () => {
    const state = defaultState();
    startPending(state, 'k', 1000);
    const later = 1000 + WAIT_MS + CONFIRM_WINDOW_MS + 1;
    expect(startPending(state, 'k', later)).toBe(later);
  });
});

describe('desiredRules', () => {
  it('uses bundled rulesets by default, with no allow rule', () => {
    const r = desiredRules(defaultState());
    expect(r.enableRulesetIds).toEqual(['adult', 'gambling', 'gore']);
    expect(r.disableRulesetIds).toEqual([]);
    expect(r.addRules).toEqual([]);
  });

  it('keeps a refreshed rule and turns off its bundled ruleset', () => {
    const state = defaultState();
    state.applied.adult = 'v2';
    const r = desiredRules(state);
    expect(r.disableRulesetIds).toEqual(['adult']);
    expect(r.removeRuleIds).not.toContain(11);
    expect(r.removeRuleIds).toContain(12);
  });

  it('removes everything for a disabled category, even a refreshed one', () => {
    const state = defaultState();
    state.enabled.gambling = false;
    state.applied.gambling = 'v2';
    const r = desiredRules(state);
    expect(r.enableRulesetIds).not.toContain('gambling');
    expect(r.disableRulesetIds).toContain('gambling');
    expect(r.removeRuleIds).toContain(12);
  });

  it('lets allowlisted sites outrank block rules', () => {
    const state = defaultState();
    state.allowlist = ['ok.com'];
    const [rule] = desiredRules(state).addRules;
    expect(rule?.priority).toBeGreaterThan(1);
    expect(rule?.condition.requestDomains).toEqual(['ok.com']);
  });
});

describe('validateList', () => {
  const list = JSON.stringify(['a.com', 'b.com']);
  it('accepts a matching, plausible list', () => {
    expect(validateList(list, 'x', 'x', 2)).toEqual(['a.com', 'b.com']);
  });
  it('rejects a checksum mismatch', () => {
    expect(() => validateList(list, 'x', 'y', 2)).toThrow('Checksum');
  });
  it('rejects invalid entries', () => {
    expect(() => validateList(JSON.stringify(['a.com', 'bad domain']), 'x', 'x', 1)).toThrow('invalid');
  });
  it('rejects something that is not a list', () => {
    expect(() => validateList('{"a":1}', 'x', 'x', 1)).toThrow('invalid');
  });
  it('rejects a list far smaller than the bundled one', () => {
    expect(() => validateList(list, 'x', 'x', 100)).toThrow('too small');
  });
});

describe('isValidDomain', () => {
  it.each(['a.com', 'xn--bcher-kva.de', 'a-b.co.uk'])('accepts %s', (d) => expect(isValidDomain(d)).toBe(true));
  it.each(['', 'localhost', 'a.com/path', 'A.COM', '<b>.com', 'a.com?x=1', null, 5])('rejects %s', (d) => expect(isValidDomain(d)).toBe(false));
});
