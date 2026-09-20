# API and protocol versioning

**Responsibility:** preserve compatibility across rolling deployments.  
**Authority:** normative API design.  
**Owner role:** API/reliability.

Version command inputs, outputs, events, protocol frames, workflow journals, persisted payloads, and SDK contracts independently where necessary. Add fields compatibly before removing them. Old workers must be able to finish accepted work while new workers deploy.

Workflow replay and event replay require explicit schema compatibility or migration. A TypeScript type change without runtime decoding and stored-payload review is not a safe version change.
