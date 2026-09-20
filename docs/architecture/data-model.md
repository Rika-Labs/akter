# Durable data model

**Responsibility:** define the durable records required by the runtime.  
**Authority:** design.  
**Owner role:** database/runtime.

Framework-private records include:

| Record         | Purpose                         | Authority         |
| -------------- | ------------------------------- | ----------------- |
| Actor          | identity, address, tenant, type | routing           |
| Generation     | current fenced writer           | runtime           |
| Receipt        | command identity and result     | retry safety      |
| Inbox          | durable message admission       | delivery          |
| Event          | committed publication           | replay            |
| Timer          | future command intent           | scheduling        |
| Execution      | activity/job/workflow attempt   | work recovery     |
| Transfer       | ownership phase and manifest    | authority change  |
| Cursor         | subscription continuity         | realtime          |
| Blob reference | verified object identity        | application state |

Application tables remain ordinary relational tables. Generated ownership columns, indexes, and tenant keys must be specified per supported schema shape. Runtime tables are protected from ordinary application mutation and have explicit retention and restore dependencies.

Every record needs a unique identity, lifecycle, retry behavior, deletion policy, and crash-point analysis before implementation.
