---
title: "The akter CLI"
sidebarTitle: "CLI"
description: "The akter command-line tool: its commands, flags, output, and exit statuses."
---

# The `akter` CLI

**Responsibility:** document the `akter` command-line tool: its commands, flags, output, and exit statuses.  
**Authority:** normative CLI interface.  
**Owner role:** API/SDK.  
**Change policy:** a changed command, flag, or exit status updates this page, the runbooks, and the guides that use it.

`akter` is the CLI package selected for publication as the `@rikalabs/akter-cli` name (see [ADR 0103](../decisions/0103-cli-distribution.md)); its first registry publish is a maintainer bootstrap. Once published, install it with `npm i -D @rikalabs/akter-cli` or `bun add -d @rikalabs/akter-cli`, then run it with `npx akter` or `bunx akter`. For one-off use, run `npx -p @rikalabs/akter-cli akter login`; for a global install, run `npm i -g @rikalabs/akter-cli`. It supports Node 24+ and Bun 1.4.2+, and the framework package does not carry a second bin. The command parses its arguments with Effect's `effect/cli` module: one root `akter` command whose subcommands are the groups below, each flag typed and described, so `akter --help` and `akter <command> --help` print the same reference as this page. Flags take their value as `--flag value` or `--flag=value`, and `--` ends flag parsing.

## Exit statuses

| Status | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | The command succeeded, or printed help, its version, or completions.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1      | The command ran and reported a refusal: `workflows check` or `payloads check` found a deploy that would be refused, `payloads clear` left a version uncleared, `adopt plan` found a table problem or an `adopt` step was refused, a runner refused an operator request (`Refused (<status>): <body>`), the control plane refused a hosted command or no longer accepts the stored session, a `login` was denied or expired, or a `deploy` failed or outlasted `--timeout`. |
| 2      | Usage error: an unknown command or flag, a missing or invalid value, an entry module that cannot be loaded, an unreachable runner or control plane, a database `workflows check`, `payloads`, or `adopt` cannot read, a hosted command run before `login`, or stored credentials other users can read. An invalid invocation prints the command's help on stdout and the error on stderr.                                                                                  |

## Global flags

Every command takes `--help` (`-h`), `--version` (`-v`), `--completions <bash|zsh|fish|sh>`, which prints a shell completion script, `--log-level <level>`, and `--wizard`, which builds a command interactively.

## Public command groups

```text
DESCRIPTION
  Run actors locally, check a deploy against stored data, adopt existing tables, inspect and repair a running deployment, and deploy to Akter Cloud

USAGE
  akter <subcommand> [flags]

GLOBAL FLAGS
  --help, -h                                                          Show help information
  --version, -v                                                       Show version information
  --wizard                                                            Start wizard mode for a command
  --completions <bash|zsh|fish|sh>                                    Print shell completion script (choices: bash, zsh, fish, sh)
  --log-level <all|trace|debug|info|warn|warning|error|fatal|none>    Sets the minimum log level (choices: all, trace, debug, info, warn, warning, error, fatal, none)

Develop and check:
  dev          Run the entry's app locally with a read-only inspector at /_akter/inspector
  workflows    Check workflow changes against open executions
  payloads     Check and clear stored event and job payload versions
  adopt        Adopt existing tables: plan, observe legacy writers, backfill, enforce, and check status
  fleet        Set up fleet views' change feed and rebuild a view from its source

Operate a running deployment:
  defects          Read recent defects from runners
  inspect          Read one actor's state, newest receipts, and dead letters through the first runner named
  export           Write one actor's state and pending intents and jobs to a new seed file, through the first runner named
  receipts         Read stored command outcomes
  dead-letters     Repair dead-lettered jobs; the runner audits each repair
  subscriptions    List and skip stuck subscription rows

Akter Cloud client:
  login     Sign in to Akter Cloud through the browser and store the session for deploy
  logout    Sign out of Akter Cloud and delete the stored session
  whoami    Show who the stored Akter Cloud session signs in as
  deploy    Upload the app directory, build and roll it out on Akter Cloud, and follow it until it is live
  env       List, set, unset and import encrypted write-only environment variables
  logs      Read recent customer runner logs, or follow with resumable long polls

```

