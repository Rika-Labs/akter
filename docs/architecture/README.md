# Architecture

The 0.2 engine runs in `packages/akter`. The bucket's immutable segment chain is write authority; process memory and Effect Cluster locks are not. Commands run synchronously against copy-on-write drafts and nothing leaves the owner before its segment is durable.

Read [topology](01-topology.md), [lifecycle](02-lifecycle.md), [storage layout](03-storage-layout.md), [dispatch](04-dispatch.md), and [adapters](05-adapters.md). The [contracts](../contracts/README.md) distinguish the normative target from sections with recorded failure evidence.
