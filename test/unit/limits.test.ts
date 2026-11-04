import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  ENCOURAGEMENTS,
  describeOpening,
  LIMIT_RULE_BASE,
  MAX_LIMITS,
  PRESETS,
  isLimitingNow,
  isLoosening,
  isScheduled,
  isValidSchedule,
  limitRule,
  lowestFreeSlot,
  nextEncouragement,
  nextOpening,
  type Limit,
  type Schedule,
} from '../../src/lib/limits';

// 2026-11-02 is a Monday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, 2 + ((day + 6) % 7), hour, minute);
const limit = (schedule: Schedule | null): Limit => ({ id: 'reddit', label: 'Reddit', domains: ['reddit.com'], slot: 3, schedule });

describe('isScheduled', () => {
  const work = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 };
  it.each([
    ['inside the range', at(1, 12), true],
    ['exactly at the start', at(1, 9), true],
    ['one minute before the start', at(1, 8, 59), false],
    ['exactly at the end', at(1, 17), false],
    ['one minute before the end', at(1, 16, 59), true],
    ['on a day not picked', at(6, 12), false],
    ['on Sunday, not picked', at(0, 12), false],
  ])('%s', (_name, date, expected) => expect(isScheduled(work, date)).toBe(expected));

  const night = { days: [5], start: 22 * 60, end: 6 * 60 };
  it.each([
    ['before midnight on the picked day', at(5, 23), true],
    ['after midnight, carried over from the picked day', at(6, 5, 59), true],
    ['when the range has ended', at(6, 6), false],
    ['early on the picked day, which belongs to the day before', at(5, 3), false],
    ['late on the following day', at(6, 23), false],
  ])('overnight: %s', (_name, date, expected) => expect(isScheduled(night, date)).toBe(expected));

  it('carries Sunday night over into Monday', () => {
    expect(isScheduled({ days: [0], start: 22 * 60, end: 6 * 60 }, at(1, 2))).toBe(true);
  });
});

describe('isLimitingNow', () => {
  const now = at(1, 12).getTime();
  it('limits at all times without a schedule', () => expect(isLimitingNow(limit(null), now)).toBe(true));
  it('follows the schedule', () => {
    expect(isLimitingNow(limit(DEFAULT_SCHEDULE), now)).toBe(true);
    expect(isLimitingNow(limit(DEFAULT_SCHEDULE), at(6, 12).getTime())).toBe(false);
  });
});

describe('isValidSchedule', () => {
  it('accepts a normal and an overnight range', () => {
    expect(isValidSchedule(DEFAULT_SCHEDULE)).toBe(true);
    expect(isValidSchedule({ days: [0], start: 1320, end: 360 })).toBe(true);
  });
  it.each([
    ['no days', { days: [], start: 1, end: 2 }],
    ['equal times', { days: [1], start: 5, end: 5 }],
    ['a day out of range', { days: [7], start: 1, end: 2 }],
    ['a time out of range', { days: [1], start: 1, end: 1440 }],
    ['a fractional time', { days: [1], start: 1.5, end: 2 }],
    ['nothing', null],
    ['days that are not a list', { days: 'mon', start: 1, end: 2 }],
  ])('rejects %s', (_name, value) => expect(isValidSchedule(value)).toBe(false));
});

describe('lowestFreeSlot', () => {
  it('reuses freed slots and stops at the cap', () => {
    expect(lowestFreeSlot([])).toBe(0);
    expect(lowestFreeSlot([limit(null), { ...limit(null), slot: 0 }])).toBe(1);
    const full = Array.from({ length: MAX_LIMITS }, (_, slot) => ({ ...limit(null), slot }));
    expect(lowestFreeSlot(full)).toBeNull();
  });
});

describe('limitRule', () => {
  it('outranks the allowlist, catches top-level pages only, and passes only the host', () => {
    const rule = limitRule(limit(null), 'abc');
    expect(rule.id).toBe(LIMIT_RULE_BASE + 3);
    expect(rule.priority).toBeGreaterThan(100);
    expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    expect(rule.action.redirect?.regexSubstitution).toBe('chrome-extension://abc/block.html?limit=reddit&host=\\1');
  });
});