## Operator commands

`defects list`, `inspect`, `export`, `receipts show`, `dead-letters`, and `subscriptions` call a runner's `Operators.serve` routes. Each reads its bearer token from `AKTER_OPERATOR_TOKEN`, or from the environment variable `--token-env` names. `--url` repeats; `defects list` reads every runner named, and the single-actor commands use the first. See [ADR 0050](../decisions/0050-operator-authority-and-audited-repair.md) for the grants each command needs and the [runbooks](../operations/runbooks.md) for when to use them.

## Akter Cloud commands

`login`, `logout`, `whoami` and `deploy` are the Akter Cloud client commands. They talk to its control plane through the public `CloudApi` contract ([ADR 0085](../decisions/0085-cli-login-and-source-deploys.md)). `login` signs in through Better Auth's device authorization grant and stores the session in `credentials.json` in the CLI's configuration directory: `AKTER_CONFIG_DIR` when set, else `~/Library/Application Support/akter` on macOS, `%APPDATA%\akter` on Windows and `$XDG_CONFIG_HOME/akter` (default `~/.config/akter`) elsewhere. The file is `0600` in a `0700` directory, written under a random temporary name that must not already exist and renamed into place, and a file the group or others can read is refused until it is fixed or replaced by another `login`. The other commands send the stored session as a bearer token to the control plane it came from, which must be `https`, or `http` only on a loopback host (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`); `login --api-url` refuses any other URL with exit 2, and stored credentials naming one are refused as unreadable. A session acts in every organization its user belongs to; the control plane checks membership on every request.

`production`, `staging`, and `dev` are customer project environment names accepted by the public Cloud API. They describe where a customer's deployment runs, not the infrastructure stages used to provision Akter Cloud itself.

Environment responses may include `database: { source: "managed" | "customer", state: "provisioning" | "ready" | "read-only" | "failed" }`. `managed` is the database Akter Cloud runs for the environment; `customer` is a Postgres database the customer brought, always `ready` once set. The status never includes a URL, host, username, password, database name or engine, because Akter Cloud runs Postgres only. Environment variable values remain write-only.

## Commands

### `akter login`

Sign in to Akter Cloud through the browser and store the session for deploy

```text
USAGE
  akter login [flags]

FLAGS
  --api-url string    The control plane to sign in to (default AKTER_API_URL, then https://api.akter.dev)
```

It prints the console's `/device` page and a code written `XXXX-XXXX` (never a link that carries the code), then polls at the interval the control plane names, five seconds slower after each `slow_down`, until the code is approved, denied or past its own expiry. Approving the code saves the session, which starts in the approver's active organization, and prints who it signs in as; a denied or expired code exits 1 and saves nothing. If the control plane will not say who the new session belongs to, `login` signs the session out again and saves nothing.

For a local control plane, run `akter login --api-url http://localhost:3001`, or set `AKTER_API_URL=http://localhost:3001`. The flag overrides the environment variable, which overrides the hosted default.

### `akter logout`

Sign out of Akter Cloud and delete the stored session

```text
USAGE
  akter logout
```

It revokes the session at its control plane, then deletes the stored credentials even when the control plane could not be reached, and says so. A credentials file other users could read is still revoked, since its token may have leaked.

### `akter whoami`

Show who the stored Akter Cloud session signs in as

```text
USAGE
  akter whoami
```

It prints the email address and control plane, then one line per organization: its slug, the role and its id. An expired or revoked session exits 1 and asks for `akter login`.

### `akter deploy`

Upload the app directory, build and roll it out on Akter Cloud, and follow it until it is live

```text
USAGE
  akter deploy [flags]

FLAGS
  --project string       The project to deploy to (default AKTER_PROJECT)
  --env choice           The environment to deploy to (default production) (choices: production, staging, dev)
  --context directory    The app directory to upload, holding src/app.ts (default the current directory)
  --commit string        The commit SHA the deployment is labeled with (default the context's git HEAD)
  --message string       The deployment's message (default the commit's subject)
  --timeout integer      Seconds to follow the rollout before giving up on it (default 900)
```

It packs the app directory with `.akterignore`, or `.gitignore` when there is none, read with Git's root `.gitignore` rules: a pattern with a `/` before its end is anchored at the directory, any other matches at every depth, a trailing `/` matches only directories, and nothing inside a left-out directory comes back. `.git` is always left out. Symbolic links are sent as links and never followed, files keep their permission bits, and owners and times are zeroed so the same files give the same digest. No Dockerfile is sent: the platform builds the app from its `src/app.ts`, whose default export is an `App.make` value ([hosted apps](01-server-api.md#composition)), and a directory whose ignore file leaves out or lacks `src/app.ts` is refused with exit 2 before anything is uploaded. It uploads the archive to `POST /api/projects/:projectId/sources`, creates the deployment with `source: { digest }`, and prints each rollout step as it starts and ends. While the build runs it prints the build log's new lines on every poll, reading `GET .../build-log?after=<next index>` so each line is printed once, and when the build succeeds it prints the rest before the step's end. It exits 0 once the deployment is `live`, and 1 when it fails, naming the failed step and, for a failed build, printing the build's last 20 lines to stderr. Outside a git repository the deployment is labeled with the archive digest's first 40 hex digits; a dirty working tree marks the message `(with uncommitted changes)`. A control plane without a builder refuses the upload with `NotImplemented`, and one past 64 MiB is refused with `PayloadTooLarge`.

### `akter logs`

Read recent customer runner stdout/stderr, or follow with resumable bounded long polls.

```text
USAGE
  akter logs [flags]

FLAGS
  --project string       The project (default AKTER_PROJECT)
  --env choice           The environment (default production; production, staging, dev)
  --deployment string    Read this deployment instead of the environment's current deployment
  --since integer        Seconds of recent output to request, from 1 to 3600 (default 300)
  --limit integer        Maximum lines per response, from 1 to 200 (default 100)
  --follow               Resume long polls until interrupted
```

Each line prints its UTC timestamp, runner identifier, stream and text, separated by tabs. Terminal color sequences are removed and control, Unicode line separators, and bidirectional-formatting characters are replaced so customer text cannot forge terminal lines. A trailing `…` marks text clipped at 4096 UTF-8 bytes. Fly merges stdout and stderr, so its stream is `unknown`; Docker preserves the two streams. This reads customer runner output only, not build output or platform internals. A suspended organization remains readable. The provider retains only recent output, not a durable archive; a dropped connection resumes from the last successful cursor but cannot recover expired provider output.

Recent mode reads every page in the bounded time window, using the returned cursor while `more` is true, then exits. `--limit` bounds each response rather than the total output. The server clamps the requested timestamp into its most recent hour, so the maximum `--since` is not rejected by network delay or client clock skew. Follow drains available pages immediately before waiting at most 20 seconds for more output. Transport failures and typed 503 `Unavailable` responses retry from the last successful cursor with capped exponential delays; six consecutive failed requests stop the command. Authentication, authorization, missing-resource and unsupported-operation refusals are never retried. SIGINT interrupts the Effect runtime and cancels the in-flight request; no background follower remains.

Following an environment switches to its new current deployment after a rollout and resets its provider position within the original bounded time window. `--deployment` stays on the selected deployment. See the [logs API contract](07-cloud-logs.md).

### `akter dev`

Run the entry's app locally with a read-only inspector at `/_akter/inspector`

```text
USAGE
  akter dev [flags]

FLAGS
  --entry file             The entry module; it exports `app`, a Layer of its routes
  --database-url string    Run on this Postgres instead of PGlite
  --data-dir directory     Where PGlite keeps its files (default in memory)
  --port integer           The port to listen on; 0 picks a free one (default 3000)
  --hostname string        The address to listen on (default 127.0.0.1)
  --tenant string          The one tenant the inspector reads (default default)
```

### `akter workflows check`

Compare the entry's workflows with every open execution, read-only; exit 1 when a deploy would be refused

```text
USAGE
  akter workflows check [flags]

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
```

### `akter payloads check`

Check that every stored event and job payload version still decodes, read-only; exit 1 when a deploy would be refused

```text
USAGE
  akter payloads check [flags]

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
```

### `akter payloads clear`

Mark superseded event versions past their retention horizon cleared; exit 1 when one stays uncleared

```text
USAGE
  akter payloads clear [flags]

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
```

### `akter adopt plan`

Plan adopting the entry's existing tables, with the SQL each needs; exit 1 while a table has a problem

```text
USAGE
  akter adopt plan [flags]

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
  --table string           Plan only this adopted table
```

### `akter adopt observe`

Record which writers still write an adopted table, or report them with --report

```text
USAGE
  akter adopt observe [flags] <table>

ARGUMENTS
  table string    The adopted table to observe

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
  --report                 Report the writes recorded so far instead of starting to observe
  --since string           With --report, only writes within this window, such as 7d
  --clear                  With --report, clear the reported writes
```

### `akter adopt backfill`

Fill routing_key on an observed table's rows, in batches

```text
USAGE
  akter adopt backfill [flags] <table>

ARGUMENTS
  table string    The adopted table to backfill

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
  --batch integer          Rows per pass (default 1000)
```

### `akter adopt enforce`

Enforce an adopted table: only the runtime's writer role and --allow roles may write it

```text
USAGE
  akter adopt enforce [flags] <table>

ARGUMENTS
  table string    The adopted table to enforce

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
  --writer-role string     The database role the runtime writes the table as
  --allow string           Another role still allowed to write the table; repeat for several
  --quiet string           How long no legacy write may have been recorded before enforcing, such as 7d
```

### `akter adopt status`

Show each adopted table's mode and the rows left to backfill

```text
USAGE
  akter adopt status [flags]

FLAGS
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
```

### `akter adopt release`

Return an enforced table to observing

```text
USAGE
  akter adopt release [flags] <table>

ARGUMENTS
  table string    The adopted table to release

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
  --to choice              The mode to return the table to; only observe (choices: observe)
```

### `akter fleet setup`

Give the entry's fleet view sources full replica identity, publish them, and create the logical slot; needs wal_level=logical

```text
USAGE
  akter fleet setup [flags]

FLAGS
  --entry file             The entry module; it exports a `fleet` array of Fleet.view values
  --database-url string    The application's Postgres URL
```

### `akter fleet rebuild`

Rebuild a fleet view from its source, clearing its error; exit 1 when no runtime registered it

```text
USAGE
  akter fleet rebuild [flags] <view>

ARGUMENTS
  view string    The fleet view to rebuild

FLAGS
  --database-url string    The application's Postgres URL
```

### `akter defects list`

List recent defects from each runner named; each keeps only its own recent defect spans

```text
USAGE
  akter defects list [flags]

FLAGS
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default AKTER_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
  --tenant string       The tenant to read, or * for every tenant the operator's grant covers (default *)
  --actor string        Only defects of this actor type
  --since string        Only defects this recent: 1h, 30m, 2d, 45s, or any duration
  --limit integer       At most this many of the newest defects, 1 to 1000
```

### `akter inspect`

Read one actor's state, newest receipts, and dead letters through the first runner named

```text
USAGE
  akter inspect [flags] <actor>

ARGUMENTS
  actor string    The actor, as <Type>/<id>

FLAGS
  --tenant string       The tenant the request acts in
  --receipts integer    How many of the newest receipts to show, 1 to 1000 (default 20)
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default AKTER_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
```

### `akter export`

Write one actor's state and pending intents and jobs to a new seed file, through the first runner named

```text
USAGE
  akter export [flags] <actor>

ARGUMENTS
  actor string    The actor, as <Type>/<id>

FLAGS
  --tenant string       The tenant the request acts in
  --output file         The seed file to create; an existing file is never replaced
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default AKTER_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
```

### `akter receipts show`

Print one receipt's stored outcome as JSON; the runner never runs the command to answer

```text
USAGE
  akter receipts show [flags] <actor> <commandId>

ARGUMENTS
  actor string        The actor, as <Type>/<id>
  commandId string    The command id whose stored outcome to show

FLAGS
  --tenant string       The tenant the request acts in
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default AKTER_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
```

### `akter dead-letters retry`

Run a dead-lettered job again

```text
USAGE
  akter dead-letters retry [flags] <jobId>

ARGUMENTS
  jobId string    The dead-lettered job's id

FLAGS
  --actor string        The actor that enqueued the job, as <Type>/<id>
  --tenant string       The tenant the request acts in
  --reason string       Why, recorded in the operator audit log (up to 500 characters)
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default AKTER_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
  --provider-checked    Confirm the provider never applied an ambiguous attempt, so running it again is safe
```

### `akter dead-letters discard`

Settle a dead-lettered job without running it

```text
USAGE
  akter dead-letters discard [flags] <jobId>

ARGUMENTS
  jobId string    The dead-lettered job's id

FLAGS
  --actor string        The actor that enqueued the job, as <Type>/<id>
  --tenant string       The tenant the request acts in
  --reason string       Why, recorded in the operator audit log (up to 500 characters)
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default AKTER_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
```

### `akter subscriptions list`

List subscription rows whose deliveries keep failing, with their lag and last error

```text
USAGE
  akter subscriptions list [flags]

FLAGS
  --lagging                 List the rows whose deliveries keep failing; the only listing, so required
  --tenant string           The tenant the request acts in
  --min-attempts integer    Only rows with at least this many failed attempts
  --limit integer           At most this many rows, 1 to 1000
  --url string              A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string        The environment variable holding the operator bearer token (default AKTER_OPERATOR_TOKEN)
  --json                    Print the runner's answer as JSON
```

### `akter subscriptions skip`

Skip a stuck subscription row's events through a cursor; the runner audits the skip

```text
USAGE
  akter subscriptions skip [flags]

FLAGS
  --source string          The source actor whose events the row delivers, as <Type>/<id>
  --subscriber string      The subscribing actor, as <Type>/<id>
  --subscription string    The subscription's name on the subscriber
  --through string         Skip every event up to and including this source event cursor
  --tenant string          The tenant the request acts in
  --reason string          Why, recorded in the operator audit log (up to 500 characters)
  --url string             A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string       The environment variable holding the operator bearer token (default AKTER_OPERATOR_TOKEN)
  --json                   Print the runner's answer as JSON
```

## `akter env`

These commands use the stored Akter Cloud session. All take `--project <id>` (default `AKTER_PROJECT`) and `--env <production|staging|dev>` (default `production`).

- `akter env list` prints each variable's name and UTC update time, with `managed` provenance for platform-provisioned names. Values cannot be read back.
- `akter env set <name> --file <path>` reads the exact UTF-8 file contents, including a final newline, and writes the value without printing it. Omit `--file` to read piped stdin; interactive terminal input is refused so a secret is never echoed. Input is limited to 65,536 bytes. Use `printf %s "$TOKEN" | akter env set TOKEN` rather than placing the value in arguments or shell history.
- `akter env unset <name>` removes a customer variable. Repeating the deletion is safe.
- `akter env import [file]` imports a dotenv file atomically. `-` or no file reads piped stdin; the document is limited to 1 MiB. The result reports created and updated counts, not values.

Changes apply to the next deployment. Platform-managed values, including the managed `DATABASE_URL`, cannot be replaced or deleted through these commands. Rollback restores the original captured environment rather than current settings. Refused writes exit 1; input/configuration errors exit 2.
