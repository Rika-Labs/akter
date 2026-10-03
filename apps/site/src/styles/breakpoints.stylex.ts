import * as stylex from "@stylexjs/stylex"

/** Media queries every style module shares, so a breakpoint is named once. */
export const queries = stylex.defineConsts({
  desktopDown: "@media (max-width: 1200px)",
  tabletDown: "@media (max-width: 1000px)",
  phoneDown: "@media (max-width: 760px)",
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
  motionOk: "@media (prefers-reduced-motion: no-preference)",
})
