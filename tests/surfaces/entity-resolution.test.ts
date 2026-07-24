import { describe, expect, it } from "vite-plus/test";

import {
  createGraphStore,
  type EntityUpsert,
  type GraphAttestationContext,
} from "../../packages/engine/src/graph/store.ts";
import { createSurfaceRegistry } from "../../packages/engine/src/surfaces/registry.ts";
import { resolveEntitySurface } from "../../apps/runtime/src/host/whatsapp-runtime.ts";

const ACCOUNT = "15550000000:7@s.whatsapp.net";
const GROUP = "team@g.us";
const PERSON_DM = "204663831932940@lid"; // the real archived DM from §13, never configured as a chat.
const CONTEXT: GraphAttestationContext = { author: { kind: "brain", id: "brain" }, evidenceIds: ["test:resolution"] };

const attestEntity = (store: ReturnType<typeof createGraphStore>, input: EntityUpsert): string => {
  const result = store.attest({ context: CONTEXT, claim: { kind: "entity", input } });
  if (result.kind !== "entity") throw new Error("Expected an Entity Attestation.");
  return result.entity.entityId;
};

describe("resolveEntitySurface — one prompt operation for group reply and known-Person DM (S5)", () => {
  it("resolves a configured group thread to its existing Surface and opens a known person's DM Surface", () => {
    const store = createGraphStore(":memory:");
    const surfaces = createSurfaceRegistry(":memory:");
    // Only the group is operator-authorized; the DM chat is not configured.
    const [groupSurface] = surfaces.activateConfigured(ACCOUNT, [GROUP]);

    const threadId = attestEntity(store, {
      type: "thread",
      properties: { chatId: GROUP },
      identity: { platform: "whatsapp", externalId: GROUP },
    });
    const personId = attestEntity(store, {
      type: "person",
      properties: { name: "Aaron" },
      identity: { platform: "whatsapp", externalId: PERSON_DM },
    });

    const deps = { graph: store, surfaces, accountJid: ACCOUNT };

    // Group reply: resolves to the pre-existing operator-authorized Surface. A stable Surface never releases.
    const group = resolveEntitySurface(deps, threadId);
    expect(group?.surfaceId).toBe(groupSurface!.id);
    group?.release(); // no-op — the configured group survives.
    expect(surfaces.activeSurface(ACCOUNT, GROUP)?.id).toBe(groupSurface!.id);

    // Known-person DM: opens a distinct Surface on demand (find-or-create), idempotent on repeat.
    const dm = resolveEntitySurface(deps, personId);
    expect(dm?.surfaceId).toBeDefined();
    expect(dm?.surfaceId).not.toBe(groupSurface!.id);
    expect(resolveEntitySurface(deps, personId)?.surfaceId).toBe(dm!.surfaceId);
    expect(surfaces.activeBinding(dm!.surfaceId)?.providerChatId).toBe(PERSON_DM);

    // Opening the DM never retired the configured group binding.
    expect(surfaces.activeSurface(ACCOUNT, GROUP)?.id).toBe(groupSurface!.id);

    store.close();
    surfaces.close();
  });

  it("release() retires a DM this call newly opened, but leaves an already-live DM (and the group) intact", () => {
    const store = createGraphStore(":memory:");
    const surfaces = createSurfaceRegistry(":memory:");
    surfaces.activateConfigured(ACCOUNT, [GROUP]);
    const personId = attestEntity(store, {
      type: "person",
      properties: { name: "Aaron" },
      identity: { platform: "whatsapp", externalId: PERSON_DM },
    });
    const deps = { graph: store, surfaces, accountJid: ACCOUNT };

    // First resolution opens the DM; its release undoes exactly that (failed admission ⇒ no lingering binding).
    const first = resolveEntitySurface(deps, personId);
    expect(surfaces.activeSurface(ACCOUNT, PERSON_DM)).toBeDefined();
    first!.release();
    expect(surfaces.activeSurface(ACCOUNT, PERSON_DM)).toBeUndefined(); // rolled back — intake won't admit it.

    // Re-open it and accept it (no release). A LATER resolution finds it already live: its release is a no-op,
    // so a second failed prompt cannot tear down a legitimately-open two-way DM.
    resolveEntitySurface(deps, personId); // opens again, kept.
    const live = surfaces.activeSurface(ACCOUNT, PERSON_DM);
    const again = resolveEntitySurface(deps, personId);
    again!.release();
    expect(surfaces.activeSurface(ACCOUNT, PERSON_DM)?.id).toBe(live?.id); // untouched.

    store.close();
    surfaces.close();
  });

  it("refuses to open a person whose WhatsApp identity is a group JID (no group participation via the DM path)", () => {
    const store = createGraphStore(":memory:");
    const surfaces = createSurfaceRegistry(":memory:");
    surfaces.activateConfigured(ACCOUNT, [GROUP]);
    // Data-quality edge case: a person entity mistakenly linked to a group chat's JID.
    const personOnGroup = attestEntity(store, {
      type: "person",
      properties: { name: "Mislinked" },
      identity: { platform: "whatsapp", externalId: "discovered-group@g.us" },
    });
    const deps = { graph: store, surfaces, accountJid: ACCOUNT };

    // The DM path must not open a group — that would let an unconfigured group participate. Fail closed.
    expect(resolveEntitySurface(deps, personOnGroup)).toBeUndefined();
    expect(surfaces.activeSurface(ACCOUNT, "discovered-group@g.us")).toBeUndefined(); // never activated.

    // Same guard must hold for a non-lowercase group JID — the registry lowercases internally, so a
    // case-sensitive check would miss it and open the group as a DM.
    const personOnUpperGroup = attestEntity(store, {
      type: "person",
      properties: { name: "MislinkedUpper" },
      identity: { platform: "whatsapp", externalId: "STRANGER@G.US" },
    });
    expect(resolveEntitySurface(deps, personOnUpperGroup)).toBeUndefined();
    expect(surfaces.activeSurface(ACCOUNT, "STRANGER@G.US")).toBeUndefined(); // never activated.

    store.close();
    surfaces.close();
  });

  it("fails closed for an unknown entity, a non-addressable entity, and a discovered (unconfigured) group", () => {
    const store = createGraphStore(":memory:");
    const surfaces = createSurfaceRegistry(":memory:");
    surfaces.activateConfigured(ACCOUNT, [GROUP]);
    const deps = { graph: store, surfaces, accountJid: ACCOUNT };

    // Unknown entity id — nothing in the Graph.
    expect(resolveEntitySurface(deps, "person:never-met")).toBeUndefined();

    // A person known only on GitHub has no WhatsApp identity → not a WhatsApp Surface.
    const githubOnly = attestEntity(store, {
      type: "person",
      properties: {},
      identity: { platform: "github", externalId: "octocat" },
    });
    expect(resolveEntitySurface(deps, githubOnly)).toBeUndefined();

    // A non-addressable type (a topic) resolves to nothing.
    const topic = attestEntity(store, { type: "topic", properties: { label: "release cadence" } });
    expect(resolveEntitySurface(deps, topic)).toBeUndefined();

    // A discovered group thread whose chat was never configured is NOT openable — discovery never grants
    // participation (unlike a known person, a thread resolves only to an already-active Surface).
    const strangerThread = attestEntity(store, {
      type: "thread",
      properties: { chatId: "stranger@g.us" },
      identity: { platform: "whatsapp", externalId: "stranger@g.us" },
    });
    expect(resolveEntitySurface(deps, strangerThread)).toBeUndefined();
    expect(surfaces.activeSurface(ACCOUNT, "stranger@g.us")).toBeUndefined();

    store.close();
    surfaces.close();
  });
});
