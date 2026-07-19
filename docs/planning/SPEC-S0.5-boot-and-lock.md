# S0.5 · Boot, and lock the door

Spec for the stage that is next. Against `REBUILD-PLAN-2026-07-19.md` revision 3.
Fixes **F-3** (the service will not boot with billing disabled) and **F-4** (sign-up is open to the
internet). Nothing else in the plan boots until this lands.

## Why this is one stage and not two

F-3 and F-4 are the same change viewed twice: *the service must be startable and reachable by
exactly one person, with no payment provider in the environment.* Splitting them ships a service
that boots and hands accounts to strangers, or one that is locked and cannot start. Neither is
demonstrable.

## The seam — it already exists, and this stage does not move it

`getEntitlementSnapshot` is **already an injected interface**, not a direct call:

```ts
// packages/api/src/routers/index.ts:9  — the interface
readonly getEntitlementSnapshot: (userId: string) => Promise<EntitlementSnapshot>;
// packages/api/src/routers/index.ts:58 — the single call site
dependencies.getEntitlementSnapshot(context.session.user.id),
// apps/api/src/index.ts:24            — the adapter supplied today
getEntitlementSnapshot,
```

This is the good shape already: one method, one parameter, one return type, and the whole Polar
customer-state round-trip hidden behind it. **The interface does not change. This stage replaces the
adapter.** Callers, the router and every consumer of `EntitlementSnapshot` are untouched.

**What stays behind the seam:** whether Polar is configured at all, whether a network call happens,
the 404-versus-401 distinction, and the projection/`subscriptionEntitlements` read. Callers continue
to know exactly one fact — a user has an entitlement snapshot — and learn nothing about billing.

**Deletion test:** delete the seam and the Polar-configured branch reappears at the router and at
every future admin route. It earns its keep.

**Two adapters, so the seam is real** (not hypothetical): the live Polar adapter and the
always-entitled adapter. That is the test that justifies keeping it rather than inlining.

## Interface being changed

| Interface | Change | Kind |
|---|---|---|
| `packages/env/src/server.ts:11-13` — the env contract | three Polar vars become optional | **widened**; existing full configs still validate |
| `getEntitlementSnapshot` (`packages/api/src/routers/index.ts:9`) | **unchanged** — adapter swapped at `apps/api/src/index.ts:24` | none |
| `betterAuth` config (`packages/auth/src/index.ts:20-64`) | Polar plugin becomes conditional; sign-up disabled | narrowed |
| Login route (`apps/web/src/app/login/page.tsx:9`) | defaults to sign-**in**; sign-up form removed from the default path | narrowed |

## Files, with line ranges

| File | Lines | Change |
|---|---|---|
| `packages/env/src/server.ts` | 11-13 | `POLAR_ACCESS_TOKEN`, `POLAR_SUCCESS_URL`, `POLAR_WEBHOOK_SECRET` → `.optional()` |
| `packages/auth/src/index.ts` | 27-29 | `emailAndPassword: { enabled: true, disableSignUp: true }` |
| `packages/auth/src/index.ts` | 39-63 | wrap the `polar({...})` plugin in a configured-check; `plugins: polarConfigured ? [polar({...})] : []` |
| `packages/auth/src/index.ts` | 41 | `createCustomerOnSignUp: true` only reachable when configured |
| `packages/auth/src/index.ts` | 70-88 | `getEntitlementSnapshot`: **return the always-entitled snapshot without calling Polar** when unconfigured. Do not rely on the `catch` — it only handles 404 (`isPolarNotFound`, `:69`), so an unconfigured Polar returning 401 or refusing the connection **re-throws** today |
| `apps/web/src/app/login/page.tsx` | 9-15 | `useState(true)`; delete the `onSwitchToSignUp` path |
| `apps/web/src/components/sign-up-form.tsx` | whole file | **not deleted** — public signup returns later (owner's instruction). Unreferenced from the login route |
| `packages/db` seed | new | one operator account, idempotent |

**Do not delete the Polar code.** The owner's standing instruction is that public signup and billing
return later and the code stays in the tree.

## The gate — real-world, re-runnable

Run against a real build with **no Polar credentials in the environment**:

```bash
env -u POLAR_ACCESS_TOKEN -u POLAR_SUCCESS_URL -u POLAR_WEBHOOK_SECRET pnpm start
curl -s -o /dev/null -w '%{http_code}' localhost:PORT/rpc/coworker.snapshot        # → 401
curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $SESSION" .../coworker.snapshot # → 200
curl -X POST .../api/auth/sign-up/email -d '{"email":"stranger@…",…}'              # → refused
```

### Negative assertions — all three must be observed failing

1. **An unauthenticated request must not reach an admin route.** 401, and **no row is written** —
   assert the operation ledger is unchanged across the unauthenticated call. A 401 with a side
   effect is the failure this catches.
2. **A second account must not be creatable.** The sign-up endpoint is refused at the *server*, not
   merely hidden in the UI. Hiding the form is not the assertion; `curl` is.
3. **No outbound request to Polar occurs during a full wizard poll cycle.** This is the one that
   catches a silent pass: `getEntitlementSnapshot` could "work" by throwing and being caught
   somewhere, or by hitting the network and getting lucky. Run the 3-second snapshot poll for ≥15
   seconds with outbound traffic to `api.polar.sh` blocked (or captured) and assert **zero
   connection attempts**. If Polar is still being called, this stage has not done its job even
   though every status code above is green.

**Why assertion 3 exists:** revision 2 assumed the failure mode was "hits Polar". The measured
failure mode is a **throw** — `getEntitlementSnapshot` catches only 404, so an unconfigured Polar
returning 401 re-throws and the wizard's poll 500s. A fix that merely broadens the `catch` would
make the endpoint return 200 while still calling Polar on every poll. Assertion 3 is what
distinguishes the real fix from that one.

## Receipt

`docs/proof/operator-auth-live.md` — following the `github-webhook-live.md` convention: dated,
ticket-linked, exact commands and their real output, and a verdict table. Records the boot with the
env vars actually unset, the three status codes, the packet-level evidence for assertion 3, and an
explicit ❌ for anything not observed.

## Rollback

Single commit, revert cleanly. Nothing depends on this stage yet — S7a is the first consumer. The
env change is *widening*, so an environment that still has all three Polar vars set continues to
validate and behave exactly as today. That is what makes this reversible: the old configuration
remains a legal configuration.

## Out of scope

Deleting Polar code; the subscription wizard stage (that is S7a); anything touching tenancy — there
is none; anything requiring the E2B key, a second phone or the VPS.
