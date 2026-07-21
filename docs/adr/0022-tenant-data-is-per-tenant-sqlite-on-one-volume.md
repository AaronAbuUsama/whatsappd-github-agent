# Tenant data is per-tenant SQLite on one volume

> **SUPERSEDED — 2026-07-19.** Retired by the owner's decision to drop multi-tenancy entirely
> (one instance, both companies inside it). It was also **factually unbuildable**: there is no Flue
> libsql durable adapter. `@flue/runtime/node` exports exactly one persistence factory,
> `sqlite(path?)` (`dist/node/index.d.mts:18`), and Flue discovers a single default-exported adapter
> from a source-root `db.ts` at **build** time, calling `connect()` once
> (`docs-guide-database.md:18,26`, `docs-api-data-persistence-api.md:52`). N adapters in one process
> is not constructible. See `docs/planning/GRILL-REPORT-2026-07-19.md` Q3 and
> `REBUILD-PLAN-2026-07-19.md` revision 3.

Each tenant's state lives in its own directory of SQLite/libsql files under the single service volume — the proven managed layout (`application.sqlite`, whatsappd session store, credential files) extended from one implicit tenant to `tenants/<slug>/`. whatsappd's pluggable `./stores/libsql` store keys each session to its tenant directory. Flue conversation durability uses the framework's documented libsql durable adapter so that restarts recover conversations and in-flight submissions instead of losing process-local memory state — the documented behavior of a Node deployment without a `db.ts` adapter. Backup is a volume snapshot; there is no per-tenant cloud database and no control-plane database. This supersedes ADR 0018's Turso-hosted tenant credential store along with the provisioner-era per-tenant Turso lifecycle.

The recorded migration path, deliberately not taken now, is one Postgres with row-level security when tenants who are not the operator arrive: RLS gives data isolation a schema-level guarantee, at the cost of rewriting the engine's `node:sqlite` persistence and operating a database server. At the current trust level — every tenant is the operator's own organization — filesystem-per-tenant isolation inside one service is sufficient and keeps every hot path local and synchronous.
