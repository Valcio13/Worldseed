/** Feature flags that opt into unfinished integration surfaces. */
export function isV3IdleIntegrationEnabled(value = import.meta.env.VITE_ENABLE_V3_IDLE) {
  return value === 'true';
}
