import type { Glyph } from "../illustrations/glyphs.ts"
import { githubUrl } from "../site.ts"

/** Where an example stands today. Only examples that exist are linked. */
export type Availability =
  | { readonly kind: "available"; readonly where: string; readonly href: string }
  | { readonly kind: "planned" }

/** One example: the actor it shows, what it demonstrates, and the topics it files under. */
export interface Example {
  readonly glyph: Glyph
  readonly title: string
  readonly summary: string
  readonly topic: "Realtime" | "Background work" | "Agents" | "Data"
  readonly availability: Availability
}

/** The topics the filter offers, in order. */
export const topics = ["Realtime", "Background work", "Agents", "Data"] as const

/**
 * The examples page's catalogue. Counter ships in the quickstart and Order and payment in the
 * README; every other example is planned, and the page says so.
 */
export const examples: ReadonlyArray<Example> = [
  {
    glyph: "counter",
    title: "Counter",
    summary:
      "One actor, one number. The quickstart: state that survives a restart, and a test that crashes it.",
    topic: "Data",
    availability: { kind: "available", where: "In the quickstart", href: "/docs" },
  },
  {
    glyph: "order",
    title: "Order and payment",
    summary:
      "An order that records its lines, emits an event, and charges the customer through a retried job.",
    topic: "Background work",
    availability: {
      kind: "available",
      where: "In the README",
      href: `${githubUrl}#what-it-looks-like`,
    },
  },
  {
    glyph: "chat",
    title: "Chat room",
    summary:
      "A room owns its members and messages. Typing hints broadcast live; history resumes from a cursor.",
    topic: "Realtime",
    availability: { kind: "planned" },
  },
  {
    glyph: "agent",
    title: "Coding agent",
    summary:
      "A session that keeps its transcript, streams tokens, pauses for approval, and resumes after a deploy.",
    topic: "Agents",
    availability: { kind: "planned" },
  },
  {
    glyph: "document",
    title: "Collaborative document",
    summary: "One document, many cursors. Edits commit in order; presence is a best-effort hint.",
    topic: "Realtime",
    availability: { kind: "planned" },
  },
  {
    glyph: "device",
    title: "Connected device",
    summary:
      "Desired state, readings and command history, with scheduled health checks and live telemetry.",
    topic: "Realtime",
    availability: { kind: "planned" },
  },
  {
    glyph: "schedule",
    title: "Nightly report",
    summary:
      "A singleton that wakes on a cron schedule, fans out work, and survives a restart mid-run.",
    topic: "Background work",
    availability: { kind: "planned" },
  },
  {
    glyph: "tenant",
    title: "Per-tenant workspace",
    summary:
      "Settings and records per workspace, isolated by tenant, and reportable across tenants with plain SQL.",
    topic: "Data",
    availability: { kind: "planned" },
  },
]
