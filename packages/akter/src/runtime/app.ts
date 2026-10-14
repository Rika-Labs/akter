import { type Crypto, Effect, Layer, Predicate, Schema } from "effect"
import type { AnyActor, TypeError } from "../contract/make.ts"
import type { ImplementationOf } from "../handlers/registry.ts"

export const TypeId: unique symbol = Symbol.for("@rikalabs/akter/App")

/**
 * Every service a hosted app's layer may require. The host provides them, so an app never
 * constructs a runtime and a requirement outside this union is a compile error at `App.make`.
 */
export type AppServices = Crypto.Crypto

/** Building the app's layer failed; `cause` is what the layer failed with. */
export class AppLayerFailed extends Schema.TaggedError<AppLayerFailed>()("AppLayerFailed", {
  cause: Schema.Defect(),
}) {}

/**
 * A served app: the actor contracts its `/rpc` group is derived from, and one layer that binds
 * every one of their handlers and builds any services they need from `AppServices` alone.
 */
export interface App<Actors extends ReadonlyArray<AnyActor> = ReadonlyArray<AnyActor>> {
  readonly [TypeId]: typeof TypeId
  readonly actors: Actors
  readonly layer: Layer.Layer<ImplementationOf<Actors[number]>, AppLayerFailed, AppServices>
}

type Complete<Actors extends ReadonlyArray<AnyActor>, Provided> = [
  Exclude<ImplementationOf<Actors[number]>, Provided>,
] extends [never]
  ? unknown
  : TypeError<"App.make: the layer does not implement every actor in `actors`">

const DeclaredActors = Schema.Array(Schema.Struct({ name: Schema.String }))

/**
 * Declares a served app, the default export of `src/app.ts`. The layer must implement every
 * actor it lists and may require only `AppServices`; both are compile errors here, which is
 * why a host accepts only values this constructor branded. A failure building the layer
 * becomes `AppLayerFailed`, so a host that loads the app knows its error type.
 *
 * @example
 * ```ts
 * export default App.make({ actors: [Counter], layer: CounterLive })
 * ```
 */
const make = <const Actors extends ReadonlyArray<AnyActor>, Provided, E = never>(
  app: {
    readonly actors: Actors
    readonly layer: Layer.Layer<Provided, E, AppServices>
  } & Complete<Actors, Provided>,
): App<Actors> => ({
  [TypeId]: TypeId,
  actors: app.actors,
  layer: Layer.catch(app.layer, (cause) =>
    Layer.effectDiscard(Effect.fail(AppLayerFailed.make({ cause }))),
  ) as Layer.Layer<ImplementationOf<Actors[number]>, AppLayerFailed, AppServices>,
})

/**
 * Whether `value` is an app `App.make` built: branded, with named actors and a layer. A loader
 * uses it on a module's default export before providing the layer.
 */
const is = (value: unknown): value is App =>
  Predicate.hasProperty(value, TypeId) &&
  value[TypeId] === TypeId &&
  Predicate.hasProperty(value, "actors") &&
  Schema.is(DeclaredActors)(value.actors) &&
  Predicate.hasProperty(value, "layer") &&
  Layer.isLayer(value.layer)

/** Served app declaration and the loader's check of a module's default export. */
export const App = { make, is }
