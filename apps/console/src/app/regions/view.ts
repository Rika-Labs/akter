import {
  button,
  columns,
  dataTable,
  pageBody,
  pageHeader,
  propertyList,
  section,
  status,
} from "@akter/ui"
import { meter, regionMap } from "@akter/ui/charts"
import { formatInteger } from "@akter/ui/geometry"
import * as Routes from "../navigation/routes.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import type { RegionsPage } from "./model.ts"

/** Where the project runs: each region's yard of tenants, its database, and the largest tables. */
export const regionsScreen = ({ h, page }: ScreenInput<RegionsPage>): Screen => ({
  title: "Regions & database",
  crumbs: [{ label: "Regions & database" }],
  actions: [
    button(h, { label: "Add region", size: "sm", icon: "plus", href: Routes.settingsRegions() }),
  ],
  body: pageBody(h, [
    pageHeader(h, {
      title: "Regions & database",
      description: "Every tenant has a home region. Its actors and rows live there.",
    }),
    regionMap(h, {
      label: "Regions by tenants",
      formatTenants: (tenants) => `${formatInteger(tenants)} tenants`,
      regions: page.regions.map((region) => ({
        id: region.id,
        place: region.place,
        tenants: region.tenants,
        primary: region.primary,
        healthy: region.healthy,
      })),
    }),
    columns(h, {
      layout: "even",
      children: page.regions.map((region) =>
        section(h, {
          title: region.id,
          meta: region.primary ? "primary" : region.place,
          children: [
            propertyList(h, {
              layout: "wide",
              ruled: true,
              items: [
                {
                  label: "Status",
                  value: status(h, {
                    tone: region.healthy ? "live" : "warning",
                    label: region.healthy ? "Healthy" : "Degraded",
                  }),
                },
                { label: "Database", value: region.database },
                {
                  label: "Storage",
                  value: meter(h, {
                    label: "Storage",
                    value: region.storageUsed,
                    limit: region.storageLimit,
                    format: (value) => `${formatInteger(value)} GB`,
                    compact: true,
                  }),
                },
                { label: "CPU", value: region.cpu },
                { label: "Connections", value: region.connections },
                { label: "Runners", value: region.runners },
                { label: "Backups", value: region.backups },
              ],
            }),
          ],
        }),
      ),
    }),
    section(h, {
      title: "Largest tables",
      meta: "owned by actors",
      children: [
        dataTable(h, {
          label: "Largest tables",
          columns: [
            { key: "name", label: "Table", width: "minmax(0, 1.2fr)", mono: true },
            {
              key: "actor",
              label: "Actor",
              width: "minmax(0, 1fr)",
              mono: true,
              hideBelow: "compact",
            },
            { key: "rows", label: "Rows", width: "4.5rem", align: "end" },
            { key: "size", label: "Size", width: "4.5rem", align: "end" },
            { key: "region", label: "Region", width: "6rem", muted: true, hideBelow: "narrow" },
          ],
          rows: page.tables.map((table) => ({
            key: table.name,
            cells: [table.name, table.actorType, table.rows, table.size, table.region],
          })),
        }),
      ],
    }),
  ]),
})
