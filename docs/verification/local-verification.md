# Local verification and sign-off

**Responsibility:** define how a head commit is verified and signed off before it can merge or be released, now that this repository runs no verification workflow.
**Authority:** evidence.
**Owner role:** verification/reliability.
**Change policy:** a change to the checks, the statuses or the sandbox needs maintainer review of the diff; the tool never signs off its own change with a manifest it has not committed.

## What is required

`main` requires two commit statuses, `verify` and `branch`, on the pull request's head. Both come only from `bun run verify:local <pr> --post --agent <name>`, which runs on the maintainer's Mac against the exact head SHA. Which checks make up each status is the checked-in [`tooling/local-verify/manifest.json`](../../tooling/local-verify/manifest.json); its tests assert the two contexts, the former workflow jobs, the Postgres project groups against the shard registry, and that no check is required by two statuses or by none.

| Former workflow                                                                                                                                                                | Now                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify jobs (`self-host-recipe`, `static`, `pack`, `public-workspaces`, `framework-unit`, `framework-pglite-*`, `framework-postgres-*`, `framework-drills`, `node-postgres-*`) | checks `self-host`, `static`, `pack`, `workspaces`, `framework-unit`, `framework-pglite`, `framework-postgres`, `framework-migrations`, `framework-drills`, `node-postgres`, all required by `verify`                                                                         |
| Trusted policy (`branch`)                                                                                                                                                      | check `branch`, required by `branch`; it runs from the trusted checkout, also requires the head to contain its base, and the head to equal the verified commit                                                                                                                |
| Evidence gate (current-SHA run and artifact)                                                                                                                                   | statuses are set on the exact SHA only; results from another SHA, an older manifest or changed tooling are discarded; a run refuses to post unless the runner, manifest and policy scripts equal `main` or the head, uncommitted changes excluded; a push clears the statuses |
| Nightly properties, Stress                                                                                                                                                     | optional suites `properties`, `simulation`, `stress`                                                                                                                                                                                                                          |
| Release gate on a `ci.yml` run                                                                                                                                                 | [`release.yml`](../operations/05-releasing.md) requires the `verify` and `branch` commit statuses of the tagged commit                                                                                                                                                        |

There was no Postgres server version matrix; every Postgres job used 18.6, as the manifest does. `Lock debug` and `Relay soak` were temporary debugging workflows that exist only on old `ci/611-*` branches, so they have no counterpart. The `Deploy` workflow moved to the private repository with the cloud code (#670); nothing here deploys.

## Strictness

- A failed `git` command (fetch, ref resolution, checkout, worktree creation) stops the run with the error; nothing is swallowed, and a run that stopped posts nothing.
- The `branch` check requires the head to contain the `main` tip fetched at that moment, and the policy script requires the pull request to target `main`. There is no case for stacked pull requests: one goes green only after it is retargeted to `main` and contains it.
- Host checks run with an allowlisted environment (`PATH`, `HOME`, `USER`, `TMPDIR`, locale, `DOCKER_HOST`, `BUN_INSTALL`), not the operator's, so provider keys, `GH_TOKEN`, `SSH_AUTH_SOCK` and the variables `~/.config/akter/load` exports never reach a step. `runner.test.ts` plants canaries in the outer process and asserts that neither `baseEnv()` nor a real step's `env` output contains them. This sits beside the container sandbox: the allowlist protects against an accident or a trusted branch's script, the sandbox against hostile code.
- `Release` publishes only the commit its tag names, from `main`: it fails unless the checked-out commit is the tag's commit, the tag matches the package version, and the commit is an ancestor of `origin/main`, and it reads the statuses of that same commit. This repository has no deploy workflow.

## No cached results

Every check runs with `TURBO_FORCE=1`, so Turbo executes each task and replays nothing. A replayed result once let a required check pass without running because a test read a file its package's Turbo inputs did not cover. The runner also fails a check whose log contains `cache hit, replaying logs`. Developers who run Turbo by hand keep its cache. Partial runs are combined only from earlier runs that recorded themselves as uncached, and the sign-off states "Turbo cache: uncached". To keep the cache correct for ordinary development too, `turbo.json` declares the files outside their package that tests read: `@akter/local-verify#test` (the framework's shard registry and conformance groups) and `@rikalabs/akter-cli#test` (`packages/akter/src/testing/conformance/fleet.ts`). The other tests were audited and read only their own package, dependencies Turbo already hashes through `^build`, or `.cache` scratch directories.

