---
title: "The durable CLI"
sidebarTitle: "CLI"
description: "The durable command-line tool: its commands, flags, output, and exit statuses."
---

# The `durable` CLI

**Responsibility:** document the `durable` command-line tool: its commands, flags, output, and exit statuses.  
**Authority:** normative CLI interface.  
**Owner role:** API/SDK.  
**Change policy:** a changed command, flag, or exit status updates this page, the runbooks, and the guides that use it.

`durable` is the `apps/cli` bin. It parses its arguments with Effect's `effect/cli` module: one root `durable` command whose subcommands are the groups below, each flag typed and described, so `durable --help` and `durable <command> --help` print the same reference as this page. Flags take their value as `--flag value` or `--flag=value`, and `--` ends flag parsing.

## Exit statuses

| Status | Meaning                                                                                                                                                                                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | The command succeeded, or printed help, its version, or completions.                                                                                                                                                                                                                                                   |
| 1      | The command ran and reported a refusal: `workflows check` or `payloads check` found a deploy that would be refused, `payloads clear` left a version uncleared, `adopt plan` found a table problem or an `adopt` step was refused, or a runner refused an operator request (`Refused (<status>): <body>`).              |
| 2      | Usage error: an unknown command or flag, a missing or invalid value, an entry module that cannot be loaded, an unreachable runner, a database `workflows check`, `payloads`, or `adopt` cannot read, or a refused `tenants create`. An invalid invocation prints the command's help on stdout and the error on stderr. |

## Global flags

Every command takes `--help` (`-h`), `--version` (`-v`), `--completions <bash|zsh|fish|sh>`, which prints a shell completion script, `--log-level <level>`, and `--wizard`, which builds a command interactively.

## `durable --help`

```text
DESCRIPTION
  Run actors locally, check a deploy against stored data, adopt existing tables, and inspect and repair a running deployment

USAGE
  durable <subcommand> [flags]

GLOBAL FLAGS
  --help, -h                                                          Show help information
  --version, -v                                                       Show version information
  --wizard                                                            Start wizard mode for a command
  --completions <bash|zsh|fish|sh>                                    Print shell completion script (choices: bash, zsh, fish, sh)
  --log-level <all|trace|debug|info|warn|warning|error|fatal|none>    Sets the minimum log level (choices: all, trace, debug, info, warn, warning, error, fatal, none)

Develop and check:
  dev          Run the entry's app locally with a read-only inspector at /_durable/inspector
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

Control plane:
  tenants    Manage the tenant directory
  billing    Set up the billing catalog
```

## Operator commands

`defects list`, `inspect`, `export`, `receipts show`, `dead-letters`, and `subscriptions` call a runner's `Operators.serve` routes. Each reads its bearer token from `DURABLE_OPERATOR_TOKEN`, or from the environment variable `--token-env` names. `--url` repeats; `defects list` reads every runner named, and the single-actor commands use the first. See [ADR 0050](../decisions/0050-operator-authority-and-audited-repair.md) for the grants each command needs and the [runbooks](../operations/runbooks.md) for when to use them.

## Commands

### `durable billing setup`

Create or reconcile products, meters and prices using the configured provisional pricing. Every provider creation has a stable identity; repeating setup does not duplicate catalog objects.

```text
durable billing setup --mode local --database-url postgres://project:project@localhost:55415/project
durable billing setup --mode stripe
```

Local mode is the default and uses only the SQL-backed Stripe implementation. Stripe mode reads `STRIPE_API_KEY` from the environment; it is not a command-line argument. API, edge and setup consume the same optional `BILLING_PRICING_CONFIG` JSON configuration. Setup does not publish the planning prices or establish live tax/provider support.

### `durable dev`

Run the entry's app locally with a read-only inspector at /_durable/inspector

```text
USAGE
  durable dev [flags]

FLAGS
  --entry file             The entry module; it exports `app`, a Layer of its routes
  --database-url string    Run on this Postgres instead of PGlite
  --data-dir directory     Where PGlite keeps its files (default in memory)
  --port integer           The port to listen on; 0 picks a free one (default 3000)
  --hostname string        The address to listen on (default 127.0.0.1)
  --tenant string          The one tenant the inspector reads (default default)
```

### `durable workflows check`

Compare the entry's workflows with every open execution, read-only; exit 1 when a deploy would be refused

```text
USAGE
  durable workflows check [flags]

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
```

### `durable payloads check`

Check that every stored event and job payload version still decodes, read-only; exit 1 when a deploy would be refused

```text
USAGE
  durable payloads check [flags]

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
```

### `durable payloads clear`

Mark superseded event versions past their retention horizon cleared; exit 1 when one stays uncleared

```text
USAGE
  durable payloads clear [flags]

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
```

### `durable adopt plan`

Plan adopting the entry's existing tables, with the SQL each needs; exit 1 while a table has a problem

```text
USAGE
  durable adopt plan [flags]

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
  --table string           Plan only this adopted table
```

### `durable adopt observe`

Record which writers still write an adopted table, or report them with --report

```text
USAGE
  durable adopt observe [flags] <table>

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

### `durable adopt backfill`

Fill routing_key on an observed table's rows, in batches

```text
USAGE
  durable adopt backfill [flags] <table>

ARGUMENTS
  table string    The adopted table to backfill

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
  --batch integer          Rows per pass (default 1000)
```

### `durable adopt enforce`

Enforce an adopted table: only the runtime's writer role and --allow roles may write it

```text
USAGE
  durable adopt enforce [flags] <table>

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

### `durable adopt status`

Show each adopted table's mode and the rows left to backfill

