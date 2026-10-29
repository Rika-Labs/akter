# Authorization model

`auth` authenticates a request before `/rpc` handling; `access(caller, request)` authorizes the actor operation. Callers are `User`, `Anonymous`, or `System`, discriminated by `_tag`. The default actor access admits `User` and `System`, not anonymous requests.

WebSocket sessions bind caller identity at open and recheck authentication and actor access. Forwarded caller identity is authenticated peer metadata, never a frame-supplied override. Hosted assertions bind the request and session; credentials cannot cross environment stores.

Internal commands never appear on the public client handle or `/rpc`. They are reachable by engine-originated sends, schedules, cron, job `self`, and `onFailure`. A `System` subject names the origin and may retain the original principal as `onBehalfOf`; it is not an operator credential.

Operators resolve to separate scoped grants through `OperatorAuth.tokens(...)` and the separate `POST /operator` endpoint. `inspect`, stored outcomes, log contents, snapshots, fork, replay, delete, export, and audit reads are distinct capabilities. Reads audit before answering; mutations audit in the same durable segment. Scope denial is audited and missing audit storage fails closed. The CLI defaults to loopback `http://127.0.0.1:8080`, tenant `default`, and `AKTER_OPERATOR_TOKEN`.

The current server rejects tenants other than `default`. General tenant-scoped actor addresses and hosted isolation need dedicated evidence; object-key prefixes and TypeScript types alone do not authorize access.
