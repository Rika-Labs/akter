# Competitive positioning

**Responsibility:** explain product choice without distorting technical tradeoffs.  
**Authority:** product messaging.  
**Owner role:** product/marketing.
**Change policy:** a change requires product sign-off.

Durable Actors is an Effect-native actor framework for applications that need identity, relational business data, realtime clients, and durable work in one model. `Actor.make` covers stateful actors, singleton services, cron-triggered commands, and actor-owned workflows instead of making developers compose separate application primitives.

## Honest comparison

| Product                         | Strongest fit                                                                                                | Durable Actors difference                                                                                                                                               | Prefer the alternative when                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Rivet Actors                    | Self-hostable actor infrastructure with polished actor-local ergonomics and broad client reach               | Adds one-transaction command turns over keyed state and relational `OwnedTable` data, retained receipts, Effect-native contracts, and actor-owned workflows and effects | Rivet's existing ecosystem, languages, deployment support, or storage model fits better                                           |
| Cloudflare Durable Objects      | Globally distributed, managed object-local coordination tightly integrated with Cloudflare                   | Keeps ordinary Postgres and Drizzle as the relational system of record, supports embedded and self-hosted operation, and makes deployment ownership portable            | Cloudflare's edge placement, platform integration, and managed object storage are the primary requirements                        |
| Temporal-style workflow engines | Long-running, finite orchestration with mature workflow histories, operations, and multi-language ecosystems | Starts from an open-ended actor identity; workflows, cron, timers, realtime connections, tables, and effects are members or policies of that actor                      | The central problem is business-process orchestration rather than a stateful domain object with realtime and relational ownership |

## Positioning guardrails

- Do not call a workflow engine deficient because it is not an actor system.
- Do not imply benchmark, scale, regional, or availability advantages without evidence.
- Do not claim broadcasts are durable or external effects are exactly once.
- Do not position the framework as an AI platform. Agents are a compelling actor workload, and OpenAPI is the tool-generation boundary.
- Do not hide operational maturity: Durable Actors must earn confidence through conformance tests, observability, and production evidence.

See [fit and non-fit](fit-and-non-fit.md) and the [vision](../vision/README.md).

## Product direction after the foundation

The framework should compete on the boundary that Rivet Actors and Durable Objects do not own: durable relational authority, inspectable history, safe adoption into an existing Postgres system, and derived clients that preserve command identity. The next differentiators are therefore M6 adoption and observation features, not a competing VM or a claim of lower cold-start latency.

Rivet's agentOS remains a useful reference point and possible compute provider, but this project will not copy its kernel, filesystem, or sandbox implementation. The durable agent runtime is Outlast, a separate product built on this framework: it makes Postgres-backed actor state authoritative and treats sandbox execution as replaceable compute ([ADR 0017](../decisions/0017-m1-record-corrections.md)). A future generated-app product will generate validated Durable Actor contracts rather than arbitrary HTTP servers by default.

These are product directions, not current support claims. Each remains gated by the ADR and verification requirements listed in the roadmap.
