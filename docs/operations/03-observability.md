# Observability

**Responsibility:** make behavior explainable in production.  
**Authority:** operational.  
**Owner role:** operations/reliability.

Every command, generation, receipt, message, event, execution, transfer, connection, and external operation receives a correlation identity. Metrics must bound high-cardinality actor labels.

Operators need command latency, queue age, fence failures, transaction retries, worker recovery, unknown effects, live-query lag, gateway memory, database saturation, blob orphans, and restore status.
