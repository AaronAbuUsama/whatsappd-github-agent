import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import type {
  GraphAttestationContext,
  GraphEntity,
  GraphRelation,
  GraphStore,
} from "@ambient-agent/engine/graph/store.ts";
import { getGraphStore } from "./runtime.ts";
import { entitySchema, relationSchema, toEntityUpsert, toRelationUpsert } from "./schemas.ts";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));
const evidenceSelection = v.pipe(v.array(nonEmpty), v.minLength(1));

const provenanceOutput = v.object({
  chatId: v.optional(v.string()),
  messageId: v.optional(v.string()),
  deliveryId: v.optional(v.string()),
});
// The durable Evidence ids backing an entity/relation — its Attestations' Evidence Sets, which are
// conversation_events.event_id / github-event:* ids. These are the ONLY ids the Brain can cite as
// evidence in prompt_speaker/file_issue (recordPrompt validates them); provenance.messageId is a raw
// provider message id and is NOT a citable evidence id.
const entityOutput = v.object({
  entityId: v.string(),
  type: v.string(),
  properties: v.record(v.string(), v.unknown()),
  confidence: v.number(),
  provenance: provenanceOutput,
  attestationIds: v.array(v.string()),
  evidenceIds: v.array(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
});
const relationOutput = v.object({
  relationId: v.string(),
  fromId: v.string(),
  relation: v.string(),
  toId: v.string(),
  confidence: v.number(),
  provenance: provenanceOutput,
  attestationIds: v.array(v.string()),
  evidenceIds: v.array(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
});

const MAX_TOOL_ATTESTATION_IDS = 20;

const publicEntity = (entity: GraphEntity, evidenceIds: readonly string[]): v.InferOutput<typeof entityOutput> => ({
  ...entity,
  attestationIds: entity.attestationIds.slice(-MAX_TOOL_ATTESTATION_IDS),
  evidenceIds: evidenceIds.slice(-MAX_TOOL_ATTESTATION_IDS),
});
const publicRelation = (
  relation: GraphRelation,
  evidenceIds: readonly string[],
): v.InferOutput<typeof relationOutput> => ({
  ...relation,
  attestationIds: relation.attestationIds.slice(-MAX_TOOL_ATTESTATION_IDS),
  evidenceIds: evidenceIds.slice(-MAX_TOOL_ATTESTATION_IDS),
});

/**
 * The default store, resolved lazily so mounting these tools on an agent never forces
 * the graph to be configured at `initialize()` time — only when a tool actually runs
 * (by then production has wired it via `composeSpeaker`). Every store method is a
 * closure that ignores `this`, so forwarding through the proxy is safe. Tests pass an
 * explicit store and bypass this entirely.
 */
const lazyGraphStore: GraphStore = new Proxy({} as GraphStore, {
  get: (_target, property) => Reflect.get(getGraphStore(), property) as unknown,
});

const claimContext = (
  context: GraphAttestationContext,
  selectedEvidenceIds: readonly string[],
): GraphAttestationContext => {
  const allowed = new Set(context.evidenceIds);
  const evidenceIds = [...new Set(selectedEvidenceIds)];
  if (evidenceIds.length === 0 || evidenceIds.some((evidenceId) => !allowed.has(evidenceId))) {
    throw new Error("Every selected Evidence id must belong to this trusted Scribe Batch.");
  }
  return { ...context, evidenceIds };
};

/**
 * The ontology tools share one implementation, but every write receives its author and
 * Evidence Set from the trusted runtime context. The model cannot supply provenance.
 */
type GraphContextSource = GraphAttestationContext | (() => GraphAttestationContext);
const contextFrom = (source: GraphContextSource): GraphAttestationContext =>
  typeof source === "function" ? source() : source;

const graphToolsByName = (store: GraphStore, context: GraphContextSource) => ({
  record_entity: defineTool({
    name: "record_entity",
    description:
      "Propose one typed Entity as an immutable Attestation in the shared Graph. Keyed Entities converge " +
      "on their natural key. Retrying the same claim against the same Evidence Set is idempotent and never " +
      "amplifies confidence.",
    input: v.object({ entity: entitySchema, evidenceIds: evidenceSelection }),
    output: v.object({ entityId: v.string(), type: v.string(), confidence: v.number() }),
    run: ({ input }) => {
      const result = store.attest({
        context: claimContext(contextFrom(context), input.evidenceIds),
        claim: { kind: "entity", input: toEntityUpsert(input.entity) },
      });
      if (result.kind === "entity") {
        return { entityId: result.entity.entityId, type: result.entity.type, confidence: result.entity.confidence };
      }
      if (result.kind === "entity-receipt") {
        return { entityId: result.entityId, type: result.type, confidence: result.confidence };
      }
      throw new Error("Entity Attestation returned the wrong result.");
    },
  }),
  record_relation: defineTool({
    name: "record_relation",
    description:
      "Propose one typed Relation as an immutable Attestation between two projected Entities. Retrying the " +
      "same claim against the same Evidence Set is idempotent and never amplifies confidence.",
    input: v.object({ edge: relationSchema, evidenceIds: evidenceSelection }),
    output: v.object({ relationId: v.string(), confidence: v.number() }),
    run: ({ input }) => {
      const edge = input.edge;
      const result = store.attest({
        context: claimContext(contextFrom(context), input.evidenceIds),
        claim: { kind: "relation", input: toRelationUpsert(edge) },
      });
      if (result.kind === "relation") {
        return { relationId: result.relation.relationId, confidence: result.relation.confidence };
      }
      if (result.kind === "relation-receipt") {
        return { relationId: result.relationId, confidence: result.confidence };
      }
      throw new Error("Relation Attestation returned the wrong result.");
    },
  }),
  merge_entities: defineTool({
    name: "merge_entities",
    description:
      "Record a Brain merge ruling as an immutable Attestation. The Belief Projection resolves the loser " +
      "onto the survivor without deleting history.",
    input: v.object({ survivorId: nonEmpty, loserId: nonEmpty, evidenceIds: evidenceSelection }),
    output: v.object({ survivorId: v.string() }),
    run: ({ input }) => {
      const result = store.attest({
        context: claimContext(contextFrom(context), input.evidenceIds),
        claim: { kind: "merge", survivorId: input.survivorId, loserId: input.loserId },
      });
      if (result.kind === "merge") return { survivorId: result.survivor.entityId };
      if (result.kind === "merge-receipt") return { survivorId: result.survivorId };
      throw new Error("Merge Attestation returned the wrong result.");
    },
  }),
  rule_attestation: defineTool({
    name: "rule_attestation",
    description:
      "Record a Brain confirmation or overruling of one Entity/Relation Attestation. The ruling is immutable; " +
      "it changes the Belief Projection without rewriting the target Attestation.",
    input: v.object({
      action: v.picklist(["confirm", "overrule"]),
      targetAttestationId: nonEmpty,
      evidenceIds: evidenceSelection,
    }),
    output: v.object({ attestationId: v.string(), action: v.picklist(["confirm", "overrule"]) }),
    run: ({ input }) => {
      const result = store.attest({
        context: claimContext(contextFrom(context), input.evidenceIds),
        claim: {
          kind: "ruling",
          action: input.action,
          targetAttestationId: input.targetAttestationId,
        },
      });
      if (result.kind !== "ruling") throw new Error("Ruling Attestation returned the wrong result.");
      return { attestationId: result.attestation.id, action: input.action };
    },
  }),
  lookup_graph: defineTool({
    name: "lookup_graph",
    description:
      "Read the shared graph: resolve an external identity or entity id to its one-hop neighborhood, or list " +
      "candidate entities by type and text for resolution.",
    input: v.object({
      entityId: v.optional(nonEmpty),
      platform: v.optional(v.picklist(["whatsapp", "github"])),
      externalId: v.optional(nonEmpty),
      type: v.optional(
        v.picklist([
          "person",
          "agent",
          "thread",
          "topic",
          "commitment",
          "repository",
          "issue",
          "pull_request",
          "project",
          "milestone",
          "goal",
        ]),
      ),
      query: v.optional(nonEmpty),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
    }),
    output: v.object({ entities: v.array(entityOutput), relations: v.array(relationOutput) }),
    run: ({ input }) => {
      // ponytail: one full attestations() scan per lookup to map attestationId -> its Evidence Set, so the
      // Brain gets a citable evidence id. The Graph is small and lookup is off the hot path; index by
      // attestation id in the store if this ever bites.
      let evidenceByAttestation: Map<string, readonly string[]> | undefined;
      const evidenceFor = (attestationIds: readonly string[]): readonly string[] => {
        if (evidenceByAttestation === undefined) {
          evidenceByAttestation = new Map(store.attestations().map((a) => [a.id, a.evidenceIds]));
        }
        return [...new Set(attestationIds.flatMap((id) => [...(evidenceByAttestation!.get(id) ?? [])]))];
      };
      const neighborhood = (entity: GraphEntity | undefined) => {
        if (entity === undefined) return { entities: [], relations: [] };
        const relations = [...store.relationsFrom(entity.entityId), ...store.relationsTo(entity.entityId)];
        return {
          entities: [publicEntity(entity, evidenceFor(entity.attestationIds))],
          relations: relations.map((r) => publicRelation(r, evidenceFor(r.attestationIds))),
        };
      };
      if (input.platform !== undefined && input.externalId !== undefined) {
        return neighborhood(store.resolveIdentity(input.platform, input.externalId, input.type));
      }
      if (input.entityId !== undefined) {
        return neighborhood(store.getEntity(input.entityId));
      }
      const entities = store.findEntities({
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return { entities: entities.map((e) => publicEntity(e, evidenceFor(e.attestationIds))), relations: [] };
    },
  }),
});

/** Brain-capable surface. Its trusted context is explicit at construction. */
export const createGraphTools = (store: GraphStore, context: GraphAttestationContext): ToolDefinition[] =>
  Object.values(graphToolsByName(store, context));

/** Brain write authority with trusted context resolved from its currently claimed durable Batch. */
export const createBrainGraphTools = (
  context: () => GraphAttestationContext,
  store: GraphStore = lazyGraphStore,
): ToolDefinition[] => Object.values(graphToolsByName(store, context));

/** Scribe proposal surface: read plus Entity/Relation Attestations, never merge rulings. */
export const createScribeGraphTools = (
  context: GraphAttestationContext,
  store: GraphStore = lazyGraphStore,
): ToolDefinition[] => {
  const tools = graphToolsByName(store, context);
  return [tools.lookup_graph, tools.record_entity, tools.record_relation];
};

const readOnlyContext: GraphAttestationContext = {
  author: { kind: "ingester", id: "read-only-tool-surface" },
  evidenceIds: ["read-only:unused"],
};

/** Speakers can consult the Graph but cannot mutate or ratify it. */
export const createSpeakerGraphTools = (store: GraphStore = lazyGraphStore): ToolDefinition[] => [
  graphToolsByName(store, readOnlyContext).lookup_graph,
];

/** Read-only surface for the Specialists (§5 D6). */
export const createSpecialistGraphTools = (store: GraphStore = lazyGraphStore): ToolDefinition[] => [
  graphToolsByName(store, readOnlyContext).lookup_graph,
];
