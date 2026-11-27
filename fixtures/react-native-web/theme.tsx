import { createContext, useContext, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';

const light = {
  canvas: '#EEF2F5', surface: '#FFFFFF', ink: '#182936', secondary: '#516474',
  muted: '#677B88', border: '#CFDAE0', accent: '#174F68', onAccent: '#FFFFFF',
  status: '#08654E', statusFill: '#D9F3E8', danger: '#A53131', dangerFill: '#FBE8E5',
  skeleton: '#DCE5E9',
};

const dark: typeof light = {
  canvas: '#15212A', surface: '#202F3B', ink: '#EDF4F7', secondary: '#B8C9D4',
  muted: '#A5B8C5', border: '#3B505E', accent: '#A0DCEF', onAccent: '#163545',
  status: '#8DE4BC', statusFill: '#213F36', danger: '#FFB5A8', dangerFill: '#4B302F',
  skeleton: '#3A4F5B',
};

const Theme = createContext(light);
export const usePalette = () => useContext(Theme);

export function ThemeProvider({ children }: PropsWithChildren) {
  const scheme = useColorScheme();
  return <Theme.Provider value={scheme === 'dark' ? dark : light}>{children}</Theme.Provider>;
}

export function DarkProvider({ children }: PropsWithChildren) {
  return <Theme.Provider value={dark}>{children}</Theme.Provider>;
}
