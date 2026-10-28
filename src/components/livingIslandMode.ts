export type LivingIslandMode = 'guest' | 'verified';

export function initialLivingIslandMode(
  savedPreference: string | null,
  isProduction: boolean,
  liveEnabled: boolean,
): LivingIslandMode {
  if (savedPreference === 'guest') return 'guest';
  if ((savedPreference === 'live' || savedPreference === 'verified') && liveEnabled)
    return 'verified';
  return isProduction && liveEnabled ? 'verified' : 'guest';
}
