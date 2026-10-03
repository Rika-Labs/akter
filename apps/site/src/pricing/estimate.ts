/** Hours in the month the estimator bills a runner that is always on. */
export const HOURS_PER_MONTH = 730

/** One paid plan: its monthly base price and the usage included before overage applies. */
export interface Plan {
  readonly name: "Pro" | "Team"
  readonly monthly: number
  readonly maxRegions: number
}

/** The usage every plan includes each month. */
export const included = {
  commands: 100_000_000,
  runnerHours: 2_000,
  storageGb: 100,
  egressGb: 1_000,
} as const

/**
 * Placeholder overage rates until Akter cloud launches. Runner hours and storage come from the
 * pricing proposal; the commands and egress rates are stand-ins that keep the estimate whole.
 */
export const rates = {
  perMillionCommands: 0.2,
  perRunnerHour: 0.04,
  perStorageGbMonth: 0.25,
  perEgressGb: 0.05,
} as const

/** Pro covers one region; Team covers up to five. */
export const plans: Readonly<Record<"Pro" | "Team", Plan>> = {
  Pro: { name: "Pro", monthly: 20, maxRegions: 1 },
  Team: { name: "Team", monthly: 250, maxRegions: 5 },
}

/** What a team tells the estimator about its month. */
export interface Usage {
  readonly commands: number
  readonly runners: number
  readonly storageGb: number
  readonly egressGb: number
  readonly regions: number
}

/** One priced line of the bill: its amount, and the usage it priced against what was included. */
export interface Line {
  readonly label: string
  readonly amount: number
  readonly detail?: string
}

/** The estimate: the plan chosen for the region count, each line, and the monthly total. */
export interface Estimate {
  readonly plan: Plan
  readonly lines: ReadonlyArray<Line>
  readonly total: number
}

const cents = (amount: number): number => Math.round(amount * 100) / 100

const over = (used: number, allowance: number): number => Math.max(0, used - allowance)

/** Formats an amount as dollars with cents, grouped by thousands. */
export const dollars = (amount: number): string =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD" })

const compact = (value: number): string =>
  value >= 1_000_000_000
    ? `${value / 1_000_000_000}B`
    : value >= 1_000_000
      ? `${value / 1_000_000}M`
      : value.toLocaleString("en-US")

const storage = (gb: number): string => (gb >= 1000 ? `${gb / 1000} TB` : `${gb} GB`)

/**
 * Prices a month. Regions pick the plan (one region is Pro, two to five is Team); each usage line
 * is charged only for what exceeds the plan's included amount, and the total is the plan price
 * plus the lines.
 */
export const estimate = (usage: Usage): Estimate => {
  const plan = usage.regions <= plans.Pro.maxRegions ? plans.Pro : plans.Team
  const runnerHours = usage.runners * HOURS_PER_MONTH
  const commandsOver = over(usage.commands, included.commands)
  const lines: ReadonlyArray<Line> = [
    { label: `${plan.name} plan`, amount: plan.monthly },
    {
      label: "Commands",
      amount: cents((commandsOver / 1_000_000) * rates.perMillionCommands),
      detail: `${compact(usage.commands)} · ${compact(included.commands)} included`,
    },
    {
      label: "Runner hours",
      amount: cents(over(runnerHours, included.runnerHours) * rates.perRunnerHour),
      detail: `${usage.runners} × ${HOURS_PER_MONTH} h · ${included.runnerHours.toLocaleString("en-US")} included`,
    },
    {
      label: "Storage",
      amount: cents(over(usage.storageGb, included.storageGb) * rates.perStorageGbMonth),
      detail: `${storage(usage.storageGb)} · ${storage(included.storageGb)} included`,
    },
    {
      label: "Egress",
      amount: cents(over(usage.egressGb, included.egressGb) * rates.perEgressGb),
      detail: `${storage(usage.egressGb)} · ${storage(included.egressGb)} included`,
    },
  ]

  return { plan, lines, total: cents(lines.reduce((sum, line) => sum + line.amount, 0)) }
}

/** The month the estimator opens on, and the figures the pricing mock shows. */
export const defaults: Usage = {
  commands: 100_000_000,
  runners: 3,
  storageGb: 500,
  egressGb: 100,
  regions: 1,
}
