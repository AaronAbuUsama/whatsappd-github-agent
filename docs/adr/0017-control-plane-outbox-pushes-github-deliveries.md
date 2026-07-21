---
status: proposed
date: 2026-07-18
issue: https://github.com/AaronAbuUsama/ambient-agent/issues/168
---

# The control-plane outbox pushes GitHub deliveries to tenant runtimes

## Decision

Use a **durable control-plane outbox followed by authenticated tenant push**.

The central GitHub receiver verifies the GitHub signature, derives the event name and delivery GUID from the
verified headers, reads `installation.id` when present, and commits the complete verified envelope plus any resolved
route and configured GitHub App ID to the control-plane Turso database before returning `202 Accepted` to GitHub. A
relay claims due rows under an expiring lease and pushes a `RoutedGitHubWebhookDelivery`—the existing
`GitHubWebhookDelivery` plus its configured App ID—to the tenant's T-F `POST /deliveries` bridge. The runtime
authenticates the request with T-F's purpose-bound `x-ambient-agent-bridge` HMAC and passes the routed envelope
through the one `handleGitHubDelivery(delivery)` funnel without adding a second ingestion path.

This is at-least-once transport. Both ledgers scope each GitHub delivery GUID to the configured GitHub App that
received it. The control-plane outbox owns receipt, routing, retry, and tenant acknowledgement; the tenant ingress
ledger owns application interpretation and Flue Admission. A duplicate wake is harmless under
[ADR 0014](./0014-window-delivery-is-an-at-least-once-wake.md).

This ADR remains proposed until #168 is ratified. It deliberately does not add production routes, migrations, or
workers before that gate. The executable contract at
[`T-C-webhook-delivery.prototype.ts`](../planning/wayfinder/T-C-webhook-delivery.prototype.ts) makes the state
machine reviewable now.

## Why the current funnel is not durable enough for SaaS routing

