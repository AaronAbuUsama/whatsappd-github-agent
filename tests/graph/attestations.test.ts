import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createGraphStore, type GraphAttestationContext } from "../../packages/engine/src/graph/store.ts";
import { createBrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const scribe = (evidenceIds: readonly string[], batchId = "scribe-batch:test"): GraphAttestationContext => ({
  author: { kind: "scribe", id: "scribe" },
  evidenceIds,
  batchId,
});
const brain = (evidenceIds: readonly string[]): GraphAttestationContext => ({
  author: { kind: "brain", id: "brain" },
  evidenceIds,
});

describe("append-only Graph", () => {
  it("deduplicates an exact retry without amplifying confidence", () => {
    const store = createGraphStore(":memory:", { now: () => new Date("2026-07-22T00:00:00.000Z") });
    const draft = {
      context: scribe(["arrival:chat:a"]),
      claim: {
        kind: "entity" as const,
        input: {
          type: "person" as const,
          properties: { name: "Alice" },
          identity: { platform: "whatsapp" as const, externalId: "alice@s.whatsapp.net" },
          confidence: 0.5,
        },
      },
    };

    const first = store.attest(draft);
    const retry = store.attest(draft);
    expect(retry.attestation.id).toBe(first.attestation.id);
    expect(store.attestations()).toHaveLength(1);
    expect(store.resolveIdentity("whatsapp", "alice@s.whatsapp.net")?.confidence).toBe(0.5);
    expect(store.projectionVersion()).toBe(`projection:${first.attestation.id}`);
    store.close();
  });

  it("combines confidence only across independent Evidence Sets", () => {
    const store = createGraphStore(":memory:");
    const claim = {
      kind: "entity" as const,
      input: {
        type: "person" as const,
        properties: { name: "Alice" },
        identity: { platform: "whatsapp" as const, externalId: "alice@s.whatsapp.net" },
        confidence: 0.5,
      },
    };
    store.attest({ context: scribe(["arrival:chat:a"], "scribe-batch:a"), claim });
    store.attest({ context: scribe(["arrival:chat:b"], "scribe-batch:b"), claim });

    expect(store.resolveIdentity("whatsapp", "alice@s.whatsapp.net")?.confidence).toBe(0.75);
    expect(store.attestations()).toHaveLength(2);
    store.close();
  });

  it("does not treat overlapping Evidence Sets as independent support", () => {
    const store = createGraphStore(":memory:");
    const claim = {
      kind: "entity" as const,
      input: { type: "topic" as const, properties: { label: "memory" }, confidence: 0.5 },
    };
    store.attest({ context: scribe(["arrival:a", "arrival:b"], "scribe-batch:ab"), claim });
    store.attest({ context: scribe(["arrival:b", "arrival:c"], "scribe-batch:bc"), claim });
    expect(store.findEntities({ type: "topic" })[0]?.confidence).toBe(0.5);
    store.attest({ context: scribe(["arrival:d"], "scribe-batch:d"), claim });
    expect(store.findEntities({ type: "topic" })[0]?.confidence).toBe(0.75);
    store.close();
  });

  it("resolves contradictory properties by authority and Confidence, with immutable Brain rulings", () => {
    const store = createGraphStore(":memory:");
    const open = store.attest({
      context: scribe(["arrival:promise"]),
      claim: {
        kind: "entity",
        input: {
          type: "commitment",
          properties: { description: "Ship it", status: "open" },
          confidence: 1,
        },
      },
    });
    const weakDone = store.attest({
      context: scribe(["arrival:maybe-done"]),
      claim: {
        kind: "entity",
        input: {
          type: "commitment",
          properties: { description: "Ship it", status: "done" },
          confidence: 0.1,
        },
      },
    });
    if (open.kind !== "entity" || weakDone.kind !== "entity") throw new Error("Expected Entity Attestations.");
    expect(store.getEntity(open.entity.entityId)).toMatchObject({
      properties: { description: "Ship it", status: "open" },
      confidence: 1,
    });

    expect(() =>
      store.attest({
        context: scribe(["arrival:not-authority"]),
        claim: { kind: "ruling", action: "overrule", targetAttestationId: open.attestation.id },
      }),
    ).toThrow(/Only the Brain/u);
    store.attest({
      context: brain(["arrival:operator-overrule"]),
      claim: { kind: "ruling", action: "overrule", targetAttestationId: open.attestation.id },
    });
    expect(store.getEntity(open.entity.entityId)?.properties).toMatchObject({
      description: "Ship it",
      status: "done",
    });
    expect(store.getEntity(open.entity.entityId)?.confidence).toBeCloseTo(0.1);
    const confirmation = store.attest({
      context: brain(["arrival:operator-confirm"]),
      claim: { kind: "ruling", action: "confirm", targetAttestationId: weakDone.attestation.id },
    });
    if (confirmation.kind !== "ruling") throw new Error("Expected a Brain ruling.");
    expect(store.getEntity(open.entity.entityId)).toMatchObject({
      properties: { description: "Ship it", status: "done" },
      confidence: 1,
      attestationIds: expect.arrayContaining([weakDone.attestation.id, confirmation.attestation.id]),
    });
    expect(store.attestations()).toHaveLength(4);
    store.close();
  });

  it("keeps every partially corrected property tied to its actual supporting Attestations", () => {
    const store = createGraphStore(":memory:");
    const original = store.attest({
      context: scribe(["arrival:original"]),
      claim: {
        kind: "entity",
        input: {
          type: "commitment",
          properties: { description: "Ship the old plan", status: "open" },
          confidence: 0.8,
        },
      },
    });
    if (original.kind !== "entity") throw new Error("Expected an Entity Attestation.");
    const correction = store.attest({
      context: scribe(["arrival:correction"]),
      claim: {
        kind: "entity",
        input: {
          id: original.entity.entityId,
          type: "commitment",
          properties: { description: "Ship the corrected plan" },
          confidence: 0.9,
        },
      },
    });
    if (correction.kind !== "entity") throw new Error("Expected a correction Attestation.");
    expect(correction.entity).toMatchObject({
      properties: { description: "Ship the corrected plan", status: "open" },
      confidence: 0.8,
      attestationIds: expect.arrayContaining([original.attestation.id, correction.attestation.id]),
    });
    store.close();
  });

  it("resolves type disagreement inside one identity-owned Entity", () => {
    const store = createGraphStore(":memory:");
    const identity = { platform: "github" as const, externalId: "same-login" };
    const person = store.attest({
      context: scribe(["arrival:person"]),
      claim: { kind: "entity", input: { type: "person", properties: { name: "Alex" }, identity, confidence: 0.9 } },
    });
    const agent = store.attest({
      context: scribe(["arrival:agent"]),
      claim: { kind: "entity", input: { type: "agent", properties: { name: "Alex bot" }, identity, confidence: 0.1 } },
    });
    if (person.kind !== "entity" || agent.kind !== "entity") throw new Error("Expected Entity Attestations.");
    expect(agent.entity.entityId).toBe(person.entity.entityId);
    expect(store.findEntities({}).map(({ entityId }) => entityId)).toEqual([person.entity.entityId]);
    expect(store.resolveIdentity("github", "same-login")?.type).toBe("person");

    store.attest({
      context: brain(["arrival:brain-type-ruling"]),
      claim: { kind: "entity", input: { type: "agent", properties: { name: "Alex bot" }, identity, confidence: 0.1 } },
    });
    expect(store.resolveIdentity("github", "same-login")?.type).toBe("agent");
    store.close();
  });

  it("keeps a direct-message Thread distinct from the actor with the same WhatsApp id", () => {
    const store = createGraphStore(":memory:");
    const externalId = "alice@s.whatsapp.net";
    const person = store.attest({
      context: scribe(["arrival:dm:person"]),
      claim: {
        kind: "entity",
        input: {
          type: "person",
          properties: { name: "Alice" },
          identity: { platform: "whatsapp", externalId },
        },
      },
    });
    const thread = store.attest({
      context: scribe(["arrival:dm:thread"]),
      claim: {
        kind: "entity",
        input: {
          type: "thread",
          properties: { chatId: externalId },
          identity: { platform: "whatsapp", externalId },
        },
      },
    });
    if (person.kind !== "entity" || thread.kind !== "entity") throw new Error("Expected Entity Attestations.");

    expect(person.entity.entityId).not.toBe(thread.entity.entityId);
    expect(store.resolveIdentity("whatsapp", externalId, "person")?.entityId).toBe(person.entity.entityId);
    expect(store.resolveIdentity("whatsapp", externalId, "agent")?.entityId).toBe(person.entity.entityId);
    expect(store.resolveIdentity("whatsapp", externalId, "thread")?.entityId).toBe(thread.entity.entityId);
    store.close();
  });

  it("lets the Brain overrule an incorrect merge and restores both projected Entities", () => {
    const store = createGraphStore(":memory:");
    const entity = (externalId: string) => {
      const result = store.attest({
        context: brain([`arrival:${externalId}`]),
        claim: {
          kind: "entity",
          input: {
            type: "person",
            properties: { name: externalId },
            identity: { platform: "github", externalId },
          },
        },
      });
      if (result.kind !== "entity") throw new Error("Expected an Entity Attestation.");
      return result;
    };
    const survivor = entity("alice");
    const loser = entity("bob");
    const merge = store.attest({
      context: brain(["arrival:bad-merge"]),
      claim: { kind: "merge", survivorId: survivor.entity.entityId, loserId: loser.entity.entityId },
    });
    expect(store.getEntity(loser.entity.entityId)).toBeUndefined();
    store.attest({
      context: brain(["arrival:merge-overrule"]),
      claim: { kind: "ruling", action: "overrule", targetAttestationId: merge.attestation.id },
    });
    expect(store.getEntity(survivor.entity.entityId)).toBeDefined();
    expect(store.getEntity(loser.entity.entityId)).toBeDefined();
    expect(store.resolveIdentity("github", "bob")?.entityId).toBe(loser.entity.entityId);
    store.close();
  });

  it("projects a Brain confirmation as support for a merge", () => {
    const store = createGraphStore(":memory:");
    const entity = (externalId: string) => {
      const result = store.attest({
        context: brain([`arrival:${externalId}`]),
        claim: {
          kind: "entity",
          input: {
            type: "person",
            properties: { name: externalId },
            identity: { platform: "github", externalId },
          },
        },
      });
      if (result.kind !== "entity") throw new Error("Expected an Entity Attestation.");
      return result;
    };
    const survivor = entity("alice-confirmed");
    const loser = entity("alice-alias-confirmed");
    const merge = store.attest({
      context: brain(["arrival:merge"]),
      claim: { kind: "merge", survivorId: survivor.entity.entityId, loserId: loser.entity.entityId },
    });
    const confirmation = store.attest({
      context: brain(["arrival:merge-confirmation"]),
      claim: { kind: "ruling", action: "confirm", targetAttestationId: merge.attestation.id },
    });
    expect(store.getEntity(survivor.entity.entityId)?.attestationIds).toEqual(
      expect.arrayContaining([merge.attestation.id, confirmation.attestation.id]),
    );
    store.close();
  });

  it("returns immutable receipts when exact retries were later overruled", () => {
    const store = createGraphStore(":memory:");
    const entityDraft = {
      context: scribe(["arrival:entity"]),
      claim: {
        kind: "entity" as const,
        input: { type: "topic" as const, properties: { label: "obsolete" }, confidence: 0.5 },
      },
    };
    const entity = store.attest(entityDraft);
    if (entity.kind !== "entity") throw new Error("Expected an Entity Attestation.");
    store.attest({
      context: brain(["arrival:entity-overrule"]),
      claim: { kind: "ruling", action: "overrule", targetAttestationId: entity.attestation.id },
    });
    expect(store.attest(entityDraft)).toMatchObject({
      kind: "entity-receipt",
      attestation: { id: entity.attestation.id },
    });

    const from = store.attest({
      context: brain(["arrival:from"]),
      claim: { kind: "entity", input: { type: "topic", properties: { label: "from" } } },
    });
    const to = store.attest({
      context: brain(["arrival:to"]),
      claim: { kind: "entity", input: { type: "topic", properties: { label: "to" } } },
    });
    if (from.kind !== "entity" || to.kind !== "entity") throw new Error("Expected Entity Attestations.");
    const relationDraft = {
      context: scribe(["arrival:relation"]),
      claim: {
        kind: "relation" as const,
        input: { fromId: from.entity.entityId, relation: "mentions" as const, toId: to.entity.entityId },
      },
    };
    const relation = store.attest(relationDraft);
    if (relation.kind !== "relation") throw new Error("Expected a Relation Attestation.");
    store.attest({
      context: brain(["arrival:relation-overrule"]),
      claim: { kind: "ruling", action: "overrule", targetAttestationId: relation.attestation.id },
    });
    expect(store.attest(relationDraft)).toMatchObject({
      kind: "relation-receipt",
      attestation: { id: relation.attestation.id },
    });
    store.close();
  });

  it("returns an immutable merge receipt when its projected survivor no longer exists", () => {
    const store = createGraphStore(":memory:");
    const entityDraft = (label: string) => ({
      context: scribe([`arrival:${label}`]),
      claim: { kind: "entity" as const, input: { type: "topic" as const, properties: { label } } },
    });
    const survivorDraft = entityDraft("survivor-that-will-disappear");
    const loserDraft = entityDraft("loser-that-will-disappear");
    const survivor = store.attest(survivorDraft);
    const loser = store.attest(loserDraft);
    if (survivor.kind !== "entity" || loser.kind !== "entity") throw new Error("Expected Entity Attestations.");
    const mergeDraft = {
      context: brain(["arrival:merge-receipt"]),
      claim: { kind: "merge" as const, survivorId: survivor.entity.entityId, loserId: loser.entity.entityId },
    };
    const merge = store.attest(mergeDraft);
    store.attest({
      context: brain(["arrival:overrule-survivor"]),
      claim: { kind: "ruling", action: "overrule", targetAttestationId: survivor.attestation.id },
    });
    store.attest({
      context: brain(["arrival:overrule-loser"]),
      claim: { kind: "ruling", action: "overrule", targetAttestationId: loser.attestation.id },
    });

    expect(store.attest(mergeDraft)).toMatchObject({
      kind: "merge-receipt",
      attestation: { id: merge.attestation.id },
      survivorId: survivor.entity.entityId,
    });
    store.close();
  });

  it("deduplicates merge and pre-merge Relation retries after the loser leaves the Projection", () => {
    const store = createGraphStore(":memory:");
    const entity = (externalId: string) => {
      const result = store.attest({
        context: brain([`test:${externalId}`]),
        claim: {
          kind: "entity",
          input: {
            type: "person",
            properties: { name: externalId },
            identity: { platform: "github", externalId },
          },
        },
      });
      if (result.kind !== "entity") throw new Error("Expected an Entity Attestation.");
      return result;
    };
    const survivor = entity("alice");
    const loser = entity("alice-alt");
    const topic = store.attest({
      context: brain(["test:topic"]),
      claim: { kind: "entity", input: { type: "topic", properties: { label: "memory" } } },
    });
    if (topic.kind !== "entity") throw new Error("Expected a Topic Attestation.");
    const relationDraft = {
      context: brain(["test:relation"]),
      claim: {
        kind: "relation" as const,
        input: { fromId: loser.entity.entityId, relation: "interested_in" as const, toId: topic.entity.entityId },
      },
    };
    const relation = store.attest(relationDraft);
    const mergeDraft = {
      context: brain(["test:merge"]),
      claim: { kind: "merge" as const, survivorId: survivor.entity.entityId, loserId: loser.entity.entityId },
    };
    const merge = store.attest(mergeDraft);
    const mergeRetry = store.attest(mergeDraft);
    const relationRetry = store.attest(relationDraft);
    expect(mergeRetry.attestation.id).toBe(merge.attestation.id);
    expect(relationRetry.attestation.id).toBe(relation.attestation.id);
    expect(store.relationsFrom(survivor.entity.entityId, "interested_in")).toHaveLength(1);
    expect(store.getEntity(survivor.entity.entityId)?.attestationIds).toContain(merge.attestation.id);
    store.close();
  });

  it("keeps corrections immutable while projecting the latest supported properties", () => {
    const store = createGraphStore(":memory:");
    const context = scribe(["arrival:chat:open"], "scribe-batch:open");
    const first = store.attest({
      context,
      claim: {
        kind: "entity",
        input: {
          type: "commitment",
          properties: { description: "Ship it", status: "open" },
          confidence: 0.6,
        },
      },
    });
    if (first.kind !== "entity") throw new Error("Expected an Entity Attestation.");
    store.attest({
      context: scribe(["arrival:chat:done"], "scribe-batch:done"),
      claim: {
        kind: "entity",
        input: {
          type: "commitment",
          properties: { description: "Ship it", status: "done" },
          confidence: 0.8,
        },
      },
    });

    expect(store.getEntity(first.entity.entityId)?.properties.status).toBe("done");
    expect(store.attestations()).toHaveLength(2);
    expect(store.attestations().map(({ evidenceIds }) => evidenceIds)).toEqual([
      ["arrival:chat:open"],
      ["arrival:chat:done"],
    ]);
    store.close();
  });

  it("rebuilds the same Belief Projection from Attestations after projection loss", () => {
    const root = mkdtempSync(join(tmpdir(), "graph-attestations-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const store = createGraphStore(path);
    const person = store.attest({
      context: scribe(["arrival:chat:person"]),
      claim: {
        kind: "entity",
        input: {
          type: "person",
          properties: { name: "Alice" },
          identity: { platform: "whatsapp", externalId: "alice@s.whatsapp.net" },
          confidence: 0.7,
        },
      },
    });
    if (person.kind !== "entity") throw new Error("Expected a Person Attestation.");
    const thread = store.attest({
      context: scribe(["arrival:chat:thread"]),
      claim: {
        kind: "entity",
        input: {
          type: "thread",
          properties: { chatId: "chat@g.us" },
          identity: { platform: "whatsapp", externalId: "chat@g.us" },
          confidence: 0.9,
        },
      },
    });
    if (thread.kind !== "entity") throw new Error("Expected a Thread Attestation.");
    store.attest({
      context: scribe(["arrival:chat:relation"]),
      claim: {
        kind: "relation",
        input: {
          fromId: person.entity.entityId,
          relation: "participates_in",
          toId: thread.entity.entityId,
          confidence: 0.8,
        },
      },
    });
    store.close();

    const database = new DatabaseSync(path);
    database.exec("DELETE FROM graph_relations; DELETE FROM graph_identities; DELETE FROM graph_entities;");
    database.close();

    const rebuilt = createGraphStore(path);
    expect(rebuilt.resolveIdentity("whatsapp", "alice@s.whatsapp.net")?.entityId).toBe(person.entity.entityId);
    expect(rebuilt.relationsFrom(person.entity.entityId, "participates_in")).toHaveLength(1);
    expect(rebuilt.attestations()).toHaveLength(3);
    rebuilt.close();
  });

  it("rejects claims without a non-empty trusted Evidence Set", () => {
    const store = createGraphStore(":memory:");
    expect(() =>
      store.attest({
        context: scribe([]),
        claim: { kind: "entity", input: { type: "topic", properties: { label: "memory" } } },
      }),
    ).toThrow(/Evidence Set/u);
    store.close();
  });

  it("enforces immutability in SQLite, below the application API", () => {
    const root = mkdtempSync(join(tmpdir(), "graph-immutable-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const store = createGraphStore(path);
    store.attest({
      context: scribe(["arrival:chat:message"]),
      claim: { kind: "entity", input: { type: "topic", properties: { label: "memory" } } },
    });
    store.close();

    const database = new DatabaseSync(path);
    expect(() => database.exec("UPDATE graph_attestations SET confidence = 1")).toThrow(/immutable/u);
    expect(() => database.exec("DELETE FROM graph_attestations")).toThrow(/immutable/u);
    database.close();
  });

  it("resolves a GitHub event's origin delivery id as provenance on a derived Graph fact (§10)", () => {
    const root = mkdtempSync(join(tmpdir(), "graph-github-provenance-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    // brain_github_events lives in the same application DB the graph store reads its provenance from.
    createConversationArchive(path).close();
    const inbox = createBrainInbox(path, { providerChatIdForSurface: () => undefined });
    const event = inbox.admitGitHubEvent({
      githubAppId: "app-planner",
      deliveryId: "gh-delivery-42",
      eventName: "issues",
      action: "opened",
      repository: "acme/widgets",
      summary: "Issue #7 opened in acme/widgets",
      detail: { issue: { number: 7 } },
    });
    inbox.close();

    const store = createGraphStore(path);
    store.attest({
      context: brain([event.id]),
      claim: {
        kind: "entity",
        input: {
          type: "repository",
          properties: { repo: "acme/widgets" },
          identity: { platform: "github", externalId: "acme/widgets" },
        },
      },
    });
    // The derived fact carries the origin webhook delivery id — GitHub-origin facts stay provenance-complete.
    expect(store.resolveIdentity("github", "acme/widgets", "repository")).toMatchObject({
      provenance: { deliveryId: "gh-delivery-42" },
    });
    store.close();
  });

  it("migrates the shipped mutable Projection into explicit legacy Attestations once", () => {
    const root = mkdtempSync(join(tmpdir(), "graph-legacy-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE graph_entities (
        entity_id TEXT PRIMARY KEY, type TEXT NOT NULL, properties_json TEXT NOT NULL,
        confidence REAL NOT NULL, source_chat_id TEXT, source_message_id TEXT,
        source_delivery_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE graph_relations (
        relation_id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
        relation TEXT NOT NULL, to_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
        confidence REAL NOT NULL, source_chat_id TEXT, source_message_id TEXT,
        source_delivery_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (from_id, relation, to_id)
      ) STRICT;
      CREATE TABLE graph_identities (
        platform TEXT NOT NULL, external_id TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES graph_entities(entity_id), display_name TEXT,
        PRIMARY KEY (platform, external_id)
      ) STRICT;
      CREATE TABLE conversation_events (
        event_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, provider_message_id TEXT NOT NULL
      ) STRICT;
      INSERT INTO conversation_events VALUES (
        'arrival:chat@g.us:message-1', 'chat@g.us', 'message-1'
      );
      INSERT INTO graph_entities VALUES (
        'person_legacy', 'person', '{"name":"Alice"}', 0.7,
        'chat@g.us', 'message-1', NULL, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z'
      );
      INSERT INTO graph_entities VALUES (
        'person_unverified', 'person', '{"name":"Rumour"}', 0.9,
        NULL, NULL, NULL, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z'
      );
      INSERT INTO graph_identities VALUES (
        'whatsapp', 'alice@s.whatsapp.net', 'person_legacy', 'Alice'
      );
    `);
    legacy.close();

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const migrated = createGraphStore(path);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("dropped legacy Entity person_unverified"));
    warning.mockRestore();
    expect(migrated.resolveIdentity("whatsapp", "alice@s.whatsapp.net")).toMatchObject({
      entityId: "person_legacy",
      confidence: 0.7,
      provenance: { chatId: "chat@g.us", messageId: "message-1" },
    });
    expect(migrated.attestations()).toHaveLength(3);
    expect(migrated.getEntity("person_unverified")).toBeUndefined();
    expect(migrated.attestations()[0]).toMatchObject({
      author: { kind: "migration", id: "legacy-graph" },
      evidenceIds: ["arrival:chat@g.us:message-1"],
    });
    const seenAgain = migrated.attest({
      context: scribe(["arrival:chat@g.us:message-2"]),
      claim: {
        kind: "entity",
        input: {
          type: "person",
          properties: { name: "Alice" },
          identity: { platform: "whatsapp", externalId: "alice@s.whatsapp.net" },
          confidence: 0.5,
        },
      },
    });
    if (seenAgain.kind !== "entity") throw new Error("Expected a migrated Entity Attestation.");
    expect(seenAgain.entity.entityId).toBe("person_legacy");
    migrated.close();

    const reopened = createGraphStore(path);
    expect(reopened.attestations()).toHaveLength(4);
    reopened.close();
  });
});
