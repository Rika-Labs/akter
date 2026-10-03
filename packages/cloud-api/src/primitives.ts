import { Schema } from "effect"

const identifier = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)))

export const UserId = identifier.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const OrganizationId = identifier.pipe(Schema.brand("OrganizationId"))
export type OrganizationId = typeof OrganizationId.Type

export const MemberId = identifier.pipe(Schema.brand("MemberId"))
export type MemberId = typeof MemberId.Type

export const InvitationId = identifier.pipe(Schema.brand("InvitationId"))
export type InvitationId = typeof InvitationId.Type

export const ApiKeyId = identifier.pipe(Schema.brand("ApiKeyId"))
export type ApiKeyId = typeof ApiKeyId.Type

export const ProjectId = identifier.pipe(Schema.brand("ProjectId"))
export type ProjectId = typeof ProjectId.Type

export const DeploymentId = identifier.pipe(Schema.brand("DeploymentId"))
export type DeploymentId = typeof DeploymentId.Type

export const DomainId = identifier.pipe(Schema.brand("DomainId"))
export type DomainId = typeof DomainId.Type

export const DeadLetterId = identifier.pipe(Schema.brand("DeadLetterId"))
export type DeadLetterId = typeof DeadLetterId.Type

export const InvoiceId = identifier.pipe(Schema.brand("InvoiceId"))
export type InvoiceId = typeof InvoiceId.Type

/** Lowercase letters, digits and inner hyphens, 1 to 40 characters. */
export const Slug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/)),
  Schema.brand("Slug"),
)
export type Slug = typeof Slug.Type

/** A display name: 1 to 100 characters with no leading or trailing blanks. */
export const Name = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\S(?:.{0,98}\S)?$/)),
  Schema.brand("Name"),
)
export type Name = typeof Name.Type

export const Email = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/), Schema.isMaxLength(254)),
  Schema.brand("Email"),
)
export type Email = typeof Email.Type

export const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
export type NonNegativeInt = typeof NonNegativeInt.Type

export const NonNegative = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
export type NonNegative = typeof NonNegative.Type

/** A UTC instant; the JSON codec reads and writes ISO 8601 strings. */
export const Timestamp = Schema.DateTimeUtc

/** A UTC calendar day written `YYYY-MM-DD`. */
export const CalendarDay = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)))
export type CalendarDay = typeof CalendarDay.Type

/** A billing period written `YYYY-MM`. */
export const BillingPeriod = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-(?:0[1-9]|1[0-2])$/)),
)
export type BillingPeriod = typeof BillingPeriod.Type

export const Role = Schema.Literals(["owner", "admin", "member", "viewer"])
export type Role = typeof Role.Type

/** The roles an invitation may grant; ownership is never granted by invitation. */
export const InviteRole = Schema.Literals(["admin", "member", "viewer"])
export type InviteRole = typeof InviteRole.Type

export const EnvironmentName = Schema.Literals(["production", "staging", "dev"])
export type EnvironmentName = typeof EnvironmentName.Type

/** The launch regions; a new region is a contract change. */
export const RegionId = Schema.Literals(["us-east-1", "us-west-2"])
export type RegionId = typeof RegionId.Type

/** A commit SHA, abbreviated or full. */
export const CommitSha = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{7,40}$/)))
export type CommitSha = typeof CommitSha.Type

/** An actor address written `Type/key`. */
export const ActorAddress = Schema.String.pipe(
  Schema.check(Schema.isMinLength(3), Schema.isMaxLength(1024), Schema.isPattern(/^[^/]+\/.+$/)),
)
export type ActorAddress = typeof ActorAddress.Type

/** Who performed an action: a person or an organization API key. */
export const ActorReference = Schema.Struct({
  kind: Schema.Literals(["user", "api-key"]),
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
})
export type ActorReference = typeof ActorReference.Type

export const SeriesPoint = Schema.Struct({ at: Timestamp, value: Schema.Finite })
export type SeriesPoint = typeof SeriesPoint.Type

/** Query fields shared by every paged list; spread them into an endpoint's `query`. */
export const pageQuery = {
  limit: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  cursor: Schema.optional(Schema.String),
}

/** A page of `item`; `nextCursor` is null on the last page. */
export const Page = <const Item extends Schema.Top>(item: Item) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Schema.String) })
