import {
  AddDomain,
  ApiKeyId,
  type ApiKeyPermission,
  CreateApiKey,
  CreateInvitation,
  DomainId,
  EnvVariableName,
  EnvironmentName,
  InvitationId,
  type IntegrationKind,
  type InviteRole,
  MemberId,
  NotificationEvent,
  type OrganizationId,
  type PlanChange,
  type ProjectId,
  type RegionId,
  Role,
  type UpdatePreferences,
  UpdateOrganization,
  UpdateProfile,
} from "@akter/cloud-api"
import { Effect, Option, Schema } from "effect"
import {
  cloud,
  ConsoleError,
  consoleError,
  fixturesEnabled,
  load,
  type Loaded,
  organizationContext,
  projectContext,
  withProject,
} from "../api/client.ts"
import { AppRoute } from "../navigation/routes.ts"
import {
  choiceFields,
  parseMemberRoleKey,
  parseNotificationKey,
  parseSpendLimit,
  spendLimitKey,
  toggleFields,
} from "./keys.ts"
import {
  toBilling,
  toDomain,
  toEndpoints,
  toEnvironments,
  toIntegrations,
  toInvoices,
  toKeys,
  toAuditEntry,
  toMember,
  toOrganizationSummary,
  toPendingInvitations,
  toPlans,
  toProjectSummary,
  toRegionChoices,
  toUsage,
  toVariable,
} from "./mapping.ts"
import {
  emptySettings,
  type PaidPlan,
  type SettingsPage,
  SettingsSection,
  type SettingsSlice,
} from "./model.ts"
import type * as Fixtures from "./fixtures.ts"
import { browserContext, hostedPageUrl } from "./stripe.ts"

type Api = Effect.Success<typeof cloud>

const allSlices: ReadonlyArray<SettingsSection> = SettingsSection.literals

/** The slices a settings route renders; any other route reads none. */
const slicesFor = (route: AppRoute): ReadonlyArray<SettingsSection> => {
  const of =
    (...names: ReadonlyArray<SettingsSection>) =>
    () =>
      names
  return AppRoute.matchOrElse(
    route,
    {
      SettingsGeneral: of("preferences"),
      SettingsAppearance: of(),
      SettingsProfile: of("profile"),
      SettingsNotifications: of("notifications"),
      SettingsEnvironment: of("environments"),
      SettingsRegions: of("regions"),
      SettingsDomains: of("domains"),
      SettingsKeys: of("keys", "endpoints"),
      SettingsIntegrations: of("integrations"),
      SettingsOrganization: of("organization", "project"),
      SettingsMembers: of("organization", "members", "invitations"),
      SettingsBilling: of("billing", "plans", "invoices", "usage"),
      SettingsUsage: of("usage"),
      SettingsAudit: of("audit"),
    },
    of(),
  )
}

const slice = <E>(
  live: Effect.Effect<SettingsSlice, E>,
  pick: (fixtures: typeof Fixtures) => SettingsSlice,
): Effect.Effect<Loaded<SettingsSlice>, ConsoleError> =>
  load(live, () => import("./fixtures.ts").then(pick))

/**
 * A slice read through the project. `run` reports its own source when only part of what it reads is
 * sample, and the fixture replaces the whole slice only when `run` fails with NotImplemented.
 */
const mixedProjectSlice = <E>(
  run: (
    api: Api,
    context: Effect.Success<typeof projectContext>,
  ) => Effect.Effect<Loaded<SettingsSlice>, E>,
  pick: (fixtures: typeof Fixtures) => SettingsSlice,
): Effect.Effect<Loaded<SettingsSlice>, ConsoleError> =>
  withProject(run, () =>
    import("./fixtures.ts").then((fixtures) => ({ data: pick(fixtures), sample: true })),
  ).pipe(Effect.map(({ data, sample }) => ({ data: data.data, sample: sample || data.sample })))

const projectSlice = <E>(
  run: (
    api: Api,
    context: Effect.Success<typeof projectContext>,
  ) => Effect.Effect<SettingsSlice, E>,
  pick: (fixtures: typeof Fixtures) => SettingsSlice,
): Effect.Effect<Loaded<SettingsSlice>, ConsoleError> =>
  mixedProjectSlice(
    (api, context) => run(api, context).pipe(Effect.map((data) => ({ data, sample: false }))),
    pick,
  )

