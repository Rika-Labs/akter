import { isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import type { Resource } from "alchemy/Resource"
import { removeRecord, updateRecord } from "@distilled.cloud/vercel/dns"
import { Effect } from "effect"
import { createDnsRecord, listDnsRecords } from "./api.ts"
import type { Providers } from "./providers.ts"
import { Vercel } from "./resources.ts"

/**
 * Properties of one DNS record in a domain Vercel hosts. A record is identified by its domain,
 * name and type; changing any of them replaces it.
 */
export interface DnsRecordProps {
  /** The Vercel domain that hosts the record, such as `akter.dev`. */
  domain: string
  /** The name relative to the domain: empty for the apex and `*.dev` for a wildcard. */
  name: string
  type: "A" | "AAAA" | "CNAME" | "TXT" | "MX"
  value: string
  ttl?: number
  /** Required by `MX` records. */
  mxPriority?: number
  /** The Vercel team that owns the domain, when the token spans several. */
  teamId?: string
}

export interface DnsRecordAttributes {
  id: string
  domain: string
  name: string
  type: string
  value: string
  /** The fully qualified name, with the apex written as the domain itself. */
  fqdn: string
  teamId: string | undefined
}

/**
 * A DNS record on a Vercel-hosted domain. Reconciling adopts a record at the same name and type
 * only when this resource created it or it already holds the wanted value, so a deploy retried
 * after a lost state write converges; any other record, such as the domain's mail records, is
 * left alone. Deleting removes the record.
 *
 * @example
 * ```typescript
 * yield* Vercel.DnsRecord("Api", {
 *   domain: "akter.dev",
 *   name: "api",
 *   type: "CNAME",
 *   value: "akter-prod-api.fly.dev",
 * })
 * ```
 */
export type DnsRecord = Resource<
  "Vercel.DnsRecord",
  DnsRecordProps,
  DnsRecordAttributes,
  never,
  Providers
>

const PAGES = 50

const MANAGED = "Managed by Alchemy"

const apex = (name: string) => (name === "@" ? "" : name)

const unquote = (value: string) => value.replace(/^"(.*)"$/, "$1")

/** A record the resource may take over: at the same name and type, and made by it or already right. */
const ours = (
  record: { name: string; type: string; value: string; comment: string | undefined },
  props: DnsRecordProps,
) =>
  apex(record.name) === props.name &&
  record.type === props.type &&
  (record.comment === MANAGED || unquote(record.value) === unquote(props.value))

const attributesOf = (props: DnsRecordProps, id: string, value: string): DnsRecordAttributes => ({
  id,
  domain: props.domain,
  name: props.name,
  type: props.type,
  value,
  fqdn: props.name === "" ? props.domain : `${props.name}.${props.domain}`,
  teamId: props.teamId,
})

/** Every record of the domain, following the pagination cursor newest first. */
const recordsOf = Effect.fn(function* (props: { domain: string; teamId?: string | undefined }) {
  const records: Array<{
    id: string
    name: string
    type: string
    value: string
    mxPriority: number | undefined
    ttl: number | undefined
    comment: string | undefined
  }> = []
  let until: string | undefined
  for (let page = 0; page < PAGES; page++) {
    const response = yield* listDnsRecords({
      domain: props.domain,
      teamId: props.teamId,
      limit: "100",
      until,
    })
    records.push(...response.records)
    const next = response.pagination?.next
    if (next === null || next === undefined) return records
    until = String(next)
  }
  return records
})

export const DnsRecordProvider = Provider.succeed(Vercel.DnsRecord, {
  stables: ["id", "domain", "name", "type"],

  diff: ({ news, output }) =>
    Effect.succeed(
      isResolved(news) &&
        output !== undefined &&
        (news.domain !== output.domain || news.name !== output.name || news.type !== output.type)
        ? ({ action: "replace", deleteFirst: true } as const)
        : undefined,
    ),

  read: Effect.fn(function* ({ olds, output }) {
    const domain = output?.domain ?? olds.domain
    const records = yield* recordsOf({ domain, teamId: output?.teamId ?? olds.teamId })
    const found = records.find((record) =>
      output === undefined ? ours(record, olds) : record.id === output.id,
    )
    return found === undefined ? undefined : attributesOf(olds, found.id, found.value)
  }),

  reconcile: Effect.fn(function* ({ news, output }) {
    const find = Effect.map(recordsOf(news), (records) =>
      records.find((record) =>
        output === undefined ? ours(record, news) : record.id === output.id,
      ),
    )
    const existing = yield* find
    if (existing === undefined) {
      yield* createDnsRecord({
        domain: news.domain,
        teamId: news.teamId,
        name: news.name,
        type: news.type,
        value: news.value,
        ttl: news.ttl,
        mxPriority: news.mxPriority,
        comment: MANAGED,
      })
      const created = yield* find
      if (created === undefined)
        return yield* Effect.die(
          new Error(`Vercel did not list the ${news.type} record ${news.name} on ${news.domain}`),
        )
      return attributesOf(news, created.id, news.value)
    }
    const current =
      unquote(existing.value) === unquote(news.value) &&
      (news.mxPriority === undefined || existing.mxPriority === news.mxPriority) &&
      (news.ttl === undefined || existing.ttl === news.ttl)
    if (!current)
      yield* updateRecord({
        recordId: existing.id,
        teamId: news.teamId,
        name: news.name,
        type: news.type,
        value: news.value,
        ttl: news.ttl,
        mxPriority: news.mxPriority,
      })
    return attributesOf(news, existing.id, news.value)
  }),

  delete: Effect.fn(function* ({ output }) {
    yield* removeRecord({
      domain: output.domain,
      recordId: output.id,
      teamId: output.teamId,
    }).pipe(Effect.catchTag("NotFound", () => Effect.void))
  }),
})
