import * as Axiom from "alchemy/Axiom"
import * as Docker from "alchemy/Docker"
import * as Fly from "alchemy/Fly"
import * as GitHub from "alchemy/GitHub"
import { KeyPair, KeyPairProvider } from "alchemy/KeyPair"
import * as Provider from "alchemy/Provider"
import * as Stripe from "alchemy/Stripe"
import { Layer } from "effect"
import { providers as nekiProviders } from "./neki/providers.ts"
import { providers as vercelProviders } from "./vercel/providers.ts"

/** The key pairs the stack generates itself; Fly's collection already carries `Random`. */
export class Generated extends Provider.ProviderCollection<Generated>()("Akter.Generated") {}

const generated = Layer.effect(Generated, Provider.collection([KeyPair])).pipe(
  Layer.provide(KeyPairProvider()),
)

export const stackProviders = Layer.mergeAll(
  Fly.providers(),
  Docker.providers(),
  Axiom.providers(),
  Stripe.providers(),
  GitHub.providers(),
  nekiProviders,
  vercelProviders,
  generated,
)
