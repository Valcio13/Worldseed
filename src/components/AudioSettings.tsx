import { useEffect, useState } from 'react';
import {
  attemptIslandMusicAutoplay,
  activateIslandAudio,
  getAudioPreferences,
  setMusicEnabledByUser,
  subscribeAudioPreferences,
  updateAudioPreferences,
} from '../game/sound';
import { ThemeToggle } from './ThemeToggle';
import './AudioSettings.css';

export function AudioSettings() {
  const [preferences, setPreferences] = useState(getAudioPreferences);

  useEffect(() => {
    const unsubscribe = subscribeAudioPreferences(setPreferences);
    attemptIslandMusicAutoplay();
    return unsubscribe;
  }, []);

  function updateVolume(key: 'musicVolume' | 'sfxVolume', value: string) {
    updateAudioPreferences({ [key]: Number(value) / 100 });
    activateIslandAudio();
  }

  function toggleMute() {
    const nextMuted = !preferences.muted;
    updateAudioPreferences({ muted: nextMuted });
    if (!nextMuted) activateIslandAudio();
  }

  function toggleMusic() {
    const nextEnabled = !preferences.musicEnabled;
    setMusicEnabledByUser(nextEnabled);
    if (nextEnabled) activateIslandAudio();
  }

  return (
    <div className="audio-settings-group">
      <ThemeToggle />
      <details className="audio-settings">
        <summary aria-label="Audio settings">♫ Audio</summary>
        <div className="audio-settings-panel">
          <button type="button" aria-pressed={preferences.musicEnabled} onClick={toggleMusic}>
            {preferences.musicEnabled ? 'Pause music' : 'Play music'}
          </button>
          <button type="button" aria-pressed={preferences.muted} onClick={toggleMute}>
            {preferences.muted ? 'Unmute audio' : 'Mute audio'}
          </button>
          <label>
            <span>Music</span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={Math.round(preferences.musicVolume * 100)}
              aria-label="Music volume"
              onChange={(event) => updateVolume('musicVolume', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Sound effects</span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={Math.round(preferences.sfxVolume * 100)}
              aria-label="Sound effects volume"
              onChange={(event) => updateVolume('sfxVolume', event.currentTarget.value)}
            />
          </label>
        </div>
      </details>
    </div>
  );
}
