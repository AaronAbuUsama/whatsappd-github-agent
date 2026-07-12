import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { Client, SessionState } from "eve/client";
import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubResult } from "../../agent/subagents/github/lib/output-schema.ts";
import delegate from "../../agent/tools/delegate.ts";
import { GatewayStore } from "../../agent/lib/jobs.ts";
import { eveJobLoopback, forkPendingJobs, type JobLoopback } from "../../src/gateway/job-runner.ts";

const dirs: string[] = [];

const temporaryDatabase = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wa-delegation-"));
  dirs.push(dir);
  return join(dir, "gateway.sqlite");
};

afterEach(() => {
  delete process.env.WA_GATEWAY_DB;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("non-blocking delegate", () => {
  it("durably enqueues against the verified voice session and returns started", async () => {
    const path = temporaryDatabase();
    process.env.WA_GATEWAY_DB = path;
    const ctx = { session: { id: "voice-session-1" } } as ToolContext;

    const result = await delegate.execute({ kind: "github", task: "File the login crash." }, ctx);

    expect(result).toMatchObject({ status: "started" });
    const store = new GatewayStore(path);
    expect(store.listJobs()).toEqual([
      expect.objectContaining({
        id: result.jobId,
        voiceSessionId: "voice-session-1",
        task: "File the login crash.",
        status: "pending",
      }),
    ]);
    store.close();
  });

  it("claims only jobs whose verified voice session is mapped to a persisted chat SessionState", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    store.enqueue({ voiceSessionId: "unmapped-session", kind: "github", task: "Wait for correlation." });
    const mappedId = store.enqueue({ voiceSessionId: "voice-session-2", kind: "github", task: "File it." });
    store.set("team@g.us", { sessionId: "voice-session-2", continuationToken: "opaque", streamIndex: 7 });

    expect(store.claimPending(10)).toEqual([
      expect.objectContaining({ id: mappedId, chatId: "team@g.us", status: "running", attempts: 1 }),
    ]);
    expect(store.get("team@g.us")).toEqual({
      sessionId: "voice-session-2",
      continuationToken: "opaque",
      streamIndex: 7,
    });
    expect(store.listJobs().find((job) => job.voiceSessionId === "unmapped-session")?.status).toBe("pending");
    store.close();
  });

  it("reclaims a running job after the store is reopened", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    const id = first.enqueue({ voiceSessionId: "voice-session-3", kind: "github", task: "Survive restart." });
    first.set("team@g.us", { sessionId: "voice-session-3", streamIndex: 2 });
    expect(first.claimPending(1)[0]).toMatchObject({ id, status: "running", attempts: 1 });

    // A delegate tool opens a short-lived connection while the gateway is live;
    // merely opening it must not misclassify active work as crash leftovers.
    const concurrent = new GatewayStore(path);
    expect(concurrent.listJobs()[0]).toMatchObject({ id, status: "running" });
    concurrent.close();
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.reclaimRunning()).toBe(1);
    expect(restarted.listJobs()[0]).toMatchObject({ id, status: "pending", attempts: 1 });
    expect(restarted.claimPending(1)[0]).toMatchObject({ id, status: "running", attempts: 2 });
    restarted.close();
  });
});

