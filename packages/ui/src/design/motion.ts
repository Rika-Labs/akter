import * as stylex from "@stylexjs/stylex"
import { conditions, motion } from "../tokens.stylex.ts"

/**
 * Timing fragments composed after a component's visual styles. Each owns only duration and easing,
 * never `transitionProperty`, which stays with the component that animates. Reduced motion keeps
 * the state change and drops the travel.
 */
export const motionStyles = stylex.create({
  fast: {
    transitionDuration: { default: motion.fast, [conditions.reducedMotion]: motion.instant },
    transitionTimingFunction: motion.ease,
  },
  moderate: {
    transitionDuration: { default: motion.moderate, [conditions.reducedMotion]: motion.instant },
    transitionTimingFunction: motion.easeOut,
  },
  slow: {
    transitionDuration: { default: motion.slow, [conditions.reducedMotion]: motion.instant },
    transitionTimingFunction: motion.easeOut,
  },
})

const enter = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(4px) scale(0.985)" },
  to: { opacity: 1, transform: "none" },
})

const fade = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
})

/** Entrance animations for surfaces that appear: popovers, dialogs, toasts. */
export const entranceStyles = stylex.create({
  rise: {
    animationName: { default: enter, [conditions.reducedMotion]: fade },
    animationDuration: motion.moderate,
    animationTimingFunction: motion.easeOut,
    animationFillMode: "both",
  },
  fade: {
    animationName: fade,
    animationDuration: motion.moderate,
    animationTimingFunction: motion.ease,
    animationFillMode: "both",
  },
})
