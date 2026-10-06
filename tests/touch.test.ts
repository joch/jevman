import { describe, expect, it } from 'vitest';
import { swipeDir } from '../src/touch';

describe('swipeDir', () => {
  it('reads the dominant axis of a swipe', () => {
    expect(swipeDir(100, 100, 160, 110)).toBe('right');
    expect(swipeDir(100, 100, 40, 90)).toBe('left');
    expect(swipeDir(100, 100, 110, 30)).toBe('up');
    expect(swipeDir(100, 100, 95, 170)).toBe('down');
  });

  it('ignores taps and tiny movements', () => {
    expect(swipeDir(100, 100, 105, 108)).toBeNull();
  });
});