/**
 * Loads what the settings pages read from the control plane. With a route it loads only the
 * endpoints that page renders, so one endpoint that is not implemented yet falls back to its own
 * fixture and never to another page's data; without one it loads every slice. Billing figures come
 * from the control plane's Stripe records, never from the browser talking to Stripe.
 *
 * Each slice records whether it is sample data in `sampleSections`, and the envelope is sample when
 * any slice is. The organization and project the pages act on come from the control plane only: a
 * context that cannot be resolved fails the load instead of falling back to a sample identity.
 */
export const loadSettings = (route?: AppRoute): Effect.Effect<Loaded<SettingsPage>, ConsoleError> =>
  Effect.gen(function* () {
    const api = yield* cloud
    const organization = yield* Effect.cached(organizationContext)

    const slices: Readonly<
      Record<SettingsSection, Effect.Effect<Loaded<SettingsSlice>, ConsoleError>>
    > = {
      preferences: slice(
        api.account.getPreferences().pipe(Effect.map((preferences) => ({ preferences }))),
        (fixtures) => fixtures.preferencesSlice,
      ),
      notifications: slice(
        api.account
          .getNotifications()
          .pipe(Effect.map((settings) => ({ notifications: settings.preferences }))),
        (fixtures) => fixtures.notificationsSlice,
      ),
      profile: slice(
        api.account.me().pipe(
          Effect.map(({ user }) => ({
            profile:
              user === null
                ? null
                : { name: user.name, email: user.email, emailVerified: user.emailVerified },
          })),
        ),
        (fixtures) => fixtures.profileSlice,
      ),
      organization: slice(
        organization.pipe(
          Effect.map((context) => ({
            organization: toOrganizationSummary(context),
          })),
        ),
        (fixtures) => fixtures.organizationSlice,
      ),
      project: projectSlice(
        (_, context) => Effect.succeed({ project: toProjectSummary(context) }),
        (fixtures) => fixtures.projectSlice,
      ),
      environments: mixedProjectSlice(
        (api, { project: current }) =>
          Effect.gen(function* () {
            const params = { projectId: current.id }
            const environments = yield* api.projects.listEnvironments({ params })
            const variables = yield* Effect.forEach(
              environments,
              (environment) =>
                load(
                  api.environmentVariables
                    .list({ params: { ...params, environment: environment.name } })
                    .pipe(Effect.map((listed) => listed.map(toVariable))),
                  () =>
                    import("./fixtures.ts").then(
                      ({ environmentsSlice }) =>
                        environmentsSlice.environments?.find(
                          (entry) => entry.environment === environment.name,
                        )?.variables ?? [],
                    ),
                ),
              { concurrency: "unbounded" },
            )
            return {
              data: {
                environments: toEnvironments({
                  environments,
                  variables: variables.map((entry) => entry.data),
                }),
              },
              sample: variables.some((entry) => entry.sample),
            }
          }),
        (fixtures) => fixtures.environmentsSlice,
      ),
      regions: mixedProjectSlice(
        (api, { project: current, environment }) =>
          Effect.gen(function* () {
            const [catalog, running] = yield* Effect.all(
              [
                load(api.regions.catalog(), () =>
                  sampleRegions().then((regions) => regions.map(({ id, city }) => ({ id, city }))),
                ),
                load(
                  api.regions
                    .list({ params: { projectId: current.id, environment } })
                    .pipe(
                      Effect.map((entries) =>
                        entries.map((entry) => ({ ...entry.region, home: entry.home })),
                      ),
                    ),
                  () => Promise.resolve([{ id: current.homeRegion, city: "", home: true }]),
                ),
              ],
              { concurrency: "unbounded" },
            )
            const known = running.sample
              ? running.data.flatMap((entry) => {
                  const region = catalog.data.find((candidate) => candidate.id === entry.id)
                  return region === undefined ? [] : [{ ...region, home: entry.home }]
                })
              : running.data
            return {
              data: { regions: toRegionChoices({ catalog: catalog.data, running: known }) },
              sample: catalog.sample || running.sample,
            }
          }),
        (fixtures) => fixtures.regionsSlice,
      ),
      domains: projectSlice(
        (api, { project: current }) =>
          Effect.gen(function* () {
            const domains = yield* api.domains.list({ params: { projectId: current.id } })
            return { domains: domains.map(toDomain) }
          }),
        (fixtures) => fixtures.domainsSlice,
      ),
      keys: slice(
        Effect.gen(function* () {
          const { organization: current } = yield* organization
          const keys = yield* api.apiKeys.list({
            params: { organizationId: current.id },
            query: {},
          })
          return { keys: toKeys(keys) }
        }),
        (fixtures) => fixtures.keysSlice,
      ),
      endpoints: projectSlice(
        (api, { project: current, environment }) =>
          Effect.gen(function* () {
            const endpoints = yield* api.projects.getEndpoints({
              params: { projectId: current.id, environment },
            })
            return { endpoints: toEndpoints(endpoints) }
          }),
        (fixtures) => fixtures.endpointsSlice,
      ),
      integrations: projectSlice(
        (api, { project: current }) =>
          Effect.gen(function* () {
            const integrations = yield* api.integrations.list({ params: { projectId: current.id } })
            return { integrations: toIntegrations(integrations) }
          }),
        (fixtures) => fixtures.integrationsSlice,
      ),
      members: slice(
        Effect.gen(function* () {
          const { organization: current } = yield* organization
          const members = yield* api.members.list({ params: { organizationId: current.id } })
          return { members: members.map(toMember) }
        }),
        (fixtures) => fixtures.membersSlice,
      ),
      invitations: slice(
        Effect.gen(function* () {
          const { organization: current } = yield* organization
          const invitations = yield* api.invitations.list({
            params: { organizationId: current.id },
          })
          return { invitations: toPendingInvitations(invitations) }
        }),
        (fixtures) => fixtures.invitationsSlice,
      ),
      billing: slice(
        Effect.gen(function* () {
          const { organization: current } = yield* organization
          const billing = yield* api.billing.get({ params: { organizationId: current.id } })
          const { plan } = billing
          if (!("id" in plan))
            return yield* ConsoleError.make({
              kind: "Unavailable",
              message: "This organization has no billing account yet.",
            })
          return { billing: toBilling({ ...billing, plan }) }
        }).pipe(Effect.catchTag("Unavailable", billingUnavailable)),
        (fixtures) => fixtures.billingSlice,
      ),
      plans: slice(
        api.billing.listPlans().pipe(Effect.map((catalog) => ({ plans: toPlans(catalog) }))),
        (fixtures) => fixtures.plansSlice,
      ),
      invoices: slice(
        Effect.gen(function* () {
          const { organization: current } = yield* organization
          const invoices = yield* api.billing.listInvoices({
            params: { organizationId: current.id },
          })
          return { invoices: toInvoices(invoices) }
        }),
        (fixtures) => fixtures.invoicesSlice,
      ),
      usage: slice(
        Effect.gen(function* () {
          const { organization: current } = yield* organization
          const usage = yield* api.usage.get({ params: { organizationId: current.id }, query: {} })
          return { usage: toUsage(usage) }
        }).pipe(Effect.catchTag("Unavailable", billingUnavailable)),
        (fixtures) => fixtures.usageSlice,
      ),
      audit: slice(
        Effect.gen(function* () {
          const { organization: current } = yield* organization
          const page = yield* api.audit.list({
            params: { organizationId: current.id },
            query: { limit: auditPageSize },
          })
          return { audit: page.items.map(toAuditEntry), auditTruncated: page.nextCursor !== null }
        }),
        (fixtures) => fixtures.auditSlice,
      ),
    }

    const loaded = yield* Effect.forEach(
      route === undefined ? allSlices : slicesFor(route),
      (name) => slices[name].pipe(Effect.map((result) => ({ name, ...result }))),
      { concurrency: "unbounded" },
    )
    const forced = fixturesEnabled()
    const sampleSections = forced
      ? allSlices
      : loaded.filter((result) => result.sample).map((result) => result.name)
    const page: SettingsPage = Object.assign(
      { ...emptySettings },
      ...loaded.map((result) => result.data),
      { sampleSections },
    )
    return { data: page, sample: forced || sampleSections.length > 0 }
  })

