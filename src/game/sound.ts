export interface AudioPreferences {
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
  musicEnabled: boolean;
}

export type IslandSound =
  | 'collect'
  | 'habitat'
  | 'upgrade'
  | 'evolution'
  | 'rebirth'
  // Compatibility aliases used by the retired restoration screen.
  | 'water'
  | 'grass'
  | 'forest'
  | 'unlock'
  | 'complete';

const STORAGE_KEY = 'worldseed:audio-preferences:v1';
const LEGACY_SOUND_KEY = 'worldseed:sound';
const MUSIC_DISABLED_KEY = 'worldseed:music-explicitly-disabled:v1';
const DEFAULT_PREFERENCES: AudioPreferences = {
  musicVolume: 0.15,
  sfxVolume: 1,
  muted: false,
  musicEnabled: true,
};

const SFX_NOTES: Record<IslandSound, number[]> = {
  collect: [659, 880],
  habitat: [523, 659, 784],
  upgrade: [659, 784, 988],
  evolution: [523, 659, 784, 1047],
  rebirth: [392, 523, 659, 784],
  water: [523, 659],
  grass: [587, 784],
  forest: [392, 587, 784],
  unlock: [523, 659, 784],
  complete: [392, 523, 659, 784],
};

const MUSIC_URL = '/audio/cozy-day-617663.mp3';
const CROSSFADE_MS = 2_000;
const CROSSFADE_START_SECONDS = 2.6;

let preferences: AudioPreferences = readPreferences();
type IslandAudioContext = InstanceType<typeof window.AudioContext>;
let audioContext: IslandAudioContext | null = null;
let sfxBus: ReturnType<IslandAudioContext['createGain']> | null = null;
type IslandMusicElement = ReturnType<typeof createMusicElement>;
let musicPlayers: [IslandMusicElement, IslandMusicElement] | null = null;
let currentMusicPlayer = 0;
let crossfadeTimer: number | null = null;
let crossfadeStartedAt: number | null = null;
let crossfadeFrom = 0;
let sfxBusyUntil = Number.NEGATIVE_INFINITY;
const listeners = new Set<(value: AudioPreferences) => void>();
let musicStartPending = false;
let musicStartGeneration = 0;
let musicGestureFallback: (() => void) | null = null;

function removeMusicGestureFallback(): void {
  if (!musicGestureFallback || typeof document === 'undefined') return;
  document.removeEventListener('pointerdown', musicGestureFallback);
  document.removeEventListener('click', musicGestureFallback);
  document.removeEventListener('keydown', musicGestureFallback);
  document.removeEventListener('touchstart', musicGestureFallback);
  musicGestureFallback = null;
}

function installMusicGestureFallback(): void {
  if (musicGestureFallback || typeof document === 'undefined') return;
  musicGestureFallback = () => {
    if (!preferences.musicEnabled || preferences.muted || preferences.musicVolume <= 0) return;
    startMusic();
  };
  document.addEventListener('pointerdown', musicGestureFallback);
  document.addEventListener('click', musicGestureFallback);
  document.addEventListener('keydown', musicGestureFallback);
  document.addEventListener('touchstart', musicGestureFallback);
}

function clampVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function readPreferences(): AudioPreferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFERENCES };
  try {
    const explicitlyDisabled = localStorage.getItem(MUSIC_DISABLED_KEY) === 'true';
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === 'object') {
        const value = parsed as Partial<AudioPreferences>;
        return {
          musicVolume: clampVolume(value.musicVolume, DEFAULT_PREFERENCES.musicVolume),
          sfxVolume: clampVolume(value.sfxVolume, DEFAULT_PREFERENCES.sfxVolume),
          muted: typeof value.muted === 'boolean' ? value.muted : false,
          // Old builds persisted their default-off state; only the explicit opt-out marker is authoritative.
          musicEnabled: !explicitlyDisabled,
        };
      }
    }
    return {
      ...DEFAULT_PREFERENCES,
      muted: localStorage.getItem(LEGACY_SOUND_KEY) === 'off',
      musicEnabled: !explicitlyDisabled,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function persistPreferences(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    localStorage.setItem(LEGACY_SOUND_KEY, preferences.muted ? 'off' : 'on');
  } catch {
    // Audio preferences are optional and never affect game saves.
  }
}

export function getAudioPreferences(): AudioPreferences {
  return { ...preferences };
}

