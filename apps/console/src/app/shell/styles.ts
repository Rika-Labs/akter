import { colors, conditions, radius, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"

/** Console chrome around the pages: the project switcher, narrow-only controls, loading states. */
export const shellStyles = stylex.create({
  root: { minHeight: "100dvh", backgroundColor: colors.background, color: colors.foreground },
  switcherRow: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    minWidth: 0,
    paddingBlockEnd: space.xs,
  },
  switcher: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flex: "1",
    minWidth: 0,
    height: "2rem",
    paddingInline: space.sm,
    borderRadius: radius.sm,
    color: colors.foreground,
    backgroundColor: { default: "transparent", ":hover": colors.accent },
    fontWeight: 560,
    textAlign: "start",
  },
  switcherName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  switcherChevron: { color: colors.subtleForeground, display: "inline-flex" },
  narrowOnly: { display: { default: "none", [conditions.narrow]: "inline-flex" } },
  wideOnly: { display: { default: "inline-flex", [conditions.narrow]: "none" } },
  settingsBar: { display: { default: "none", [conditions.narrow]: "block" } },
  search: { marginBlockEnd: space.sm },
  loading: {
    display: "grid",
    gap: space.md,
    paddingBlock: "1.75rem",
    paddingInline: { default: space.xxl, [conditions.narrow]: space.lg },
  },
  skeleton: {
    height: "0.75rem",
    borderRadius: radius.xs,
    backgroundColor: colors.accent,
  },
  skeletonTitle: { width: "10rem", height: "1.25rem" },
  skeletonWide: { width: "min(40rem, 100%)" },
  skeletonShort: { width: "min(24rem, 70%)" },
  pinnedAdd: { color: colors.subtleForeground },
  account: { position: "relative" },
  fixture: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s,
    paddingInline: space.sm,
    color: colors.subtleForeground,
    fontSize: typography.micro,
  },
})
