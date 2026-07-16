import { init, type Experiment } from "braintrust";

interface RubricScoreRecord {
  axis: number;
  metric: string;
  threshold: number;
  direction?: "minimum" | "maximum";
  score: number;
  criteria: string;
  input: unknown;
  output: unknown;
  rationale: string;
  skillBundle: string;
}

const scores = new Map<string, { threshold: number; direction: "minimum" | "maximum"; values: number[] }>();
let experiment: Experiment | undefined;

const braintrustExperiment = (): Experiment | undefined => {
  if (!process.env.BRAINTRUST_API_KEY) return undefined;
  experiment ??= init({
    project: process.env.BRAINTRUST_PROJECT_NAME ?? "Flue",
    projectId: process.env.BRAINTRUST_PROJECT_ID,
    experiment: process.env.BRAINTRUST_EXPERIMENT_NAME ?? "ambient-agent-eval-baseline",
    description: "Participation rubric baseline for ambient-agent issue #113.",
    apiKey: process.env.BRAINTRUST_API_KEY,
    update: true,
    setCurrent: false,
  });
  return experiment;
};

export const recordRubricScore = (record: RubricScoreRecord): void => {
  const direction = record.direction ?? "minimum";
  const existing = scores.get(record.metric);
  if (existing !== undefined && existing.threshold !== record.threshold) {
    throw new Error(
      `Rubric metric ${record.metric} changed threshold from ${existing.threshold} to ${record.threshold}.`,
    );
  }
  if (existing !== undefined && existing.direction !== direction) {
    throw new Error(`Rubric metric ${record.metric} changed direction from ${existing.direction} to ${direction}.`);
  }
  const metric = existing ?? {
    threshold: record.threshold,
    direction,
    values: [],
  };
  metric.values.push(record.score);
  scores.set(record.metric, metric);

  braintrustExperiment()?.log({
    input: record.input,
    output: record.output,
    scores: { [record.metric]: record.score },
    metadata: {
      axis: record.axis,
      criteria: record.criteria,
      rationale: record.rationale,
      threshold: record.threshold,
      direction,
      skillBundle: record.skillBundle,
    },
  });
};

export const finishBraintrustReport = async (label: string): Promise<void> => {
  const failed: string[] = [];
  for (const [metric, result] of [...scores].sort(([left], [right]) => left.localeCompare(right))) {
    const rate = result.values.reduce((total, value) => total + value, 0) / result.values.length;
    console.info(
      `[rubric] ${metric}: ${(rate * 100).toFixed(1)}% (${result.direction} ${(result.threshold * 100).toFixed(1)}%)`,
    );
    const passed = result.direction === "minimum" ? rate >= result.threshold : rate <= result.threshold;
    if (!passed) failed.push(`${metric} was ${(rate * 100).toFixed(1)}%`);
  }

  const current = experiment;
  if (current === undefined) {
    console.info(`[rubric] ${label}: Braintrust export disabled (BRAINTRUST_API_KEY is unset).`);
  } else {
    await current.flush();
    const summary = await current.summarize({ summarizeScores: true });
    console.info(`[rubric] ${label}: ${summary.experimentUrl ?? "Braintrust experiment uploaded; URL unavailable."}`);
  }
  if (failed.length > 0) throw new Error(`${label} missed aggregate thresholds: ${failed.join(", ")}.`);
};
