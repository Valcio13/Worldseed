import { useEffect, useState } from 'react';
import './OpeningReveal.css';

const OPENING_REVEAL_DURATION_MS = 1_500;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** A one-time visual curtain; the active game is mounted beside it immediately. */
export function OpeningReveal() {
  const [visible, setVisible] = useState(() => !prefersReducedMotion());

  useEffect(() => {
    if (!visible) return;

    const timer = window.setTimeout(() => setVisible(false), OPENING_REVEAL_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="opening-reveal" data-testid="opening-reveal" aria-hidden="true" inert>
      <span className="opening-reveal-brand living-brand">
        <span className="living-brand-seed" aria-hidden="true">
          ✦
        </span>
        <span>worldseed</span>
      </span>
    </div>
  );
}
