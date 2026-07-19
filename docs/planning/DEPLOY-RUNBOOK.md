# Hosted deploy runbook — first two tenants

Written 2026-07-19 on `integration/unify-tracks` (PR #239). Target: the existing Dokploy VPS
(`ssh capxul-vps`, Swarm active, 1 manager node `srv1626161`, overlay network
`dokploy-network`, ~21G disk free — watch this, the box is at 79%).

## Already done on the VPS

- Repo cloned at `~/ambient-agent`, tracking `integration/unify-tracks` (GitHub SSH auth
  as `capxul-agent` works).
- Tenant runtime image built locally as `ambient-agent-runtime:latest` +
  `ambient-agent-runtime:unify-<sha>` from `apps/runtime/Dockerfile`. Single-node swarm
  runs a node-local image; no registry needed until there is a second node.

## Deploy order

1. **Control-plane database** (Turso or plain libSQL): run `pnpm db:migrate` against
   `DATABASE_URL` — nothing runs migrations automatically (`apps/api/Dockerfile` doesn't).
2. **apps/api** on Dokploy from `apps/api/Dockerfile`. Must be attached to
   `dokploy-network` (C5): the provisioner reaches tenant runtimes at
   `http://{appName}:3000` by swarm service name.
3. **apps/web** on Dokploy from its Dockerfile, `CORS_ORIGIN`/`BETTER_AUTH_URL` pointing
   at the public domains Traefik serves.
4. Tenant provisioning then happens through the product (signup → onboarding), not by hand.

## Environment the API needs (all fail-closed at boot)

`DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`POLAR_ACCESS_TOKEN`, `POLAR_SUCCESS_URL`, `POLAR_WEBHOOK_SECRET`, `CORS_ORIGIN`.
Polar is hard-coded to sandbox (`packages/auth/src/lib/payments.ts`) with product id
`64122dbf-…` — fine for "nobody pays yet".

Provisioner block (all nine or none — if any is set the rest are required; if none is
set the provisioner silently never runs):
`TENANT_RUNTIME_IMAGE=ambient-agent-runtime:latest`, `TENANT_RUNTIME_PORT=3000` (must be
exactly 3000 — operate mode takes the port from config.json, which hard-codes 3000),
`DOKPLOY_BASE_URL`, `DOKPLOY_API_KEY`, `DOKPLOY_ENVIRONMENT_ID`, `DOKPLOY_SERVER_ID`,
`DOKPLOY_NETWORK_NAME=dokploy-network`, `TENANT_SECRET_ENCRYPTION_KEY` (32 random bytes
base64), `DOKPLOY_WORKER_HOSTNAME=srv1626161`.
Plus Turso platform: org, group, and platform token (per-tenant DB creation).
`GITHUB_APPS_JSON` is optional but without it every operate reconcile blocks with
`tenant_github_credentials_missing` — setup mode still works.

## Owner inputs required (cannot be derived from code)

1. **DOKPLOY_API_KEY / ENVIRONMENT_ID / SERVER_ID** — from the Dokploy UI. C4: dokploy's
   own `serverId` for the local host is conventionally null/empty in its DB; verify what
   `/api/server.all` returns for this instance and use that id. If the API rejects an
   empty string, this instance's real server row id is the answer.
2. **Turso** org slug, group, platform token — or the decision to run per-tenant DBs some
   other way.
3. **GitHub Apps**: which of the three Apps (speaker/coder/reviewer roles) are live, and
   where their webhooks currently point. Webhooks must point at the API's public
   `/github/…` delivery route per app.
4. **Polar** sandbox access token + webhook secret (existing test setup), success URL.
5. **Domains**: which hostnames Traefik should serve for web and api.
6. Secrets land in Infisical or vaultwarden (both already run on this VPS) and get wired
   into Dokploy env — never committed.

## Known gaps accepted for tonight

- **Hosted Reviewer cannot run (B3)**: the control plane never writes
  `runtime.reviewerSandbox` and hard-codes `reviewRepositories: []`
  (`packages/installation/src/schema.ts:144`); deeper still, the reviewer sandbox shells
  out to `docker run`, which a tenant container cannot do without a socket mount.
  Issue filing and the Coder pipeline work; PR review needs a design decision
  (host-level reviewer service vs. socket-mounted sandbox vs. sandboxless first cut).
- **Recovery lever**: a tenant blocked by the provisioner requires
  `acknowledgeQuiescence`, which no HTTP route exposes yet; recovery is a manual DB/API
  poke. The probe patience fix (C3) makes this much rarer.
- Disk headroom on the VPS is thin (21G); the build cache + image cost ~5-6G. Prune or
  move hosts before adding tenants beyond the first two.
