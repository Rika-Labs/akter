import { RegionsPage } from "./model.ts"

/** Fixture regions for `storefront`. Illustrative test data. */
export const regions: RegionsPage = RegionsPage.make({
  regions: [
    {
      id: "us-east-1",
      place: "Virginia",
      primary: true,
      healthy: true,
      tenants: 1_204,
      database: "Neki Postgres 18 · 4 vCPU",
      storageUsed: 212,
      storageLimit: 500,
      cpu: "41%",
      connections: "180 of 400",
      runners: "3 · shard group default",
      backups: "Point-in-time · 7 days",
    },
    {
      id: "eu-west-1",
      place: "Ireland",
      primary: false,
      healthy: true,
      tenants: 388,
      database: "Neki Postgres 18 · 2 vCPU",
      storageUsed: 64,
      storageLimit: 250,
      cpu: "22%",
      connections: "72 of 200",
      runners: "3 · shard group default",
      backups: "Point-in-time · 7 days",
    },
  ],
  tables: [
    { name: "order_lines", actorType: "Order", rows: "1.9M", size: "41 GB", region: "us-east-1" },
    { name: "cart_items", actorType: "Cart", rows: "6.2M", size: "38 GB", region: "us-east-1" },
    {
      name: "room_messages",
      actorType: "SupportRoom",
      rows: "11.4M",
      size: "22 GB",
      region: "eu-west-1",
    },
    {
      name: "transcript",
      actorType: "AgentSession",
      rows: "880K",
      size: "19 GB",
      region: "us-east-1",
    },
    { name: "receipts", actorType: "—", rows: "9.4M", size: "12 GB", region: "us-east-1" },
  ],
})
