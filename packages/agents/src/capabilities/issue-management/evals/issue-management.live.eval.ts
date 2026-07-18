import { afterAll } from "vitest";
import { describeEval } from "vitest-evals";

import { finishBraintrustReport } from "../../../../../test-support/src/evals/braintrust-reporter.ts";
import { createFlueAgentHarness } from "../../../../../test-support/src/evals/harness.ts";
import { participationAxes, rubricJudgeHarness } from "../../../../evals/rubric-judges.ts";

const harness = createFlueAgentHarness({ agentName: "speaker" });
const liveOnly = () => process.env.SPEAKER_EVAL_LIVE_MODEL !== "true";

describeEval(
  "Axis 3 issue capture conversation — live judged",
  {
    harness,
    judgeHarness: rubricJudgeHarness,
    judges: [participationAxes.issueCapture.judge],
    judgeThreshold: participationAxes.issueCapture.threshold,
    skipIf: liveOnly,
  },
  (it) => {
    it("files a template-complete bug and returns its issue link", async ({ run }) => {
      await run({
        window: {
          texts: [
            "Please file this bug. After restart, a queued scheduler job disappears instead of running. I can reproduce it by queueing a job, stopping the process, and starting it again; the expected result is that the queued job runs.",
          ],
        },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
    });

    it("elicits missing details before any issue mutation", async ({ run }) => {
      await run({
        window: { texts: ["Please file a bug: the scheduler is broken."] },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
    });
  },
);

describeEval(
  "Axis 6 elicitation persistence — live judged",
  {
    harness,
    judgeHarness: rubricJudgeHarness,
    judges: [participationAxes.elicitation.judge],
    judgeThreshold: participationAxes.elicitation.threshold,
    skipIf: liveOnly,
  },
  (it) => {
    it("asks pointed, batched, non-redundant questions for a thin report", async ({ run }) => {
      await run({
        window: { texts: ["Can you capture this feature idea? Make deployments better."] },
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
    });
  },
);

afterAll(async () => await finishBraintrustReport("Issue Management live judged suites"));
