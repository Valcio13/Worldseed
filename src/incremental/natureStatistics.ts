/**
 * Converts canonical per-run earned Nature atoms to the bounded EIP-712 metric.
 * Sub-Nature fractions are already represented as integer atoms and are preserved.
 */
export const MAX_ATTESTED_NATURE_ATOMS = (1n << 256n) - 1n;

export function natureAtomsForSettlement(earnedNatureAtoms: bigint): bigint {
  if (earnedNatureAtoms < 0n) throw new Error('Earned Nature atoms cannot be negative.');
  return earnedNatureAtoms > MAX_ATTESTED_NATURE_ATOMS
    ? MAX_ATTESTED_NATURE_ATOMS
    : earnedNatureAtoms;
}
