# Framework conformance

`@akter/conformance` is an unpublished verification workspace, not an application dependency.

In 0.2 the 0.1 suites that ran against the old engine are retired; [the retirement map](../../docs/internals/verification/0.1-retirement.md) names the 0.2 evidence or the accepted removal for each. What remains is `src/conformance/workflow-engine.ts`: the cases a `WorkflowEngine` must pass, run today against Effect's `ClusterWorkflowEngine` in memory and kept as the template for the shard workflow engine's suite. `src/conformance/store.ts` is the bucket-protocol suite every `Store` backend runs; the framework's `src/store/*.test.ts` files run it ([store protocol evidence](../../docs/internals/verification/store-protocol.md)). The seeded simulator and the benchmark driver are added here as their milestones land.

From the repository root:

```sh
bun run --cwd tooling/conformance test
```
