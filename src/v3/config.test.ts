import { describe, expect, it } from 'vitest';
import { v3ContractAbi } from './config';

describe('V3 lifetime statistic getters', () => {
  it.each([
    ['lifetimeNatureCollectedAtoms', ['address']],
    ['totalAccumulatedRebirthScore', ['address']],
    ['seasonalAccumulatedRebirthScore', ['address', 'uint64']],
  ])('%s has the contract-compatible call and uint256 result', (name, inputTypes) => {
    const getter = v3ContractAbi.find((item) => item.type === 'function' && item.name === name);

    expect(getter).toBeDefined();
    if (!getter || getter.type !== 'function') return;
    expect(getter.stateMutability).toBe('view');
    expect(getter.inputs.map((input) => input.type)).toEqual(inputTypes);
    expect(getter.outputs.map((output) => output.type)).toEqual(['uint256']);
  });
});
