import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createBrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Reproduces a pre-#317 install: brain_effects without 'file_issue' in its kind CHECK, plus real
// surface_deliveries/directive_outcomes rows FK-bound to it — exactly the shape the live capxul-vps
// install was in before this migration was fixed.
const seedPreMigrationDatabase = (databasePath: string): void => {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE brain_batches (
      batch_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      dispatch_id TEXT,
      accepted_at TEXT,
      settled_at TEXT
    ) STRICT;
    CREATE TABLE brain_effects (
      effect_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES brain_batches(batch_id),
      kind TEXT NOT NULL CHECK (kind IN ('prompt_speaker', 'stay_silent')),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'completed')),
      dispatch_id TEXT,
      accepted_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE surfaces (
      surface_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE surface_deliveries (
      delivery_id TEXT PRIMARY KEY,
      directive_id TEXT NOT NULL UNIQUE REFERENCES brain_effects(effect_id),
      surface_id TEXT NOT NULL REFERENCES surfaces(surface_id),
      provider_chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('attempting', 'sent', 'failed', 'uncertain')),
      provider_message_id TEXT,
      conversation_event_id TEXT,
      error TEXT,
      attempted_at TEXT NOT NULL,
      settled_at TEXT
    ) STRICT;
    CREATE TABLE directive_outcomes (
      directive_id TEXT PRIMARY KEY REFERENCES brain_effects(effect_id),
      delivery_id TEXT UNIQUE REFERENCES surface_deliveries(delivery_id),
      surface_id TEXT NOT NULL REFERENCES surfaces(surface_id),
      status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'uncertain', 'settled_without_say')),
      provider_message_id TEXT,
      conversation_event_id TEXT,
      detail TEXT,
      settled_at TEXT NOT NULL
    ) STRICT;

    INSERT INTO brain_batches (batch_id, created_at) VALUES ('batch:1', '2026-01-01T00:00:00.000Z');
    INSERT INTO surfaces (surface_id, created_at) VALUES ('surface:team', '2026-01-01T00:00:00.000Z');
    INSERT INTO brain_effects
      (effect_id, batch_id, kind, payload_json, status, dispatch_id, accepted_at, completed_at, created_at)
    VALUES
      ('effect:1', 'batch:1', 'prompt_speaker', '{}', 'completed', 'dispatch:1',
       '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO surface_deliveries
      (delivery_id, directive_id, surface_id, provider_chat_id, text, status, provider_message_id, attempted_at, settled_at)
    VALUES
      ('delivery:1', 'effect:1', 'surface:team', 'team@g.us', 'hello', 'sent', 'wamid:1',
       '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z');
    INSERT INTO directive_outcomes
      (directive_id, delivery_id, surface_id, status, provider_message_id, settled_at)
    VALUES
      ('effect:1', 'delivery:1', 'surface:team', 'delivered', 'wamid:1', '2026-01-01T00:00:02.000Z');
  `);
  db.close();
};

describe("brain_effects file_issue migration", () => {
  it("preserves existing surface_deliveries and directive_outcomes rows and their FK linkage", () => {
    const root = mkdtempSync(join(tmpdir(), "ambient-brain-migration-"));
    roots.push(root);
    const databasePath = join(root, "application.sqlite");
    // createBrainInbox prepares statements against conversation_events, owned by the Archive.
    createConversationArchive(databasePath).close();
    seedPreMigrationDatabase(databasePath);

    // Triggers the rename-copy-drop migration on open.
    createBrainInbox(databasePath, { providerChatIdForSurface: () => "team@g.us" });

    const verify = new DatabaseSync(databasePath);
    const effectsSql = (
      verify.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'brain_effects'").get() as {
        sql: string;
      }
    ).sql;
    expect(effectsSql).toContain("'file_issue'");

    expect(verify.prepare("SELECT * FROM surface_deliveries WHERE delivery_id = 'delivery:1'").get()).toMatchObject({
      directive_id: "effect:1",
      surface_id: "surface:team",
      status: "sent",
    });
    expect(verify.prepare("SELECT * FROM directive_outcomes WHERE directive_id = 'effect:1'").get()).toMatchObject({
      delivery_id: "delivery:1",
      status: "delivered",
    });

    // The real bug: a naive rename-copy-drop leaves these FKs pointing at the dropped
    // brain_effects_legacy/surface_deliveries_legacy tables. Prove they now resolve against the live
    // tables by inserting a brand-new row that only the CURRENT brain_effects/surface_deliveries satisfy.
    verify.exec(`
      INSERT INTO brain_effects (effect_id, batch_id, kind, payload_json, status, created_at)
      VALUES ('effect:2', 'batch:1', 'file_issue', '{}', 'pending', '2026-01-02T00:00:00.000Z');
      INSERT INTO surface_deliveries
        (delivery_id, directive_id, surface_id, provider_chat_id, text, status, attempted_at)
      VALUES ('delivery:2', 'effect:2', 'surface:team', 'team@g.us', 'second', 'attempting', '2026-01-02T00:00:01.000Z');
      INSERT INTO directive_outcomes (directive_id, delivery_id, surface_id, status, settled_at)
      VALUES ('effect:2', 'delivery:2', 'surface:team', 'delivered', '2026-01-02T00:00:02.000Z');
    `);
    expect(verify.prepare("SELECT count(*) c FROM surface_deliveries").get()).toMatchObject({ c: 2 });
    expect(verify.prepare("SELECT count(*) c FROM directive_outcomes").get()).toMatchObject({ c: 2 });
    verify.close();
  });
});
