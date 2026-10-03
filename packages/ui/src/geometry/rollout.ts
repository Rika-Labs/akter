import { niceTicks } from "./ticks.ts"

/** One phase of a deploy and when it ran, in seconds from the start of the deploy. */
export interface RolloutPhase {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly start: number
  readonly end: number
}

/** A phase placed on the timeline as fractions of its width. */
export interface RolloutBar extends RolloutPhase {
  readonly left: number
  readonly width: number
}

/** A time tick: its value in seconds and where it sits, as a fraction of the width. */
export interface RolloutTick {
  readonly value: number
  readonly position: number
}

/** A point on the traffic-shift curve: time as a fraction of the deploy, new version's share. */
export interface SharePoint {
  readonly x: number
  readonly y: number
}

/** The placed timeline. */
export interface RolloutLayout {
  readonly bars: ReadonlyArray<RolloutBar>
  readonly ticks: ReadonlyArray<RolloutTick>
  readonly span: number
  readonly share: ReadonlyArray<SharePoint>
}

const smoothstep = (value: number): number => {
  const clamped = Math.min(1, Math.max(0, value))
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * Places deploy phases on a shared time axis rounded up to a tick, and samples the share of turns
 * served by the new version, which rises smoothly while actors move during `shift`.
 */
export const rolloutLayout = (
  input: Readonly<{
    phases: ReadonlyArray<RolloutPhase>
    shift: Readonly<{ start: number; end: number }>
    samples?: number
  }>,
): RolloutLayout => {
  const finish = Math.max(...input.phases.map((phase) => phase.end), input.shift.end)
  const axis = niceTicks({ min: 0, max: finish, count: 5 })
  const span = axis.max
  const samples = input.samples ?? 48
  return {
    span,
    bars: input.phases.map((phase) => ({
      ...phase,
      left: phase.start / span,
      width: Math.max(0.004, (phase.end - phase.start) / span),
    })),
    ticks: axis.ticks.map((value) => ({ value, position: value / span })),
    share: Array.from({ length: samples + 1 }, (_, index) => {
      const time = (index / samples) * span
      const progress =
        (time - input.shift.start) / Math.max(0.001, input.shift.end - input.shift.start)
      return { x: index / samples, y: smoothstep(progress) }
    }),
  }
}
