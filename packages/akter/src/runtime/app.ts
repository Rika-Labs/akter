import { type Crypto, Effect, Layer, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import type { layer } from "./layer.ts"

export const TypeId: unique symbol = Symbol.for("@rikalabs/akter/App")

/** What `Actors.layer` provides: the actor runtime every handler layer registers with. */
type RuntimeServices = Layer.Success<ReturnType<typeof layer>>

/**
 * Every service a hosted app's layer may require. The host builds
 * `Actors.layer` over its own database and provides it with the SQL client and
 * `Crypto`, so an app never constructs a runtime and a requirement outside
 * this union is a compile error at `App.make`.
 */
export type AppServices = RuntimeServices | SqlClient.SqlClient | Crypto.Crypto

/** Building the app's layer failed; `cause` is what the layer failed with. */
export class AppLayerFailed extends Schema.TaggedError<AppLayerFailed>()("AppLayerFailed", {
  cause: Schema.Defect(),
}) {}

/**
 * An actor definition as an app declares it: its name, which `Actors.serve`
 * routes by, and its declared members, which `checkWorkflows` compares with
 * stored executions before a rollout.
 */
export interface AppActor {
  readonly name: string
  readonly api: object
}

/**
 * A hosted app: the actor definitions to serve and one layer that registers
 * their handlers and builds any services they need from `AppServices` alone.
 */
export interface App {
  readonly [TypeId]: typeof TypeId
  readonly actors: ReadonlyArray<AppActor>
  readonly layer: Layer.Layer<never, AppLayerFailed, AppServices>
}

const DeclaredActors = Schema.Array(
  Schema.Struct({ name: Schema.String, api: Schema.ObjectKeyword }),
)

/**
 * Declares a hosted app, the default export of `src/app.ts`. Any handler
 * requirement the layer leaves unprovided fails to compile here, which is why
 * the host accepts only values this constructor branded: a layer's
 * requirements cannot be checked at run time. A failure building the layer
 * becomes `AppLayerFailed`, so a host that loads the app knows its error type.
 *
 * @example
 * ```ts
 * export default App.make({ actors: [Counter], layer: CounterLive })
 * ```
 */
const make = <E = never>(app: {
  readonly actors: ReadonlyArray<AppActor>
  readonly layer: Layer.Layer<never, E, AppServices>
}): App => ({
  [TypeId]: TypeId,
  actors: [...app.actors],
  layer: Layer.catch(app.layer, (cause) =>
    Layer.effectDiscard(Effect.fail(AppLayerFailed.make({ cause }))),
  ),
})

/**
 * Whether `value` is an app `App.make` built: branded, with actors that each
 * have a name and an `api` object, and a layer. A loader uses it on a module's default export before providing the
 * layer.
 */
const is = (value: unknown): value is App =>
  Predicate.hasProperty(value, TypeId) &&
  value[TypeId] === TypeId &&
  Predicate.hasProperty(value, "actors") &&
  Schema.is(DeclaredActors)(value.actors) &&
  Predicate.hasProperty(value, "layer") &&
  Layer.isLayer(value.layer)

/** Hosted app declaration and the loader's check of a module's default export. */
export const App = { make, is }
