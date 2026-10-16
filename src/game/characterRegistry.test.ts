import { describe, expect, it } from 'vitest';
import { characterRosterOrder, CHARACTER_REGISTRY } from './characterRegistry';

describe('character registry', () => {
  it('keeps the approved sprite roster and derives a stable order from all source hashes', () => {
    const hashes = ['eth-hash', 'hemi-hash', 'btc-hash'];
    const first = characterRosterOrder(hashes, 'selected-seed');
    expect(first).toHaveLength(CHARACTER_REGISTRY.length);
    expect(new Set(first)).toEqual(new Set(CHARACTER_REGISTRY.map((character) => character.id)));
    expect(characterRosterOrder(hashes, 'selected-seed')).toEqual(first);
    expect(characterRosterOrder(['other-eth', ...hashes.slice(1)], 'selected-seed')).not.toEqual(
      first,
    );
  });
});
