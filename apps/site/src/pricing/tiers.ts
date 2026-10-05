import { consoleUrl, contactUrl, quickstartUrl } from "../site.ts"

/** One plan card: its price, what it is for, what it includes, and where its button goes. */
export interface Tier {
  readonly name: string
  readonly price: string
  readonly period: string
  readonly summary: string
  readonly features: ReadonlyArray<string>
  readonly cta: string
  readonly href: string
  readonly featured?: boolean
}

/** The four plans. Prices are placeholders until Akter Cloud launches. */
export const tiers: ReadonlyArray<Tier> = [
  {
    name: "Open source",
    price: "$0",
    period: "forever",
    summary: "Self-host on your own Postgres server. The whole framework, nothing held back.",
    features: [
      "Apache-2.0",
      "Embedded or served",
      "Every guarantee, same code",
      "Community on GitHub",
    ],
    cta: "Read the quickstart",
    href: quickstartUrl,
  },
  {
    name: "Pro",
    price: "$20",
    period: "/ mo + usage",
    summary: "One team shipping to production on Akter Cloud.",
    features: [
      "1M commands free each month",
      "Actor inspector and live tail",
      "Production and preview environments",
      "Up to 5 members",
    ],
    cta: "Start building",
    href: `${consoleUrl}/sign-up`,
    featured: true,
  },
  {
    name: "Team",
    price: "$250",
    period: "/ mo + usage",
    summary: "Several teams, more regions, and the controls security asks for.",
    features: [
      "Everything in Pro",
      "Multi-region",
      "SSO, roles and audit log",
      "Point-in-time restore",
    ],
    cta: "Start a trial",
    href: `${consoleUrl}/sign-up`,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    summary: "Dedicated databases, your cloud, and a direct line to the people who build it.",
    features: [
      "Dedicated Postgres databases",
      "Bring your own cloud",
      "Custom retention",
      "Support with response times",
    ],
    cta: "Talk to us",
    href: contactUrl,
  },
]

/** One row of the usage table: a meter and what it costs on the free and paid plans. */
export interface Meter {
  readonly meter: string
  readonly free: string
  readonly paid: string
}

/** How Akter Cloud meters usage. Rates are placeholders until Akter Cloud launches. */
export const meters: ReadonlyArray<Meter> = [
  { meter: "Committed commands", free: "1M per month", paid: "Per million commands" },
  { meter: "Reads", free: "Count as 0.2 of a command", paid: "Count as 0.2 of a command" },
  { meter: "Storage", free: "0.5 GB, hard cap", paid: "$0.30 per GB-month" },
  {
    meter: "Realtime connections",
    free: "Capped per plan",
    paid: "Capped per plan, messages not billed",
  },
]

/** The static controls the bill estimate shows until prices are set; `on` is the preselected option. */
export const estimateControls: ReadonlyArray<{
  readonly label: string
  readonly options: ReadonlyArray<string>
  readonly on: string
}> = [
  { label: "Commands / month", options: ["1M", "10M", "100M", "1B"], on: "10M" },
  { label: "Reads per command", options: ["0", "1", "5", "20"], on: "1" },
  { label: "Storage", options: ["1 GB", "10 GB", "100 GB"], on: "10 GB" },
]

/** The pricing FAQ. Answers about the cloud say so where the product is not yet launched. */
export const pricingQuestions: ReadonlyArray<{
  readonly question: string
  readonly answer: string
}> = [
  {
    question: "Is self-hosting really free?",
    answer:
      "Yes. The framework is Apache-2.0 and the same code runs embedded in your server or served on its own, against your own Postgres database. Akter Cloud only sells running it for you.",
  },
  {
    question: "What counts as a command?",
    answer:
      "Every turn: a command, a job result or a timer firing. A read counts as 0.2 of a command, and an actor that is asleep costs storage only.",
  },
  {
    question: "What happens if I go over my spend limit?",
    answer:
      "Akter Cloud has not launched, so these are intentions rather than terms. You will set a spend limit per project, be warned as usage approaches it, and choose whether to pause or keep serving once it is reached.",
  },
  {
    question: "Can I move from the cloud to self-hosting?",
    answer:
      "That is the design: the cloud runs the same framework against a Postgres database, so leaving means pointing the same code at your own database. Migration steps will be documented when the cloud launches.",
  },
  {
    question: "Do you charge for idle actors?",
    answer:
      "Idle actors cost storage only. Their state and pending work stay in your Postgres database, and they use no runner time until the next command, timer or job wakes them.",
  },
]
