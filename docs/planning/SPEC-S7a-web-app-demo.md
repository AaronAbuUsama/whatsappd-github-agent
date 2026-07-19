# S7a · Web app — delete the dead screens

Spec for the second stage of the demo path. Against `REBUILD-PLAN-2026-07-19.md` revision 3.
Depends on **S0.5**. Ends with a browser the owner can sign into and drive end to end — the first
time that will ever be true.

## What this stage is not

Revision 2's S7 was a rewiring: `tenantId` onto 21 oRPC call sites, plus a new tenant list and
switcher. **All of that is deleted** — with one instance there is no tenant dimension, and the 21
call sites keep their present signatures untouched.

What remains is subtraction. Every screen removed here is a screen whose backing concept no longer
exists: billing is off, and the provisioner that produced `preparing`/`uncertain`/reconcile states is
being demolished.

**Re-derived, not trusted:** every deletion claim below was checked against the tree. The counts are
measured.

## The seam — the wizard stage table

```ts
// apps/web/src/app/onboarding/[[...step]]/onboarding.tsx:31-72 — the interface
```

The stage table is the module's interface: a caller (the router, the redirect effect) knows only
*which stage is current*, and each stage's rendering, verbs and transitions stay behind it. Removing
a stage is an edit to the table plus its block — it does not ripple, which is why this stage is
subtraction rather than surgery.

**What stays behind the seam:** which oRPC verbs a stage calls, how it polls, and how it renders.
**What must not leak through it:** a stage that no longer exists must leave no `nextAction` value
that the redirect effect can still produce. That is the failure this stage's negative assertion
catches.

**The bidirectional redirect stays.** `onboarding.tsx:121-124` → `/dashboard` and
`dashboard.tsx:98-102` → `/onboarding` lock each other, and revision 2 called this a defect because
it blocked a second tenant. With one instance it is **correct behaviour** — exactly one place to be
at any moment — and removing it would be inventing a problem.

## Files, with line ranges

### Delete

| What | File | Lines | Note |
|---|---|---|---|
| subscription stage — declaration | `onboarding.tsx` | 33-36 | |
| subscription stage — render | `onboarding.tsx` | 325-350 | Polar checkout + entitlement chip |
| `preparing` stage — declaration | `onboarding.tsx` | 43-46 | |
| `preparing` stage — render | `onboarding.tsx` | 386-424 | and the `ensureSetup` verb behind it, which dies with the provisioner |
| reconcile button 1 of 3 | `onboarding.tsx` | 409-417 | inside `preparing`, goes with it |
| reconcile button 2 of 3 | `onboarding.tsx` | 748-756 | activation stage |
| reconcile button 3 of 3 | `dashboard.tsx` | 646-660 | recent-operations list |
| shared reconcile helper | `onboarding.tsx` | 289-293 | orphaned once the three callers go |
| `runtime.restart` | `dashboard.tsx` | 404-420 | the only call site |
| `uncertain` branches — 9 sites | `onboarding.tsx` | 287 | |
| | `dashboard.tsx` | 49-50, 225, 270, 306, 311, 318, 435, 646 | incl. the `blocked_unknown` alert at 305-329 |
| suspended-billing alert | `dashboard.tsx` | 282-294 | dead with Polar off |
| billing cards | `dashboard.tsx` | 331-382 | header survives; the billing cards do not |
| recent operations panel | `dashboard.tsx` | 628-673 | provisioning-era concept |

### Keep, unchanged

`model` (426-482), `whatsapp` (484-539), `chats` (541-596), `github` (598-708), `activation`
(710-759); the repo repair panel (`dashboard.tsx:497-567`), model challenge card (569-590), pairing
QR card (592-626), signed-in account (675-688). **No `tenantId` is added to any of them.**

The `github` stage already passes an installation-scoped id (`onboarding.tsx:207,232,250`) because it
goes over REST (`apps/api/src/github-routes.ts`), not oRPC. It is the one stage that already has the
shape S-ORG will later need.

### Not in this stage

The ASCII→canvas QR swap. `qrcode-terminal@0.12.0` (`apps/web/package.json:29`) renders into a
`<pre>` at `onboarding.tsx:501-510` and `dashboard.tsx:604-613`. Phone cameras read monospace badly,
so it should change — but it is a **prerequisite-adjacent nicety**, not a gate, and pairing is a
one-time ceremony. Own ticket; do not let it block the demo.

## The gate — real-world, re-runnable, in a real browser

**Prerequisite (ceremony, not a gate):** the WhatsApp account is paired once. Re-running the gate
must not re-pair.

With **no Polar credentials in the environment** (S0.5's condition), in a real browser:

1. Sign in as the seeded operator.
2. Model auth — device-code challenge → verified.
3. Chat selection — real chat list from the paired account → select the canary chat.
4. GitHub config — real installation, real repository selection.
5. Activate → `status='active'`.
6. Send a real message in the canary WhatsApp chat and **get a real reply**.

Step 6 is what makes this a demo rather than a form-filling exercise. Steps 1-5 prove the wizard;
step 6 proves the wizard configured something that actually runs.

### Negative assertions

1. **No deleted concept is reachable.** Assert that no route, no `nextAction` value and no rendered
   screen produces a subscription stage, a `preparing` stage, a reconcile control, a restart control
   or an `uncertain` state. Not "I did not see one" — enumerate the `nextAction` union and assert the
   removed members are gone from the type **and** that the redirect effect has no unreachable branch.
2. **Activating with a stale `basisFingerprint` is refused, with a message the operator can see.**
   Fingerprint, add a repository in another tab, then activate from the first tab. This must fail
   *visibly*. `basisFingerprint` is a genuine product guarantee — "did what you reviewed change while
   you reviewed it?" — and a silent pass here is a silent wrong-config activation.
3. **The reply in step 6 is real.** Assert the message arrives from the live provider with an ack —
   not that the UI reported success. The Speaker settling silent is a valid outcome in general, so
   the gate must drive an input whose reply is mandatory, and assert the **absence of silence**.

**Assertion 3 is the anti-silent-degradation clause.** Every other step in this gate can go green
with a fully configured, completely inert agent.

## Receipt

`docs/proof/operator-demo-live.md` — dated, ticket-linked, `github-webhook-live.md` convention.
Screenshots of each wizard step, the real chat transcript for step 6 with the provider ack, the
enumerated `nextAction` union for assertion 1, and an explicit ❌ against anything not observed.

## Rollback

Deletion-only within two files, plus the `ensureSetup` verb. Revert restores the screens. Nothing
downstream consumes the removed UI, and no schema or contract changes — `utils/orpc.ts` names no
verb and is untouched. The one-way door is the `ensureSetup` verb removal, so land that as its own
commit within the stage.

## Out of scope

`tenantId` anywhere; the tenant switcher (no tenants); the canvas QR; S-ORG's per-chat repository
scoping; anything requiring E2B, a second phone or the VPS.
