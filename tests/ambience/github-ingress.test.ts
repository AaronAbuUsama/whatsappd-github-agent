import { describe, expect, it } from "vite-plus/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GitHubWebhookDelivery } from "@flue/github";

import { createGitHubIngress, loadGitHubIngressSettings } from "../../src/github/ingress.ts";
import { createGitHubIngressStore } from "../../src/github/ingress-store.ts";

const issueOpenedDelivery = (deliveryId: string): GitHubWebhookDelivery =>
  ({
    name: "issues",
    deliveryId,
    payload: {
      action: "opened",
      repository: {
        id: 101,
        name: "widgets",
        html_url: "https://github.com/acme/widgets",
        owner: { login: "acme" },
      },
      issue: {
        number: 29,
        html_url: "https://github.com/acme/widgets/issues/29",
        title: "Admission proof",
        state: "open",
      },
      sender: { login: "octocat", id: 1, type: "User" },
    },
  }) as GitHubWebhookDelivery;

describe("GitHub ingress configuration", () => {
  it("loads explicit repository ownership without guessing case-sensitive GitHub identity", () => {
    const settings = loadGitHubIngressSettings({
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_CHAT_ROUTES: "Acme/Widgets=chat-a@g.us,acme/other=chat-b@g.us",
      APPLICATION_DB_PATH: ":memory:",
    });

    expect(settings.routes).toEqual(
      new Map([
        ["acme/widgets", "chat-a@g.us"],
        ["acme/other", "chat-b@g.us"],
      ]),
    );
    expect(settings.databasePath).toBe(":memory:");
  });

  it("fails closed without a secret or any repository-to-chat ownership", () => {
    expect(() => loadGitHubIngressSettings({ GITHUB_CHAT_ROUTES: "acme/widgets=chat@g.us" })).toThrow(
      "GITHUB_WEBHOOK_SECRET",
    );
    expect(() => loadGitHubIngressSettings({ GITHUB_WEBHOOK_SECRET: "secret" })).toThrow(
      "At least one GitHub chat route",
    );
  });

  it("shares the application database unless the managed composition supplies the same path explicitly", () => {
    expect(
      loadGitHubIngressSettings({
        GITHUB_WEBHOOK_SECRET: "secret",
        GITHUB_REPO: "acme/widgets",
        WHATSAPP_GROUP_ID: "chat@g.us",
        APPLICATION_DB_PATH: "/managed/application.sqlite",
      }).databasePath,
    ).toBe("/managed/application.sqlite");
    expect(
      loadGitHubIngressSettings({
        GITHUB_WEBHOOK_SECRET: "secret",
        GITHUB_REPO: "acme/widgets",
        WHATSAPP_GROUP_ID: "chat@g.us",
      }).databasePath,
    ).toBe("./application.sqlite");
    expect(
      loadGitHubIngressSettings({
        GITHUB_WEBHOOK_SECRET: "secret",
        GITHUB_REPO: "acme/widgets",
        WHATSAPP_GROUP_ID: "chat@g.us",
        APPLICATION_DB_PATH: "/managed/application.sqlite",
        GITHUB_INGRESS_DB_PATH: "/legacy/github-ingress.db",
      }),
    ).toMatchObject({
      databasePath: "/managed/application.sqlite",
      legacyDatabasePath: "/legacy/github-ingress.db",
    });
  });
});

