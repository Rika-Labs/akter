# Infrastructure

Railway application roles and external Alchemy-managed resources have explicit ownership. Nothing is applied by this skeleton. `preview` fails closed until a real provider/version-specific stack is written and reviewed.

Choose a disposable environment, verify Alchemy's exact API and provider support, then implement the resource inventory in docs/INFRASTRUCTURE.md. Keep state/credentials out of Git. Do not execute paid provisioning during install or ordinary development.
