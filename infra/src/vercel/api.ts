import * as API from "@distilled.cloud/core/api"
import * as S from "@distilled.cloud/core/schema"
import {
  Retry,
  T,
  VercelProtocol,
  type VercelOpContext,
  type VercelOpError,
} from "@distilled.cloud/vercel"
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  PaymentRequired,
} from "@distilled.cloud/vercel/dns"

/**
 * The generated `createRecord` carries only a record's `type`, because the
 * OpenAPI document describes the body as a union per record type. This
 * operation sends the full body through the same protocol, credentials and
 * retry policy as the generated ones.
 */
const CreateInput = S.Struct({
  domain: S.String.pipe(T.Label()),
  teamId: S.optional(S.String.pipe(T.Query())),
  name: S.String,
  type: S.String,
  value: S.String,
  ttl: S.optional(S.Number),
  mxPriority: S.optional(S.Number),
  comment: S.optional(S.String),
})

const CreateOutput = S.Struct({ uid: S.optional(S.String), updated: S.optional(S.Number) })

export const createDnsRecord: API.OperationMethod<
  typeof CreateInput.Type,
  typeof CreateOutput.Type,
  BadRequest | PaymentRequired | Forbidden | NotFound | Conflict | VercelOpError,
  VercelOpContext
> = API.make(() => ({
  input: CreateInput.pipe(
    T.Http({ method: "POST", uri: "/v2/domains/{domain}/records", code: 200 }),
  ),
  output: CreateOutput,
  errors: [BadRequest, PaymentRequired, Forbidden, NotFound, Conflict],
  protocol: VercelProtocol,
  retry: Retry.Retry,
}))

const DnsRecordItem = S.Struct({
  id: S.String,
  name: S.String,
  type: S.String,
  value: S.String,
  mxPriority: S.optional(S.Number),
  ttl: S.optional(S.Number),
  comment: S.optional(S.String),
})

const ListInput = S.Struct({
  domain: S.String.pipe(T.Label()),
  teamId: S.optional(S.String.pipe(T.Query())),
  limit: S.optional(S.String.pipe(T.Query())),
  until: S.optional(S.String.pipe(T.Query())),
})

const ListOutput = S.Struct({
  records: S.Array(DnsRecordItem),
  pagination: S.optional(S.Struct({ next: S.NullOr(S.Number) })),
})

/**
 * The generated `getRecords` types its response as unknown; this one decodes
 * the records and the cursor, which an older API version omits.
 */
export const listDnsRecords: API.OperationMethod<
  typeof ListInput.Type,
  typeof ListOutput.Type,
  BadRequest | Forbidden | NotFound | VercelOpError,
  VercelOpContext
> = API.make(() => ({
  input: ListInput.pipe(T.Http({ method: "GET", uri: "/v5/domains/{domain}/records", code: 200 })),
  output: ListOutput,
  errors: [BadRequest, Forbidden, NotFound],
  protocol: VercelProtocol,
  retry: Retry.Retry,
}))
