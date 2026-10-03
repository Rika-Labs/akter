import { dataTable, input, pageBody, pageHeader, statRow } from "@akter/ui"
import { formatCompact, formatDuration, formatInteger } from "@akter/ui/geometry"
import * as stylex from "@stylexjs/stylex"
import * as Routes from "../navigation/routes.ts"
import { ChangedField } from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { ActorsPage } from "./model.ts"

const layout = stylex.create({ filter: { maxWidth: "20rem" } })

/** The project's actor types: what each accepts, how many exist, and how busy they are. */
export const actorsScreen = ({ h, model, page }: ScreenInput<ActorsPage>): Screen => {
  const query = (model.fields["actor-filter"] ?? "").trim().toLocaleLowerCase()
  const types = page.types.filter(
    (type) =>
      query.length === 0 ||
      type.name.toLocaleLowerCase().includes(query) ||
      type.commands.some((command) => command.toLocaleLowerCase().includes(query)),
  )
  const instances = page.types.reduce((sum, type) => sum + type.instances, 0)
  const awake = page.types.reduce((sum, type) => sum + type.awake, 0)
  return {
    title: "Actors",
    crumbs: [{ label: "Actors" }],
    body: pageBody(h, [
      pageHeader(h, { title: "Actors" }),
      statRow(h, {
        label: "Actors",
        stats: [
          { label: "Types", value: String(page.types.length) },
          { label: "Instances", value: formatCompact(instances), detail: "rows in your Postgres" },
          {
            label: "Awake",
            value: formatInteger(awake),
            detail:
              instances === 0
                ? "no actors yet"
                : `${((awake / instances) * 100).toFixed(1)}% of all actors`,
          },
          {
            label: "Commands / s",
            value: formatInteger(page.types.reduce((sum, type) => sum + type.commandsPerSecond, 0)),
          },
        ],
      }),
      input(h, {
        name: "actor-filter",
        label: "Filter actor types",
        value: model.fields["actor-filter"] ?? "",
        placeholder: "Filter by type or command",
        icon: "filter",
        type: "search",
        style: layout.filter,
        onInput: (value) => ChangedField({ name: "actor-filter", value }),
      }),
      dataTable(h, {
        label: "Actor types",
        empty: "No actor type matches that filter.",
        columns: [
          { key: "type", label: "Type", width: "minmax(7rem, 1.2fr)", mono: true },
          {
            key: "commands",
            label: "Commands",
            width: "minmax(0, 2fr)",
            muted: true,
            hideBelow: "compact",
          },
          { key: "instances", label: "Instances", width: "6.5rem", align: "end" },
          { key: "awake", label: "Awake", width: "5.5rem", align: "end", hideBelow: "narrow" },
          { key: "rate", label: "Cmd / s", width: "4.5rem", align: "end", hideBelow: "compact" },
          { key: "p99", label: "p99", width: "4.5rem", align: "end", hideBelow: "narrow" },
        ],
        rows: types.map((type) => ({
          key: type.name,
          href: Routes.actorType({ actorType: type.name }),
          cells: [
            type.name,
            type.commands.join(", "),
            formatInteger(type.instances),
            formatInteger(type.awake),
            formatInteger(type.commandsPerSecond),
            type.commandsPerSecond === 0 ? "—" : formatDuration(type.p99Ms),
          ],
        })),
      }),
    ]),
  }
}
