import { CredentialsStoreLive, ProfileStoreLive } from "alchemy/Auth"
import * as Planetscale from "alchemy/Planetscale"
import * as Provider from "alchemy/Provider"
import { Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { NekiDatabaseProvider } from "./database.ts"
import { NekiLogicalDatabaseProvider } from "./logical-database.ts"
import { Neki } from "./resources.ts"
import { NekiRoleProvider } from "./role.ts"

/**
 * The Neki resources and what they need to call PlanetScale: credentials from the
 * Alchemy PlanetScale auth profile, an HTTP client, and the profile and credential
 * stores. Provide it on the stack next to `Planetscale.providers()` or alone.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Planetscale.Neki") {}

export const providers = Layer.effect(
  Providers,
  Provider.collection([Neki.Database, Neki.Role, Neki.LogicalDatabase]),
).pipe(
  Layer.provide(
    Layer.mergeAll(NekiDatabaseProvider, NekiRoleProvider, NekiLogicalDatabaseProvider),
  ),
  Layer.provideMerge(Planetscale.fromAuthProvider()),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(Planetscale.Auth.PlanetscaleAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.orDie,
)