/**
 * Billing and usage answer `Unavailable` when the organization's plan is missing from the pricing
 * configuration, an operator fault the edge refuses work for too. The error carries no reason
 * beyond its message, so every `Unavailable` from these reads is worded the same calm way rather
 * than as a lost connection.
 */
const billingUnavailable = () =>
  Effect.fail(
    ConsoleError.make({
      kind: "Unavailable",
      message:
        "Billing can’t be read right now, so plan and usage figures aren’t shown. Try again in a minute.",
    }),
  )

const sampleRegions = () =>
  import("./fixtures.ts").then(({ regionsSlice }) => regionsSlice.regions ?? [])

const auditPageSize = 100

/**
 * Mutations. Each resolves the active organization or project itself, takes plain ids from the
 * page data, and fails with a `ConsoleError` the shell can show; none falls back to a fixture.
 */

const inOrganization = <A, E>(
  run: (api: Api, organizationId: OrganizationId) => Effect.Effect<A, E>,
): Effect.Effect<A, ConsoleError> =>
  Effect.gen(function* () {
    const api = yield* cloud
    const { organization } = yield* organizationContext
    return yield* run(api, organization.id)
  }).pipe(Effect.mapError(consoleError))

const inProject = <A, E>(
  run: (api: Api, projectId: ProjectId, environment: EnvironmentName) => Effect.Effect<A, E>,
): Effect.Effect<A, ConsoleError> =>
  Effect.gen(function* () {
    const api = yield* cloud
    const { project, environment } = yield* projectContext
    return yield* run(api, project.id, environment)
  }).pipe(Effect.mapError(consoleError))

