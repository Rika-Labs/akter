# Guarantees and limits

This page lists what Akter promises, how each promise is tested, and the limits you should know about before you depend on it.

## What Akter guarantees

- **A reply means the change is stored.** Akter writes a command's result to the bucket before it sends the reply, a broadcast, a message to another actor, a timer or a job start.
- **A failed command leaves nothing behind.** A declared error, a thrown exception, an oversized state or a lost write throws away the state change and everything the command staged.
- **A command runs once per command id.** Retries with the same id get the stored outcome for ten minutes.
- **One actor, one command at a time.** Commands to the same actor never overlap.
- **Messages between actors arrive exactly once,** in the order each sender sent them.
- **Timers fire once,** late if no server was running when they came due, never dropped.
- **A recorded job step never runs again.** A step interrupted before its result was recorded can run again, so external calls need idempotency keys.
- **One writer per shard.** The bucket's conditional writes reject a stale owner's writes, so a network partition or a paused process can't corrupt the log.
- **Missing or corrupt data stops the shard.** Akter refuses to open a shard whose log or pages are damaged, rather than continuing from a default state.

## How it's tested

Each guarantee has failure tests that try to break it. The [failure matrix](../internals/verification/02-failure-matrix.md) lists them.

- **Simulation.** The engine runs over a simulated bucket with seeded scheduling, crashes, lost responses, outages and slow writes. One-server and two-server scenarios with moving shard owners have run over 10,000 seeds each, on Bun and on Node.
- **MinIO.** The store's bucket protocol runs against MinIO in CI, and the [self-host example](../../apps/self-host) has a script that checks retries, refused credentials and restarts end to end.
- **Both runtimes.** The test suites run on Bun and on Node.

## Storage providers

A provider works with Akter when `akter storage check` passes against it. MinIO passes in CI. Cloudflare R2 passed six of the seven probes on 2026-10-31 and failed `ordered listing with limit and start-after`: it lists a key after the longer keys that start with it, so `10` comes before `1`. AWS S3 and Tigris have no recorded run yet. That means untested here, not broken: run the check on your provider, region and endpoint before you deploy, and keep its output.

Akter's performance hasn't been measured on a production storage provider. Command latency depends on your bucket's write latency.

## Limits

| Limit                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| State size, without lists | 256 KiB                                                                     |
| List size                 | No limit                                                                    |
| Command id memory         | 10 minutes                                                                  |
| `find` results            | 1,000 ids per call                                                          |
| `find` string comparison  | First 64 bytes                                                              |
| History retention         | 1 to 365 days; 7 by default                                                 |
| Shards                    | Fixed when the store is created; 16 by default                              |
| Tenants                   | The server serves only the `default` tenant                                 |
| Handoff between servers   | A few seconds after a drain; a few seconds after a lease expires on a crash |

## Not yet tested

- Restoring a store from a backup.
- Behavior when a server's clock jumps.
- Slow clients, end to end through a real server.
- Lists, history and garbage collection at large sizes, such as tens of gigabytes.
- Waking a store that has no running server when a timer comes due. Akter reports `nextDue` when it drains, and starting a server in time is up to you.
