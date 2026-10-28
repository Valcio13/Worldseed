import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { PP_UPGRADES, type UpgradeChoice } from '../rulesV1';

export const SOLIDITY_UPGRADE_IDS = {
  growth: 0,
  efficiency: 1,
  awakening: 2,
  rebirth: 3,
} as const satisfies Record<(typeof PP_UPGRADES)[number], number>;

export interface SolidityUpgradeChoice {
  upgradeId: number;
  quantity: number;
}

export function toSolidityUpgradeChoices(
  choices: readonly UpgradeChoice[],
): SolidityUpgradeChoice[] {
  const result = choices.map(({ upgradeId, quantity }) => {
    if (upgradeId === 'rebirth')
      throw new Error('The verified Rebirth PP upgrade is disabled until it provides a benefit.');
    if (!Object.hasOwn(SOLIDITY_UPGRADE_IDS, upgradeId)) throw new Error('Unknown PP upgrade ID.');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 65_535)
      throw new Error('Upgrade quantity must fit a positive uint16.');
    return { upgradeId: SOLIDITY_UPGRADE_IDS[upgradeId], quantity };
  });
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]!.upgradeId >= result[index]!.upgradeId)
      throw new Error('Upgrade choices must be unique and sorted by uint8 upgradeId.');
  }
  return result;
}

/** Exactly keccak256(abi.encode(UpgradeChoice[])), where Solidity struct fields are uint8,uint16. */
export function encodeUpgradeChoices(choices: readonly UpgradeChoice[]): Hex {
  const canonical = toSolidityUpgradeChoices(choices);
  return encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        components: [
          { name: 'upgradeId', type: 'uint8' },
          { name: 'quantity', type: 'uint16' },
        ],
      },
    ],
    [canonical],
  );
}

export function hashUpgradeChoices(choices: readonly UpgradeChoice[]): Hex {
  return keccak256(encodeUpgradeChoices(choices));
}
