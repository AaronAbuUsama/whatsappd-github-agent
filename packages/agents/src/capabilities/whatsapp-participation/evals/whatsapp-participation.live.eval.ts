import { afterAll } from "vitest";
import { describeEval } from "vitest-evals";

import { finishBraintrustReport, recordRubricScore } from "../../../../../test-support/src/evals/braintrust-reporter.ts";
import { createFlueAgentHarness } from "../../../../../test-support/src/evals/harness.ts";
import { participationAxes, participationSkillBundle, rubricJudgeHarness } from "../../../../evals/rubric-judges.ts";

const harness = createFlueAgentHarness({ agentName: "speaker" });
const liveOnly = () => process.env.SPEAKER_EVAL_LIVE_MODEL !== "true";

describeEval(
  "Axis 1 address forms — live judged",
  {
    harness,
    judgeHarness: rubricJudgeHarness,
    judges: [participationAxes.addressForms.judge],
    judgeThreshold: participationAxes.addressForms.threshold,
    skipIf: liveOnly,
  },
  (it) => {
    it.for([
      { name: "social chatter", text: "Beautiful sunset today." },
      { name: "opinion chatter", text: "I still think tabs look nicer than spaces." },
      { name: "generic room question", text: "What framework does everyone think is best?" },
    ])("$name", async ({ text }, { run }) => {
      const result = await run({
        window: { texts: [text] },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const replied = result.output.whatsappEvents.some(
        (event) => event !== null && typeof event === "object" && !Array.isArray(event) && event.kind === "send",
      );
      recordRubricScore({
        axis: 1,
        metric: "axis_1_unsolicited_reply_rate",
        threshold: 0.05,
        direction: "maximum",
        score: replied ? 1 : 0,
        criteria: "Chatter / social / opinion: never.",
        input: { texts: [text] },
        output: result.output,
        rationale: replied ? "At least one outbound send was recorded." : "No outbound send was recorded.",
        skillBundle: participationSkillBundle,
      });
    });

    it("answers an implicit question only when the fact is retrievable", async ({ run }) => {
      await run({
        window: { texts: ["Which room is the release call in?"] },
        fixture: {
          resetGitHub: true,
          resetWhatsApp: true,
          history: [{ scope: "current", text: "The release call is in the Cedar room." }],
        },
      });
    });
  },
);

describeEval(
  "Axis 2 usefulness threshold — live judged",
  {
    harness,
    judgeHarness: rubricJudgeHarness,
    judges: [participationAxes.usefulness.judge],
    judgeThreshold: participationAxes.usefulness.threshold,
    skipIf: liveOnly,
  },
  (it) => {
    it("answers an explicit address briefly and honestly when the fact is unavailable", async ({ run }) => {
      await run({
        window: { texts: ["Speaker, what was the name of my childhood cat?"] },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
    });
  },
);

describeEval(
  "Axis 4 multi-message Windows — live judged",
  {
    harness,
    judgeHarness: rubricJudgeHarness,
    judges: [participationAxes.multiMessage.judge],
    judgeThreshold: participationAxes.multiMessage.threshold,
    skipIf: liveOnly,
  },
  (it) => {
    it("handles two actionable concerns without acknowledging the chatter", async ({ run }) => {
      await run({
        window: {
          texts: [
            "Beautiful sunset today.",
            { text: "Speaker, what room is the release call in?", from: "bob@s.whatsapp.net", pushName: "Bob" },
            {
              text: "Please file this bug: after restart a queued scheduler job disappears instead of running. I can reproduce it by queueing a job, stopping the process, and starting it again; the queued job should run.",
              from: "carol@s.whatsapp.net",
              pushName: "Carol",
            },
          ],
        },
        fixture: {
          resetGitHub: true,
          resetWhatsApp: true,
          history: [{ scope: "current", text: "The release call is in the Cedar room." }],
        },
      });
    });
  },
);

afterAll(async () => await finishBraintrustReport("WhatsApp Participation live judged suites"));
