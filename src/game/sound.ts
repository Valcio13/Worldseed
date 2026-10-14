export type IslandSound = 'water' | 'grass' | 'forest' | 'unlock' | 'complete';

const notes: Record<IslandSound, number[]> = {
  water: [523, 659],
  grass: [587, 784],
  forest: [392, 587, 784],
  unlock: [523, 659, 784],
  complete: [392, 523, 659, 784],
};

/** A quiet, original oscillator chime. The calling click is the browser audio gesture. */
export function playIslandSound(kind: IslandSound): void {
  if (typeof window === 'undefined') return;
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return;
  try {
    const context = new AudioContextConstructor();
    const now = context.currentTime;
    notes[kind].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + index * 0.075;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.055, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.2);
    });
    window.setTimeout(() => void context.close(), 650);
  } catch {
    // Audio is decorative; gameplay continues if the browser blocks it.
  }
}