Today the raw GitHub channel in
[`apps/runtime/src/channels/github.ts`](../../apps/runtime/src/channels/github.ts#L6-L18) verifies and immediately
calls a two-line process-local interface:

```ts
export const handleGitHubDelivery = (delivery: GitHubWebhookDelivery): Promise<GitHubIngressResult> =>
  ingressHandler.get()(delivery);
```

That interface is the right tenant-side seam: its implementation claims the GUID in local SQLite before
interpretation and tolerates provider redelivery. It is not a control-plane durability seam. Until the tenant is
called, no tenant row exists. A synchronous central receiver that forwards first and returns GitHub's status has an
unrecoverable window whenever the tenant is down, because GitHub
[does not automatically redeliver failed webhooks](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).
GitHub also requires a response within ten seconds and recommends asynchronous queuing in its
[webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

T-A established internal HTTP addressability, T-B put authoritative routing state in the control-plane Turso DB,
and T-F reserved authenticated `POST /deliveries`. The outbox uses all three decisions without coupling tenant
runtimes to the shared control-plane database.

## Module and interfaces

The external control-plane module is deliberately deep: two entry points hide verification-independent persistence,
claim leasing, endpoint resolution, backoff, acknowledgement validation, and recovery.

```ts
interface GitHubDeliveryRelay {
  // Called only after GitHub signature verification. Commits before the receiver returns 202.
  accept(delivery: VerifiedGitHubDelivery): Promise<"inserted" | "duplicate">;

  // Claims a bounded due batch, pushes it, and atomically acks or schedules each retry.
  drainOnce(now: Date): Promise<{ claimed: number; acked: number; retrying: number }>;
}

type RoutedGitHubWebhookDelivery = GitHubWebhookDelivery & { readonly githubAppId: string };
type RoutedGitHubIngressResult = GitHubIngressResult & { readonly githubAppId: string };

interface TenantDeliveryPort {
  push(target: TenantRuntimeTarget, delivery: RoutedGitHubWebhookDelivery): Promise<RoutedGitHubIngressResult>;
}
```

`TenantDeliveryPort` is the remote-but-owned seam. Production uses the T-F HTTP adapter; tests use an in-memory
adapter that returns scripted `RoutedGitHubIngressResult` values. The Turso store is local-substitutable through local
libsql in tests. GitHub is a true external dependency and is mocked at the verified receiver interface.

The runtime does not learn the outbox interface. It gains only T-F's conditional route:

```ts
app.post("/deliveries", authenticateBridge("delivery-push"), async (context) => {
  const delivery = parseRoutedGitHubWebhookDelivery(await context.req.json());
  const result = await handleGitHubDelivery(delivery);
  return context.json(result, isDurableTenantAcknowledgement(delivery, result) ? 200 : 503);
});
```

The endpoint returns `2xx` only when the tenant ledger is terminal for the same App/GUID pair. In particular, a
concurrent `duplicate` whose record is still `received` is retryable, not an acknowledgement. The current raw channel
returns `503` only for `deferred`; the build ticket must tighten this response mapping for the new bridge route
without adding another ingress funnel. The `handleGitHubDelivery` value widens to the routed shape so its store can
claim the App/GUID pair while preserving the original GUID for provenance.

## Persistence and identity

The production migration should encode this logical record in the control-plane database:

```sql
CREATE TABLE github_delivery_outbox (
  delivery_guid       TEXT NOT NULL,
  github_app_id       TEXT NOT NULL,
  event_name          TEXT NOT NULL,
  installation_id     TEXT,
  tenant_id           TEXT,
  payload_json        TEXT NOT NULL,
  payload_sha256      TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('pending', 'acked')),
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT NOT NULL,
  claim_id            TEXT,
  claim_expires_at    TEXT,
  last_error          TEXT,
  tenant_result_json  TEXT,
  received_at         TEXT NOT NULL,
  acknowledged_at     TEXT,
  PRIMARY KEY (github_app_id, delivery_guid)
);
```

- **Identity:** `delivery_guid` is
  [`X-GitHub-Delivery`](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks#use-the-x-github-delivery-header),
  which is stable across redelivery. Because the SaaS configures three GitHub Apps that can receive the same GitHub
  event, the control-plane idempotency key is `(github_app_id, delivery_guid)`, not the GUID globally. A repeated
  App/GUID pair with the same `event_name`, nullable `installation_id`, and `payload_sha256` is an acknowledged
  duplicate. A mismatch is an integrity collision: return an error, alert, and never overwrite the first row.
- **Payload:** persist the verified JSON body, event name, installation ID, App ID, and SHA-256 digest in the same
  transaction. The receiver supplies `github_app_id` from its configured App context, never from the webhook body.
  Never rely on the later GitHub API to reconstruct the event.
- **Routing:** pin an App/GUID pair to the first resolved `tenant_id`. Resolve the current runtime hostname/port at
  every push, so a Dokploy restart or VIP-to-DNSRR change does not rewrite delivery ownership. A missing or unknown
  installation is stored with `tenant_id = NULL` and returns `202`, so it is never silently dropped. Registry
  reconciliation retries an unknown ID; a missing ID remains visibly unclaimable and alerts for
  compatibility/operator resolution.
- **Retention:** never prune an unacknowledged row. Acknowledged payload retention and App/GUID tombstone compaction
  need an explicit data-retention policy in the implementation ticket; absence of that policy defaults to retention,
  not loss.

The tenant migration mirrors the same key in local SQLite: `github_ingress_deliveries` gains `github_app_id` and a
composite primary key `(github_app_id, delivery_id)`. Existing self-hosted rows migrate under a reserved `legacy`
scope; after cutover, both the raw self-hosted channel and the SaaS route supply their configured App ID. The original
`delivery_id` column remains the GitHub GUID used by downstream provenance.

## Claim, retry, and acknowledgement

1. `accept` uses one transaction to insert-or-read by App/GUID. It returns only after commit. The webhook receiver then
   returns `202`; it never waits for a tenant.
2. `drainOnce` atomically assigns a random `claim_id`, a 60-second `claim_expires_at`, and increments
   `attempt_count` for due, routed, pending rows. A non-expired claim cannot be taken by another worker.
3. The HTTP adapter resolves the tenant's current internal target, applies T-F's `delivery-push` authorization, sends
   the persisted envelope, and uses a timeout shorter than the claim lease.
4. A matching App/GUID terminal tenant result (`done`, `unsupported`, `uncorrelated`, `failed`, or a `duplicate` whose
   stored status is terminal) atomically changes `pending -> acked`, stores the result, and clears the claim. `acked`
   means the tenant ingress ledger settled; it does not rewrite an application-level `failed` result as success.
5. A timeout, network error, non-2xx, malformed/mismatched result, `deferred`, or `duplicate/received` clears the claim
   and schedules another attempt with full-jitter exponential backoff (one second base, fifteen-minute cap).
   Transport failures have no maximum attempt count; alerting escalates a stalled row, but only a recognized tenant
   acknowledgement makes it terminal.
6. A worker crash leaves a claim that expires and is reclaimed. A crash after tenant acceptance but before the
   outbox ack causes one more push; the tenant App/GUID ledger returns a terminal duplicate and the outbox settles.
7. A tenant can remain down indefinitely without losing the payload. Recovery is automatic when its endpoint becomes
   healthy; no tenant poller or shared-database credential is needed.

## The receiver's own downtime

An outbox closes the tenant-downtime window, but no local transaction can cover a request that never commits. GitHub
does not retry that failed request automatically. The integrity-safe MVP therefore also needs a small GitHub App
delivery reconciler:

- every five minutes, for each configured GitHub App, scan recent delivery attempts with an overlap from the last
  durable successful cursor;
- request redelivery for attempts GitHub reports failed;
- let the outbox App/GUID primary key absorb races and repeats; and
- alert if the reconciler has not completed within GitHub's
  [documented three-day redelivery window](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks#about-redelivering-webhooks).

This is recovery insurance, not the normal transport. The receiver still commits quickly and responds `202`.

## Options considered

Scores are 1 (weak) to 5 (strong).

| Option | Floor-first | Reversible | Small blast radius | Correctness / integrity | Parallelizable | Existing fit | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Bare synchronous push | 2 | 5 | 5 | 1 | 4 | 5 | Reject. It ships only the happy path; adding persistence/retry turns it into the chosen option. |
| Durable control-plane outbox -> authenticated tenant push | 5 | 4 | 4 | 5 | 4 | 5 | **Choose.** Adds one control-plane table/relay and the already-reserved runtime route while preserving the one-line tenant funnel. |
| Tenant pull | 3 | 4 | 3 | 5 | 4 | 3 | Reject for MVP. It survives downtime, but adds authenticated claim/ack routes and a polling lifecycle to every runtime and makes T-F's reserved delivery route unused. |

Bare push has the shallowest implementation but no integrity. Tenant pull can be correct, yet it moves routing,
claims, and control-plane availability into every tenant. The chosen module concentrates those behaviors behind the
control-plane relay interface and keeps the runtime adapter small.

## Graduation into implementation tickets

File these after ratification; each is independently reviewable and all link #165 and #168.

1. **Control-plane GitHub receiver + durable outbox** — owners: `apps/api`, `packages/api`, `packages/db`. Add raw-body
   GitHub HMAC verification, installation lookup, the outbox migration/store, insert-before-`202`, App/GUID collision
   and missing/unknown-installation behavior. Proof: local libsql route tests covering commit failure, exact
   duplicate, same-GUID events from different Apps, collision within one App, missing installation, and delayed
   installation registration.
2. **Outbox relay + tenant HTTP adapter** — owners: `apps/api`, `packages/api`. Add atomic claim leases, endpoint
   resolution from `agent_instances`, capped-jitter retry, strict acknowledgement parsing, stalled-row diagnostics,
   and an in-memory tenant adapter. Proof: crash-after-claim, crash-after-tenant-ack, downtime/recovery, auth rejection,
   malformed ack, and terminal duplicate tests.
3. **Authenticated runtime `POST /deliveries` bridge** — owners: `apps/runtime`, `packages/installation`. Reuse T-F's
   `delivery-push` HMAC, validate `RoutedGitHubWebhookDelivery`, migrate the local ingress ledger to an App/GUID
   composite key, call only `handleGitHubDelivery`, and map `deferred` plus `duplicate/received` to retryable
   responses. Proof: auth/schema tests, same-GUID deliveries from two Apps, and one persisted App/GUID restart test
   showing terminal duplicate acknowledgement.
4. **GitHub App failed-delivery reconciler** — owner: `apps/api`. Persist one scan cursor per App, overlap scans,
   request redelivery for GitHub-reported failures, expose last-success/stalled health, and rely on the outbox
   App/GUID for deduplication. Proof: scripted GitHub adapter tests for receiver downtime, repeat scans, and the
   three-day alert.
5. **One-tenant live delivery proof** — owner: deployment/proof. With the control plane and runtime on
   `dokploy-network`, stop the tenant, emit a real GitHub event, prove the central receiver returns `202` and the row
   remains pending, restart the tenant, and prove the same App/GUID reaches `handleGitHubDelivery` once and both
   ledgers settle. This remains human/environment proof until a Dokploy instance and GitHub App are wired.

Tickets 1 and 3 can proceed in parallel. Ticket 2 depends on their interfaces; ticket 4 depends on ticket 1's
idempotent receiver; ticket 5 depends on 1-4.

## Mechanical review

Run:

```sh
pnpm exec vitest run tests/planning/webhook-delivery-mechanism.test.ts
```

The check proves App-scoped GUID deduplication, cross-App separation, collision refusal, delayed routing, route
pinning, exclusive/expiring claims, downtime retry without payload loss, strict tenant acknowledgement,
crash-after-ack recovery, and capped backoff. It does not claim a production database, HTTP route, or live Dokploy
proof exists yet.
