import { consoleUrl, contactUrl } from "../site.ts"

/** One plan card: its price, what it is for, what it includes, and where its button goes. */
export interface Tier {
  readonly name: string
  readonly price: number | "Custom"
  readonly period: string
  readonly summary: string
  readonly features: ReadonlyArray<string>
  readonly cta: string
  readonly href: string
  readonly boxes: number
  readonly featured?: boolean
  readonly crane?: boolean
}

/** The four plans. Prices are placeholders until Akter cloud launches. */
export const tiers: ReadonlyArray<Tier> = [
  {
    name: "Open source",
    price: 0,
    period: "forever",
    summary: "Self-host on your own Postgres. The whole framework, nothing held back.",
    features: [
      "Apache-2.0",
      "Embedded or served",
      "Every guarantee, same code",
      "Community on GitHub",
    ],
    cta: "Read the quickstart",
    href: "/docs",
    boxes: 1,
  },
  {
    name: "Pro",
    price: 20,
    period: "/ mo + usage",
    summary: "One team shipping to production on Akter cloud.",
    features: [
      "100M commands included",
      "2,000 runner hours included",
      "1 region · 3 environments",
      "Actor inspector and live tail",
      "Up to 5 members",
    ],
    cta: "Start building",
    href: `${consoleUrl}/sign-up`,
    boxes: 3,
    featured: true,
  },
  {
    name: "Team",
    price: 250,
    period: "/ mo + usage",
    summary: "Several teams, more regions, and the controls security asks for.",
    features: [
      "Everything in Pro",
      "Multi-region, tenant home regions",
      "SSO, roles and audit log",
      "99.9% uptime SLA",
      "Unlimited members",
    ],
    cta: "Start a trial",
    href: `${consoleUrl}/sign-up`,
    boxes: 6,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    summary: "Dedicated runners, your cloud, and a direct line to the people who build it.",
    features: [
      "Dedicated shard groups",
      "Bring your own cloud or VPC",
      "Custom retention",
      "Support with response times",
    ],
    cta: "Talk to us",
    href: contactUrl,
    boxes: 0,
    crane: true,
  },
]

/** A cell of the comparison table: `true` when included, `false` when not offered, else its value. */
export type Cell = boolean | string

/** One comparison row, one cell per plan in the order of `tiers`. */
export interface Row {
  readonly label: string
  readonly cells: readonly [Cell, Cell, Cell, Cell]
}

/** The comparison table's two groups. */
export const comparison: ReadonlyArray<{
  readonly title: string
  readonly rows: ReadonlyArray<Row>
}> = [
  {
    title: "Framework",
    rows: [
      { label: "Actors, commands, receipts", cells: [true, true, true, true] },
      { label: "Jobs, timers, workflows", cells: [true, true, true, true] },
      { label: "Realtime connections", cells: [true, true, true, true] },
      { label: "Testing with crashes", cells: [true, true, true, true] },
    ],
  },
  {
    title: "Cloud",
    rows: [
      { label: "Managed runners and Postgres", cells: [false, true, true, true] },
      { label: "Regions", cells: [false, "1", "Up to 5", "Any"] },
      { label: "Environments", cells: [false, "3", "10", "Unlimited"] },
      { label: "Actor inspector, live tail", cells: [false, true, true, true] },
      { label: "Receipt retention", cells: ["Yours", "30 days", "90 days", "Custom"] },
      { label: "SSO and audit log", cells: [false, false, true, true] },
      { label: "Dedicated shard groups", cells: [false, false, false, true] },
      { label: "Uptime SLA", cells: [false, false, "99.9%", "Custom"] },
    ],
  },
]

/** The pricing FAQ. Answers about the cloud say so where the product is not yet launched. */
export const pricingQuestions: ReadonlyArray<{
  readonly question: string
  readonly answer: string
}> = [
  {
    question: "Is self-hosting really free?",
    answer:
      "Yes. The framework is Apache-2.0 and the same code runs embedded in your server or served on its own, against your own Postgres. Akter cloud only sells running it for you.",
  },
  {
    question: "What counts as a command?",
    answer:
      "Every turn: a command, a job result or a timer firing. Reads over HTTP are free, and so is an actor that is asleep.",
  },
  {
    question: "What happens if I go over my spend limit?",
    answer:
      "Akter cloud has not launched, so these are intentions rather than terms. You will set a spend limit per project, be warned as usage approaches it, and choose whether to pause or keep serving once it is reached.",
  },
  {
    question: "Can I move from the cloud to self-hosting?",
    answer:
      "That is the design: the cloud runs the same framework against Postgres, so leaving means pointing the same code at your own database. Migration steps will be documented when the cloud launches.",
  },
  {
    question: "Do you charge for idle actors?",
    answer:
      "Idle actors cost storage only. Their state and pending work stay in Postgres, and they use no runner time until the next command, timer or job wakes them.",
  },
]
