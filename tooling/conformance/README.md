# Framework conformance

`@akter/conformance` is an unpublished verification workspace, not an application dependency.

On `rewrite/0.2` the 0.1 suites that ran against the old engine are retired; [the retirement map](../../docs/verification/0.1-retirement.md) names the 0.2 evidence or the accepted removal for each. What remains is `src/conformance/workflow-engine.ts`: the cases a `WorkflowEngine` must pass, run today against Effect's `ClusterWorkflowEngine` in memory and kept as the template for the shard workflow engine's suite. The seeded simulator, the bucket-protocol integration suites and the benchmark driver are added here as their milestones land.

From the repository root:

```sh
bun run --cwd tooling/conformance test
```
