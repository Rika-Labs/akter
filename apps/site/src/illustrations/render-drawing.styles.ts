import { colors } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { queries } from "../styles/breakpoints.stylex.ts"
import { siteColors } from "../styles/site-tokens.stylex.ts"

const glide = stylex.keyframes({
  from: { strokeDashoffset: 0 },
  to: { strokeDashoffset: -58 },
})

const trolleyTravel = stylex.keyframes({
  "0%": { transform: "translateX(0)" },
  "15%": { transform: "translateX(0)" },
  "45%": { transform: "translateX(var(--reach))" },
  "60%": { transform: "translateX(var(--reach))" },
  "90%": { transform: "translateX(0)" },
  "100%": { transform: "translateX(0)" },
})

const hoistLift = stylex.keyframes({
  "0%": { transform: "translateY(0)" },
  "5%": { transform: "translateY(0)" },
  "15%": { transform: "translateY(-18px)" },
  "45%": { transform: "translateY(-18px)" },
  "55%": { transform: "translateY(0)" },
  "60%": { transform: "translateY(0)" },
  "70%": { transform: "translateY(-18px)" },
  "90%": { transform: "translateY(-18px)" },
  "100%": { transform: "translateY(0)" },
})

const bobbing = stylex.keyframes({
  "0%": { transform: "translateY(0)" },
  "50%": { transform: "translateY(-3px)" },
  "100%": { transform: "translateY(0)" },
})

/** Fill and stroke paints for each brand paint role, mapped to design tokens so themes apply. */
export const fills = stylex.create({
  ink: { fill: colors.foreground },
  face: { fill: siteColors.sceneFace },
  top: { fill: siteColors.sceneTop },
  end: { fill: siteColors.sceneEnd },
  none: { fill: "none" },
})

/** Fills for the container on the crane's hoist, the one object in the scene painted in the accent. */
export const hoistFills = stylex.create({
  ink: { fill: colors.foreground },
  face: { fill: siteColors.accent },
  top: { fill: siteColors.accentTop },
  end: { fill: siteColors.accentEnd },
  none: { fill: "none" },
})

export const strokes = stylex.create({
  ink: { stroke: colors.foreground },
  face: { stroke: colors.illustrationFace },
  top: { stroke: colors.illustrationTop },
  end: { stroke: colors.illustrationEnd },
  none: { stroke: "none" },
})

/**
 * Motion for the brand's animated classes. Each animation only runs when the visitor has not asked
 * for reduced motion, so the scene is a still drawing for them.
 */
export const motion = stylex.create({
  water: {
    strokeDasharray: "16 5 3 5",
    animationName: { default: "none", [queries.motionOk]: glide },
    animationDuration: "10s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  waterReverse: {
    animationDuration: "15s",
    animationDirection: "reverse",
  },
  trolley: {
    animationName: { default: "none", [queries.motionOk]: trolleyTravel },
    animationDuration: "9s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  hoist: {
    animationName: { default: "none", [queries.motionOk]: hoistLift },
    animationDuration: "9s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  bob: {
    animationName: { default: "none", [queries.motionOk]: bobbing },
    animationDuration: "4.5s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
})

export const text = stylex.create({
  mono: { fontFamily: '"Geist Mono", ui-monospace, monospace' },
})
