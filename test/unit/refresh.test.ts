import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../../src/lib/refresh';

describe('isNewerVersion', () => {
  it.each([
    ['0.3.1', '0.3.0', true],
    ['0.4.0', '0.3.9', true],
    ['1.0.0', '0.9.9', true],
    ['0.10.0', '0.9.0', true],
    ['0.3.0', '0.3.0', false],
    ['0.2.9', '0.3.0', false],
    ['v0.4.0', '0.3.0', false],
    ['0.4', '0.3.0', false],
    ['<b>9</b>', '0.3.0', false],
    [9, '0.3.0', false],
    [null, '0.3.0', false],
  ])('%s against %s', (candidate, current, expected) => expect(isNewerVersion(candidate, current)).toBe(expected));
});