const inApi = <A, E>(run: (api: Api) => Effect.Effect<A, E>): Effect.Effect<A, ConsoleError> =>
  Effect.flatMap(cloud, run).pipe(Effect.mapError(consoleError))

export const updateProfile = (input: {
  readonly name: string
}): Effect.Effect<void, ConsoleError> =>
  inApi((api) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeEffect(UpdateProfile)(input)
      yield* api.account.updateProfile({ payload })
    }),
  )

export const updatePreferences = (patch: UpdatePreferences): Effect.Effect<void, ConsoleError> =>
  inApi((api) => api.account.updatePreferences({ payload: patch })).pipe(Effect.asVoid)

/** Turns one event on or off for one channel, keeping every other notification setting as it is. */
export const setNotification = (input: {
  readonly event: NotificationEvent
  readonly channel: "email" | "slack"
  readonly enabled: boolean
}): Effect.Effect<void, ConsoleError> =>
  inApi((api) =>
    Effect.gen(function* () {
      const current = yield* api.account.getNotifications()
      const preferences = current.preferences.some((entry) => entry.event === input.event)
        ? current.preferences.map((entry) =>
            entry.event === input.event ? { ...entry, [input.channel]: input.enabled } : entry,
          )
        : [
            ...current.preferences,
            { event: input.event, email: false, slack: false, [input.channel]: input.enabled },
          ]
      yield* api.account.setNotifications({ payload: { preferences } })
    }),
  )

export const updateOrganization = (input: {
  readonly name?: string
  readonly slug?: string
}): Effect.Effect<void, ConsoleError> =>
  inOrganization((api, organizationId) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeEffect(UpdateOrganization)(input)
      yield* api.organizations.update({ params: { organizationId }, payload })
    }),
  )

/** Deletes the selected project. */
export const deleteProject: Effect.Effect<void, ConsoleError> = inProject((api, projectId) =>
  api.projects.delete({ params: { projectId } }),
)

export const inviteMember = (input: {
  readonly email: string
  readonly role: InviteRole
}): Effect.Effect<void, ConsoleError> =>
  inOrganization((api, organizationId) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeEffect(CreateInvitation)(input)
      yield* api.invitations.create({ params: { organizationId }, payload })
    }),
  )

export const resendInvitation = (invitationId: string): Effect.Effect<void, ConsoleError> =>
  inOrganization((api, organizationId) =>
    api.invitations.resend({
      params: { organizationId, invitationId: InvitationId.make(invitationId) },
    }),
  ).pipe(Effect.asVoid)

