import { describe, expect, it } from 'vitest';
import { countNewCpMilestones, nextCpMilestoneTier } from './cpMilestones';

describe('V3 seasonal CP milestones', () => {
  it('awards only on new seven-tier milestones above the threshold', () => {
    expect(countNewCpMilestones(35, 0, 35)).toBe(0);
    expect(countNewCpMilestones(41, 35, 35)).toBe(0);
    expect(countNewCpMilestones(42, 35, 35)).toBe(1);
    expect(countNewCpMilestones(42, 42, 35)).toBe(0);
    expect(countNewCpMilestones(56, 42, 35)).toBe(2);
  });

  it('does not let switching between the tier-35 and tier-42 rules claim a past milestone', () => {
    expect(countNewCpMilestones(42, 42, 42)).toBe(0);
    expect(countNewCpMilestones(42, 42, 35)).toBe(0);
    expect(countNewCpMilestones(49, 42, 35)).toBe(1);
    expect(countNewCpMilestones(49, 42, 42)).toBe(1);
    expect(countNewCpMilestones(49, 35, 42)).toBe(1);
  });

  it('exposes the next milestone and handles the score ceiling', () => {
    expect(nextCpMilestoneTier(0, 35)).toBe(42);
    expect(nextCpMilestoneTier(42, 42)).toBe(49);
    expect(nextCpMilestoneTier(65_534, 42)).toBeNull();
  });

  it('rejects malformed score inputs', () => {
    expect(() => countNewCpMilestones(-1, 0, 35)).toThrow(RangeError);
    expect(() => countNewCpMilestones(1.5, 0, 35)).toThrow(RangeError);
    expect(() => nextCpMilestoneTier(0, 35, 0)).toThrow(RangeError);
  });
});
