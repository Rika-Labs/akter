import { button, codeBlock, dataTable, pageBody, pageHeader, section } from "@akter/ui"
import * as Routes from "../navigation/routes.ts"
import { deployStatus } from "../overview/view.ts"
import { CopiedText } from "../shell/message.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { DeploymentsPage } from "./model.ts"

/** The deploy history: each deploy starts new runners, moves actors over and drains the old ones. */
export const deploymentsScreen = ({ h, page }: ScreenInput<DeploymentsPage>): Screen => {
  const command = `bunx akter deploy --env ${page.environment}`
  return {
    title: "Deployments",
    crumbs: [{ label: "Deployments" }],
    actions: [
      button(h, {
        label: "Regions & database",
        variant: "ghost",
        size: "sm",
        href: Routes.regions(),
      }),
      button(h, {
        label: "Deploy",
        variant: "primary",
        size: "sm",
        onClick: CopiedText({ text: command, label: "deploy command" }),
      }),
    ],
    body: pageBody(h, [
      pageHeader(h, { title: "Deployments" }),
      dataTable(h, {
        label: "Deployments",
        columns: [
          { key: "commit", label: "Commit", width: "5.5rem", mono: true },
          { key: "message", label: "Message", width: "minmax(0, 1.6fr)" },
          { key: "status", label: "Status", width: "7.5rem", hideBelow: "compact" },
          { key: "author", label: "Author", width: "5rem", muted: true, hideBelow: "narrow" },
          {
            key: "regions",
            label: "Regions",
            width: "minmax(0, 1.2fr)",
            muted: true,
            hideBelow: "narrow",
          },
          { key: "took", label: "Took", width: "3.5rem", align: "end", hideBelow: "compact" },
          { key: "when", label: "When", width: "3rem", align: "end" },
        ],
        rows: page.deploys.map((deploy) => ({
          key: deploy.commit,
          href: Routes.deployment({ commit: deploy.commit }),
          cells: [
            deploy.commit,
            deploy.message,
            deployStatus(h)(deploy),
            deploy.author,
            deploy.regions.join(", "),
            deploy.took,
            deploy.when,
          ],
        })),
      }),
      section(h, {
        title: "Deploy from your machine",
        children: [
          codeBlock(h, {
            code: `$ ${command}`,
            language: "shell",
            onCopy: CopiedText({ text: command, label: "deploy command" }),
          }),
        ],
      }),
    ]),
  }
}