export const updateMemberRole = (input: {
  readonly memberId: string
  readonly role: Role
}): Effect.Effect<void, ConsoleError> =>
  inOrganization((api, organizationId) =>
    api.members.updateRole({
      params: { organizationId, memberId: MemberId.make(input.memberId) },
      payload: { role: input.role },
    }),
  ).pipe(Effect.asVoid)

/** The key and the one chance to read its secret; keep the secret out of the Model once shown. */
export const createApiKey = (input: {
  readonly name: string
  readonly permission: ApiKeyPermission
  readonly projectScoped: boolean
}): Effect.Effect<{ readonly name: string; readonly secret: string }, ConsoleError> =>
  inProject((api, projectId) =>
    Effect.gen(function* () {
      const { organization } = yield* organizationContext
      const payload = yield* Schema.decodeEffect(CreateApiKey)(
        input.projectScoped
          ? { name: input.name, permission: input.permission, projectId }
          : { name: input.name, permission: input.permission },
      )
      const created = yield* api.apiKeys.create({
        params: { organizationId: organization.id },
        payload,
      })
      return { name: created.key.name, secret: created.secret }
    }),
  )

export const revokeApiKey = (keyId: string): Effect.Effect<void, ConsoleError> =>
  inOrganization((api, organizationId) =>
    api.apiKeys.revoke({ params: { organizationId, keyId: ApiKeyId.make(keyId) } }),
  ).pipe(Effect.asVoid)

/** Writes a variable's value; the value is write-only and is never read back. */
export const setEnvironmentVariable = (input: {
  readonly environment: EnvironmentName
  readonly name: string
  readonly value: string
}): Effect.Effect<void, ConsoleError> =>
  inProject((api, projectId) =>
    Effect.gen(function* () {
      const name = yield* Schema.decodeEffect(EnvVariableName)(input.name)
      yield* api.environmentVariables.set({
        params: { projectId, environment: input.environment, name },
        payload: { value: input.value },
      })
    }),
  )

export const addDomain = (input: {
  readonly hostname: string
  readonly environment: EnvironmentName
}): Effect.Effect<void, ConsoleError> =>
  inProject((api, projectId) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeEffect(AddDomain)(input)
      yield* api.domains.add({ params: { projectId }, payload })
    }),
  )

/** Rechecks the DNS records of the domain the page names. */
export const verifyDomain = (domainId: string): Effect.Effect<void, ConsoleError> =>
  inProject((api, projectId) =>
    Schema.decodeEffect(DomainId)(domainId).pipe(
      Effect.flatMap((id) => api.domains.verify({ params: { projectId, domainId: id } })),
    ),
  ).pipe(Effect.asVoid)

export const addRegion = (region: RegionId): Effect.Effect<void, ConsoleError> =>
  inProject((api, projectId) =>
    api.regions.add({ params: { projectId }, payload: { region } }),
  ).pipe(Effect.asVoid)

/** Connects an integration; follow `redirectUrl` when it is not null, as OAuth integrations need. */
export const connectIntegration = (input: {
  readonly kind: IntegrationKind
  readonly settings?: Readonly<Record<string, string>>
}): Effect.Effect<{ readonly redirectUrl: string | null }, ConsoleError> =>
  inProject((api, projectId) =>
    api.integrations.connect({
      params: { projectId, kind: input.kind },
      payload: input.settings === undefined ? {} : { settings: input.settings },
    }),
  ).pipe(Effect.map((connection) => ({ redirectUrl: connection.redirectUrl })))

/**
 * Saves the spend limit. The control plane can store it and still answer `Unavailable` when it
 * cannot price the organization's plan, so that answer says the save is unconfirmed, not failed.
 */
export const setSpendLimit = (limitCents: number | null): Effect.Effect<void, ConsoleError> =>
  inOrganization((api, organizationId) =>
    api.billing.setSpendLimit({ params: { organizationId }, payload: { limitCents } }).pipe(
      Effect.catchTag("Unavailable", () =>
        Effect.fail(
          ConsoleError.make({
            kind: "Unavailable",
            message:
              "Billing couldn’t confirm the spend limit right now. Reload in a minute to see whether it was saved.",
          }),
        ),
      ),
    ),
  ).pipe(Effect.asVoid)

