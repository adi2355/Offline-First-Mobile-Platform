import { DarkTheme as NavigationDarkTheme, DefaultTheme as NavigationDefaultTheme } from '@react-navigation/native';
import { colors } from '../styles/design-system';
export const darkThemeColors = colors.dark;
export const lightThemeColors = colors.light;
export const CustomDarkNavigationTheme = {
  ...NavigationDarkTheme,
  colors: {
    ...NavigationDarkTheme.colors,
    primary: darkThemeColors.primary,
    background: darkThemeColors.background,
    card: darkThemeColors.card,
    text: darkThemeColors.text.primary,
    border: darkThemeColors.border.default,
    notification: darkThemeColors.primary,
  },
};
export const CustomLightNavigationTheme = {
  ...NavigationDefaultTheme,
  colors: {
    ...NavigationDefaultTheme.colors,
    primary: lightThemeColors.primary,
    background: lightThemeColors.background,
    card: lightThemeColors.card,
    text: lightThemeColors.text.primary,
    border: lightThemeColors.border.default,
    notification: lightThemeColors.primary,
  },
};
export type AppTheme = typeof darkThemeColors;
export type ThemeName = 'dark' | 'light'; 