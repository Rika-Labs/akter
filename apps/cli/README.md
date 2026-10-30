# @rikalabs/akter-cli

The `akter` command for [Akter](https://github.com/Rika-Labs/akter): run an app locally, check a storage bucket, and inspect a running server.

```sh
bun add -d @rikalabs/akter-cli
```

Install it at the same version as `@rikalabs/akter`.

| Command                                     | What it does                               |
| ------------------------------------------- | ------------------------------------------ |
| `akter dev`                                 | Serves `src/app.ts` on `127.0.0.1:8080`    |
| `akter storage check --bucket <bucket>`     | Checks that a bucket works with Akter      |
| `akter inspect actor <Type> <id>`           | Shows what's stored for one actor          |
| `akter log tail <shard> --follow`           | Follows one shard's command log            |
| `akter fork <Type> <id> --at <n> --to <id>` | Copies an actor's history into a new actor |

Operator commands such as `inspect` and `log` use their own credential, read from `AKTER_OPERATOR_TOKEN`, and every request is audited.

See the [CLI reference](https://github.com/Rika-Labs/akter/blob/main/docs/reference/cli.md) for every command and flag.
