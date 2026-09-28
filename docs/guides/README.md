# Overview

**Responsibility:** the home page of the docs site: what the site covers and where the rest of the documentation lives.  
**Authority:** operational.  
**Owner role:** documentation.  
**Change policy:** change with `apps/docs/src/pages.ts` when a page is added to or removed from the site.

Durable Actors is an Effect-native actor framework on Postgres. You declare an actor with `Actor.make`, and each command it receives runs as one turn inside one database transaction: the actor's state, its owned Drizzle rows, its events, the command's receipt, and the work it hands off all commit together or not at all.

The framework is alpha and not yet on npm. The [quickstart](../quickstart.md) runs it from a checkout. What has shipped is listed in each API page's implemented subset; everything else on those pages is accepted design.

## On this site

- [Quickstart](../quickstart.md): create an app, run it, and test it.
- [API reference](../api/README.md): the server API, the context services, the TypeScript SDK, Drizzle, generated clients, naming, and versioning.

Every page has a Markdown copy: replace `.html` with `.md` in its address, or follow **View as Markdown** at the bottom of the page. [`llms.txt`](https://llmstxt.org) at the site root lists every Markdown copy.

## In the repository

The runtime guarantees and the reasons behind them are not published here. They stay in the repository, next to the code and tests that hold them to account:

- [Runtime contracts](../contracts/README.md): what a turn, a receipt, an intent, or a connection guarantees.
- [Architecture decisions](../decisions/README.md): why each choice was made, and what was rejected.
- [Verification](../verification/README.md): the evidence required before a guarantee is claimed.
- [Support matrix](../operations/support-matrix.md): which backends and deployment modes are supported today.
