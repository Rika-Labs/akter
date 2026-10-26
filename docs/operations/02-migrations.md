---
title: "Upgrades and schema changes"
description: "Change actor schemas and roll out new builds without a migration command."
---

# Upgrades and schema changes

Akter 0.2 has no migration command. You change an actor's schema by shaping its decoding, and you roll out a new build by handing shards from the old runner to the new one.

## Move from 0.1

0.2 is a clean break from 0.1. Redeploy to a fresh 0.2 store; later 0.2 redeployments reuse it. There is no `akter migrate` or `adopt` command, no relational schema conversion, and no in-place conversion of old runtime data. Keep any 0.1 export or backup separately as historical data.

## Change an actor schema

State is decoded from stored bytes using the current schema, and a new actor starts from the decoded value of `{}`. So:

- **Add a field** with a decoding default, or make it optional, or declare an `Actor.list`. A defaulted field can decode an old checkpoint.
- **Reshape a field** with a Schema transformation that reads the old encoded shape.
- There is no `initial` or `migrate` member.

Test both old checkpoint bytes and tail replay against the new schema, independently of the live state type.

## Roll out a new build

1. The old runner stops accepting new work, writes a checkpoint, appends a `Released` entry, and reports each shard's offset and `nextDue`.
2. The new release, which waits in standby, takes over the shards.

If the old build left an unclean tail, keep and run that matching build to recover it. Do not delete the tail or default the state to push a rollout through.

An operator with the `replay` capability can choose to replay with the current build. A replayed outcome that differs from the recorded one still raises `ReplayMismatch`, so this is a diagnostic option, not a compatibility promise. A change to the store format needs its own accepted decision and a new `akter storage check` run on your provider.
