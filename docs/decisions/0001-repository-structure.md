# ADR 0001: Repository structure

**Responsibility:** define the monorepo layout and package ownership boundaries.  
**Authority:** recorded decision.  
**Owner role:** runtime architecture.  
**Change policy:** supersede via a new ADR; do not edit accepted ADRs in place.

**Status:** accepted (2026-09-21)  
**Supersedes:** `docs/architecture/package-boundaries.md` (thirteen skeleton packages)

## Context

The template layout split the actor runtime into `protocol runtime drizzle sdk gateway work realtime blobs testing`, plus `apps/server` and `apps/worker`. Research decision 151 settled one npm distribution, `akter`, with four subpath entries, and decision 155 settled three ways to run (embedded, served, hosted). Thirteen internal packages cannot express a four-entry public surface, and every one of them was an `export {}` scaffold. The monorepo also needed the naming and boundary contract from the Whorl restructure so a tree checker can enforce it.

## Decision

- One framework package, `packages/akter`, with `src/{identity,errors,members,policies,actor,state,tables,handles,contexts,activation,serve,client,runtime,testing}`. Root and `client/` never import SQL or cluster modules; `runtime/` and `testing/` do.
- Runtime construction is `Actors.layer` from `@rikalabs/akter/runtime`. `Actor.layer` on the root is dropped: the browser-safety rule is physical (a folder), not a tree-shaking promise.
- Actor definitions use role folders: `<actor>/{contract,layer,queries}.ts` with `workflows/` and `effects/` beside them.
- `examples/` is a workspace: `counter`, `chat`, `coding-agent`, ported from `research/v4/example`; they are the end-to-end corpus.
- The CLI is `apps/cli` (`@akter/cli`), bin name `durable`.
- Control-plane actors (`packages/deployments`) run embedded in `apps/api`; there is no `apps/worker` and no `apps/runner`.
- Disposable test databases live in `tooling/databases`; the tree checker and exemptions in `tooling/structure`.
- Renames: `auth → accounts`, `database → postgres`, `server → api`, `@project/* → @akter/*`, root package `@akter/monorepo` (the unscoped name belongs to the framework). Docker images are `infra/docker/<app>/Dockerfile`.
- `packages/ui` stays as an exemption until the console build runs the StyleX transform; template `test/` directories are exempt until each package is rewritten on the framework.

## Alternatives

- Keep thirteen packages and publish them under `@akter/*`: rejected by decision 151 (four entries express the boundary; thirteen do not).
- `ActorRuntime.layer`: rejected for `Actors.layer`, which names the tag every `X.get` already requires.
- PascalCase `Chat.ts` / `Chat.server.ts` as in the research corpus: rejected for role folders so one actor's contract, server layer and queries sit together and the file rules stay uniform.
- A separate `apps/worker` for control-plane actors: rejected until load shows the API process cannot host them.

## Consequences

- `docs/architecture/package-boundaries.md` is replaced by `repository-structure.md`; AGENTS.md lists `examples/`.
- `bun.lock` changes: nine workspace packages removed, seven added.
- The lint rules and tree checker named in `repository-structure.md` do not exist yet; the document is their specification.
- Research documents keep the `Actor.layer` spelling as history; DECISIONS.md rows 173–180 record the change.

## Evidence

`bun run check` passes on the restructured tree (lint, format, typecheck, tests, builds). `rg "@project/"` finds only self-contained CI fixtures under `.github/test/`.

## Revisit when

- The console build compiles StyleX itself (then fold `packages/ui` into `apps/console/src/ui/`).
- `apps/api` cannot host the control-plane actors under load (then add a runner process).
- The framework leaves `private: true` (then settle publishing metadata and the `client/` TypeScript environment).
