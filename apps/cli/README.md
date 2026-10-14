# Akter CLI

`@rikalabs/akter-cli` provides Effect CLI commands for Akter Cloud, storage checks, local development and audited operator reads.

```text
akter dev --entry src/app.ts --dir .akter/store --port 8080
akter inspect actor Room room-1
akter inspect shard 0
akter log tail 0 --follow
akter log export 0
akter snapshot 0
akter replay 0 --current
akter storage check --directory .akter/store
```

`akter dev` uses the filesystem store and can enable Effect DevTools. Operator commands use a separate bearer credential from `AKTER_OPERATOR_TOKEN` (or an explicit `--token-env`) and separate grants for inspection, logs, snapshots, outcomes and replay. Reads are audited before they answer. Cloud commands (`login`, `logout`, `whoami`, `deploy`, `env`, `keys`, `logs`) remain available.
