import * as stylex from "@stylexjs/stylex"

// Owned semantic tokens. Components consume roles, never theme-specific colors.
export const tokens = stylex.defineVars({
  background: "#f7f8fa",
  foreground: "#16232c",
  card: "#ffffff",
  muted: "#edf1f3",
  mutedForeground: "#657681",
  border: "#dfe6e9",
  primary: "#136d59",
  primaryForeground: "#ffffff",
  accent: "#e5f3ed",
  destructive: "#a3352a",
  destructiveBackground: "#fff0ed",
  ring: "#258775",
  radius: "12px",
})

export const darkTheme = stylex.createTheme(tokens, {
  background: "#101819",
  foreground: "#e7efec",
  card: "#172223",
  muted: "#223032",
  mutedForeground: "#a0b2ae",
  border: "#304243",
  primary: "#80dbbb",
  primaryForeground: "#10251d",
  accent: "#243e34",
  destructive: "#ffb4a5",
  destructiveBackground: "#382622",
  ring: "#80dbbb",
})
