---
title: "Upgrades and schema changes"
description: "0.2 starts empty; evolve schema fields and release builds without a migration command."
---

# Upgrades and schema changes

Akter 0.2 is a clean break from 0.1. Upgrading from 0.1 requires a fresh 0.2 store; subsequent 0.2 redeployments reuse that store. There is no `akter migrate` or `adopt` command, no relational schema conversion, and no in-place conversion of old runtime authority. Keep any 0.1 export or backup separately as historical data.

## Actor schemas

Initial state is decoded from `{}`. Give every state field a decoding default, make it optional, or declare an `Actor.list`. A new defaulted field can decode an old checkpoint; reshaping a field needs a Schema transformation that reads the old encoded shape. There is no `initial` or `migrate` member. Test both old checkpoint bytes and tail replay independently of the live state type.

## Release handoff

A clean old runner stops admission, checkpoints, appends `Released`, and reports offsets and `nextDue`. A new release waits in standby. If an old build leaves an unclean tail, retain and run that matching build to recover it; do not delete the tail or default state to make rollout proceed.

An audited `replay` operator can explicitly choose the current build, but outcome comparison still raises `ReplayMismatch` when a replayed outcome differs. Opt-in is a diagnostic escape hatch, not a compatibility promise. Store format changes require a new accepted decision and provider-specific storage-check evidence.
