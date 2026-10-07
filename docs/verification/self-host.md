# Self-host recipe evidence

**Responsibility:** bound the claims of the executable two-runner deployment recipe.
**Authority:** evidence.

The recipe is `apps/self-host`, documented in [self-host operations](../operations/self-host.md) and selected in the Mintlify navigation. It uses only the framework's public package exports. No framework contract is changed.

## Commands and scope

Run from the repository root, with Docker Compose, OpenSSL and curl installed:

```sh
SELFHOST_RUNTIME=bun bash apps/self-host/verify.sh
SELFHOST_RUNTIME=node bash apps/self-host/verify.sh
bun run --cwd apps/self-host typecheck
bun run --cwd apps/self-host lint
bun run lint:structure
bun run lint:directives
```

Local evidence on 2026-10-07 uses Linux arm64 containers on the shared Mac's Docker daemon, Bun 1.4.2, Node 24.18.0 and a real Postgres server 18.6. Both runtime images build, and each full lifecycle script exits zero. The optional `self-host-recipe` CI job repeats the same script for both runtimes on the Linux x64 hosted runner; a local pass is not a claim that the hosted job has already passed.

Each run refuses existing named containers and its named database volume. It creates its own short-lived credentials, Postgres server, two runners and an external client container, then removes those containers, its volume, bridge network and temporary credential directory. It never starts a hosted provider stack or writes to production.

## Wrong implementations rejected

| Scenario                   | Plausible wrong implementation                                                                       | Independent observation                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Concurrent first boot      | Both runners create migration history or independently apply the same migration.                     | An event trigger holds the first history-table creation open for eight seconds; both processes start against the fresh database, exactly one creation is recorded, both become ready, and two healthy runner registrations and the counter registration exist. A failed contender never satisfies the two readiness probes.    |
| Startup readiness          | A listening HTTP port or incomplete migration is reported ready.                                     | While `pg_stat_activity` confirms the migration session is sleeping in the trigger, neither runner may answer readiness 200. Both must later answer 200.                                                                                                                                                                       |
| Migration replay           | Every restart reruns startup DDL or rewrites migration history.                                      | The ordered migration IDs, names and creation timestamps are identical before and after restart; the history-table creation audit remains one.                                                                                                                                                                                 |
| Cross-runner commands      | Runners keep separate counters or a remote hop cannot authenticate.                                  | The public Promise client sends 3 through runner A and 7 through runner B to the same key. Both independent reads must return 10. Missing and wrong bearer credentials must be denied.                                                                                                                                         |
| Peer encryption            | The peer listener accepts plaintext, or an unreachable listener is mistaken for a security pass.     | The same live peer accepts an authenticated TLS 1.3 handshake and closes plaintext without application bytes. Connection refusal, other errors, unexpected data and a three-second timeout fail the probe.                                                                                                                     |
| Runner-only SIGTERM        | The process closes actor layers immediately, stays ready while draining, or loses the admitted turn. | A handler-start marker and the absence of its receipt prove the command is in flight before `compose stop runner-a runner-b`. The active runner must report `draining`, the command must return 21, both drains must be clean and both processes must exit zero. The database must contain exactly one receipt before restart. |
| Lost or duplicated receipt | Restart discards receipts or retries rerun a committed increment.                                    | Retry with the original command ID through the other runner returns 21 and the public read remains 21.                                                                                                                                                                                                                         |
| Full-stack stop            | The database stops before runners drain, or an outage loses the command or its receipt.              | A second handler-start marker and absent receipt precede full `compose stop`. After restart, the original client must complete or safely retry its increment of 13 to 34. Exactly one receipt remains, and another retry returns 34 without changing the public read.                                                          |

The test-only `COMMAND_DELAY_MS=3000` keeps a real transaction open long enough for the signal; it is zero by default. The receipt absence assertion rejects a drill that accidentally stops after the command already committed. The database trigger and catalog reads observe real database behavior, not a mocked migration coordinator. The smoke script does not import runtime hooks or internal entry points.

## Limits

This is one host, two runner processes and one Postgres server. It establishes the container recipe and the tested graceful completion/replay path, not a performance SLO, database failover, a SIGKILL crash drill, Neki support, cross-host routing, managed certificate rotation or secure public ingress. Deadline-expired rollback and commit-unknown recovery remain covered by the existing framework drain and recovery suites, not claimed as a new result of this recipe. The generated bearer provider identifies one logical caller in one tenant.

The source-built images include the installed monorepo dependency tree; size minimization is not verified. Published npm versions lag main until alpha.2, so these results do not apply to the currently published alpha.1 package.
