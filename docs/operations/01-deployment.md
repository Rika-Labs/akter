# Deployment

**Responsibility:** define supported operating shapes.  
**Authority:** operational.  
**Owner role:** operations/platform.

The same runtime contracts must work locally, on self-hosted Postgres, in the managed cloud, and in managed private deployments. Customers must not require our control plane for the self-hosted path.

Deployment documentation must include process roles, connection pools, secrets, health checks, graceful shutdown, scaling limits, network boundaries, blob configuration, and upgrade order.