## Sign-off

A run writes a "Local verification" section into the pull request body, between two HTML comment markers the tool owns, listing each required check, where it ran (host, sandbox or tool), its time, the head SHA, the statuses, the log directory and the isolation used. With every check green it also posts one comment per head SHA, quoting the same facts. A failing or partial run sets failure statuses and the section reads "Not signed off"; there is no comment. Nobody ticks boxes or edits the section by hand, and a status or comment copied from another head means nothing, because `main` requires the status on the current head.

## Untrusted pull requests

The author is trusted when they are listed in the manifest or their head is a branch of this repository and they are not a bot. Everything else, including a fork, a deleted fork and Dependabot, runs in the Docker sandbox of [`tooling/local-verify/sandbox`](../../tooling/local-verify/sandbox/Dockerfile):

- The checkout is a standalone clone of the exact head in a throwaway directory and is the only bind mount, so there is no home directory, `~/.config/akter/secrets.env`, SSH agent socket, Docker socket or `gh` token.
- Every capability is dropped, privilege escalation is off, the user is the host user's id, and the container environment is built from scratch rather than inherited.
- Postgres server and replica containers are started by the outer tool on a private network per check or conformance group and handed to the sandbox by URL, so the sandbox needs no Docker access.
- The outer tool, which never executes pull request code, is the only process that holds credentials: it reads exit codes, writes logs, and posts statuses, the body section and the comment. It never runs git inside the pull request's directory after the container has started, because a hostile `.git/config` could execute code on the host.

`self-host` and `framework-drills` start containers of their own and therefore need the host Docker daemon. They do not run for an untrusted head, so `verify` stays failing with those checks missing until a maintainer reads the diff and reruns with `--trust-reviewed <head sha>`, which names the exact head and is recorded in the sign-off.

The `sandbox` check (`bun run --cwd tooling/local-verify test:isolation`) plants a random canary file beside `~/.config/akter/secrets.env`, sets a fake SSH agent, `GH_TOKEN` and other secret variables in the outer process, and asserts from inside a sandbox started with the production argument list that the canary path, its directory and its contents cannot be found anywhere in the container's file system, that none of those variables exist, that there is no socket, `docker`, `gh` or `ssh`, that only `/work` is mounted, and that a marker placed in the checkout is found by the same search. It is a required check, so a change that widens the mount or the environment fails verification.

Known limits: the sandbox has outbound network access, because installs and the tarball smoke need the registry, so a hostile pull request can reach whatever the Docker network can reach, including services bound on the host's LAN address. It runs linux/arm64 images on Apple silicon, not the x86 runners the old workflow used. A container escape would defeat it.

## Optional suites

`bun run verify:local <pr> --only stress` (or `bun run verify:local main --only stress`) runs a suite. Suites never post statuses and are not required per pull request.

| Suite        | Intended cadence                                         | Covers                                                                                                   |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `properties` | nightly on `main`                                        | random-seed property runs of the unit and PGlite suites, then the Postgres suites                        |
| `simulation` | nightly on `main`                                        | 10,000 new simulation seeds per run, from a counter that advances each run                               |
| `stress`     | nightly on `main`; weekly if the machine cannot spare it | the framework suites repeated under CPU load (`--runs 1-25`, default 10), failing cases reported by name |

No scheduler runs them; a maintainer or agent starts them. Run `stress` only when the machine is otherwise idle, since it deliberately saturates the CPU.

## Running it

Run it with background execution and a timeout that covers the whole suite, 7200 seconds (the checks' own deadlines add up to more than 1800; time spent waiting for a heavy slot counts): `bun run verify:local <pr>`. Do not wrap it in `heavy.sh`; it takes one of the machine's two heavy slots and a run mutex itself, creates and removes only containers and networks it named (`akter-verify-<pr>-<check>-<pid>`), and keeps logs under `~/.capy/work/akter-verify/runs`. `--inject-failure <id>` makes a check fail on purpose, to prove the failure path without committing a broken test.