describe("GitHub ingress delivery ledger", () => {
  it("atomically claims a delivery identifier only once and persists correlation", () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:00.000Z")).toBe(true);
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:01.000Z")).toBe(false);

      store.beginDispatch("delivery-29", "acme/widgets", "chat-29@g.us");
      store.settle("delivery-29", {
        status: "dispatched",
        repository: "acme/widgets",
        chatId: "chat-29@g.us",
        ambience: "ambience",
        dispatchId: "dispatch-29",
        acceptedAt: "2026-07-13T00:00:01.000Z",
        settledAt: "2026-07-13T00:00:02.000Z",
      });

      expect(store.get("delivery-29")).toEqual({
        deliveryId: "delivery-29",
        eventName: "issues",
        repository: "acme/widgets",
        chatId: "chat-29@g.us",
        ambience: "ambience",
        dispatchId: "dispatch-29",
        acceptedAt: "2026-07-13T00:00:01.000Z",
        status: "dispatched",
        receivedAt: "2026-07-13T00:00:00.000Z",
        settledAt: "2026-07-13T00:00:02.000Z",
      });
    } finally {
      store.close();
    }
  });

  it("surfaces an interrupted claim as uncertain without blind redispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-github-ingress-"));
    const path = join(root, "application.sqlite");
    const interrupted = createGitHubIngressStore(path, () => new Date("2026-07-13T00:00:00.000Z"));
    interrupted.claim("interrupted-29", "issues", "2026-07-13T00:00:00.000Z");
    interrupted.beginDispatch("interrupted-29", "acme/widgets", "chat-29@g.us");
    interrupted.close();
    const store = createGitHubIngressStore(path, () => new Date("2026-07-13T00:00:01.000Z"));
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        routes: new Map([["acme/widgets", "chat-29@g.us"]]),
        dispatch: async () => {
          admissions += 1;
          return { dispatchId: "must-not-dispatch", acceptedAt: "2026-07-13T00:00:00.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        now: () => new Date("2026-07-13T00:00:01.000Z"),
      });

      const result = await ingress({
        name: "issues",
        deliveryId: "interrupted-29",
        payload: { action: "opened" },
      } as GitHubWebhookDelivery);

      expect(result.status).toBe("uncertain");
      expect(admissions).toBe(0);
      expect(store.get("interrupted-29")).toMatchObject({
        status: "uncertain",
        error: "Process ended after Ambience admission began; outcome unknown",
      });
      expect(
        (
          await ingress({
            name: "issues",
            deliveryId: "interrupted-29",
            payload: { action: "opened" },
          } as GitHubWebhookDelivery)
        ).status,
      ).toBe("uncertain");
      expect(admissions).toBe(0);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("safely resumes a received delivery after restart and records dispatching before Flue", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-github-ingress-resume-"));
    const path = join(root, "application.sqlite");
    const beforeRestart = createGitHubIngressStore(path);
    beforeRestart.claim("resume-56", "issues", "2026-07-15T00:00:00.000Z");
    beforeRestart.close();
    const store = createGitHubIngressStore(path);
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        routes: new Map([["acme/widgets", "chat-56@g.us"]]),
        dispatch: async () => {
          admissions += 1;
          expect(store.get("resume-56")).toMatchObject({
            status: "dispatching",
            repository: "acme/widgets",
            chatId: "chat-56@g.us",
          });
          return { dispatchId: "dispatch-56", acceptedAt: "2026-07-15T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        now: () => new Date("2026-07-15T00:00:02.000Z"),
      });

      await expect(ingress(issueOpenedDelivery("resume-56"))).resolves.toMatchObject({
        status: "dispatched",
        dispatchId: "dispatch-56",
      });
      expect(admissions).toBe(1);
      expect(store.get("resume-56")).toMatchObject({ status: "dispatched", dispatchId: "dispatch-56" });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a dispatching failure as uncertain and never automatically repeats it", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        routes: new Map([["acme/widgets", "chat-56@g.us"]]),
        dispatch: async () => {
          admissions += 1;
          throw new Error("Flue response was lost");
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(ingress(issueOpenedDelivery("uncertain-56"))).rejects.toThrow("Flue response was lost");
      expect(store.get("uncertain-56")).toMatchObject({
        status: "uncertain",
        repository: "acme/widgets",
        chatId: "chat-56@g.us",
      });
      await expect(ingress(issueOpenedDelivery("uncertain-56"))).resolves.toMatchObject({ status: "uncertain" });
      expect(admissions).toBe(1);
    } finally {
      store.close();
    }
  });

  it("deduplicates a concurrent redelivery without disturbing the active admission", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        routes: new Map([["acme/widgets", "chat-56@g.us"]]),
        dispatch: async () => {
          admissions += 1;
          await gate;
          return { dispatchId: "dispatch-concurrent", acceptedAt: "2026-07-15T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      const first = ingress(issueOpenedDelivery("concurrent-56"));
      await expect(ingress(issueOpenedDelivery("concurrent-56"))).resolves.toMatchObject({
        status: "duplicate",
        record: { status: "dispatching" },
      });
      release();
      await expect(first).resolves.toMatchObject({ status: "dispatched", dispatchId: "dispatch-concurrent" });
      expect(admissions).toBe(1);
    } finally {
      store.close();
    }
  });

  it("migrates the predecessor ledger conservatively without losing settled delivery evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-github-ingress-migration-"));
    const path = join(root, "application.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE github_ingress_deliveries (
          delivery_id TEXT PRIMARY KEY,
          event_name TEXT NOT NULL,
          repository TEXT,
          chat_id TEXT,
          ambience TEXT,
          dispatch_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('received', 'unsupported', 'uncorrelated', 'dispatched', 'uncertain', 'failed')),
          error TEXT,
          received_at TEXT NOT NULL,
          settled_at TEXT
        ) STRICT;
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, status, received_at)
        VALUES ('legacy-unknown', 'issues', 'received', '2026-07-14T00:00:00.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, dispatch_id, status, received_at, settled_at)
        VALUES ('legacy-dispatched', 'issues', 'acme/widgets', 'chat@g.us', 'ambience', 'dispatch-old',
                'dispatched', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z');
      `);
      legacy.close();

      const store = createGitHubIngressStore(path, () => new Date("2026-07-15T00:00:00.000Z"));
      expect(store.get("legacy-unknown")).toMatchObject({
        status: "uncertain",
        error: "Legacy ingress record predates the dispatching boundary; admission outcome unknown",
      });
      expect(store.get("legacy-dispatched")).toMatchObject({
        status: "dispatched",
        dispatchId: "dispatch-old",
      });
      expect(store.claim("new-delivery", "issues", "2026-07-15T00:00:00.000Z")).toBe(true);
      store.beginDispatch("new-delivery", "acme/widgets", "chat@g.us");
      expect(store.get("new-delivery")).toMatchObject({ status: "dispatching" });
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports the advertised standalone ledger once into application.sqlite and retains the source as backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-github-ingress-cutover-"));
    const legacyPath = join(root, "data", "github-ingress.db");
    const applicationPath = join(root, "application.sqlite");
    const previousDirectory = process.cwd();
    try {
      await mkdir(join(root, "data"));
      const legacy = new DatabaseSync(legacyPath);
      legacy.exec(`
        CREATE TABLE github_ingress_deliveries (
          delivery_id TEXT PRIMARY KEY,
          event_name TEXT NOT NULL,
          repository TEXT,
          chat_id TEXT,
          ambience TEXT,
          dispatch_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('received', 'unsupported', 'uncorrelated', 'dispatched', 'uncertain', 'failed')),
          error TEXT,
          received_at TEXT NOT NULL,
          settled_at TEXT
        ) STRICT;
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, status, received_at)
        VALUES ('legacy-in-flight', 'issues', 'received', '2026-07-14T00:00:00.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, dispatch_id, status, received_at, settled_at)
        VALUES ('legacy-complete', 'issues', 'acme/widgets', 'chat@g.us', 'ambience', 'dispatch-complete',
                'dispatched', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z');
      `);
      legacy.close();

      process.chdir(root);
      const settings = loadGitHubIngressSettings({
        GITHUB_WEBHOOK_SECRET: "secret",
        GITHUB_REPO: "acme/widgets",
        WHATSAPP_GROUP_ID: "chat@g.us",
        APPLICATION_DB_PATH: applicationPath,
      });
      expect(settings).toMatchObject({
        databasePath: applicationPath,
        legacyDatabasePath: "./data/github-ingress.db",
      });
      const store = createGitHubIngressStore(
        settings.databasePath,
        () => new Date("2026-07-15T00:00:00.000Z"),
        settings.legacyDatabasePath,
      );
      expect(store.get("legacy-in-flight")).toMatchObject({
        status: "uncertain",
        error: "Imported legacy ingress attempt; admission outcome unknown",
      });
      expect(store.get("legacy-complete")).toMatchObject({
        status: "dispatched",
        dispatchId: "dispatch-complete",
      });
      store.close();

      const reopened = createGitHubIngressStore(settings.databasePath, undefined, settings.legacyDatabasePath);
      expect(reopened.list()).toHaveLength(2);
      reopened.close();
      const backup = new DatabaseSync(legacyPath, { readOnly: true });
      expect(
        backup.prepare("SELECT status FROM github_ingress_deliveries WHERE delivery_id = 'legacy-in-flight'").get(),
      ).toEqual({ status: "received" });
      backup.close();
    } finally {
      process.chdir(previousDirectory);
      await rm(root, { recursive: true, force: true });
    }
  });
});