```text
USAGE
  durable adopt status [flags]

FLAGS
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
```

### `durable adopt release`

Return an enforced table to observing

```text
USAGE
  durable adopt release [flags] <table>

ARGUMENTS
  table string    The adopted table to release

FLAGS
  --entry file             The entry module; it exports an `actors` array of actor definitions
  --database-url string    The application's Postgres URL
  --json                   Print the report as JSON
  --to choice              The mode to return the table to; only observe (choices: observe)
```

### `durable fleet setup`

Give the entry's fleet view sources full replica identity, publish them, and create the logical slot; needs wal_level=logical

```text
USAGE
  durable fleet setup [flags]

FLAGS
  --entry file             The entry module; it exports a `fleet` array of Fleet.view values
  --database-url string    The application's Postgres URL
```

### `durable fleet rebuild`

Rebuild a fleet view from its source, clearing its error; exit 1 when no runtime registered it

```text
USAGE
  durable fleet rebuild [flags] <view>

ARGUMENTS
  view string    The fleet view to rebuild

FLAGS
  --database-url string    The application's Postgres URL
```

### `durable defects list`

List recent defects from each runner named; each keeps only its own recent defect spans

```text
USAGE
  durable defects list [flags]

FLAGS
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default DURABLE_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
  --tenant string       The tenant to read, or * for every tenant the operator's grant covers (default *)
  --actor string        Only defects of this actor type
  --since string        Only defects this recent: 1h, 30m, 2d, 45s, or any duration
  --limit integer       At most this many of the newest defects, 1 to 1000
```

### `durable inspect`

Read one actor's state, newest receipts, and dead letters through the first runner named

```text
USAGE
  durable inspect [flags] <actor>

ARGUMENTS
  actor string    The actor, as <Type>/<id>

FLAGS
  --tenant string       The tenant the request acts in
  --receipts integer    How many of the newest receipts to show, 1 to 1000 (default 20)
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default DURABLE_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
```

### `durable export`

Write one actor's state and pending intents and jobs to a new seed file, through the first runner named

```text
USAGE
  durable export [flags] <actor>

ARGUMENTS
  actor string    The actor, as <Type>/<id>

FLAGS
  --tenant string       The tenant the request acts in
  --output file         The seed file to create; an existing file is never replaced
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default DURABLE_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
```

### `durable receipts show`

Print one receipt's stored outcome as JSON; the runner never runs the command to answer

```text
USAGE
  durable receipts show [flags] <actor> <commandId>

ARGUMENTS
  actor string        The actor, as <Type>/<id>
  commandId string    The command id whose stored outcome to show

FLAGS
  --tenant string       The tenant the request acts in
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default DURABLE_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
```

### `durable dead-letters retry`

Run a dead-lettered job again

```text
USAGE
  durable dead-letters retry [flags] <jobId>

ARGUMENTS
  jobId string    The dead-lettered job's id

FLAGS
  --actor string        The actor that enqueued the job, as <Type>/<id>
  --tenant string       The tenant the request acts in
  --reason string       Why, recorded in the operator audit log (up to 500 characters)
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default DURABLE_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
  --provider-checked    Confirm the provider never applied an ambiguous attempt, so running it again is safe
```

### `durable dead-letters discard`

Settle a dead-lettered job without running it

```text
USAGE
  durable dead-letters discard [flags] <jobId>

ARGUMENTS
  jobId string    The dead-lettered job's id

FLAGS
  --actor string        The actor that enqueued the job, as <Type>/<id>
  --tenant string       The tenant the request acts in
  --reason string       Why, recorded in the operator audit log (up to 500 characters)
  --url string          A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string    The environment variable holding the operator bearer token (default DURABLE_OPERATOR_TOKEN)
  --json                Print the runner's answer as JSON
```

### `durable subscriptions list`

List subscription rows whose deliveries keep failing, with their lag and last error

```text
USAGE
  durable subscriptions list [flags]

FLAGS
  --lagging                 List the rows whose deliveries keep failing; the only listing, so required
  --tenant string           The tenant the request acts in
  --min-attempts integer    Only rows with at least this many failed attempts
  --limit integer           At most this many rows, 1 to 1000
  --url string              A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string        The environment variable holding the operator bearer token (default DURABLE_OPERATOR_TOKEN)
  --json                    Print the runner's answer as JSON
```

### `durable subscriptions skip`

Skip a stuck subscription row's events through a cursor; the runner audits the skip

```text
USAGE
  durable subscriptions skip [flags]

FLAGS
  --source string          The source actor whose events the row delivers, as <Type>/<id>
  --subscriber string      The subscribing actor, as <Type>/<id>
  --subscription string    The subscription's name on the subscriber
  --through string         Skip every event up to and including this source event cursor
  --tenant string          The tenant the request acts in
  --reason string          Why, recorded in the operator audit log (up to 500 characters)
  --url string             A runner's base URL; repeat to name several, a single-actor command uses the first
  --token-env string       The environment variable holding the operator bearer token (default DURABLE_OPERATOR_TOKEN)
  --json                   Print the runner's answer as JSON
```

### `durable tenants create`

Record a new tenant's home region in the control plane's directory, attributed to --operator

```text
USAGE
  durable tenants create [flags] <tenant>

ARGUMENTS
  tenant string    The tenant's name: 1 to 128 of A-Z a-z 0-9 . _ : -

FLAGS
  --deployment string      The deployment the tenant belongs to
  --region string          The tenant's home region: the deployment's primary region
  --database-url string    The control plane's Postgres URL
  --operator string        The subject of the User the directory change's receipt records
```
