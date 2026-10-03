import type {
  ActorInspector,
  ActorInstance as CloudActorInstance,
  ActorTimelineEntry,
} from "@akter/cloud-api"
import { type DateTime, Predicate } from "effect"
import { ago, clock, splitAddress } from "../overview/time.ts"
import { type ActorInstance, ActorPage } from "./model.ts"

/** An owned-table cell as text: strings as written, everything else as its JSON form. */
export const cellText = (cell: ActorInspector["tables"][number]["rows"][number][number]): string =>
  Predicate.isString(cell) ? cell : JSON.stringify(cell)

const timelineTitles: Readonly<Record<ActorTimelineEntry["kind"], string>> = {
  command: "committed",
  event: "emitted",
  job: "ran",
}

/** One instance of a type as a row; an instance that never ran a command has none, written `—`. */
export const toActorInstance =
  (now: DateTime.Utc) =>
  (instance: CloudActorInstance): ActorInstance => ({
    key: instance.key,
    awake: instance.status === "awake",
    generation: instance.generation,
    lastCommand: instance.lastCommand ?? "—",
    lastTurn: instance.lastActivityAt === null ? "—" : ago(now)(instance.lastActivityAt),
  })

/** The inspector's view of one actor, read from the runner that owns it. */
export const toActorPage = (inspector: ActorInspector): ActorPage => {
  const { actorType, key } = splitAddress(inspector.address)
  const { properties } = inspector
  return ActorPage.make({
    actorType,
    key,
    awake: properties.status === "awake",
    generation: properties.generation,
    turn: inspector.turn,
    runner: properties.runner ?? "—",
    tenant: properties.tenant,
    mailbox: properties.mailboxDepth,
    state: JSON.stringify(inspector.state, null, 2),
    tables: inspector.tables.map((table) => ({
      name: table.table,
      columns: table.columns,
      rows: table.rows.map((row) => ({ cells: row.map(cellText) })),
    })),
    receipts: inspector.receipts.map((receipt) => ({
      commandId: receipt.commandId,
      command: receipt.command,
      result: receipt.result,
      at: clock(receipt.at),
      replayed: receipt.replayed,
    })),
    events: inspector.events,
    jobs: inspector.jobs,
    connections: inspector.connections,
    activity: inspector.timeline.map((entry, index) => ({
      key: `${String(index)}-${entry.kind}-${entry.label}`,
      committed: entry.kind === "command",
      title: timelineTitles[entry.kind],
      subject: entry.label,
      detail: entry.detail ?? "",
      time: clock(entry.at),
    })),
  })
}