describe('PRESETS', () => {
  it('covers the sites promised in the roadmap', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['x', 'reddit', 'instagram', 'tiktok']);
  });
});

describe('isLoosening', () => {
  const work = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 };
  it.each([
    ['all the time to a schedule', null, work, true],
    ['a schedule to all the time', work, null, false],
    ['all the time to all the time', null, null, false],
    ['the same schedule', work, work, false],
    ['the same schedule with days in another order', work, { ...work, days: [5, 4, 3, 2, 1] }, false],
    ['adding a day', work, { ...work, days: [...work.days, 6] }, false],
    ['dropping a day', work, { ...work, days: [1, 2, 3, 4] }, true],
    ['ending earlier', work, { ...work, end: 16 * 60 }, true],
    ['starting later', work, { ...work, start: 10 * 60 }, true],
    ['starting earlier and ending later', work, { ...work, start: 8 * 60, end: 18 * 60 }, false],
    ['moving the same hours to other days', work, { ...work, days: [0, 2, 3, 4, 6] }, true],
    ['an overnight range that still covers the day', work, { days: [0, 1, 2, 3, 4, 5, 6], start: 8 * 60, end: 7 * 60 }, false],
    ['shortening an overnight range past midnight', { days: [5], start: 22 * 60, end: 2 * 60 }, { days: [5], start: 22 * 60, end: 60 }, true],
    ['keeping the Saturday morning of a Friday night range', { days: [5], start: 22 * 60, end: 2 * 60 }, { days: [5, 6], start: 0, end: 23 * 60 + 59 }, true],
    ['Sunday night running into Monday', { days: [0], start: 23 * 60, end: 60 }, { days: [0, 1], start: 0, end: 23 * 60 + 59 }, true],
  ])('%s', (_name, current, next, expected) => expect(isLoosening(current, next)).toBe(expected));
});

describe('nextEncouragement', () => {
  it('never repeats the sentence on screen', () => {
    for (const current of ENCOURAGEMENTS) {
      for (const r of [0, 0.5, 0.999]) expect(nextEncouragement(current, () => r)).not.toBe(current);
    }
  });

  it('can reach every sentence', () => {
    const seen = new Set(Array.from({ length: ENCOURAGEMENTS.length }, (_, i) => nextEncouragement(null, () => i / ENCOURAGEMENTS.length)));
    expect(seen.size).toBe(ENCOURAGEMENTS.length);
  });
});

describe('nextOpening', () => {
  const work = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 };
  it('is null when the limit has no end or is not applying', () => {
    expect(nextOpening(limit(null), at(1, 12).getTime())).toBeNull();
    expect(nextOpening(limit(work), at(1, 8).getTime())).toBeNull();
  });
  it.each([
    ['later the same day', work, at(1, 12), at(1, 17), 'today at 17:00'],
    ['past midnight', { days: [5], start: 22 * 60, end: 2 * 60 }, at(5, 23), at(6, 2), 'tomorrow at 02:00'],
    ['days away when ranges join up', { days: [1, 2, 3], start: 0, end: 23 * 60 + 59 }, at(1, 12), at(1, 23, 59), 'today at 23:59'],
    ['on a named day', { days: [1, 2, 3, 4, 5, 6, 0], start: 8 * 60, end: 7 * 60 }, at(1, 12), at(2, 7), 'tomorrow at 07:00'],
  ])('%s', (_name, schedule, now, expected, words) => {
    const opening = nextOpening(limit(schedule), now.getTime());
    expect(opening?.getTime()).toBe(expected.getTime());
    expect(describeOpening(opening!, now.getTime())).toBe(words);
  });
  it('names the day when it is further away', () => {
    expect(describeOpening(at(5, 8), at(2, 12).getTime())).toBe('on Friday at 08:00');
  });
});