describe("gateway job runner", () => {
  it("uses task-mode outputSchema for the worker and full SessionState for report-back", async () => {
    const selectors: Array<SessionState | string | undefined> = [];
    const sends: unknown[] = [];
    const persisted = { sessionId: "voice-real", continuationToken: "not-a-chat-id", streamIndex: 12 };
    const advanced = { ...persisted, streamIndex: 16 };
    let call = 0;
    const client = {
      session(selector?: SessionState | string) {
        selectors.push(selector);
        call += 1;
        return {
          state: call === 1 ? { streamIndex: 0 } : advanced,
          async send(input: unknown) {
            sends.push(input);
            return {
              async result() {
                return call === 1
                  ? {
                      data: {
                        action: "create_issue",
                        number: 88,
                        url: "https://github.com/acme/repo/issues/88",
                        summary: "Filed #88.",
                      },
                      status: "completed",
                      events: [{ type: "subagent.called", data: { name: "github" } }],
                    }
                  : {
                      data: undefined,
                      status: "waiting",
                      events: [
                        {
                          type: "actions.requested",
                          data: {
                            actions: [
                              { kind: "tool-call", toolName: "say", callId: "say-1", input: { text: "Done — #88" } },
                            ],
                          },
                        },
                      ],
                    };
              },
            };
          },
        };
      },
    } as unknown as Client;
    const replies: Array<{ chatId: string; text: string }> = [];
    const loopback = eveJobLoopback(client, async (chatId, text) => {
      replies.push({ chatId, text });
    });
    const job = {
      id: "job-real",
      voiceSessionId: "voice-real",
      chatId: "group@g.us",
      kind: "github" as const,
      task: "File the bug.",
      status: "running" as const,
      attempts: 1,
    };

    expect(await loopback.runGithub(job)).toMatchObject({ number: 88 });
    expect(await loopback.deliverVoice(job, persisted, "worker result")).toEqual(advanced);

    expect(selectors).toEqual([undefined, persisted]);
    expect(sends[0]).toMatchObject({
      message: expect.stringMatching(/declared `github` subagent.*File the bug\./s),
      outputSchema: expect.any(Object),
    });
    expect(replies).toEqual([{ chatId: "group@g.us", text: "Done — #88" }]);
  });

  it("forks workers concurrently but serializes same-chat report-back SessionState", async () => {
    const store = new GatewayStore(temporaryDatabase());
    store.set("alpha@g.us", { sessionId: "voice-alpha", continuationToken: "alpha-token", streamIndex: 4 });
    store.enqueue({ voiceSessionId: "voice-alpha", kind: "github", task: "File alpha." });
    store.enqueue({ voiceSessionId: "voice-alpha", kind: "github", task: "File beta." });

    const releases: Array<() => void> = [];
    const started: string[] = [];
    const delivered: Array<{ state: SessionState; message: string }> = [];
    const loopback: JobLoopback = {
      runGithub: (job) =>
        new Promise<GithubResult>((resolve) => {
          started.push(job.task);
          releases.push(() =>
            resolve({
              action: "create_issue",
              number: job.task.includes("alpha") ? 101 : 202,
              url: `https://github.com/acme/repo/issues/${job.task.includes("alpha") ? 101 : 202}`,
              summary: `Filed ${job.task}`,
            }),
          );
        }),
      deliverVoice: async (_job, state, message) => {
        delivered.push({ state, message });
        return { ...state, streamIndex: state.streamIndex + 1 };
      },
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          expect(yield* forkPendingJobs(store, loopback, 10)).toBe(2);
          yield* Effect.promise(() => expect.poll(() => started.length).toBe(2));
          expect(store.listJobs().map((job) => job.status)).toEqual(["running", "running"]);
          for (const release of releases) release();
          yield* Effect.promise(() => expect.poll(() => store.listJobs().every((job) => job.status === "done")).toBe(true));
        }),
      ),
    );

    expect(delivered.map(({ message }) => message)).toEqual(
      expect.arrayContaining([expect.stringContaining("#101"), expect.stringContaining("#202")]),
    );
    expect(delivered.map(({ state }) => state.streamIndex).sort((a, b) => a - b)).toEqual([4, 5]);
    expect(store.get("alpha@g.us")?.streamIndex).toBe(6);
    store.close();
  });

  it("delivers a worker failure turn instead of silently dropping it", async () => {
    const store = new GatewayStore(temporaryDatabase());
    store.set("fail@g.us", { sessionId: "voice-fail", continuationToken: "fail-token", streamIndex: 3 });
    store.enqueue({ voiceSessionId: "voice-fail", kind: "github", task: "This will fail." });
    const delivered: string[] = [];
    const loopback: JobLoopback = {
      runGithub: async () => {
        throw new Error("GitHub unavailable");
      },
      deliverVoice: async (_job, state, message) => {
        delivered.push(message);
        return { ...state, streamIndex: state.streamIndex + 1 };
      },
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          expect(yield* forkPendingJobs(store, loopback, 10)).toBe(1);
          yield* Effect.promise(() => expect.poll(() => store.listJobs()[0]?.status).toBe("failed"));
        }),
      ),
    );

    expect(delivered).toEqual([expect.stringMatching(/^\[worker FAILED job .+\] GitHub unavailable/)]);
    expect(store.listJobs()[0]).toMatchObject({ status: "failed", error: "GitHub unavailable" });
    store.close();
  });

  it("retries only report-back after delivery fails, never the completed GitHub mutation", async () => {
    const store = new GatewayStore(temporaryDatabase());
    store.set("retry@g.us", { sessionId: "voice-retry", streamIndex: 1 });
    store.enqueue({ voiceSessionId: "voice-retry", kind: "github", task: "Create exactly once." });
    let workerRuns = 0;
    let deliveries = 0;
    const loopback: JobLoopback = {
      runGithub: async () => {
        workerRuns += 1;
        return {
          action: "create_issue",
          number: 303,
          url: "https://github.com/acme/repo/issues/303",
          summary: "Filed #303.",
        };
      },
      deliverVoice: async (_job, state) => {
        deliveries += 1;
        if (deliveries === 1) throw new Error("WhatsApp temporarily unavailable");
        return { ...state, streamIndex: state.streamIndex + 1 };
      },
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* forkPendingJobs(store, loopback, 10);
          yield* Effect.promise(() => expect.poll(() => store.listJobs()[0]?.status).toBe("report_pending"));
          expect(workerRuns).toBe(1);
          yield* forkPendingJobs(store, loopback, 10);
          yield* Effect.promise(() => expect.poll(() => store.listJobs()[0]?.status).toBe("done"));
        }),
      ),
    );

    expect(workerRuns).toBe(1);
    expect(deliveries).toBe(2);
    store.close();
  });
});
