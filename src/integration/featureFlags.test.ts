import { describe, expect, it } from 'vitest';
import { isV3IdleIntegrationEnabled } from './featureFlags';

describe('V3 idle integration feature flag', () => {
  it('stays disabled when unset or set to any value other than the explicit opt-in', () => {
    expect(isV3IdleIntegrationEnabled(undefined)).toBe(false);
    expect(isV3IdleIntegrationEnabled('')).toBe(false);
    expect(isV3IdleIntegrationEnabled('false')).toBe(false);
    expect(isV3IdleIntegrationEnabled('1')).toBe(false);
    expect(isV3IdleIntegrationEnabled('TRUE')).toBe(false);
  });

  it('enables the V3 integration shell only for an explicit true value', () => {
    expect(isV3IdleIntegrationEnabled('true')).toBe(true);
  });
});
