import * as rulesV1 from './rulesV1';
import * as rulesV2 from './rulesV2';

export type CanonicalRunState = rulesV1.CanonicalRunState | rulesV2.CanonicalRunState;
export type CanonicalRunInput = rulesV1.CanonicalRunInput | rulesV2.CanonicalRunInput;
export type GameplayCommand = rulesV1.GameplayCommand | rulesV2.GameplayCommand;
export type RulesResult = rulesV1.RulesResult | rulesV2.RulesResult;

export function createCanonicalRun(
  rulesVersion: number,
  input: CanonicalRunInput,
): CanonicalRunState {
  if (rulesVersion === rulesV1.RULES_VERSION)
    return rulesV1.createCanonicalRun(input as rulesV1.CanonicalRunInput);
  if (rulesVersion === rulesV2.RULES_VERSION)
    return rulesV2.createCanonicalRun(input as rulesV2.CanonicalRunInput);
  throw new Error(`Unsupported canonical rules version: ${rulesVersion}.`);
}

export function applyCanonicalCommand(
  state: CanonicalRunState,
  command: GameplayCommand,
  serverTimeMs: number,
): RulesResult {
  if (state.rulesVersion === rulesV1.RULES_VERSION)
    return rulesV1.applyCanonicalCommand(state, command as rulesV1.GameplayCommand, serverTimeMs);
  if (state.rulesVersion === rulesV2.RULES_VERSION)
    return rulesV2.applyCanonicalCommand(state, command as rulesV2.GameplayCommand, serverTimeMs);
  throw new Error('Unsupported canonical rules version.');
}

export function serializeCanonicalRun(state: CanonicalRunState): string {
  return state.rulesVersion === rulesV2.RULES_VERSION
    ? rulesV2.serializeCanonicalRun(state)
    : rulesV1.serializeCanonicalRun(state);
}

export function deserializeCanonicalRun(serialized: string): CanonicalRunState {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || !('rulesVersion' in value))
    throw new Error('Canonical run has no rules version.');
  const version = (value as { rulesVersion: unknown }).rulesVersion;
  if (version === rulesV1.RULES_VERSION) return rulesV1.deserializeCanonicalRun(serialized);
  if (version === rulesV2.RULES_VERSION) return rulesV2.deserializeCanonicalRun(serialized);
  throw new Error(`Unsupported canonical rules version: ${String(version)}.`);
}

export function scoreTierFromEarnedNature(earnedNatureAtoms: bigint): number {
  return rulesV1.scoreTierFromEarnedNature(earnedNatureAtoms);
}

export function seasonIdAtMilliseconds(timestampMs: number): number {
  return rulesV1.seasonIdAtMilliseconds(timestampMs);
}

export function getCanonicalRulesVersion(state: CanonicalRunState): number {
  return state.rulesVersion;
}
