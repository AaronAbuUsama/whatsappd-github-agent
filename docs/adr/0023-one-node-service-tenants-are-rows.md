# One Node service; tenants are rows, not deployments

> **SUPERSEDED — 2026-07-19.** Retired by the owner's decision to drop multi-tenancy entirely:
> there are no tenant rows. One instance holds both of the operator's companies as different chats
> and different GitHub orgs. Its demolition of `apps/web` was **already** superseded by ADR 0024 —
> the web app stays and is the management surface. What survives from this ADR is the one-process
> shape and the demolition of the Dokploy provisioner, the control plane and the Turso lifecycle.
> See `REBUILD-PLAN-2026-07-19.md` revision 3.

The hosted product is a single Node process in one container on the operator's VM, holding every tenant: N whatsappd sessions in-process, the Flue agents, and per-tenant configuration read from tenant rows. Adding a tenant is an authenticated admin action that creates a row and a tenant directory, followed by a WhatsApp QR pairing served by a small authenticated admin route — pairing UX survives the web app's removal because a QR must still reach a phone camera. Flue's Node durability contract (one live process owns a given agent instance) is satisfied by construction. This supersedes ADR 0019's dual setup/operate runtime entries and retires the fenced Dokploy provisioner, the Swarm-service-per-tenant model, the control plane, self-serve signup, and billing: `apps/web`, the provisioner and its providers, and the tenant-lifecycle machinery are demolished rather than maintained.

The isolation argument that justified per-tenant containers is re-homed, not dropped: the dangerous operation was always model-directed shell execution, which is isolated per job in hosted sandboxes (ADR 0021), and data separation lives in the per-tenant store layout (ADR 0022). Self-serve signup returns later as a thin surface over a proven runtime, built when someone who is not the operator needs it — the tenancy seam to preserve until then is that everything tenant-specific hangs off the tenant row and its directory.