export function subscribeAudioPreferences(listener: (value: AudioPreferences) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateAudioPreferences(update: Partial<AudioPreferences>): AudioPreferences {
  preferences = {
    musicVolume: clampVolume(update.musicVolume ?? preferences.musicVolume, preferences.musicVolume),
    sfxVolume: clampVolume(update.sfxVolume ?? preferences.sfxVolume, preferences.sfxVolume),
    muted: update.muted ?? preferences.muted,
    musicEnabled: update.musicEnabled ?? preferences.musicEnabled,
  };
  persistPreferences();
  syncBuses();
  if (!preferences.musicEnabled || preferences.muted || preferences.musicVolume <= 0) {
    // A pending play() may stay unresolved after pause(); allow the next
    // explicit unmute to retry playback immediately.
    musicStartPending = false;
    musicStartGeneration += 1;
    removeMusicGestureFallback();
  }
  listeners.forEach((listener) => listener(getAudioPreferences()));
  return getAudioPreferences();
}

/** Persist the player's explicit Play/Pause choice separately from legacy default-off records. */
export function setMusicEnabledByUser(enabled: boolean): AudioPreferences {
  try {
    if (enabled) localStorage.removeItem(MUSIC_DISABLED_KEY);
    else localStorage.setItem(MUSIC_DISABLED_KEY, 'true');
  } catch {
    // Keep the current session's choice even when storage is unavailable.
  }
  return updateAudioPreferences({ musicEnabled: enabled });
}

function ensureAudioContext(): IslandAudioContext | null {
  if (typeof window === 'undefined' || !window.AudioContext) return null;
  if (audioContext) return audioContext;
  try {
    audioContext = new window.AudioContext();
    sfxBus = audioContext.createGain();
    sfxBus.connect(audioContext.destination);
    syncBuses();
    return audioContext;
  } catch {
    audioContext = null;
    sfxBus = null;
    return null;
  }
}

function syncBuses(): void {
  const now = audioContext?.currentTime ?? 0;
  const enabled = preferences.muted ? 0 : 1;
  if (sfxBus) sfxBus.gain.setTargetAtTime(enabled * preferences.sfxVolume, now, 0.035);
  syncMusicVolumes();
}

function createMusicElement() {
  const player = document.createElement('audio');
  player.src = MUSIC_URL;
  player.preload = 'metadata';
  player.loop = false;
  return player;
}

function ensureMusicPlayers(): [IslandMusicElement, IslandMusicElement] | null {
  if (typeof window === 'undefined') return null;
  if (musicPlayers) return musicPlayers;
  try {
    const players: [IslandMusicElement, IslandMusicElement] = [createMusicElement(), createMusicElement()];
    players.forEach((player, index) => {
      player.addEventListener('timeupdate', () => {
        if (index !== currentMusicPlayer || crossfadeStartedAt !== null) return;
        if (Number.isFinite(player.duration) && player.duration - player.currentTime <= CROSSFADE_START_SECONDS)
          beginMusicCrossfade();
      });
      player.addEventListener('ended', () => {
        if (index !== currentMusicPlayer || crossfadeStartedAt !== null) return;
        // A short/unknown-duration stream still loops if crossfade preparation was unavailable.
        player.currentTime = 0;
        startMusic();
      });
    });
    musicPlayers = players;
    syncMusicVolumes();
    return players;
  } catch {
    return null;
  }
}

function syncMusicVolumes(): void {
  if (!musicPlayers) return;
  const enabled = preferences.musicEnabled && !preferences.muted && preferences.musicVolume > 0;
  const baseVolume = enabled ? preferences.musicVolume : 0;
  if (crossfadeStartedAt !== null) {
    const progress = Math.max(0, Math.min(1, (window.performance.now() - crossfadeStartedAt) / CROSSFADE_MS));
    musicPlayers[crossfadeFrom]!.volume = baseVolume * (1 - progress);
    musicPlayers[1 - crossfadeFrom]!.volume = baseVolume * progress;
  } else {
    musicPlayers[currentMusicPlayer]!.volume = baseVolume;
    musicPlayers[1 - currentMusicPlayer]!.volume = 0;
  }
  if (!enabled) {
    musicPlayers.forEach((player) => player.pause());
    if (!preferences.musicEnabled) {
      musicPlayers.forEach((player) => { player.currentTime = 0; });
      crossfadeStartedAt = null;
      if (crossfadeTimer !== null) window.clearInterval(crossfadeTimer);
      crossfadeTimer = null;
    } else if (crossfadeStartedAt !== null) {
      const nextIndex = 1 - crossfadeFrom;
      musicPlayers[nextIndex]!.currentTime = 0;
      currentMusicPlayer = crossfadeFrom;
      crossfadeStartedAt = null;
      if (crossfadeTimer !== null) window.clearInterval(crossfadeTimer);
      crossfadeTimer = null;
    }
  }
}

function beginMusicCrossfade(): void {
  const players = ensureMusicPlayers();
  if (!players || crossfadeStartedAt !== null || !preferences.musicEnabled || preferences.muted) return;
  const nextIndex = 1 - currentMusicPlayer;
  const next = players[nextIndex]!;
  next.currentTime = 0;
  next.volume = 0;
  try {
    void next.play().then(() => {
      crossfadeFrom = currentMusicPlayer;
      crossfadeStartedAt = window.performance.now();
      if (crossfadeTimer !== null) window.clearInterval(crossfadeTimer);
      crossfadeTimer = window.setInterval(() => {
        const progress = Math.min(1, (window.performance.now() - (crossfadeStartedAt ?? 0)) / CROSSFADE_MS);
        const baseVolume = preferences.muted ? 0 : preferences.musicVolume;
        players[crossfadeFrom]!.volume = baseVolume * (1 - progress);
        players[1 - crossfadeFrom]!.volume = baseVolume * progress;
        if (progress >= 1) {
          players[crossfadeFrom]!.pause();
          players[crossfadeFrom]!.currentTime = 0;
          currentMusicPlayer = 1 - crossfadeFrom;
          crossfadeStartedAt = null;
          if (crossfadeTimer !== null) window.clearInterval(crossfadeTimer);
          crossfadeTimer = null;
          syncMusicVolumes();
        }
      }, 50);
    }).catch(() => {
      // If the browser rejects the overlap, the active player restarts on its ended event.
    });
  } catch {
    // Media playback may be unavailable in limited browser environments.
  }
}

function startMusic(): void {
  if (!preferences.musicEnabled || preferences.muted || preferences.musicVolume <= 0) return;
  const players = ensureMusicPlayers();
  if (!players) return;
  const player = players[currentMusicPlayer]!;
  if (!player.paused) {
    removeMusicGestureFallback();
    return;
  }
  if (musicStartPending) return;
  syncMusicVolumes();
  try {
    const playback = player.play();
    const startGeneration = ++musicStartGeneration;
    musicStartPending = true;
    void playback.then(
      () => {
        if (startGeneration !== musicStartGeneration) return;
        musicStartPending = false;
        removeMusicGestureFallback();
      },
      () => {
        if (startGeneration !== musicStartGeneration) return;
        musicStartPending = false;
        if (preferences.musicEnabled && !preferences.muted && preferences.musicVolume > 0) {
          installMusicGestureFallback();
        }
      },
    );
  } catch {
    musicStartGeneration += 1;
    musicStartPending = false;
    if (preferences.musicEnabled && !preferences.muted && preferences.musicVolume > 0) {
      installMusicGestureFallback();
    }
  }
}

/** Try startup playback; if browser policy blocks it, retry on the next user gesture. */
export function attemptIslandMusicAutoplay(): void {
  startMusic();
}

/** Call from a user action to comply with browser autoplay restrictions. */
export function activateIslandAudio(): void {
  if (preferences.muted) return;
  const context = ensureAudioContext();
  if (context?.state === 'suspended') void context.resume().catch(() => undefined);
  startMusic();
}

/** A quiet, original oscillator chime. Calls are rate-limited to avoid click overlap. */
export function playIslandSound(kind: IslandSound): void {
  if (preferences.muted) return;
  activateIslandAudio();
  if (preferences.sfxVolume <= 0) return;
  const context = ensureAudioContext();
  if (!context || !sfxBus) return;
  const now = context.currentTime;
  const duration = kind === 'evolution' || kind === 'complete' ? 0.48 : 0.28;
  if (now < sfxBusyUntil) return;
  sfxBusyUntil = now + duration + (SFX_NOTES[kind].length - 1) * 0.055;
  SFX_NOTES[kind].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = now + index * 0.055;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.09, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(sfxBus!);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  });
}
