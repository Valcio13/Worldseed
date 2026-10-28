import { App } from './App';
import { isV3IdleIntegrationEnabled } from '../integration/featureFlags';
import { V3IntegrationShell } from './V3IntegrationShell';

/** Adds the optional verified mode around the existing game without changing its content. */
export function V3Application() {
  const existingGame = <App />;
  return isV3IdleIntegrationEnabled() ? (
    <V3IntegrationShell guestGame={existingGame} />
  ) : (
    existingGame
  );
}
