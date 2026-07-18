import type { SpeakerInput } from "@ambient-agent/engine/inputs.ts";

/** One thing the funnel offered the Scribe: the same `(id, input)` the Speaker saw. */
export interface ScribeOffer {
  readonly id: string;
  readonly input: SpeakerInput;
}

/**
 * The Scribe's combined extraction input: the sibling inputs a quiet-period (or cap)
 * accumulated, delivered as ONE turn (#149). The Scribe reads them together and
 * extracts the ontology per its skill.
 */
export interface ScribeBatchInput {
  readonly type: "scribe.batch";
  readonly inputs: readonly SpeakerInput[];
}

export const scribeBatchInput = (inputs: readonly SpeakerInput[]): ScribeBatchInput => ({
  type: "scribe.batch",
  inputs,
});
