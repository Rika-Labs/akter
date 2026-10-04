import type {
  ActorInspector,
  ActorTypeActivity,
  ActorInstance as CloudActorInstance,
  ActorTimelineEntry,
  OwnedTableRows,
} from "@akter/cloud-api"
import { type DateTime, Predicate } from "effect"
import { orderedSeries } from "../overview/mapping.ts"
import { ago, clock, seriesLabel, splitAddress } from "../overview/time.ts"
import { type ActorInstance, ActorPage, type TypeActivity } from "./model.ts"

/** A type's activity as the page draws it: the series oldest first with UTC labels, the commands as the API ranks them. */
export const toTypeActivity = (activity: ActorTypeActivity): TypeActivity => {
  const series = orderedSeries(activity.series)
  return {
    window: activity.window,
    hours: series.map((point) => seriesLabel(activity.window)(point.at)),
    perSecond: series.map((point) => point.value),
    commands: activity.commands.map((command) => ({
      name: command.command,
      count: command.count,
      perSecond: command.perSecond,
    })),
  }
}

/** An owned-table cell as text: strings as written, everything else as its JSON form. */
export const cellText = (cell: OwnedTableRows["rows"][number][number]): string =>
  Predicate.isString(cell) ? cell : JSON.stringify(cell)

const runnerCommandId =
  /^v1\.\d+\.\d+\.([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * A receipt's command id as the Receipts table shows it. A runner-minted id
 * (`v1.<ms>.<ms>.<uuid>`) is only told apart by its uuid, so it reads as the
 * uuid's first 8 characters; any other id reads unchanged.
 */
export const shortCommandId = (commandId: string): string =>
  runnerCommandId.exec(commandId)?.[1] ?? commandId

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

/** The inspector's view of one actor, read from the runner that owns it; what the runner does not report stays unknown. */
export const toActorPage = (inspector: ActorInspector): ActorPage => {
  const { actorType, key } = splitAddress(inspector.address)
  const { properties } = inspector
  return ActorPage.make({
    actorType,
    key,
    awake: properties.status === null ? null : properties.status === "awake",
    generation: properties.generation,
    turn: inspector.turn,
    runner: properties.runner ?? "—",
    region: properties.region ?? "—",
    tenant: properties.tenant,
    mailbox: properties.mailboxDepth,
    state: inspector.state === null ? null : JSON.stringify(inspector.state, null, 2),
    tables:
      inspector.tables?.map((table) => ({
        name: table.table,
        columns: table.columns,
        rows: table.rows.map((row) => ({ cells: row.map(cellText) })),
      })) ?? null,
    receipts: inspector.receipts.map((receipt) => ({
      commandId: receipt.commandId,
      command: receipt.command,
      result: receipt.result ?? "—",
      at: receipt.at === null ? "—" : clock(receipt.at),
      replayed: receipt.replayed,
    })),
    events: inspector.events,
    jobs: inspector.jobs,
    connections: inspector.connections,
    activity:
      inspector.timeline?.map((entry, index) => ({
        key: `${String(index)}-${entry.kind}-${entry.label}`,
        committed: entry.kind === "command",
        title: timelineTitles[entry.kind],
        subject: entry.label,
        detail: entry.detail ?? "",
        time: clock(entry.at),
      })) ?? null,
  })
}
