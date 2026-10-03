import { colors, radius, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"

const flash = stylex.keyframes({
  "0%": { opacity: 0 },
  "2%": { opacity: 1 },
  "9%": { opacity: 1 },
  "16%": { opacity: 0 },
  "100%": { opacity: 0 },
})

const trace = stylex.keyframes({
  "0%": { strokeDashoffset: "var(--length)", opacity: 1 },
  "5%": { strokeDashoffset: 0, opacity: 1 },
  "14%": { strokeDashoffset: 0, opacity: 1 },
  "20%": { strokeDashoffset: 0, opacity: 0 },
  "100%": { strokeDashoffset: 0, opacity: 0 },
})

const travelAlongX = stylex.keyframes({
  "0%": { transform: "translateX(0)", opacity: 0 },
  "3%": { transform: "translateX(0)", opacity: 1 },
  "9%": { transform: "translateX(0)" },
  "14%": { transform: "translateX(calc(var(--distance) * 0.2))" },
  "19%": { transform: "translateX(calc(var(--distance) * 0.2))" },
  "24%": { transform: "translateX(calc(var(--distance) * 0.4))" },
  "29%": { transform: "translateX(calc(var(--distance) * 0.4))" },
  "34%": { transform: "translateX(calc(var(--distance) * 0.6))" },
  "39%": { transform: "translateX(calc(var(--distance) * 0.6))" },
  "44%": { transform: "translateX(calc(var(--distance) * 0.8))" },
  "50%": { transform: "translateX(calc(var(--distance) * 0.8))" },
  "54%": { transform: "translateX(var(--distance))" },
  "84%": { transform: "translateX(var(--distance))", opacity: 1 },
  "89%": { transform: "translateX(var(--distance))", opacity: 0 },
  "100%": { transform: "translateX(0)", opacity: 0 },
})

const travelAlongY = stylex.keyframes({
  "0%": { transform: "translateY(0)", opacity: 0 },
  "3%": { transform: "translateY(0)", opacity: 1 },
  "9%": { transform: "translateY(0)" },
  "14%": { transform: "translateY(calc(var(--distance) * 0.2))" },
  "19%": { transform: "translateY(calc(var(--distance) * 0.2))" },
  "24%": { transform: "translateY(calc(var(--distance) * 0.4))" },
  "29%": { transform: "translateY(calc(var(--distance) * 0.4))" },
  "34%": { transform: "translateY(calc(var(--distance) * 0.6))" },
  "39%": { transform: "translateY(calc(var(--distance) * 0.6))" },
  "44%": { transform: "translateY(calc(var(--distance) * 0.8))" },
  "50%": { transform: "translateY(calc(var(--distance) * 0.8))" },
  "54%": { transform: "translateY(var(--distance))" },
  "84%": { transform: "translateY(var(--distance))", opacity: 1 },
  "89%": { transform: "translateY(var(--distance))", opacity: 0 },
  "100%": { transform: "translateY(0)", opacity: 0 },
})

const loop = {
  animationDuration: "10s",
  animationIterationCount: "infinite",
  animationFillMode: "both",
  animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const

export const turn = stylex.create({
  wrap: { display: "block", width: "100%" },
  wide: {
    display: { default: "block", [queries.desktopDown]: "none" },
    width: "100%",
    height: "auto",
  },
  tall: {
    display: { default: "none", [queries.desktopDown]: "block" },
    width: "100%",
    maxWidth: "24rem",
    height: "auto",
    marginInline: "auto",
  },
  node: { fill: colors.card, stroke: colors.borderStrong },
  pivot: { stroke: colors.foreground },
  lit: {
    fill: colors.highlight,
    stroke: colors.foreground,
    opacity: 0,
    ...loop,
    animationName: { default: "none", [queries.motionOk]: flash },
  },
  title: {
    fill: colors.foreground,
    fontFamily: typography.sans,
    fontSize: 13.5,
    fontWeight: typography.weightStrong,
  },
  detail: {
    fill: colors.mutedForeground,
    fontFamily: typography.sans,
    fontSize: 11,
  },
  region: {
    fill: "none",
    stroke: colors.chartMuted,
    strokeDasharray: "3 4",
  },
  caption: {
    fill: colors.subtleForeground,
    fontFamily: typography.mono,
    fontSize: 9.5,
    letterSpacing: "0.04em",
  },
  link: { stroke: colors.chartMuted, fill: "none", strokeLinecap: "round" },
  linkDashed: { strokeDasharray: "2 4" },
  head: {
    stroke: colors.chartMuted,
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  trace: {
    stroke: colors.foreground,
    fill: "none",
    strokeLinecap: "round",
    opacity: 0,
    ...loop,
    animationName: { default: "none", [queries.motionOk]: trace },
  },
  headLit: {
    stroke: colors.foreground,
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    opacity: 0,
    ...loop,
    animationName: { default: "none", [queries.motionOk]: flash },
  },
  packetX: {
    opacity: 0,
    ...loop,
    animationName: { default: "none", [queries.motionOk]: travelAlongX },
    animationTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
  },
  packetY: {
    opacity: 0,
    ...loop,
    animationName: { default: "none", [queries.motionOk]: travelAlongY },
    animationTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
  },
  packet: { fill: colors.foreground },
  packetMark: { stroke: colors.illustrationFace, fill: "none", strokeLinecap: "round" },
  radius: { borderRadius: radius.md },
})
