# Data classification

A store contains end-user data: actor state and lists, command payloads and outcomes, pending jobs and sends, retained history, and operator audit metadata. It is not merely a cache. Akter Cloud's environment bucket therefore holds customer data, not just snapshots of a customer-owned database.

Treat backups and exports at the highest classification of their contents. Restrict bucket credentials to one store, encrypt backups, and limit operator scope. A historical checkpoint can retain personal data after current-state deletion until retention and GC grace periods expire.

Logs, spans, and metrics must not disclose credentials or payloads. Metrics carry no tenant, actor id, or command id labels. Audit records identify the operator and target but exclude payload values and secrets. Test redaction with representative failures instead of trusting logger configuration.
