import { afterAll, expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";

import { finishBraintrustReport, recordRubricScore } from "../../test-support/src/evals/braintrust-reporter.ts";
import { createFlueAgentHarness } from "../../test-support/src/evals/harness.ts";
import { expectNoExternalEffects } from "./shared.ts";
import { hardSilenceCriterion, participationSkillBundle } from "./rubric-judges.ts";

const harness = createFlueAgentHarness({ agentName: "speaker" });

describeEval(
  "Participation mechanics through coalesced Windows",
  { harness, skipIf: () => process.env.SPEAKER_EVAL_LIVE_MODEL === "true" },
  (it) => {
    it("stays silent on casual chatter", async ({ run }) => {
      const result = await run({
        window: { texts: ["Beautiful sunset today."] },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });

      expectNoExternalEffects(result.output);
      expect(result.output.windowMessages).toEqual([
        {
          id: expect.stringMatching(/^eval-window-/),
          text: "Beautiful sunset today.",
          from: "alice@s.whatsapp.net",
          pushName: "Alice",
        },
      ]);
      recordRubricScore({
        axis: 1,
        metric: "axis_1_unsolicited_reply_rate",
        threshold: 0.05,
        direction: "maximum",
        score: 0,
        criteria: "Chatter / social / opinion: never.",
        input: { texts: ["Beautiful sunset today."] },
        output: result.output,
        rationale: "No WhatsApp or GitHub event was recorded.",
        skillBundle: participationSkillBundle,
      });
    });

    it("uses exactly one Say when explicitly addressed", async ({ run }) => {
      const result = await run({
        window: { texts: ["Speaker, SPEAK_ONCE"] },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });

      expect(toolCalls(result).filter((call) => call.name === "say")).toHaveLength(1);
      expect(result.output.whatsappEvents).toEqual([
        { kind: "typing", chatId: result.output.instanceId, on: true },
        {
          kind: "send",
          chatId: result.output.instanceId,
          messageId: expect.stringMatching(/^fake-message-/),
          text: "one explicit outbound",
          outcome: "sent",
        },
        { kind: "typing", chatId: result.output.instanceId, on: false },
      ]);
      expect(result.output.githubOperations).toEqual([]);
      recordRubricScore({
        axis: 2,
        metric: "axis_2_addressed_say_rate",
        threshold: 1,
        score: 1,
        criteria: "Explicitly addressed with nothing to offer → always respond, brief + honest.",
        input: { texts: ["Speaker, SPEAK_ONCE"] },
        output: result.output,
        rationale: "Exactly one Say and one outbound send were recorded.",
        skillBundle: participationSkillBundle,
      });
    });

    it("records the complete issue capture and its chat receipt", async ({ run }) => {
      const result = await run({
        window: { texts: ["CREATE_COMPLETE_ISSUE"] },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);

      expect(calls.filter((call) => call.name === "github_create_issue")).toEqual([
        expect.objectContaining({ status: "ok", result: expect.objectContaining({ status: "created" }) }),
      ]);
      expect(calls.filter((call) => call.name === "say")).toEqual([
        expect.objectContaining({
          status: "ok",
          arguments: { text: "Filed https://github.com/acme/widgets/issues/1" },
        }),
      ]);
      expect(result.output.githubOperations).toEqual([
        expect.objectContaining({ kind: "create-issue", issueNumber: 1, status: "completed" }),
      ]);
      expect(result.output.whatsappEvents).toEqual([
        { kind: "typing", chatId: result.output.instanceId, on: true },
        {
          kind: "send",
          chatId: result.output.instanceId,
          messageId: expect.stringMatching(/^fake-message-/),
          text: "Filed https://github.com/acme/widgets/issues/1",
          outcome: "sent",
        },
        { kind: "typing", chatId: result.output.instanceId, on: false },
      ]);
      recordRubricScore({
        axis: 3,
        metric: "axis_3_capture_receipt_rate",
        threshold: 1,
        score: 1,
        criteria: "On filing → reply with the issue link.",
        input: { texts: ["CREATE_COMPLETE_ISSUE"] },
        output: result.output,
        rationale: "One completed create operation and one issue-link Say were recorded.",
        skillBundle: participationSkillBundle,
      });
    });

    it("hard-silences SMOKE-prefixed messages before any operation", async ({ run }) => {
      const result = await run({
        window: { texts: ["SMOKE SPEAK_ONCE CREATE_COMPLETE_ISSUE"] },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });

      expectNoExternalEffects(result.output);
      expect(toolCalls(result).filter((call) => call.name === "say" || call.name.startsWith("github_"))).toEqual([]);
      recordRubricScore({
        axis: 5,
        metric: "axis_5_hard_silence_rate",
        threshold: 1,
        score: 1,
        criteria: hardSilenceCriterion,
        input: { texts: ["SMOKE SPEAK_ONCE CREATE_COMPLETE_ISSUE"] },
        output: result.output,
        rationale: "No Say, reaction, capture, WhatsApp event, or GitHub operation was recorded.",
        skillBundle: participationSkillBundle,
      });
    });
  },
);

afterAll(async () => await finishBraintrustReport("Participation mechanics suite"));
