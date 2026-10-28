import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateAudioPreferences } from '../game/sound';
import { AudioSettings } from './AudioSettings';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  updateAudioPreferences({ musicVolume: 0.14, sfxVolume: 0.42, muted: false, musicEnabled: false });
});
afterEach(() => {
  cleanup();
  updateAudioPreferences({ musicVolume: 0.14, sfxVolume: 0.42, muted: false, musicEnabled: false });
  vi.restoreAllMocks();
});

describe('audio controls', () => {
  it('tries background music on startup and retries after a browser blocks autoplay', async () => {
    updateAudioPreferences({ musicEnabled: true, muted: false });
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(Object.assign(new Error('Autoplay blocked'), { name: 'NotAllowedError' }))
      .mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    render(<AudioSettings />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(document.body);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('does not attempt startup playback when music has been explicitly disabled', () => {
    updateAudioPreferences({ musicEnabled: false });
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<AudioSettings />);
    expect(play).not.toHaveBeenCalled();
  });

  it('exposes persisted independent music and sound effects levels and a mute control', () => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    render(<AudioSettings />);
    expect(screen.getByRole('button', { name: 'Play music' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByText('♫ Audio'));
    fireEvent.click(screen.getByRole('button', { name: 'Play music' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mute audio' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Music volume' }), {
      target: { value: '35' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Sound effects volume' }), {
      target: { value: '65' },
    });

    expect(screen.getByRole('button', { name: 'Unmute audio' })).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(localStorage.getItem('worldseed:audio-preferences:v1') ?? 'null')).toEqual({
      musicVolume: 0.35,
      sfxVolume: 0.65,
      muted: true,
      musicEnabled: true,
    });
  });
});
