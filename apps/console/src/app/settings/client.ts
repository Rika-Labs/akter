import { Effect } from "effect"
import { settings } from "./fixtures.ts"
import type { SettingsPage } from "./model.ts"

/**
 * Loads the organization and project settings. Fixture-backed; billing figures will come from the
 * control plane's Stripe records, never from the browser talking to Stripe.
 */
export const loadSettings: Effect.Effect<SettingsPage> = Effect.succeed(settings)
