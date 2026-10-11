# Public environment API key surface

The contract and command tests reject wrong route methods or scope, missing bearer authentication, an invented default-tenant payload, a secret leaking through list output, false revocation success, and undeployed or denied requests reported as success.

Run the focused evidence from the repository root:

```sh
bun --bun node_modules/vitest/vitest.mjs run packages/cloud-api/src/projects.test.ts packages/cloud-api/src/contract.test.ts apps/cli/src/commands/cloud/keys.test.ts apps/cli/src/cli.test.ts
```

The command tests run through `Command.runWith` using the real contract client and a scripted HTTP peer. They establish argument parsing, request encoding, credential selection, response decoding and output behavior, not cloud database authorization or edge authentication. The cloud's real database and edge evidence lives in `apps/api/src/environment-api-keys.test.ts` in Akter Cloud. Its redeployment, cross-project denial and revocation coverage is not replaced by these client tests. CI packaging verifies the contract's publication through `@rikalabs/akter-cli/cloud-api`.
