import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunRecord } from "@flue/runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { deliverTerminalResult, reconcileSpecialistWorkAtBoot } from "../../packages/agents/src/capabilities/delegation/bridge.ts";
import { configureDelegationRuntime } from "../../packages/agents/src/capabilities/delegation/runtime.ts";
import { launchSpecialistWork } from "../../packages/agents/src/capabilities/delegation/tools.ts";
import { coderSpecialistSpec } from "../../packages/agents/src/capabilities/coder/workflow.ts";
import { reviewerSpecialistSpec } from "../../packages/agents/src/capabilities/reviewer/workflow.ts";
import brain from "../../packages/agents/src/brain/agent.ts";
import { createBrainInbox, type BrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import type { ConversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";

const SOURCE = "surface:source";
const REPORT = "surface:report";
const CHAT = "source@g.us";
const EVIDENCE = "arrival:source:work-request";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (): { databasePath: string; inbox: BrainInbox; batchId: string } => {
  const root = mkdtempSync(join(tmpdir(), "ambient-brain-work-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  const archive = createConversationArchive(databasePath);
  archive.append({
    id: EVIDENCE,
    kind: "arrival",
    providerMessageId: "work-request",
    chatId: CHAT,
    senderId: "alice@s.whatsapp.net",
    senderName: "Alice",
    direction: "inbound",
    occurredAt: 1_000,
    payload: { live: true, isGroup: true, messageKind: "text", text: "Implement issue 7." },
  } satisfies ConversationArrival);
  archive.close();
  const inbox = createBrainInbox(databasePath, {
    providerChatIdForSurface: (surfaceId) => surfaceId === SOURCE ? CHAT : surfaceId === REPORT ? "report@g.us" : undefined,
    now: () => "2026-07-22T16:00:00.000Z",
  });
  inbox.admitIntent({ sourceSurfaceId: SOURCE, interpretation: "Implement issue 7.", evidenceIds: [EVIDENCE] });
  const batch = inbox.claimBatch()!;
  inbox.markBatchDispatched(batch.id, { dispatchId: "brain-dispatch", acceptedAt: "2026-07-22T16:00:01.000Z" });
  return { databasePath, inbox, batchId: batch.id };
};

const run = (runId: string, status: RunRecord["status"], input: unknown, result?: unknown): RunRecord => ({
  runId,
  workflowName: "coder",
  status,
  startedAt: "2026-07-22T16:00:00.500Z",
  input,
  ...(result === undefined ? {} : { result }),
});

describe("Brain-owned Specialist work", () => {
  it("mounts the Coder and Reviewer launchers on the global Brain, not on a chat-bound Speaker", async () => {
    const config = await brain.initialize({ id: "global", env: {} });
    const toolNames = config.tools?.map(({ name }) => name);
    expect(toolNames).toContain("start_coder_job");
    expect(toolNames).toContain("start_reviewer_job");
  });

  it("reserves a reviewer launch keyed by pull request and an exact retry admits the workflow once", async () => {
    const { inbox, batchId } = fixture();
    let admissions = 0;
    configureDelegationRuntime({
      inbox,
      wake: async () => undefined,
      providerChatIdForSurface: () => CHAT,
      findAdmittedRun: async () => undefined,
      admitWorkflow: async (_workflow, input) => {
        admissions += 1;
        expect(input).toMatchObject({
          repository: "acme/widgets",
          pullRequest: 8,
          brainWorkId: expect.stringMatching(/^brain-work:/u),
          sourceSurfaceId: SOURCE,
        });
        return { runId: "run:review" };
      },
    });

    const request = { batchId, sourceSurfaceId: SOURCE, repository: "acme/widgets", pullRequest: 8 };
    const first = await launchSpecialistWork(request, reviewerSpecialistSpec);
    const retry = await launchSpecialistWork(request, reviewerSpecialistSpec);

    expect(first).toEqual({ workId: expect.stringMatching(/^brain-work:[a-f0-9]{64}$/u), runId: "run:review" });
    expect(retry).toEqual(first);
    expect(admissions).toBe(1);
    expect(inbox.specialistLaunch(first.workId)).toMatchObject({
      status: "accepted",
      specialist: "reviewer",
      input: { repository: "acme/widgets", pullRequest: 8 },
    });
    inbox.close();
  });

  it("records one stable work identity before Flue admission and exact retries return the same run", async () => {
    const { inbox, batchId } = fixture();
    let admissions = 0;
    configureDelegationRuntime({
      inbox,
      wake: async () => undefined,
      providerChatIdForSurface: () => CHAT,
      findAdmittedRun: async () => undefined,
      admitWorkflow: async (_workflow, input) => {
        admissions += 1;
        expect(input).toMatchObject({ brainWorkId: expect.stringMatching(/^brain-work:/u), sourceSurfaceId: SOURCE });
        return { runId: "run:fresh" };
      },
    });

    const request = { batchId, sourceSurfaceId: SOURCE, repository: "acme/widgets", issue: 7 };
    const first = await launchSpecialistWork(request, coderSpecialistSpec);
    const retry = await launchSpecialistWork(request, coderSpecialistSpec);

    expect(first).toEqual({ workId: expect.stringMatching(/^brain-work:[a-f0-9]{64}$/u), runId: "run:fresh" });
    expect(retry).toEqual(first);
    expect(admissions).toBe(1);
    expect(inbox.specialistLaunch(first.workId)).toMatchObject({ status: "accepted", sourceSurfaceId: SOURCE });
    inbox.close();
  });

  it("reconciles a Flue-admitted run from its stable work id instead of launching a duplicate", async () => {
    const { inbox, batchId } = fixture();
    const input = { repository: "acme/widgets", issue: 7 };
    const pending = inbox.reserveSpecialistLaunch({ batchId, sourceSurfaceId: SOURCE, specialist: "coder", input });
    let admissions = 0;
    configureDelegationRuntime({
      inbox,
      wake: async () => undefined,
      providerChatIdForSurface: () => CHAT,
      findAdmittedRun: async (launch) => run("run:recovered", "active", { ...input, brainWorkId: launch.id }),
      admitWorkflow: async () => { admissions += 1; return { runId: "run:duplicate" }; },
    });

    await expect(launchSpecialistWork({ batchId, sourceSurfaceId: SOURCE, ...input }, coderSpecialistSpec))
      .resolves.toEqual({ workId: pending.id, runId: "run:recovered" });
    expect(admissions).toBe(0);
    inbox.close();
  });

  it("admits a terminal result durably to the Brain, survives restart, and leaves reporting destination unforced", async () => {
    const { databasePath, inbox, batchId } = fixture();
    const launch = inbox.reserveSpecialistLaunch({
      batchId,
      sourceSurfaceId: SOURCE,
      specialist: "coder",
      input: { repository: "acme/widgets", issue: 7 },
    });
    inbox.markSpecialistLaunchAccepted(launch.id, "run:done");
    inbox.settleBatch(batchId);
    let wakes = 0;
    await deliverTerminalResult("run:done", {
      inbox,
      wake: async () => { wakes += 1; },
      getRun: async () => run("run:done", "completed", { brainWorkId: launch.id }, {
        outcome: "opened-pr",
        prUrl: "https://github.com/acme/widgets/pull/8",
      }),
    });
    expect(wakes).toBe(1);
    expect(inbox.pendingSpecialistResults()).toHaveLength(1);
    inbox.close();

    const reopened = createBrainInbox(databasePath, {
      providerChatIdForSurface: (surfaceId) => surfaceId === SOURCE ? CHAT : surfaceId === REPORT ? "report@g.us" : undefined,
      now: () => "2026-07-22T16:01:00.000Z",
    });
    const resultBatch = reopened.claimBatch()!;
    expect(resultBatch.specialistResults).toEqual([
      expect.objectContaining({
        workId: launch.id,
        runId: "run:done",
        sourceSurfaceId: SOURCE,
        evidenceIds: [EVIDENCE],
        result: { outcome: "opened-pr", prUrl: "https://github.com/acme/widgets/pull/8" },
      }),
    ]);
    reopened.markBatchDispatched(resultBatch.id, { dispatchId: "brain-result", acceptedAt: "2026-07-22T16:01:01.000Z" });
    expect(reopened.recordPrompt({
      batchId: resultBatch.id,
      surfaceId: REPORT,
      objective: "Report the completed pull request.",
      brief: { summary: "Coder opened https://github.com/acme/widgets/pull/8", evidenceIds: [EVIDENCE] },
    }).directive.surfaceId).toBe(REPORT);
    reopened.close();
  });

  it("turns prior-process active work into one durable interrupted Brain input on boot", async () => {
    const { inbox, batchId } = fixture();
    const launch = inbox.reserveSpecialistLaunch({
      batchId,
      sourceSurfaceId: SOURCE,
      specialist: "coder",
      input: { repository: "acme/widgets", issue: 7 },
    });
    inbox.markSpecialistLaunchAccepted(launch.id, "run:orphaned");
    inbox.settleBatch(batchId);
    let wakes = 0;
    const deps = {
      inbox,
      wake: async () => { wakes += 1; },
      getRun: async () => run("run:orphaned", "active", { brainWorkId: launch.id }),
    };
    await reconcileSpecialistWorkAtBoot(deps);
    await reconcileSpecialistWorkAtBoot(deps);

    expect(inbox.pendingSpecialistResults()).toEqual([
      expect.objectContaining({ workId: launch.id, runId: "run:orphaned", status: "interrupted" }),
    ]);
    expect(wakes).toBe(1);
    inbox.close();
  });
});
