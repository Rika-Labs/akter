# Data classification

**Responsibility:** control sensitive information across surfaces.  
**Authority:** security/operations.  
**Owner role:** security.

Credentials, provider tokens, signed URLs, resume tokens, private payloads, and authorization decisions must not appear in ordinary logs, traces, client bundles, or public dashboards. Receipts and events require per-field classification before being exposed to clients or operators.

Redaction must be tested, not assumed from a logger configuration.
