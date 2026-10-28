import { useWorldseedTheme } from '../theme/useWorldseedTheme';

export function ThemeToggle() {
  const { theme, toggleTheme } = useWorldseedTheme();
  const nextTheme = theme === 'light' ? 'dark' : 'light';

  return (
    <button
      className="worldseed-theme-toggle"
      type="button"
      aria-label={`Switch to ${nextTheme} mode`}
      aria-pressed={theme === 'dark'}
      title={`Switch to ${nextTheme} mode`}
      onClick={toggleTheme}
    >
      <span aria-hidden="true">{theme === 'light' ? '☾' : '☀'}</span>
      <span className="worldseed-theme-toggle-label">{theme === 'light' ? 'Night' : 'Day'}</span>
    </button>
  );
}
