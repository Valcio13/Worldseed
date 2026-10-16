import { keccak256, stringToHex } from 'viem';

export type CharacterKind = 'animal' | 'villager' | 'spirit';

export interface CharacterDefinition {
  id: string;
  name: string;
  kind: CharacterKind;
  spriteClass: string;
  unlockHealthy: number;
  unlockForests: number;
  home: { x: number; y: number };
}

/** Approved Luna sprites and their deterministic arrival conditions. */
export const CHARACTER_REGISTRY: readonly CharacterDefinition[] = [
  {
    id: 'pip',
    name: 'Pip the woodland scout',
    kind: 'animal',
    spriteClass: 'pip',
    unlockHealthy: 0,
    unlockForests: 0,
    home: { x: 1, y: 1 },
  },
  {
    id: 'moss',
    name: 'Moss the little slime',
    kind: 'animal',
    spriteClass: 'moss',
    unlockHealthy: 3,
    unlockForests: 0,
    home: { x: 2, y: 3 },
  },
  {
    id: 'tavi',
    name: 'Tavi the explorer',
    kind: 'villager',
    spriteClass: 'tavi',
    unlockHealthy: 4,
    unlockForests: 0,
    home: { x: 1, y: 4 },
  },
  {
    id: 'luma',
    name: 'Luma the forest spirit',
    kind: 'spirit',
    spriteClass: 'luma',
    unlockHealthy: 0,
    unlockForests: 1,
    home: { x: 2, y: 5 },
  },
  {
    id: 'rowan',
    name: 'Rowan the caretaker',
    kind: 'villager',
    spriteClass: 'rowan',
    unlockHealthy: 7,
    unlockForests: 1,
    home: { x: 4, y: 4 },
  },
];

/** Stable roster order for a selected ETH + HEMI + BTC candidate set. */
export function characterRosterOrder(
  sourceHashes: readonly string[],
  selectedSeed: string,
): string[] {
  const entropy = keccak256(
    stringToHex(`worldseed:characters:v1:${sourceHashes.join('|')}:${selectedSeed}`),
  );
  return [...CHARACTER_REGISTRY]
    .sort((left, right) => {
      const leftKey = keccak256(stringToHex(`${entropy}:${left.id}`));
      const rightKey = keccak256(stringToHex(`${entropy}:${right.id}`));
      return leftKey.localeCompare(rightKey);
    })
    .map((character) => character.id);
}
