import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAudioPreferences, updateAudioPreferences } from './sound';

describe('island audio preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    updateAudioPreferences({ musicVolume: 0.14, sfxVolume: 0.42, muted: false, musicEnabled: false });
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    updateAudioPreferences({ musicVolume: 0.14, sfxVolume: 0.42, muted: false, musicEnabled: false });
  });

  it('persists independent music and effects levels plus mute without touching game saves', () => {
    updateAudioPreferences({ musicVolume: 0.3, sfxVolume: 0.75, muted: true });

    expect(getAudioPreferences()).toEqual({ musicVolume: 0.3, sfxVolume: 0.75, muted: true, musicEnabled: false });
    expect(JSON.parse(localStorage.getItem('worldseed:audio-preferences:v1') ?? 'null')).toEqual({
      musicVolume: 0.3,
      sfxVolume: 0.75,
      muted: true,
      musicEnabled: false,
    });
    expect(localStorage.getItem('worldseed:guest-save:v3')).toBeNull();
  });

  it('clamps volume values to the supported range', () => {
    updateAudioPreferences({ musicVolume: 2, sfxVolume: -1 });
    expect(getAudioPreferences()).toMatchObject({ musicVolume: 1, sfxVolume: 0 });
  });
});
