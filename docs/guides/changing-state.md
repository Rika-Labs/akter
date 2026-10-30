# Changing state

Akter has no migrations. State is stored in its encoded form, and each time an actor loads, its current schema decodes it. So changing an actor's state means writing a schema that can still read what's already stored.

## Add a field

Give the new field a default, or make it optional:

```ts
state: Schema.Struct({
  title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  archived: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
})
```

Actors stored before `archived` existed decode with `archived: false`. Adding a [list](../core/lists.md) works the same way: existing actors start with an empty list.

## Remove a field

Delete it from the schema. Stored values for it are ignored when the actor loads, and dropped the next time the actor's state is saved.

## Rename or reshape a field

The simplest way is in two releases. Say `owner: string` should become `owners: string[]`.

1. Add `owners` with a default of `[]`, and make `owner` optional. In every command, move a leftover `owner` into `owners` before doing anything else.
2. Once the old field is gone from the actors you care about, remove `owner` from the schema.

If you need every actor converted the moment it loads, write the field as an Effect Schema [transformation](https://effect.website/docs/schema/transformations/) that decodes the old encoded shape into the new one. Test it by decoding a sample of the old shape with `Schema.decodeUnknownSync` before you ship.

## Rename an actor type

An actor type's name is part of every actor's address, so a renamed type starts out empty while the old actors stay where they were. Keep type names stable.

## Remove a command or a job

Timers, sends and jobs that are still pending refer to commands and jobs by name. If a release removes a command that a pending timer will call, that timer has nowhere to go, and a job whose declaration is missing is suspended until a release that has it comes back. Before removing a command or job, stop scheduling it and let the pending work finish.

## Rolling out

During a rolling deploy, a shard moves from an old server to a new one when the old one drains, so only one release writes a shard at a time. Make sure the new schema reads the old state, and the deploy is safe.
