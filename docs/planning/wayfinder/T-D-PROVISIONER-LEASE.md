# T-D: Provisioner and single-owner lease

**Status:** recommendation ready for Aaron's ratification

**Scope:** map [#165](https://github.com/AaronAbuUsama/ambient-agent/issues/165), grilling ticket [#169](https://github.com/AaronAbuUsama/ambient-agent/issues/169)

**Decision requested:** ratify Option A below; do not build Options B or C.

## Recommendation

Use one control-plane SQLite/libsql lease row per tenant credentials store, one
unique stable Dokploy application per credentials store, and a monotonically
increasing fencing token. A provisioner invocation owns the lease; the tenant
container does not. Lease expiry permits a new reconcile but does not stop a
healthy container. Every reconcile targets the same Dokploy `applicationId`,
whose Swarm service is pinned to one replica. Dokploy auto-deploy is disabled,
and both Swarm update and rollback order are explicitly `stop-first`, so no
platform-triggered replacement can overlap the old task. Because Dokploy cannot
enforce the control-DB fence on a request already in flight, an uncertain remote
config write enters a durable fail-closed state; no successor may configure,
deploy, or start until an operator proves Dokploy is quiescent.

This is the first Ponytail rung that holds: the control DB already exists,
SQLite already supplies atomic compare-and-swap, and Dokploy already supplies a
unique generated application name plus a single-replica service. The control DB
fences which generated application ID may receive secrets and start. No queue,
coordinator, leader-election service, or new dependency is required.

The safety property is **at most one** live container using a credentials store
at every instant. When `desired_state = 'running'`, reconciliation adds the
liveness property: eventually exactly one is live. Literal “exactly one at
every instant” is neither possible nor desirable during stop, deploy, or crash
recovery; the credential-wiping failure is the at-most-one violation.

## The problem in the imported code

The SaaS import gives T-D the right seams, but no tenant or lifecycle model yet:

```ts
// packages/api/src/routers/index.ts:5-15
export const appRouter = {
  healthCheck: publicProcedure.handler(() => "OK"),
  privateData: protectedProcedure.handler(({ context }) => ({
    message: "This is private",
    user: context.session?.user,
  })),
};
```

```ts
// packages/db/src/index.ts:7-14
export function createDb() {
  const client = createClient({
    url: env.DATABASE_URL,
    authToken: env.DATABASE_AUTH_TOKEN,
  });
  return drizzle({ client, schema });
}
```

This factory also exposes a production integrity gap for T-D: Turso documents
foreign-key enforcement as off by default, while this code neither executes
nor verifies `PRAGMA foreign_keys = ON`. The module-level `db = createDb()` and
`createAuth()` at `packages/auth/src/index.ts:10-12` open separate clients, so
enabling it on only one client would still leave another unchecked. The API
must fail startup until every control-DB client used by auth or provisioning has
enabled and read back the pragma.

```ts
// packages/db/src/schema/index.ts:1-2
export * from "./auth";
export {};
```

The API composes the router once at `apps/api/src/index.ts:29-68`, and the
request context authenticates through Better Auth at
`packages/api/src/context.ts:8-16`. Polar checkout/portal are already mounted in
`packages/auth/src/index.ts:32-50`, but the `webhooks()` plugin and
subscription lifecycle callbacks are not. The current DB has only Better Auth
tables (`packages/db/src/schema/auth.ts:4-105`).

The ratified invariant is in `docs/planning/SAAS-MVP-PLAN.md:76-80`; the
provisioner/schema seam is at `:156-161`. T-B fixes the physical topology:

- the lease, tenant, and agent state live in the one control-plane Turso DB;
- each tenant gets one Turso DB for WhatsApp and model credentials;
- `application.sqlite` and `flue.sqlite` remain local to the tenant runtime.

### What this touches

```diff
 packages/db/src/index.ts
-export function createDb()
-export const db = createDb()
+export async function openControlDb() // enable + assert foreign_keys

 packages/db/src/schema/index.ts
+export * from "./provisioning";

+packages/db/src/schema/provisioning.ts
+tenant + agent_instance + provisioner_lease

 packages/api/src/routers/index.ts
+provision: protectedProcedure.input(...).handler(reconcileTenant)

+packages/api/src/provisioning/reconcile.ts
+one idempotent reconcile function used by oRPC and Polar

 packages/auth/src/index.ts
-export function createAuth() { const db = createDb(); ... }
+export function createAuth(db: ControlDb) { ... }
-import { polar, checkout, portal } from "@polar-sh/better-auth";
+import { polar, checkout, portal, webhooks } from "@polar-sh/better-auth";
+polar({ client: polarClient, use: [checkout(...), portal(),
+  webhooks({ secret: env.POLAR_WEBHOOK_SECRET,
+    onSubscriptionCreated: syncSubscription,
+    onSubscriptionUpdated: syncSubscription,
+    onSubscriptionActive: syncSubscription,
+    onSubscriptionCanceled: syncSubscription,
+    onSubscriptionRevoked: syncSubscription,
+    onSubscriptionUncanceled: syncSubscription })] })

 apps/api/src/index.ts
+const db = await openControlDb();
+const auth = createAuth(db); // serve only after the integrity assertion

 packages/env/src/server.ts
+POLAR_WEBHOOK_SECRET, DOKPLOY_API_URL, DOKPLOY_API_KEY,
+DOKPLOY_ENVIRONMENT_ID, DOKPLOY_SERVER_ID, TURSO_ORG, TURSO_PLATFORM_TOKEN,
+TENANT_SECRET_ENCRYPTION_KEY
```

Both entry points call the same service function in-process. The verified Polar
endpoint remains `/api/auth/polar/webhooks`; the webhook does **not** make a
loopback HTTP call to oRPC. The user oRPC mutation requests/retries the same
reconcile and is scoped by `context.session.user.id`.

The blast radius is the control API and control DB only. `apps/runtime` receives
the already-ratified boot inputs (`TENANT_DB_URL`, `TENANT_DB_TOKEN`, and
`config.json`/equivalent Dokploy file mount) but does not implement lease logic.

## Concrete options

### Option A — control-DB lease + stable Dokploy application (recommended)

```ts
const provision = protectedProcedure
  .input(z.object({ tenantId: z.string().min(1) }))
  .handler(({ input, context }) => requestTenantReconcile(input.tenantId, context.session.user.id));

const syncSubscription = ({ data }: SubscriptionPayload) =>
  upsertSubscriptionIntentAndReconcile({
    polarSubscriptionId: data.id,
    userId: data.customer.externalId,
    entitled: data.status === "active" || data.status === "trialing",
  });

const subscriptionWebhooks = webhooks({
  secret: env.POLAR_WEBHOOK_SECRET,
  onSubscriptionCreated: syncSubscription,
  onSubscriptionUpdated: syncSubscription,
  onSubscriptionActive: syncSubscription,
  onSubscriptionCanceled: syncSubscription,
  onSubscriptionRevoked: syncSubscription,
  onSubscriptionUncanceled: syncSubscription,
});

polar({
  client: polarClient,
  createCustomerOnSignUp: true,
  use: [checkout({ ...checkoutConfig }), portal(), subscriptionWebhooks],
});
```

```ts
const ownerId = crypto.randomUUID(); // unique per reconcile invocation
const lease = await acquireLease(credsStoreKey, ownerId, 30_000);
if (!lease) return { status: "lease_busy" };
try {
  return await reconcileTenant(tenantId, lease);
} finally {
  await releaseLease(lease); // CAS; harmless after takeover
}
```

Before remote creation, the control DB persists a deterministic display name
and a random `dokploy_creation_token`. Create passes both as `name` and a scoped
`description` marker. Dokploy appends a random suffix to the requested
`appName`, so retries may produce more than one remote **shell**. A fenced CAS
binds exactly one returned `applicationId`; only that bound ID may receive the
tenant token/config or be deployed/started. Visible losing shells are
stopped/deleted before configuration, and a late shell is credentialless and
undeployed, so it cannot join the WhatsApp session.

After binding, that `applicationId` is stable for the tenant lifetime. Its Swarm
service is pinned to the configured MVP worker as well as `replicas=1`; loss of
that worker therefore gives zero replicas, never a replacement running beside a
partitioned old task. The application uses the Docker provider with
`autoDeploy=false`; no Git provider webhook or preview deployment is installed.
Both `updateConfigSwarm` and `rollbackConfigSwarm` set `Parallelism: 1` and
`Order: "stop-first"`. Those settings defend the invariant even if an operator
manually deploys from Dokploy instead of the provisioner.

### Option B — keep a DB transaction open across Turso and Dokploy calls

```ts
await db.transaction(async (tx) => {
  const tenant = await tx.select(...);
  await turso.createDatabase(...);      // network call inside DB transaction
  await dokploy.start(...);             // another network call
  await tx.update(agentInstance).set(...);
});
```

Rejected. SQLite write locks would be held across slow, failure-prone network
calls, and rollback cannot undo either remote effect. It has worse recovery and
still provides no external fencing.

### Option C — create a new Dokploy application for every ownership epoch

```ts
const application = await dokploy.create({
  name: tenant.id,
  appName: `ambient-${tenant.id}-${lease.fencingToken}`,
});
await dokploy.start({ applicationId: application.applicationId });
```

Rejected. The fencing token deliberately produces multiple valid remote apps.
A delayed old app can overlap the new app against the same credentials store —
the exact `440 connection_replaced` failure this design must make impossible.

### Six-factor rubric

Scores are 1 (poor) to 5 (strong). “Blast radius” scores higher when smaller.

| Option                   | Floor-first | Reversible | Blast radius | Correctness / integrity | Parallelizable | Existing fit |  Total |
| ------------------------ | ----------: | ---------: | -----------: | ----------------------: | -------------: | -----------: | -----: |
| A. DB lease + stable app |           5 |          5 |            5 |                       5 |              4 |            5 | **29** |
| B. Long DB transaction   |           2 |          3 |            2 |                       2 |              1 |            2 |     12 |
| C. App per fence         |           3 |          2 |            1 |                       1 |              4 |            2 |     13 |

Option A ships the real safety floor now, is removable without changing tenant
data, confines coordination to three control tables, and matches the imported
libsql/oRPC seams. Different tenants reconcile in parallel; only invocations for
the same credentials store serialize.

## Authoritative control schema

The runnable SQL form is in
`packages/db/prototypes/provisioning-lease.ts`. The eventual Drizzle migration
must preserve these constraints exactly:

```sql
CREATE TABLE tenant (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  polar_subscription_id TEXT NOT NULL UNIQUE,
  tenant_db_name TEXT NOT NULL UNIQUE,
  tenant_db_url TEXT UNIQUE,
  tenant_db_token_ciphertext TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  desired_state TEXT NOT NULL DEFAULT 'stopped'
    CHECK (desired_state IN ('stopped', 'running', 'deleted'))
);

CREATE TABLE agent_instance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenant(id) ON DELETE CASCADE,
  creds_store_key TEXT NOT NULL UNIQUE
    REFERENCES tenant(tenant_db_name) ON DELETE CASCADE,
  dokploy_display_name TEXT NOT NULL UNIQUE,
  dokploy_creation_token TEXT NOT NULL UNIQUE,
  dokploy_application_id TEXT UNIQUE,
  dokploy_app_name TEXT UNIQUE,
  applied_config_version INTEGER NOT NULL DEFAULT 0,
  remote_config_operation_id TEXT UNIQUE,
  remote_config_owner_id TEXT,
  remote_config_fencing_token INTEGER,
  remote_config_target_version INTEGER,
  remote_config_state TEXT NOT NULL DEFAULT 'idle' CHECK (
    remote_config_state IN ('idle', 'pending', 'confirmed', 'blocked_unknown')
  ),
  phase TEXT NOT NULL DEFAULT 'pending_input' CHECK (phase IN (
    'pending_input', 'provisioning', 'starting', 'running', 'stopping',
    'stopped', 'retryable_error', 'blocked_invariant'
  )),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (remote_config_state = 'idle'
      AND remote_config_operation_id IS NULL
      AND remote_config_owner_id IS NULL
      AND remote_config_fencing_token IS NULL
      AND remote_config_target_version IS NULL) OR
    (remote_config_state != 'idle'
      AND remote_config_operation_id IS NOT NULL
      AND remote_config_owner_id IS NOT NULL
      AND remote_config_fencing_token IS NOT NULL
      AND remote_config_fencing_token > 0
      AND remote_config_target_version IS NOT NULL
      AND remote_config_target_version > 0)
  )
);

CREATE TABLE provisioner_lease (
  creds_store_key TEXT PRIMARY KEY
    REFERENCES agent_instance(creds_store_key) ON DELETE CASCADE,
  owner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  expires_at_ms INTEGER,
  acquired_at_ms INTEGER,
  renewed_at_ms INTEGER,
  CHECK (
    (owner_id IS NULL AND expires_at_ms IS NULL) OR
    (owner_id IS NOT NULL AND expires_at_ms IS NOT NULL)
  )
);
```

### Foreign-key startup gate

The `REFERENCES` and `ON DELETE CASCADE` clauses are active only after the
setting is enabled on a connection. This is not a migration-only pragma. Replace
the two current implicit clients with one initialized control-DB dependency and
inject it into auth, API context, and reconciliation:

```ts
export async function openControlDb() {
  const client = createClient({
    url: env.DATABASE_URL,
    authToken: env.DATABASE_AUTH_TOKEN,
  });

  await client.execute("PRAGMA foreign_keys = ON");
  const result = await client.execute("PRAGMA foreign_keys");
  if (Number(result.rows[0]?.foreign_keys) !== 1) {
    client.close();
    throw new Error("control_db_foreign_keys_disabled");
  }

  return { client, db: drizzle({ client, schema }) };
}
```

`apps/api/src/index.ts` awaits `openControlDb()`, passes the same initialized DB
to `createAuth(db)`, router context, and reconcile dependencies, and calls
`serve()` only after the assertion succeeds. Migration and one-off maintenance
clients have the same initializer. The production acceptance check must run an
orphan-insert rejection and a three-level `user -> tenant -> agent_instance ->
provisioner_lease` cascade against the actual control Turso URL; a driver mode
that cannot preserve the pragma for its connection is unsupported and blocks
startup. Destructive tenant deletion also observes zero child rows before
remote resource deletion, so a failed cascade cannot silently orphan control
state.

`tenant_db_url` and `tenant_db_token_ciphertext` are nullable while an active
subscription waits in `pending_input` or before the per-tenant DB is created;
SQLite still enforces uniqueness for every non-null URL. The token is
envelope-encrypted before persistence with an AES-256-GCM key supplied outside
the repository. The tenant runtime receives only its own scoped token. Logs,
errors, and `config_json` must never contain the raw token or model credential.

These uniqueness constraints are the safety spine:

1. `tenant.tenant_db_name UNIQUE` — one physical credential-store identity.
2. `agent_instance.tenant_id UNIQUE` — one agent instance per MVP tenant.
3. `agent_instance.creds_store_key UNIQUE` — a credential store cannot be bound
   to a second agent row.
4. `dokploy_creation_token UNIQUE` — retry shells are scoped to one persisted
   creation attempt marker.
5. `dokploy_application_id UNIQUE` — exactly one remote shell wins the fenced
   bind and becomes the stable service identity.
6. `dokploy_app_name UNIQUE` — Dokploy's generated service name cannot be bound
   to another agent row.
7. `remote_config_operation_id UNIQUE` — one durable identity for the only
   remote config write that may be pending for an agent.
8. `provisioner_lease.creds_store_key PRIMARY KEY` — one ownership cell.

## Lease protocol

All time comparisons use Turso/SQLite time, not provisioner host time. TTL is 30
seconds, renewal is every 10 seconds and immediately before a remote mutation,
and every remote request has an 8-second client timeout. A timed-out create or
bare lifecycle start/stop against already-confirmed config is treated as
“outcome unknown” and resolved by observing the same stable service, never by
blindly creating a second resource. A config/image/token write—and its associated
deploy/start before confirmation—is different: a late server-side commit could
overwrite a successor, so uncertainty enters the durable blocked protocol below
instead of automatic retry.

### Acquire

```sql
INSERT INTO provisioner_lease (
  creds_store_key, owner_id, fencing_token,
  expires_at_ms, acquired_at_ms, renewed_at_ms
) VALUES (
  ?1, ?2, 1,
  cast(unixepoch('subsecond') * 1000 as integer) + ?3,
  cast(unixepoch('subsecond') * 1000 as integer),
  cast(unixepoch('subsecond') * 1000 as integer)
)
ON CONFLICT (creds_store_key) DO UPDATE SET
  owner_id = excluded.owner_id,
  fencing_token = CASE
    WHEN provisioner_lease.owner_id = excluded.owner_id
      AND provisioner_lease.expires_at_ms > excluded.renewed_at_ms
      THEN provisioner_lease.fencing_token
    ELSE provisioner_lease.fencing_token + 1
  END,
  expires_at_ms = excluded.expires_at_ms,
  acquired_at_ms = CASE
    WHEN provisioner_lease.owner_id = excluded.owner_id
      AND provisioner_lease.expires_at_ms > excluded.renewed_at_ms
      THEN provisioner_lease.acquired_at_ms
    ELSE excluded.acquired_at_ms
  END,
  renewed_at_ms = excluded.renewed_at_ms
WHERE provisioner_lease.owner_id IS NULL
   OR provisioner_lease.owner_id = excluded.owner_id
   OR provisioner_lease.expires_at_ms <= excluded.renewed_at_ms
RETURNING owner_id, fencing_token, expires_at_ms;
```

No returned row means `lease_busy`. `owner_id` is a fresh UUID per reconcile
invocation, so two concurrent callbacks in one API process still serialize.
Re-entry by the same invocation keeps its token; takeover increments it.

### Renew

```sql
UPDATE provisioner_lease
SET expires_at_ms = cast(unixepoch('subsecond') * 1000 as integer) + ?4,
    renewed_at_ms = cast(unixepoch('subsecond') * 1000 as integer)
WHERE creds_store_key = ?1
  AND owner_id = ?2
  AND fencing_token = ?3
  AND expires_at_ms > cast(unixepoch('subsecond') * 1000 as integer)
RETURNING owner_id, fencing_token, expires_at_ms;
```

No returned row means `lease_lost`: stop issuing side effects immediately.

### Release

```sql
UPDATE provisioner_lease
SET owner_id = NULL,
    expires_at_ms = NULL,
    renewed_at_ms = cast(unixepoch('subsecond') * 1000 as integer)
WHERE creds_store_key = ?1
  AND owner_id = ?2
  AND fencing_token = ?3
RETURNING fencing_token;
```

The row is retained so the fencing token never resets. A late release cannot
clear a successor's lease because both owner and token must match.

### Fenced state write

Every control-state update uses the same owner/token predicate plus
`expires_at_ms > db_now`. A stale owner therefore cannot report `running`, bind
an `applicationId`, or advance `applied_config_version`. Dokploy does not accept
our fence token; safety at that boundary comes from always addressing the one
stable application whose service is fixed at one replica.

### Application bind CAS

Remote creation never carries tenant credentials. After a create response or a
marked-shell lookup, the current owner must win this bind before it may configure
or start the application:

```sql
UPDATE agent_instance
SET dokploy_application_id = ?4,
    dokploy_app_name = ?5,
    updated_at_ms = cast(unixepoch('subsecond') * 1000 as integer)
WHERE creds_store_key = ?1
  AND (
    dokploy_application_id IS NULL OR
    (dokploy_application_id = ?4 AND dokploy_app_name = ?5)
  )
  AND EXISTS (
    SELECT 1
    FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND provisioner_lease.owner_id = ?2
      AND provisioner_lease.fencing_token = ?3
      AND provisioner_lease.expires_at_ms >
        cast(unixepoch('subsecond') * 1000 as integer)
  )
RETURNING dokploy_application_id;
```

No row means the invocation lost the lease or another shell is already bound.
It must not write env/file mounts, deploy, or start its candidate. Repeating the
bind for the same ID is idempotent.

### Remote configuration pending fence

Dokploy does not accept `fencing_token`, so a request sent before lease expiry
can commit after a new owner acquires. Observation alone cannot distinguish a
request that will never commit from one that will commit late. Option A therefore
records a unique operation before the first remote config mutation. Every token,
image, mount, or runtime-config change increments `tenant.config_version`; no
new operation may begin while one is `pending` or `blocked_unknown`.

```sql
UPDATE agent_instance
SET remote_config_operation_id = ?4,
    remote_config_owner_id = ?2,
    remote_config_fencing_token = ?3,
    remote_config_target_version = ?5,
    remote_config_state = 'pending',
    updated_at_ms = cast(unixepoch('subsecond') * 1000 as integer)
WHERE creds_store_key = ?1
  AND remote_config_state IN ('idle', 'confirmed')
  AND ?5 > applied_config_version
  AND EXISTS (
    SELECT 1 FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND owner_id = ?2
      AND fencing_token = ?3
      AND expires_at_ms > cast(unixepoch('subsecond') * 1000 as integer)
  )
RETURNING remote_config_operation_id;
```

The operation stores the initiating `owner_id` and `fencing_token`. Those fields
are immutable until confirmation or operator acknowledgement. The confirmation
CAS requires both, so a successor can mark the old operation blocked but cannot
continue or confirm it even when the operation ID and desired version are known.

After every Dokploy config call returns successfully, the owner reads back the
complete desired manifest: image/build identity, env including tenant token and
`config_version`, mounts, placement, replica count, network, health check,
`autoDeploy`, and update/rollback policy. The operation remains `pending` while
that same owner/token performs any required deploy/start and observes the final
service manifest plus health (or the complete manifest at zero tasks for a
stopped tenant). Only that final exact observation lets it confirm the version:

```sql
UPDATE agent_instance
SET remote_config_state = 'confirmed',
    applied_config_version = remote_config_target_version,
    updated_at_ms = cast(unixepoch('subsecond') * 1000 as integer)
WHERE creds_store_key = ?1
  AND remote_config_operation_id = ?4
  AND remote_config_owner_id = ?2
  AND remote_config_fencing_token = ?3
  AND remote_config_state = 'pending'
  AND EXISTS (
    SELECT 1 FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND owner_id = ?2
      AND fencing_token = ?3
      AND expires_at_ms > cast(unixepoch('subsecond') * 1000 as integer)
  )
RETURNING applied_config_version;
```

If any config/deploy/start request times out, its connection drops, or the
process crashes before confirmation, the durable `pending` row survives lease
expiry. A successor may acquire only to request stop, observe the current task
count, and change that exact operation to `blocked_unknown`; it must not issue
another config, deploy, start, or credential rotation. Even an observed zero is
provisional until operator quiescence because an older start may still arrive:

```sql
UPDATE agent_instance
SET remote_config_state = 'blocked_unknown',
    phase = 'blocked_invariant',
    last_error_code = 'dokploy_config_outcome_unknown'
WHERE creds_store_key = ?1
  AND remote_config_operation_id = ?4
  AND remote_config_state = 'pending'
  AND EXISTS (
    SELECT 1 FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND owner_id = ?2
      AND fencing_token = ?3
      AND expires_at_ms > cast(unixepoch('subsecond') * 1000 as integer)
  )
RETURNING remote_config_state;
```

Clearing the block is deliberately operator-gated. The operator must use
Dokploy request/audit evidence or restart/drain Dokploy to prove the old request
cannot still commit, stop and verify the application at zero tasks again, and
restore the last confirmed manifest. Only then may the current lease owner
acknowledge the exact operation and begin a fresh higher-version write:

```sql
UPDATE agent_instance
SET remote_config_operation_id = NULL,
    remote_config_owner_id = NULL,
    remote_config_fencing_token = NULL,
    remote_config_target_version = NULL,
    remote_config_state = 'idle',
    phase = 'stopped',
    last_error_code = NULL
WHERE creds_store_key = ?1
  AND remote_config_operation_id = ?4
  AND remote_config_state = 'blocked_unknown'
  AND EXISTS (
    SELECT 1 FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND owner_id = ?2
      AND fencing_token = ?3
      AND expires_at_ms > cast(unixepoch('subsecond') * 1000 as integer)
  )
RETURNING remote_config_state;
```

This sacrifices availability only on a genuinely unknowable external write. It
adds no coordinator or queue and never claims the local fence can cancel a
remote request. The acknowledgement SQL is not reachable from the Polar webhook,
user oRPC mutation, startup sweep, or normal reconciler. A privileged operator
command requires an authenticated operator identity plus a non-empty Dokploy
quiescence evidence note. It executes the CAS first, emits a success audit
containing the operation ID, actor, time, and resolution only when `RETURNING`
succeeds, and records rejected attempts separately.

## Idempotent reconcile

Every Polar subscription callback first upserts subscription/tenant intent by
`polar_subscription_id`; duplicate `updated` plus granular webhook deliveries
therefore coalesce. Created, updated, active, canceled, revoked, and uncanceled
all call the same reducer and then the same reconcile service as the protected
oRPC mutation. Entitlement is derived from the payload's current status, not the
event name: both `active` and `trialing` are entitled. An end-of-period
cancellation remains entitled while Polar reports it active, then the later
revoked/updated payload flips `desired_state` to `stopped`. `past_due` arrives
through `onSubscriptionUpdated` and is likewise reduced from the current status.

For one acquired lease:

1. Re-read `tenant` + `agent_instance`. If subscription is neither `active` nor
   `trialing`, set `desired_state='stopped'`. If required config or captured
   model credential is absent, set `pending_input` and do not create/start
   anything.
2. Ensure the per-tenant Turso DB by deterministic name. “Already exists” is
   observation, not failure. Mint a scoped token if no decryptable token is
   recorded; write the encrypted token and URL using a fenced DB update. The
   runtime writes WhatsApp auth state at pairing; the control plane seeds only
   the already-captured model credential.
3. Ensure the Dokploy application. If `dokploy_application_id` exists, verify
   it with `GET /api/application.one` and never replace it automatically. If it
   is null, query `GET /api/environment.one` and filter applications by the
   persisted display name **and** exact creation-token description. Dokploy
   randomizes the supplied `appName`, so one or more marked, credentialless
   shells may exist after timeouts. Select one deterministically, fetch its
   generated `appName` with `application.one`, and win the fenced bind above.
   If none exists, call `POST /api/application.create` with `name`, `appName`,
   `description`, `environmentId`, and `serverId`, then bind the response.
   Stop/delete visible losing marked shells before continuing; a cleanup failure
   blocks configuration/start but does not endanger credentials.
4. Configure the stopped application: Docker image/build settings, exactly one
   replica, a placement constraint for the configured MVP worker,
   `dokploy-network`, health check, tenant DB URL/token env, bridge secret, and
   `config.json` file mount. Set `autoDeploy=false`; do not create a Git provider
   webhook or preview deployment. Set both `updateConfigSwarm` and
   `rollbackConfigSwarm` to `{ Parallelism: 1, Order: "stop-first" }` and read
   them back before proceeding. Before the first remote write, win the
   `remote_config_operation_id` CAS above. `config_version` is included in the
   boot environment, and every credential/image/config change increments it.
   After all calls return, read back the complete prepared manifest but keep the
   operation `pending` through any deploy/start. A timeout, disconnect, crash, or
   non-matching read-back enters `blocked_unknown`; no automatic remote mutation
   or start follows. Multi-node failover remains disabled: availability loss is
   preferable to two network-partitioned tasks sharing WhatsApp credentials.
5. If this is the first deployment, deploy only after step 4. If a live app
   needs a config/image change, call `application.stop`, observe zero running
   tasks, apply config, then deploy/start only while the same lease and pending
   operation remain valid. Never use start-first rolling update or create a
   replacement app against the same credentials store. A successor is never
   allowed to continue another owner's pending operation.
6. Renew/assert the lease, then call
   `POST /api/application.start { applicationId }`. Repeating start targets the
   same single-replica Swarm service. Poll `application.one` plus `/health`, read
   back the final runtime manifest/version, then confirm the remote operation and
   record `running` with fenced updates. Confirmation records
   `applied_config_version`; losing the lease first leaves the operation pending
   for fail-closed takeover.
7. For desired stop/delete, renew, call `application.stop`, observe zero tasks,
   record `stopped`, then release. Deletion of the app or tenant DB is a
   separate destructive workflow and is not implied by subscription churn.

No startup sweep needs a new queue: API boot and every relevant read/mutation
can query `agent_instance` rows in `provisioning|starting|retryable_error` or
with desired/observed mismatch and call reconcile. A `pending` remote config
operation found after takeover is stopped and changed to `blocked_unknown`, not
retried. A simple periodic retry may be added only when the build proves
event-driven retries insufficient; it never clears this block.

## Crash and restart table

| Crash point                                                | Durable observation on retry                     | Recovery                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Before acquire                                             | No owned lease                                   | Another invocation acquires                                                               |
| After tenant DB create, before local write                 | Deterministic Turso DB exists                    | Get it by name, mint/store scoped token                                                   |
| After token mint, before local write                       | DB exists, token outcome unknown                 | Mint a replacement scoped token; store only the new encrypted token                       |
| After Dokploy create, before ID bind                       | One or more marked shells may exist              | Fenced CAS binds one; losers never receive credentials or start                           |
| After config intent, before exact confirmation             | Durable remote operation remains `pending`       | Request stop, mark blocked; operator quiesces and re-verifies zero                        |
| Config/deploy/start times out but commits late             | DB still names the uncertain operation/version   | Successor cannot supersede it; operator proves quiescence before explicit acknowledgement |
| After config confirmation, before `running` write          | Desired manifest/version was already observed    | Observe the same stable service, then fenced phase write                                  |
| Owner stalls past expiry                                   | Old fence cannot mutate control state            | New owner increments token and reconciles same app                                        |
| Stop outcome unknown                                       | Stable application may be at 0 or 1              | Observe and repeat stop; never create another app                                         |
| Unbound marked shells                                      | Credentialless and undeployed                    | Stop/delete visible losers; a delayed loser is swept later                                |
| Bound app missing or replicas > 1                          | Safety cannot be proven                          | Stop all known matches, mark `blocked_invariant`, require operator proof before pairing   |
| Dokploy auto-deploy enabled or update order not stop-first | An uncontrolled rolling update may overlap tasks | Stop app, repair and read back policy, remain `blocked_invariant` until proven            |
| Control DB reports `foreign_keys != 1`                     | Cascades and referential checks are inactive     | Fail API startup; do not accept auth, webhook, or reconcile traffic                       |

Lease expiry never deletes credentials, stops a healthy container, or creates a
new Dokploy application. It only transfers permission to reconcile.

## Failure states and API result

| State/result                             | Meaning                                                                         | Retry                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pending_input`                          | Active subscription lacks config/model credential                               | User action, no container start                                                            |
| `lease_busy`                             | Another invocation owns the unexpired row                                       | Return 202/current state; do not spin                                                      |
| `provisioning` / `starting` / `stopping` | Normal durable intermediate phase                                               | Reconcile is idempotent after crash                                                        |
| `retryable_error`                        | Turso/Dokploy timeout, 429, or 5xx; outcome observed first                      | Bounded backoff, same stable identities                                                    |
| `lease_lost`                             | Renew/fenced write returned no row                                              | Stop this invocation immediately                                                           |
| `blocked_invariant`                      | Bound-ID mismatch, >1 replica, unsafe deploy policy, or secret/config ambiguity | Fail closed; stop known apps; human inspection                                             |
| `dokploy_config_outcome_unknown`         | A pending config/deploy/start was not exactly confirmed before timeout/crash    | Block all progress; operator quiesces Dokploy, stops to zero, then explicitly acknowledges |
| `control_db_foreign_keys_disabled`       | Startup pragma assertion returned anything but `1`                              | Fatal startup error; fix connection initialization                                         |
| `running` / `stopped`                    | Desired state was observed and fenced into control DB                           | No retry unless intent/version changes                                                     |

Secrets are redacted from all failure payloads. A `409/CONFLICT` during Dokploy
creation triggers a marked-shell lookup; it is not treated as proof that a
particular retry created or owns the conflicting application.

## Runnable proof

The committed self-check exercises acquisition contention, renewal, expiry
takeover, monotonic fencing, stale-owner rejection, release CAS, fenced
application binding/state writes, nullable pre-provisioning fields, the unique
credentials-store binding, the foreign-key pragma assertion, and deletion
cascades. It also proves a successor cannot begin or confirm a newer remote
config while an earlier operation is pending/blocked, and that a stale owner
cannot acknowledge the operator gate:

```bash
pnpm install --frozen-lockfile
pnpm exec tsx packages/db/prototypes/provisioning-lease.ts
pnpm typecheck
pnpm lint
pnpm test
```

Expected focused output:

```text
provisioning lease self-check: ok
```

### Human-only Dokploy proof gate

On Aaron's logged-in Dokploy instance, first confirm the MVP is single-node or
that the tenant template has an immutable placement constraint to one worker.
Before the production build calls this done, create one throwaway
creation-token-marked application with the final tenant template and prove the
external assumptions:

```bash
curl -fsS -H "x-api-key: $DOKPLOY_API_KEY" \
  "$DOKPLOY_API_URL/api/application.one?applicationId=$DOKPLOY_TEST_APPLICATION_ID" \
  | jq '{autoDeploy, replicas, updateConfigSwarm, rollbackConfigSwarm, placementSwarm}'
# require false, 1, Order=stop-first, Order=stop-first, and the pinned worker

curl -fsS -H "x-api-key: $DOKPLOY_API_KEY" \
  "$DOKPLOY_API_URL/api/environment.one?environmentId=$DOKPLOY_ENVIRONMENT_ID" \
  | jq --arg name "$DOKPLOY_TEST_NAME" \
      '[.applications[] | select(.name == $name)] | {count:length, ids:map(.applicationId)}'

curl -fsS -X POST -H "x-api-key: $DOKPLOY_API_KEY" \
  -H 'content-type: application/json' \
  "$DOKPLOY_API_URL/api/application.start" \
  -d "{\"applicationId\":\"$DOKPLOY_TEST_APPLICATION_ID\"}"
# repeat the identical start call, then prove one running Swarm task

curl -fsS -X POST -H "x-api-key: $DOKPLOY_API_KEY" \
  -H 'content-type: application/json' \
  "$DOKPLOY_API_URL/api/application.stop" \
  -d "{\"applicationId\":\"$DOKPLOY_TEST_APPLICATION_ID\"}"
# repeat the identical stop call, then prove zero running Swarm tasks
```

Also kill the provisioner after remote create but before the local ID bind, then
show that exactly one candidate wins the bind, only the winner receives
`TENANT_DB_TOKEN`, and every losing shell has zero running tasks. Confirm that
`application.create` alone never deploys or starts a service. This is
instance/runtime proof, not another product decision. Separately, kill the
provisioner after sending a config update but before confirmation. Prove the
successor stops the app, preserves the pending operation ID, and refuses newer
config/deploy/start until an operator drains or restarts Dokploy, restores the
last confirmed manifest, and acknowledges that exact operation. Do not use a
real tenant token or WhatsApp pairing data for this fault injection.

## Ratification gate

Aaron: ratify **Option A**, specifically these three semantics:

1. the lease owns **reconciliation**, so lease expiry does not kill a healthy
   tenant container; and
2. the one **fenced-bound** Dokploy `applicationId` plus worker placement and
   `replicas=1`, `autoDeploy=false`, and stop-first update/rollback policy is the
   external at-most-one fence; unbound retry shells never receive credentials
   or start; and
3. because Dokploy cannot consume the DB fence, an uncertain config/image/token
   write blocks all automatic progress and requires explicit operator proof of
   remote quiescence plus a fresh zero-task observation before another config or
   start.

After that ratification, the artifact graduates into build tickets for the
control schema, Polar/oRPC reconcile service, Dokploy/Turso clients, boot retry,
and the one logged-in-instance proof above.

## Verified external basis

- [Dokploy application API](https://docs.dokploy.com/docs/api/application):
  create/one/start/stop/deploy endpoints and caller-supplied app-name base.
- [Dokploy environment API](https://docs.dokploy.com/docs/api/environment):
  `environment.one` recovery lookup.
- [Dokploy source at `df3965a`](https://github.com/Dokploy/dokploy/blob/df3965a5816700d61c39fd1a13241b5766d7b24e/packages/server/src/db/schema/application.ts#L79-L88):
  `applicationId` primary key and `appName` unique constraint.
- [Dokploy create service at `df3965a`](https://github.com/Dokploy/dokploy/blob/df3965a5816700d61c39fd1a13241b5766d7b24e/packages/server/src/services/application.ts#L56-L91):
  create only inserts the application record; it does not deploy/start it.
- [Dokploy app-name builder at `df3965a`](https://github.com/Dokploy/dokploy/blob/df3965a5816700d61c39fd1a13241b5766d7b24e/packages/server/src/db/schema/utils.ts#L67-L71):
  a random six-character suffix is appended even when `appName` is supplied.
- [Dokploy lifecycle source at `df3965a`](https://github.com/Dokploy/dokploy/blob/df3965a5816700d61c39fd1a13241b5766d7b24e/packages/server/src/utils/docker/utils.ts#L111-L125):
  stop scales to zero; [start scales to one](https://github.com/Dokploy/dokploy/blob/df3965a5816700d61c39fd1a13241b5766d7b24e/packages/server/src/utils/docker/utils.ts#L363-L378).
- [Dokploy Swarm config source at `df3965a`](https://github.com/Dokploy/dokploy/blob/df3965a5816700d61c39fd1a13241b5766d7b24e/packages/server/src/utils/docker/utils.ts#L591-L608):
  absent update and rollback settings default to `Order: "start-first"`.
- [Dokploy application schema at `df3965a`](https://github.com/Dokploy/dokploy/blob/df3965a5816700d61c39fd1a13241b5766d7b24e/packages/server/src/db/schema/application.ts#L126-L135):
  `autoDeploy` defaults to true.
- [Turso PRAGMA reference](https://docs.turso.tech/sql-reference/pragmas#foreign-keys):
  foreign-key enforcement is off by default and must be enabled explicitly.
- [Polar Better Auth adapter](https://polar.sh/docs/integrate/sdk/adapters/better-auth):
  signed `/api/auth/polar/webhooks` handler and created/updated/active/canceled/
  revoked/uncanceled callbacks.
- [Polar subscription event sequence](https://polar.sh/docs/integrate/webhooks/events#subscriptions):
  `subscription.updated` is the catch-all lifecycle event; end-of-period
  cancellation remains active until the later revoked event.
- [Polar subscription benefits](https://polar.sh/docs/features/subscriptions/introduction#how-subscriptions-work):
  customers retain benefits while a subscription is active or trialing.
