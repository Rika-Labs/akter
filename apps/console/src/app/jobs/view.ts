import { Dialog } from "../shell/model.ts"
import {
  button,
  columns,
  dataTable,
  emptyState,
  pageBody,
  pageHeader,
  section,
  statRow,
  styleAttributes,
} from "@akter/ui"
import { barChart } from "@akter/ui/charts"
import { formatInteger } from "@akter/ui/geometry"
import { space } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import * as Routes from "../navigation/routes.ts"
import { OpenedDialog, RetriedAllDeadLetters, RetriedDeadLetter } from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { JobsPage } from "./model.ts"

const styles = stylex.create({
  actions: { display: "flex", justifyContent: "flex-end", gap: space.xs },
})

/** Jobs: what is queued and running, the dead letters waiting on a decision, and totals by type. */
export const jobsScreen = ({ h, model, page }: ScreenInput<JobsPage>): Screen => {
  const open = page.deadLetters.filter((letter) => !model.resolved.includes(letter.id))
  return {
    title: "Jobs",
    crumbs: [{ label: "Jobs" }],
    actions:
      open.length === 0
        ? []
        : [
            button(h, {
              label: "Retry all",
              variant: "ghost",
              size: "sm",
              icon: "retry",
              onClick: RetriedAllDeadLetters(),
            }),
          ],
    body: pageBody(h, [
      pageHeader(h, { title: "Jobs" }),
      statRow(h, {
        label: "Job queue",
        stats: [
          { label: "Queued", value: formatInteger(page.queued) },
          { label: "Running", value: formatInteger(page.running) },
          { label: "Retrying", value: formatInteger(page.retrying) },
          {
            label: "Dead letters",
            value: String(open.length),
            detail: open.length === 0 ? "nothing waiting" : "need a decision",
          },
        ],
      }),
      section(h, {
        title: "Dead letters",
        meta: "out of retries",
        children: [
          open.length === 0
            ? emptyState(h, {
                title: "No dead letters",
                description: "Every job either finished or is still retrying.",
                align: "start",
              })
            : dataTable(h, {
                label: "Dead letters",
                columns: [
                  { key: "job", label: "Job", width: "minmax(6rem, 1fr)", mono: true },
                  {
                    key: "actor",
                    label: "Actor",
                    width: "minmax(7rem, 1.1fr)",
                    mono: true,
                    hideBelow: "compact",
                  },
                  {
                    key: "error",
                    label: "Last error",
                    width: "minmax(0, 1.6fr)",
                    muted: true,
                    hideBelow: "narrow",
                  },
                  {
                    key: "since",
                    label: "Since",
                    width: "3.5rem",
                    align: "end",
                    hideBelow: "compact",
                  },
                  { key: "actions", label: "", width: "9.5rem", align: "end" },
                ],
                rows: open.map((letter) => ({
                  key: letter.id,
                  cells: [
                    `${letter.job} · ${letter.jobId}`,
                    h.a(
                      [h.Href(Routes.actor({ actorType: letter.actorType, key: letter.key }))],
                      [`${letter.actorType}/${letter.key}`],
                    ),
                    letter.error,
                    letter.since,
                    h.span(
                      [...styleAttributes(h, styles.actions)],
                      [
                        button(h, {
                          label: "Discard",
                          variant: "ghost",
                          size: "sm",
                          onClick: OpenedDialog({
                            dialog: Dialog.DiscardDeadLetter({ id: letter.id }),
                          }),
                          attributes: [h.AriaLabel(`Discard ${letter.jobId}`)],
                        }),
                        button(h, {
                          label: "Retry",
                          size: "sm",
                          onClick: RetriedDeadLetter({ id: letter.id }),
                          attributes: [h.AriaLabel(`Retry ${letter.jobId}`)],
                        }),
                      ],
                    ),
                  ],
                })),
              }),
        ],
      }),
      columns(h, {
        layout: "even",
        children: [
          section(h, {
            title: "By type",
            children: [
              dataTable(h, {
                label: "Jobs by type",
                columns: [
                  { key: "name", label: "Type", width: "minmax(0, 1fr)", mono: true },
                  { key: "done", label: "Done", width: "5rem", align: "end" },
                  {
                    key: "retried",
                    label: "Retried",
                    width: "4.5rem",
                    align: "end",
                    hideBelow: "compact",
                  },
                  { key: "dead", label: "Dead", width: "3.5rem", align: "end" },
                  { key: "p99", label: "p99", width: "4.5rem", align: "end" },
                ],
                rows: page.types.map((type) => ({
                  key: type.name,
                  cells: [
                    type.name,
                    formatInteger(type.done),
                    formatInteger(type.retried),
                    String(type.dead),
                    type.p99,
                  ],
                })),
              }),
            ],
          }),
          section(h, {
            title: "Throughput",
            meta: "jobs done",
            children: [
              barChart(h, {
                label: "Jobs done, recent throughput",
                height: 150,
                xTicks: 4,
                data: page.throughput.map((value, index) => ({
                  key: String(index),
                  label: page.labels[index] ?? "",
                  value,
                  highlight: index === page.throughput.length - 1,
                })),
              }),
            ],
          }),
        ],
      }),
    ]),
  }
}
