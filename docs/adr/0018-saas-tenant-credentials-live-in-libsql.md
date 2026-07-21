# SaaS tenant credentials live in isolated libSQL databases

When both `TENANT_DB_URL` and `TENANT_DB_TOKEN` are configured, Ambient Agent stores WhatsApp/Baileys auth state and the complete ChatGPT OAuth record only in that tenant's libSQL database. A partial contract fails closed. The runtime never reads or writes the corresponding local credential files in tenant mode, so an unavailable or malformed tenant store cannot silently fall back to machine-local secrets.

Each tenant receives an isolated database and scoped token from the SaaS provisioner. Provisioning, lease ownership, and final environment injection remain owned by issue #169; the storage adapters consume that contract but do not duplicate it. WhatsApp auth-state batches commit atomically. ChatGPT credential modification holds a database write transaction across read, refresh, and replacement so concurrent runtime processes cannot independently rotate the same refresh token.

Without the tenant database environment, the self-hosted CLI keeps the managed-file behavior in ADR 0011 and ADR 0013. `application.sqlite` and `flue.sqlite` remain local managed runtime files under ADR 0009 and ADR 0015 in both modes. This decision supersedes ADR 0011 and ADR 0013 only for SaaS tenant WhatsApp and ChatGPT credential storage.
