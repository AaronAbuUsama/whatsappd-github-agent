import { createHash } from "node:crypto";

import type { SpeakerInput } from "@ambient-agent/engine/inputs.ts";
import type { ScribeObservation, ScribeObservationSource } from "@ambient-agent/engine/scribe/inbox.ts";

/** One raw observation offered to Scribe independently of Speaker admission. */
export interface ScribeOffer {
  readonly input: SpeakerInput;
}

/**
 * The Scribe's combined extraction input: the sibling inputs a quiet-period (or cap)
 * accumulated, delivered as ONE turn (#149). The Scribe reads them together and
 * extracts the ontology per its skill.
 */
export interface ScribeBatchInput {
  readonly type: "scribe.batch";
  /** Stable identity for this ordered evidence membership, independent of any model attempt. */
  readonly batchId: string;
  /** Trusted immutable raw-source references available to Attestations from this batch. */
  readonly evidenceIds: readonly string[];
  readonly inputs: readonly SpeakerInput[];
}

export const scribeEvidenceIds = (input: SpeakerInput): readonly string[] => {
  if (input.type === "whatsapp.window") {
    const byId = new Map([
      ...input.messages.map(
        (message) => [message.id, message.evidenceId ?? `arrival:${message.chatId}:${message.id}`] as const,
      ),
      ...input.updates.map((update) => [update.id, update.id] as const),
    ]);
    const fallback = [...input.messages.map((message) => message.id), ...input.updates.map((update) => update.id)];
    return (input.eventOrder ?? fallback).flatMap((id) => {
      const evidenceId = byId.get(id);
      return evidenceId === undefined ? [] : [evidenceId];
    });
  }
  if (input.type === "brain.directive") return input.directive.brief.evidenceIds;
  return [`github-delivery:${input.deliveryId}`];
};

const observationInputs = (input: SpeakerInput): readonly SpeakerInput[] => {
  if (input.type !== "whatsapp.window") return [input];
  const order = input.eventOrder ?? [...input.messages.map(({ id }) => id), ...input.updates.map(({ id }) => id)];
  const byId = new Map([...input.messages, ...input.updates].map((event) => [event.id, event]));
  return order.flatMap((id) => {
    const event = byId.get(id);
    if (event === undefined) return [];
    return [
      {
        ...input,
        messages: "kind" in event ? [] : [event],
        updates: "kind" in event ? [event] : [],
        eventOrder: [event.id],
      },
    ];
  });
};

const occurredAt = (input: SpeakerInput): number | undefined => {
  if (input.type !== "whatsapp.window") return undefined;
  const event = input.messages[0] ?? input.updates[0];
  if (event === undefined) return undefined;
  return "timestamp" in event ? event.timestamp : event.occurredAt;
};

export const scribeOffers = (input: SpeakerInput): readonly ScribeOffer[] =>
  observationInputs(input).map((observation) => ({ input: observation }));

/** Convert each raw fact-stream observation into the shared durable admission shape. */
export const scribeObservations = (
  offers: readonly ScribeOffer[],
  source: ScribeObservationSource,
): readonly ScribeObservation[] =>
  offers.map(({ input }) => {
    const evidenceIds = scribeEvidenceIds(input);
    if (evidenceIds.length !== 1) {
      throw new Error(`One Scribe observation requires exactly one evidence id; received ${evidenceIds.length}.`);
    }
    return { evidenceId: evidenceIds[0]!, occurredAt: occurredAt(input) ?? 0, source, input };
  });

const orderedInputs = (inputs: readonly SpeakerInput[]): readonly SpeakerInput[] => {
  const observations = inputs
    .flatMap(observationInputs)
    .map((input, index) => ({ input, index, occurredAt: occurredAt(input) }));
  if (observations.every((observation) => observation.occurredAt !== undefined)) {
    observations.sort((left, right) => {
      const leftUnknown = left.occurredAt === 0 ? 1 : 0;
      const rightUnknown = right.occurredAt === 0 ? 1 : 0;
      return leftUnknown - rightUnknown || left.occurredAt! - right.occurredAt! || left.index - right.index;
    });
  }
  return observations.map(({ input }) => {
    if (input.type !== "whatsapp.window" || input.eventOrder === undefined) return input;
    const byId = new Map([...input.messages, ...input.updates].map((event) => [event.id, event]));
    const ordered = input.eventOrder.map((id) => byId.get(id)).filter((event) => event !== undefined);
    return {
      ...input,
      messages: ordered.filter((event): event is (typeof input.messages)[number] => !("kind" in event)),
      updates: ordered.filter((event): event is (typeof input.updates)[number] => "kind" in event),
    };
  });
};

export const scribeBatchInput = (inputs: readonly SpeakerInput[]): ScribeBatchInput => {
  const ordered = orderedInputs(inputs);
  const evidenceIds = ordered.flatMap(scribeEvidenceIds);
  const digest = createHash("sha256").update(JSON.stringify(evidenceIds)).digest("hex");
  return {
    type: "scribe.batch",
    batchId: `scribe-batch:${digest}`,
    evidenceIds,
    inputs: ordered,
  };
};

/** Split one globally ordered frontier into at most `maximumBatches` contiguous Scribe Batches. */
export const scribeBatchWave = (inputs: readonly SpeakerInput[], maximumBatches = 4): readonly ScribeBatchInput[] => {
  const ordered = orderedInputs(inputs);
  if (ordered.length === 0) return [];
  const batchCount = Math.max(1, Math.min(Math.trunc(maximumBatches), ordered.length));
  const size = Math.ceil(ordered.length / batchCount);
  const batches: ScribeBatchInput[] = [];
  for (let offset = 0; offset < ordered.length; offset += size) {
    batches.push(scribeBatchInput(ordered.slice(offset, offset + size)));
  }
  return batches;
};
