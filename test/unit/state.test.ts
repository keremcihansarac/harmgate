import { describe, expect, it } from 'vitest';
import { HEARTBEAT_GAP_MS, WAIT_MS, isValidDomain } from '../../src/lib/constants';
import { validateList } from '../../src/lib/refresh';
import { desiredRules } from '../../src/lib/rules';
import { defaultState, gatePhrase, limitChangeKey, parseGateKey, pendingStatus, touchPending } from '../../src/lib/state';

describe('pendingStatus', () => {
  const t = 1_000_000;
  const wait = (startedAt: number, lastSeen = startedAt) => ({ startedAt, lastSeen });
  it.each([
    ['no wait', undefined, t, 'none'],
    ['just started', wait(t), t, 'waiting'],
    ['almost done', wait(t, t + WAIT_MS - 1000), t + WAIT_MS - 1, 'waiting'],
    ['done and still here', wait(t, t + WAIT_MS - 1000), t + WAIT_MS, 'ready'],
    ['left the tab', wait(t, t + 1000), t + 1000 + HEARTBEAT_GAP_MS + 1, 'none'],
    ['clock moved forward past the wait', wait(t), t + WAIT_MS + 1, 'none'],
    ['clock moved backward', wait(t), t - 1, 'none'],
    ['saved by an older version', { startedAt: t } as never, t, 'none'],
  ])('%s', (_name, value, now, expected) => {
    expect(pendingStatus(value, now)).toBe(expected);
  });
});

describe('touchPending', () => {
  it('keeps a running wait, so that it cannot be moved', () => {
    const state = defaultState();
    touchPending(state, 'k', 1000);
    expect(touchPending(state, 'k', 6000)).toEqual({ startedAt: 1000, lastSeen: 6000 });
  });

  it('starts over after a silence', () => {
    const state = defaultState();
    touchPending(state, 'k', 1000);
    const later = 1000 + HEARTBEAT_GAP_MS + 1;
    expect(touchPending(state, 'k', later)).toEqual({ startedAt: later, lastSeen: later });
  });

  it('needs the full wait of unbroken check-ins to become ready', () => {
    const state = defaultState();
    let now = 0;
    touchPending(state, 'k', now);
    while (now < WAIT_MS) {
      expect(pendingStatus(state.pending.k, now)).toBe('waiting');
      now += 5000;
      touchPending(state, 'k', now);
    }
    expect(pendingStatus(state.pending.k, now)).toBe('ready');
  });
});

describe('gate keys', () => {
  it('reads valid keys and refuses the rest', () => {
    expect(parseGateKey('allow:a.com')).toEqual({ kind: 'allow', host: 'a.com' });
    const schedule = { days: [1], start: 60, end: 120 };
    expect(parseGateKey('limit-remove:site3')).toEqual({ kind: 'limit-remove', id: 'site3' });
    expect(parseGateKey(limitChangeKey('reddit', schedule))).toEqual({ kind: 'limit-change', id: 'reddit', schedule });
    for (const bad of [
      'disable:adult', 'disable:evil', 'allow:not a domain', 'nope', 'other:a.com', null, 5,
      'limit-remove:', 'limit-remove:a b', 'limit-change:reddit', 'limit-change::{}', 'limit-change:reddit:{bad',
      'limit-change:reddit:null', 'limit-change:reddit:{"days":[],"start":1,"end":2}',
    ]) expect(parseGateKey(bad)).toBeNull();
  });

  it('asks for a sentence naming exactly what is being given up', () => {
    expect(gatePhrase({ kind: 'allow', host: 'a.com' })).toBe('I choose to allow a.com.');
    const limits = [{ id: 'reddit', label: 'Reddit', domains: ['reddit.com'], slot: 0, schedule: null }];
    expect(gatePhrase({ kind: 'limit-remove', id: 'reddit' }, limits)).toBe('I choose to remove my limit on Reddit.');
    expect(gatePhrase({ kind: 'limit-change', id: 'reddit', schedule: { days: [1], start: 60, end: 120 } }, limits)).toBe('I choose to loosen my limit on Reddit.');
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

  it('has a rule in force for every category in every state', () => {
    const state = defaultState();
    state.applied.gambling = 'v2';
    const r = desiredRules(state);
    for (const c of ['adult', 'gambling', 'gore']) expect(r.enableRulesetIds.includes(c) !== r.disableRulesetIds.includes(c)).toBe(true);
    expect(r.enableRulesetIds).toEqual(['adult', 'gore']);
    expect(r.removeRuleIds).not.toContain(12);
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
