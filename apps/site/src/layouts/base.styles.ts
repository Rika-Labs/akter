import { colors, radius, shadows, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"

export const base = stylex.create({
  html: {
    colorScheme: "light",
    scrollBehavior: { default: "smooth", "@media (prefers-reduced-motion: reduce)": "auto" },
    scrollPaddingTop: "5rem",
  },
  body: {
    minHeight: "100vh",
    backgroundColor: colors.frame,
    color: colors.foreground,
    fontFamily: typography.sans,
    fontSize: typography.lead,
    fontWeight: typography.weightRegular,
    lineHeight: 1.5,
    padding: `clamp(0.55rem, 1.25vw, 1rem)`,
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
    textRendering: "optimizeLegibility",
  },
  shell: {
    minHeight: "calc(100vh - 2rem)",
    backgroundColor: colors.stone,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: "8.8px",
    boxShadow: shadows.frame,
    overflow: "clip",
    display: "flex",
    flexDirection: "column",
  },
  main: {
    flexGrow: 1,
    paddingBottom: space.section,
  },
  skip: {
    position: "absolute",
    left: space.lg,
    top: space.lg,
    zIndex: 10,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    transform: { default: "translateY(-200%)", ":focus": "translateY(0)" },
  },
})