/** A hosted billing page the console may open, or a calm refusal of one it does not recognise. */
const trusted = (session: { readonly url: string }) =>
  Option.match(hostedPageUrl(session.url, browserContext()), {
    onNone: () =>
      Effect.fail(
        ConsoleError.make({
          kind: "Untrusted",
          message: "Billing returned a link the console doesn’t recognise, so it wasn’t opened.",
        }),
      ),
    onSome: (url) => Effect.succeed({ url }),
  })

/** The Stripe Checkout page that starts a paid subscription; the server builds its return URLs. */
export const startCheckout = (
  plan: PaidPlan,
): Effect.Effect<{ readonly url: string }, ConsoleError> =>
  inOrganization((api, organizationId) =>
    api.billing.startCheckout({ params: { organizationId }, payload: { plan } }),
  ).pipe(Effect.flatMap(trusted))

/**
 * Moves the existing subscription to another paid plan. Stripe's portal cannot change these
 * subscriptions, so the control plane does it and answers with the change's status: `pending` while
 * payment is confirmed, after which the new plan's limits apply.
 */
export const changePlan = (plan: PaidPlan): Effect.Effect<PlanChange["status"], ConsoleError> =>
  inOrganization((api, organizationId) =>
    api.billing.changePlan({ params: { organizationId }, payload: { plan } }),
  ).pipe(Effect.map((change) => change.status))

/** The Stripe billing portal to send the browser to, where the card and receipts are managed. */
export const openBillingPortal: Effect.Effect<{ readonly url: string }, ConsoleError> =
  inOrganization((api, organizationId) =>
    api.billing.openPortal({ params: { organizationId } }),
  ).pipe(Effect.flatMap(trusted))

const toggleField = (key: string) =>
  Object.entries(toggleFields).find(([name]) => name === key)?.[1]

const choiceField = (key: string) =>
  Object.entries(choiceFields).find(([name]) => name === key)?.[1]

/**
 * Saves a switch the settings views flipped, by its name in the shell's `toggles`: a preference or
 * a notification. A key that is local to the console saves nothing.
 */
export const saveToggle = (input: {
  readonly key: string
  readonly enabled: boolean
}): Effect.Effect<void, ConsoleError> => {
  const field = toggleField(input.key)
  if (field !== undefined) return updatePreferences({ [field]: input.enabled })
  const notification = parseNotificationKey(input.key)
  if (notification === undefined) return Effect.void
  return Schema.decodeUnknownEffect(NotificationEvent)(notification.event).pipe(
    Effect.mapError(consoleError),
    Effect.flatMap((event) =>
      setNotification({ event, channel: notification.channel, enabled: input.enabled }),
    ),
  )
}

/**
 * Saves a select the settings views changed, by its name in the shell's `choices`: a preference,
 * the spend limit, or a member's role. A key that is local to the console saves nothing. The theme
 * picker is not a keyed row; save a theme with `updatePreferences({ theme })`.
 */
export const saveChoice = (input: {
  readonly key: string
  readonly value: string
}): Effect.Effect<void, ConsoleError> => {
  const { key, value } = input
  const field = choiceField(key)
  if (field === "defaultEnvironment")
    return Schema.decodeUnknownEffect(EnvironmentName)(value).pipe(
      Effect.mapError(consoleError),
      Effect.flatMap((defaultEnvironment) => updatePreferences({ defaultEnvironment })),
    )
  if (field === "timeZone") return updatePreferences({ timeZone: value })
  if (key === spendLimitKey) {
    const limit = parseSpendLimit(value)
    if (limit === undefined)
      return Effect.fail(ConsoleError.make({ kind: "Invalid", message: "Choose a spend limit." }))
    return setSpendLimit(limit)
  }
  const memberId = parseMemberRoleKey(key)
  if (memberId === undefined) return Effect.void
  return Schema.decodeUnknownEffect(Role)(value).pipe(
    Effect.mapError(consoleError),
    Effect.flatMap((role) => updateMemberRole({ memberId, role })),
  )
}
