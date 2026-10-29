import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'worldseed:audio-preferences:v1';
const MUSIC_DISABLED_KEY = 'worldseed:music-explicitly-disabled:v1';

async function loadFreshAudioModule() {
  vi.resetModules();
  return import('./sound');
}

describe('background music startup preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('enables startup playback for a fresh visitor with no saved audio preferences', async () => {
    const audio = await loadFreshAudioModule();

    expect(audio.getAudioPreferences()).toMatchObject({
      musicEnabled: true,
      muted: false,
      musicVolume: 0.3,
      sfxVolume: 1,
    });
  });

  it('loads enabled music and saved volume for a returning visitor', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ musicEnabled: true, muted: false, musicVolume: 0.31, sfxVolume: 0.6 }),
    );
    const audio = await loadFreshAudioModule();

    expect(audio.getAudioPreferences()).toMatchObject({
      musicEnabled: true,
      muted: false,
      musicVolume: 0.31,
      sfxVolume: 0.6,
    });
  });

  it('keeps music enabled after the player enables it and refreshes', async () => {
    const beforeRefresh = await loadFreshAudioModule();
    beforeRefresh.setMusicEnabledByUser(true);
    const afterRefresh = await loadFreshAudioModule();

    expect(afterRefresh.getAudioPreferences()).toMatchObject({ musicEnabled: true });
  });

  it('defaults old preference records without a music flag to enabled', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ musicVolume: 0.27, sfxVolume: 0.4 }));
    const audio = await loadFreshAudioModule();

    expect(audio.getAudioPreferences()).toMatchObject({ musicEnabled: true, musicVolume: 0.27 });
  });

  it('migrates legacy default-off records to enabled unless the user explicitly paused music', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ musicEnabled: false, muted: false, musicVolume: 0.31, sfxVolume: 0.6 }),
    );
    const audio = await loadFreshAudioModule();

    expect(audio.getAudioPreferences()).toMatchObject({ musicEnabled: true, musicVolume: 0.31 });
  });

  it('preserves an explicit music-off choice after reload', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ musicEnabled: true, muted: false, musicVolume: 0.31, sfxVolume: 0.6 }),
    );
    const audio = await loadFreshAudioModule();
    audio.setMusicEnabledByUser(false);
    expect(localStorage.getItem(MUSIC_DISABLED_KEY)).toBe('true');
    const reloadedAudio = await loadFreshAudioModule();

    expect(reloadedAudio.getAudioPreferences()).toMatchObject({ musicEnabled: false, musicVolume: 0.31 });
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    reloadedAudio.attemptIslandMusicAutoplay();
    expect(play).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
