import { createContext } from 'react';
import type { WorldseedTheme } from './types';

export interface ThemeContextValue {
  theme: WorldseedTheme;
  toggleTheme: () => void;
}

export const THEME_STORAGE_KEY = 'worldseed:theme';

export const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  toggleTheme: () => undefined,
});
