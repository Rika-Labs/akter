import { Effect } from "effect"
import { and, asc, eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { member, organization, user } from "@durable-actors/postgres/schema"
import { organizationBilling } from "../billing/schema.ts"
import { project } from "./schema.ts"

export const organizationFor = Effect.fn("Account.organizationFor")(function* (
  userId: string,
  activeId: string | null | undefined,
  displayOnly: boolean = false,
) {
  if (activeId == null && !displayOnly) return null

  const db = yield* PgDrizzle.makeWithDefaults()

  const rows = yield* db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(
      activeId == null
        ? eq(member.userId, userId)
        : and(eq(member.userId, userId), eq(organization.id, activeId)),
    )
    .orderBy(asc(member.createdAt), asc(organization.id))
    .limit(1)
    .pipe(Effect.orDie)

  return rows[0] ?? null
})

export const membersFor = Effect.fn("Account.membersFor")(function* (organizationId: string) {
  const db = yield* PgDrizzle.makeWithDefaults()

  return yield* db
    .select({ id: member.id, name: user.name, email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(asc(member.createdAt), asc(member.id))
    .pipe(Effect.orDie)
})

export const billingFor = Effect.fn("Account.billingFor")(function* (organizationId: string) {
  const db = yield* PgDrizzle.makeWithDefaults()

  const rows = yield* db
    .select({
      plan: organizationBilling.plan,
      status: organizationBilling.status,
      renewalDate: organizationBilling.renewalDate,
    })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, organizationId))
    .limit(1)
    .pipe(Effect.orDie)

  const row = rows[0]

  return row === undefined ? undefined : { ...row, renewalDate: row.renewalDate?.toISOString() }
})

export const projectsFor = Effect.fn("Account.projectsFor")(function* (organizationId: string) {
  const db = yield* PgDrizzle.makeWithDefaults()

  return yield* db
    .select({ id: project.id, name: project.name, status: project.status })
    .from(project)
    .where(eq(project.organizationId, organizationId))
    .orderBy(asc(project.createdAt), asc(project.id))
    .pipe(Effect.orDie)
})

export const insertProject = Effect.fn("Account.insertProject")(function* (
  id: string,
  organizationId: string,
  userId: string,
  name: string,
) {
  const db = yield* PgDrizzle.makeWithDefaults()

  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const membership = yield* tx
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
          .limit(1)
          .for("share")

        if (membership.length === 0) return undefined

        const rows = yield* tx
          .insert(project)
          .values({ id, organizationId, name })
          .returning({ id: project.id, name: project.name, status: project.status })

        return rows[0]
      }),
    )
    .pipe(Effect.orDie)
})
