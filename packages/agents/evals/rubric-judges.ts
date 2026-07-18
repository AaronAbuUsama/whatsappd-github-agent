import { createFlueClient } from "@flue/sdk";
import { readFileSync } from "node:fs";
import { createJudge, createJudgeHarness, type JudgeResult } from "vitest-evals";

import { recordRubricScore } from "../../test-support/src/evals/braintrust-reporter.ts";
import type { FlueAgentEvalInput, FlueAgentEvalOutput } from "../../test-support/src/evals/harness.ts";

const whatsappSkill = readFileSync(new URL("../src/capabilities/whatsapp-participation/SKILL.md", import.meta.url), "utf8");
const issueSkill = readFileSync(new URL("../src/capabilities/issue-management/SKILL.md", import.meta.url), "utf8");
const skillBundle = [whatsappSkill, issueSkill].join("\n\n---\n\n");

const client = createFlueClient({
  baseUrl: process.env.FLUE_BASE_URL ?? "http://127.0.0.1:3583",
});

const parseJudgeOutput = (text: string): unknown => {
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(candidate);
};

export const rubricJudgeHarness = createJudgeHarness({
  name: "speaker-participation-rubric-judge",
  run: async ({ system, prompt }, { signal }) => {
    const result = await client.agents.prompt("rubric-judge", `judge-${crypto.randomUUID()}`, {
      message: [system, prompt].filter((value) => value !== undefined && value.trim() !== "").join("\n\n"),
      signal,
    });
    return parseJudgeOutput(result.result.text);
  },
});

interface AxisDefinition {
  axis: number;
  name: string;
  metric: string;
  threshold: number;
  criteria: string;
}

const verdict = (value: unknown): { score: number; rationale: string } => {
  if (value === null || typeof value !== "object") throw new Error("Rubric judge returned a non-object verdict.");
  const candidate = value as { score?: unknown; rationale?: unknown };
  if (typeof candidate.score !== "number" || candidate.score < 0 || candidate.score > 1) {
    throw new Error("Rubric judge score must be a number from 0 to 1.");
  }
  if (typeof candidate.rationale !== "string" || candidate.rationale.trim() === "") {
    throw new Error("Rubric judge rationale must be a non-empty string.");
  }
  return { score: candidate.score, rationale: candidate.rationale };
};

const createAxisJudge = (definition: AxisDefinition) =>
  createJudge<FlueAgentEvalInput, FlueAgentEvalOutput>({
    name: definition.metric,
    judgeHarness: rubricJudgeHarness,
    assess: async (context): Promise<JudgeResult> => {
      if (context.runJudge === undefined) throw new Error(`${definition.name} requires the rubric judge harness.`);
      if (context.run.usage.provider === "speaker-fixture") {
        throw new Error(
          `${definition.name} received the faux responder. Start the fixture with SPEAKER_FIXTURE_LIVE_MODEL=true.`,
        );
      }
      const judgeInput =
        context.input.window === undefined
          ? context.input
          : {
              ...context.input,
              window: { ...context.input.window, messages: context.output.windowMessages ?? [] },
            };
      const judged = verdict(
        await context.runJudge({
          responseFormat: { type: "json" },
          prompt: [
            `Grade ${definition.name}.`,
            "Quoted ratified criterion:",
            `> ${definition.criteria.replaceAll("\n", "\n> ")}`,
            "The application under test received the following input:",
            JSON.stringify(judgeInput, null, 2),
            "Its normalized transcript and observable effects were:",
            JSON.stringify({ session: context.session, output: context.output, toolCalls: context.toolCalls }, null, 2),
            "Grade only behavior observable within this supplied scenario. Do not penalize missing future user turns or later events that the fixture does not include; for elicitation, grade the quality of the questions shown.",
            "Grade against the exact skill-bundle text below. Do not reward behavior the skill does not authorize:",
            skillBundle,
          ].join("\n\n"),
        }),
      );

      recordRubricScore({
        axis: definition.axis,
        metric: definition.metric,
        threshold: definition.threshold,
        score: judged.score,
        criteria: definition.criteria,
        input: judgeInput,
        output: { session: context.session, effects: context.output, toolCalls: context.toolCalls },
        rationale: judged.rationale,
        skillBundle,
      });
      return {
        score: judged.score,
        metadata: {
          axis: definition.axis,
          threshold: definition.threshold,
          criteria: definition.criteria,
          rationale: judged.rationale,
        },
      };
    },
  });

export const participationAxes = {
  addressForms: {
    threshold: 0.95,
    judge: createAxisJudge({
      axis: 1,
      name: "Axis 1 — address forms (conversational)",
      metric: "axis_1_address_forms_grade",
      threshold: 0.95,
      criteria: [
        "Explicit address (mention, name in text, quote-reply of the agent's message): always engage.",
        "Implicit room question: reply ONLY when the answer is specific and retrievable (citable from the chat archive or GitHub). Never general-knowledge opinions.",
        "Chatter / social / opinion: never.",
      ].join("\n"),
    }),
  },
  usefulness: {
    threshold: 0.9,
    judge: createAxisJudge({
      axis: 2,
      name: "Axis 2 — usefulness threshold (conversational)",
      metric: "axis_2_addressed_response_grade",
      threshold: 0.9,
      criteria: [
        "Explicitly addressed with nothing to offer → always respond, brief + honest (one line, no fake answers, no hedging essays).",
        "Implicitly in-scope with nothing beyond generic advice → silence.",
      ].join("\n"),
    }),
  },
  issueCapture: {
    threshold: 0.8,
    judge: createAxisJudge({
      axis: 3,
      name: "Axis 3 — issue capture is a conversation (task workflow)",
      metric: "axis_3_capture_conversation_grade",
      threshold: 0.8,
      criteria: [
        "Report doesn't fill the bug/feature template → elicit the missing information in-chat before filing.",
        "On filing → reply with the issue link.",
        "When a PR lands for a captured issue → post the PR link back to the chat.",
      ].join("\n"),
    }),
  },
  multiMessage: {
    threshold: 0.5,
    judge: createAxisJudge({
      axis: 4,
      name: "Axis 4 — multi-message windows",
      metric: "axis_4_per_concern_grade",
      threshold: 0.5,
      criteria: [
        "Handle all actionable items in the window, one message per concern, threaded via reply-to to the source message.",
        "Never acknowledge chatter; never mash concerns into one digest reply.",
      ].join("\n"),
    }),
  },
  elicitation: {
    threshold: 0.8,
    judge: createAxisJudge({
      axis: 6,
      name: "Axis 6 — elicitation persistence (task workflow)",
      metric: "axis_6_elicitation_quality_grade",
      threshold: 0.8,
      criteria: [
        "No cap: ask as many questions as needed until a proper report (template-fillable) exists.",
        "Etiquette is qualitative, not rule-bound — questions must be pointed, sensibly batched, non-redundant.",
        "No reminder/nag mechanics.",
      ].join("\n"),
    }),
  },
} as const;

export const hardSilenceCriterion = [
  "Hard silence — no say, no react, no capture — on: system/pairing/status traffic,",
  "and any SMOKE -prefixed message in a managed chat.",
].join(" ");

export const participationSkillBundle = skillBundle;
