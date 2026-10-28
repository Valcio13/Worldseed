import { useContext } from 'react';
import { ThemeContext } from './themeContext';

export function useWorldseedTheme() {
  return useContext(ThemeContext);
}
