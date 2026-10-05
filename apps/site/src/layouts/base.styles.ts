import { typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { siteColors } from "../styles/site-tokens.stylex.ts"

export const base = stylex.create({
  html: {
    colorScheme: "light",
    scrollBehavior: { default: "smooth", "@media (prefers-reduced-motion: reduce)": "auto" },
    scrollPaddingTop: "5rem",
  },
  body: {
    minHeight: "100vh",
    backgroundColor: siteColors.page,
    color: siteColors.ink,
    fontFamily: typography.sans,
    fontSize: "1rem",
    fontWeight: 400,
    lineHeight: "normal",
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
    textRendering: "optimizeLegibility",
  },
  shell: {
    minHeight: "100vh",
    overflow: "clip",
    display: "flex",
    flexDirection: "column",
  },
  main: { flexGrow: 1 },
  skip: {
    position: "absolute",
    left: "1rem",
    top: "1rem",
    zIndex: 10,
    paddingBlock: "0.5rem",
    paddingInline: "1rem",
    backgroundColor: siteColors.ink,
    color: siteColors.page,
    transform: { default: "translateY(-200%)", ":focus": "translateY(0)" },
  },
})
