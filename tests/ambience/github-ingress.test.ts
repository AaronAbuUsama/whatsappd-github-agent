import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GitHubWebhookDelivery } from "@flue/github";

import { createGitHubIngress } from "../../src/github/ingress.ts";
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

describe("GitHub ingress delivery ledger", () => {
  it("atomically claims a delivery identifier only once and persists correlation", () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:00.000Z")).toBe(true);
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:01.000Z")).toBe(false);

      store.settle("delivery-29", {
        status: "done",
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
        status: "done",
        receivedAt: "2026-07-13T00:00:00.000Z",
        settledAt: "2026-07-13T00:00:02.000Z",
      });
      expect(() =>
        store.settle("delivery-29", { status: "failed", error: "late", settledAt: "2026-07-13T00:00:03.000Z" }),
      ).toThrow("cannot settle as failed");
    } finally {
      store.close();
    }
  });

  it("reprocesses an interrupted received delivery when the provider redelivers it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-github-ingress-"));
    const path = join(root, "application.sqlite");
    const interrupted = createGitHubIngressStore(path);
    interrupted.claim("interrupted-29", "issues", "2026-07-13T00:00:00.000Z");
    interrupted.close();
    const store = createGitHubIngressStore(path);
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        routes: new Map([["acme/widgets", "chat-29@g.us"]]),
        dispatch: async () => {
          admissions += 1;
          return { dispatchId: "dispatch-redelivered", acceptedAt: "2026-07-13T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        now: () => new Date("2026-07-13T00:00:01.000Z"),
      });

      await expect(ingress(issueOpenedDelivery("interrupted-29"))).resolves.toMatchObject({
        status: "done",
        dispatchId: "dispatch-redelivered",
      });
      expect(admissions).toBe(1);
      expect(store.get("interrupted-29")).toMatchObject({ status: "done" });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a failing dispatch within its bound and then settles the delivery as done", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        routes: new Map([["acme/widgets", "chat-56@g.us"]]),
        dispatch: async () => {
          admissions += 1;
          if (admissions < 3) throw new Error("transient Flue failure");
          return { dispatchId: "dispatch-56", acceptedAt: "2026-07-15T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        retry: { attempts: 3, delayMs: () => 0 },
      });

      await expect(ingress(issueOpenedDelivery("retry-56"))).resolves.toMatchObject({
        status: "done",
        dispatchId: "dispatch-56",
      });
      expect(admissions).toBe(3);
      expect(store.get("retry-56")).toMatchObject({ status: "done", dispatchId: "dispatch-56" });
    } finally {
      store.close();
    }
  });

  it("settles an exhausted dispatch as terminally failed and deduplicates its redelivery", async () => {
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
        retry: { attempts: 2, delayMs: () => 0 },
      });

      await expect(ingress(issueOpenedDelivery("failed-56"))).resolves.toMatchObject({
        status: "failed",
        record: { status: "failed", error: "Flue response was lost" },
      });
      expect(admissions).toBe(2);
      expect(store.get("failed-56")).toMatchObject({
        status: "failed",
        repository: "acme/widgets",
        chatId: "chat-56@g.us",
      });
      await expect(ingress(issueOpenedDelivery("failed-56"))).resolves.toMatchObject({ status: "duplicate" });
      expect(admissions).toBe(2);
    } finally {
      store.close();
    }
  });

  it("deduplicates a concurrent redelivery without a second dispatch", async () => {
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
        record: { status: "received" },
      });
      release();
      await expect(first).resolves.toMatchObject({ status: "done", dispatchId: "dispatch-concurrent" });
      expect(admissions).toBe(1);
    } finally {
      store.close();
    }
  });

  it("migrates every predecessor ledger status per the ADR 0014 mapping", async () => {
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
          accepted_at TEXT,
          status TEXT NOT NULL CHECK (status IN ('received', 'dispatching', 'unsupported', 'uncorrelated', 'dispatched', 'uncertain', 'failed')),
          error TEXT,
          received_at TEXT NOT NULL,
          settled_at TEXT
        ) STRICT;
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, status, received_at)
        VALUES ('legacy-received', 'issues', 'received', '2026-07-14T00:00:00.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, status, received_at)
        VALUES ('legacy-dispatching', 'issues', 'acme/widgets', 'chat@g.us', 'ambience', 'dispatching', '2026-07-14T00:00:00.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, status, error, received_at, settled_at)
        VALUES ('legacy-uncertain', 'issues', 'acme/widgets', 'chat@g.us', 'ambience', 'uncertain',
                'Ambience admission outcome unknown', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, dispatch_id, accepted_at, status, received_at, settled_at)
        VALUES ('legacy-dispatched', 'issues', 'acme/widgets', 'chat@g.us', 'ambience', 'dispatch-old',
                '2026-07-14T00:00:00.500Z', 'dispatched', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, status, error, received_at, settled_at)
        VALUES ('legacy-failed', 'issues', 'failed', 'terminal error', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z');
      `);
      legacy.close();

      const store = createGitHubIngressStore(path);
      expect(store.get("legacy-received")).toMatchObject({ status: "received" });
      expect(store.get("legacy-dispatching")).toMatchObject({ status: "received" });
      expect(store.get("legacy-uncertain")).toMatchObject({ status: "received" });
      expect(store.get("legacy-uncertain")?.error).toBeUndefined();
      expect(store.get("legacy-uncertain")?.settledAt).toBeUndefined();
      expect(store.get("legacy-dispatched")).toMatchObject({
        status: "done",
        dispatchId: "dispatch-old",
        acceptedAt: "2026-07-14T00:00:00.500Z",
      });
      expect(store.get("legacy-failed")).toMatchObject({ status: "failed", error: "terminal error" });
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
