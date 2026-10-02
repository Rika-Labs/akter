import * as stylex from "@stylexjs/stylex"

/**
 * Akter's semantic colour roles. Light values are the Rika Labs stone and ink palette; dark values
 * keep the same warmth. Components consume roles, never palette values, so a route cannot drift
 * from the brand by picking its own grey.
 */
export const colors = stylex.defineVars({
  frame: "light-dark(#fafaf9, #0e0f0d)",
  background: "light-dark(#fbfbfa, #121311)",
  stone: "light-dark(#f5f5f4, #161715)",
  sidebar: "light-dark(#f4f3f1, #0e0f0d)",
  card: "light-dark(#ffffff, #161715)",
  popover: "light-dark(#ffffff, #1b1c1a)",
  muted: "light-dark(#f7f6f4, #1b1c1a)",
  code: "light-dark(#f7f6f3, #0e0f0d)",
  highlight: "light-dark(#e8e6e0, #2a2b28)",
  foreground: "light-dark(#0b0d0b, #ecebe7)",
  mutedForeground: "light-dark(rgb(11 13 11 / 0.6), rgb(236 235 231 / 0.6))",
  subtleForeground: "light-dark(rgb(11 13 11 / 0.4), rgb(236 235 231 / 0.38))",
  border: "light-dark(rgb(55 48 31 / 0.1), rgb(236 235 231 / 0.08))",
  borderStrong: "light-dark(rgb(55 48 31 / 0.16), rgb(236 235 231 / 0.14))",
  accent: "light-dark(rgb(55 48 31 / 0.05), rgb(236 235 231 / 0.05))",
  selected: "light-dark(rgb(55 48 31 / 0.08), rgb(236 235 231 / 0.08))",
  primary: "light-dark(#0b0d0b, #ecebe7)",
  primaryHover: "light-dark(#262826, #ffffff)",
  primaryForeground: "light-dark(#fafaf9, #121311)",
  ring: "light-dark(rgb(11 13 11 / 0.35), rgb(236 235 231 / 0.4))",
  destructive: "light-dark(#a3352a, #ff9d8f)",
  destructiveSubtle: "light-dark(#fbeeec, #2d1a17)",
  success: "light-dark(#2f6b4f, #7fcca5)",
  warning: "light-dark(#8a6416, #e2b85c)",
  chartLine: "light-dark(#0b0d0b, #ecebe7)",
  chartMuted: "light-dark(rgb(11 13 11 / 0.16), rgb(236 235 231 / 0.2))",
  chartGrid: "light-dark(rgb(11 13 11 / 0.06), rgb(236 235 231 / 0.06))",
  illustrationFace: "light-dark(#fafaf9, #161715)",
  illustrationTop: "light-dark(#f3f2ef, #1d1e1c)",
  illustrationEnd: "light-dark(#ebe9e4, #252623)",
})

/** Spacing scale in rem at a 16px root: 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96 and 128 pixels. */
export const space = stylex.defineVars({
  xxs: "0.125rem",
  xs: "0.25rem",
  s: "0.375rem",
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  xl: "1.5rem",
  xxl: "2rem",
  xxxl: "3rem",
  huge: "4rem",
  section: "6rem",
  chapter: "8rem",
})

/** Families and sizes. The console uses `sans` only; `display` is reserved for the website's headlines. */
export const typography = stylex.defineVars({
  sans: '"PolySans Var", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  display: '"Sagittaire Display", ui-serif, Georgia, serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  micro: "0.6875rem",
  caption: "0.75rem",
  small: "0.8125rem",
  body: "0.84375rem",
  lead: "1rem",
  prose: "1.0625rem",
  heading: "1.375rem",
  title: "1.75rem",
  displaySm: "2.125rem",
  displayMd: "2.75rem",
  displayLg: "4rem",
  wordmark: "9.75rem",
  weightRegular: "430",
  weightMedium: "480",
  weightStrong: "520",
  weightBold: "600",
  trackingTight: "-0.02em",
  trackingDisplay: "-0.025em",
  trackingMono: "0.06em",
})

/** Small radii on purpose: restraint over softness. `full` is for dots, avatars and toggles only. */
export const radius = stylex.defineVars({
  xs: "4px",
  sm: "6px",
  md: "8px",
  full: "999px",
})

/** Light mode carries elevation with shadow; dark mode relies on the lighter surface roles. */
export const shadows = stylex.defineVars({
  sm: "light-dark(0 1px 2px rgb(56 46 22 / 0.06), 0 0 0 transparent)",
  md: "light-dark(0 1px 2px rgb(56 46 22 / 0.05), 0 4px 16px rgb(56 46 22 / 0.05))",
  lg: "light-dark(0 8px 30px rgb(56 46 22 / 0.1), 0 8px 30px rgb(0 0 0 / 0.4))",
  frame:
    "light-dark(0 0 0 1px rgb(255 251 234 / 0.55), 0 0 0 1px rgb(255 255 255 / 0.03)), light-dark(0 8px 24px rgb(56 46 22 / 0.1), 0 8px 24px rgb(0 0 0 / 0.35))",
})

/** Durations and easings. Animations serve a state change; nothing else hand-writes timing. */
export const motion = stylex.defineVars({
  fast: "120ms",
  moderate: "200ms",
  slow: "360ms",
  ease: "cubic-bezier(0.2, 0, 0, 1)",
  easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
  linear: "linear",
})

/** Named layout and control dimensions shared by both apps. */
export const dimensions = stylex.defineVars({
  control: "2rem",
  controlSm: "1.75rem",
  controlLg: "2.375rem",
  icon: "0.9375rem",
  iconSm: "0.8125rem",
  sidebar: "15rem",
  settingsColumn: "47.5rem",
  siteColumn: "73.75rem",
  readingColumn: "40rem",
})

/**
 * Compatibility roles for the current console views until they move to `colors`.
 * New code imports `colors` and the other groups above.
 */
export const tokens = stylex.defineVars({
  background: "#fbfbfa",
  foreground: "#0b0d0b",
  card: "#ffffff",
  muted: "#f5f5f4",
  mutedForeground: "rgb(11 13 11 / 0.6)",
  border: "rgb(55 48 31 / 0.1)",
  primary: "#0b0d0b",
  primaryForeground: "#fafaf9",
  accent: "rgb(55 48 31 / 0.05)",
  destructive: "#a3352a",
  destructiveBackground: "#fbeeec",
  ring: "rgb(11 13 11 / 0.35)",
  radius: "8px",
})

/** Overrides the compatibility roles with the dark palette. */
export const darkTheme = stylex.createTheme(tokens, {
  background: "#121311",
  foreground: "#ecebe7",
  card: "#161715",
  muted: "#1b1c1a",
  mutedForeground: "rgb(236 235 231 / 0.6)",
  border: "rgb(236 235 231 / 0.08)",
  primary: "#ecebe7",
  primaryForeground: "#121311",
  accent: "rgb(236 235 231 / 0.05)",
  destructive: "#ff9d8f",
  destructiveBackground: "#2d1a17",
  ring: "rgb(236 235 231 / 0.4)",
})
