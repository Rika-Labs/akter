import { actorTypes } from "../actors/fixtures.ts"
import { CommandsPage, type TailEntry, type TurnResult } from "./model.ts"

/** A turn template the fixture tail cycles through. */
interface Turn {
  readonly actorType: string
  readonly key: string
  readonly command: string
  readonly took: string
  readonly result: TurnResult
  readonly detail: string
}

const turns: ReadonlyArray<Turn> = [
  {
    actorType: "Order",
    key: "ord_8f2c",
    command: 'Charged { chargeId: "ch_3Q9xA2" }',
    took: "4.1 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "Cart",
    key: "c_19af",
    command: 'Add { sku: "mug", quantity: 1 }',
    took: "2.2 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "SupportRoom",
    key: "general",
    command: 'Send { text: "is the mug dishwasher…" }',
    took: "0.9 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "Inventory",
    key: "sku_mug",
    command: "Reserve { quantity: 2 }",
    took: "51.0 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "AgentSession",
    key: "s_77k",
    command: 'Prompt { text: "summarise ticket #812" }',
    took: "1.4 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "Order",
    key: "ord_9a01",
    command: "Place { lines: 2 }",
    took: "3.0 ms",
    result: "error",
    detail: "AlreadyPlaced",
  },
  {
    actorType: "Cart",
    key: "c_aa31",
    command: "Checkout {}",
    took: "2.6 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "Cart",
    key: "c_19af",
    command: 'Add { sku: "tee" }',
    took: "—",
    result: "replayed",
    detail: "retry of cmd_8Kp1",
  },
  {
    actorType: "SupportRoom",
    key: "general",
    command: 'Join { user: "u_42" }',
    took: "0.7 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "Order",
    key: "ord_9a02",
    command: "Place { lines: 1 }",
    took: "5.8 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "AgentSession",
    key: "s_80c",
    command: "Approve { step: 3 }",
    took: "1.1 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "Cart",
    key: "c_19af",
    command: 'Remove { sku: "sticker" }',
    took: "38.9 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "Inventory",
    key: "sku_tee",
    command: "Release { quantity: 1 }",
    took: "2.0 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "SupportRoom",
    key: "billing",
    command: 'Leave { user: "u_19" }',
    took: "0.8 ms",
    result: "ok",
    detail: "ok",
  },
  {
    actorType: "Device",
    key: "dev_0a1",
    command: "Report { battery: 81 }",
    took: "1.6 ms",
    result: "ok",
    detail: "ok",
  },
]

const clock = (sequence: number): string => {
  const millis = 14 * 3_600_000 + 2 * 60_000 + 16_998 + sequence * 37
  const hours = Math.floor(millis / 3_600_000)
  const minutes = Math.floor((millis % 3_600_000) / 60_000)
  const seconds = Math.floor((millis % 60_000) / 1000)
  const rest = millis % 1000
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(rest).padStart(3, "0")}`
}

/**
 * The fixture tail's `sequence`th turn. The same sequence always yields the same turn and time, so
 * the live tail is deterministic in tests while still moving on screen.
 */
export const tailEntry = (sequence: number): TailEntry => {
  const turn = turns[sequence % turns.length] ?? turns[0]
  return {
    sequence,
    commandId: `v1.1791099825418.1791186225418.${String(sequence).padStart(8, "0")}-5a1e-4c0d-8e2f-0d3a7c9b1e42`,
    time: clock(sequence),
    actorType: turn?.actorType ?? "Order",
    key: turn?.key ?? "ord_8f2c",
    command: turn?.command ?? "Place",
    took: turn?.took ?? "—",
    caller:
      sequence % 4 === 3
        ? { kind: "system", subject: null, source: "timer" }
        : { kind: "user", subject: "user:usr_dallen", source: null },
    result: turn?.result ?? "ok",
    detail: turn?.detail ?? "ok",
  }
}

/** The tail's opening page: the fourteen turns before the console opened, newest first. */
export const openingTail: ReadonlyArray<TailEntry> = Array.from({ length: 14 }, (_, index) =>
  tailEntry(13 - index),
)

/** The fixture commands page: its actor types and the opening tail. */
export const commandsPage: CommandsPage = CommandsPage.make({
  types: actorTypes.map((type) => type.name),
  recent: openingTail,
})
