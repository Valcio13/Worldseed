import { useLayoutEffect } from 'react';
import { LivingIslandGame } from './LivingIslandGame';
import { OpeningReveal } from './OpeningReveal';

export function App() {
  useLayoutEffect(() => {
    document.body.classList.add('worldseed-app-scroll');
    return () => document.body.classList.remove('worldseed-app-scroll');
  }, []);

  return (
    <>
      <OpeningReveal />
      <LivingIslandGame />
    </>
  );
}
