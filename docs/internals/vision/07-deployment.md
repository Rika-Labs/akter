# Deployment

The framework runs on Bun or Node with one durable bucket per environment. Self-hosting composes `Akter.serve`, `App.make`, and `Store.s3`; local development uses `Store.fileSystem`. There is no second database dependency in the framework.

A release drains to durable checkpoints and `Released` segments before a new build opens. An unclean tail requires its matching build or explicit audited current-build replay. The host manages readiness, build retention, credentials, and wake-up of stopped stores.

Akter Cloud is private hosted infrastructure consuming the same published framework. Each environment owns a store bucket and credentials. Preview and production storage are isolated. Provider validation, pricing, quotas, and hosted lifecycle evidence are separate release gates.
