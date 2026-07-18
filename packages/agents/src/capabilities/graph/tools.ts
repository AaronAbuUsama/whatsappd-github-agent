import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import type { GraphEntity, GraphRelation, GraphStore } from "@ambient-agent/engine/graph/store.ts";
import { getGraphStore } from "./runtime.ts";
import {
  entitySchema,
  GraphConstraintError,
  relationSchema,
  toEntityUpsert,
  toRelationUpsert,
} from "./schemas.ts";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));

const provenanceOutput = v.object({
  chatId: v.optional(v.string()),
  messageId: v.optional(v.string()),
  deliveryId: v.optional(v.string()),
});
const entityOutput = v.object({
  entityId: v.string(),
  type: v.string(),
  properties: v.record(v.string(), v.unknown()),
  confidence: v.number(),
  provenance: provenanceOutput,
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
  createdAt: v.string(),
  updatedAt: v.string(),
});

const publicEntity = (entity: GraphEntity): v.InferOutput<typeof entityOutput> => ({ ...entity });
const publicRelation = (relation: GraphRelation): v.InferOutput<typeof relationOutput> => ({ ...relation });

export const createGraphTools = (store: GraphStore = getGraphStore()): ToolDefinition[] => [
  defineTool({
    name: "record_entity",
    description:
      "Record one typed entity in the shared graph. Keyed entities (people, threads, and GitHub objects) " +
      "converge on their natural key, so re-recording the same one updates it rather than duplicating; " +
      "restating raises its confidence.",
    input: v.object({ entity: entitySchema }),
    output: v.object({ entityId: v.string(), type: v.string(), confidence: v.number() }),
    run: ({ input }) => {
      const entity = store.upsertEntity(toEntityUpsert(input.entity));
      return { entityId: entity.entityId, type: entity.type, confidence: entity.confidence };
    },
  }),
  defineTool({
    name: "record_relation",
    description:
      "Record one typed edge between two existing entities in the shared graph. Re-recording the same edge " +
      "raises its confidence rather than duplicating it.",
    input: v.object({ edge: relationSchema }),
    output: v.object({ relationId: v.string(), confidence: v.number() }),
    run: ({ input }) => {
      const edge = input.edge;
      if (edge.relation === "made_by") {
        const conflicting = store.relationsFrom(edge.fromId, "made_by").find((existing) => existing.toId !== edge.toId);
        if (conflicting !== undefined) {
          throw new GraphConstraintError(
            "made-by-single",
            `${edge.fromId} is already made_by ${conflicting.toId}; a commitment has exactly one owner.`,
          );
        }
      }
      if (edge.relation === "blocks") {
        if (edge.fromId === edge.toId) {
          throw new GraphConstraintError("blocks-acyclic", `${edge.fromId} cannot block itself.`);
        }
        if (store.blocksReachable(edge.toId, edge.fromId)) {
          throw new GraphConstraintError(
            "blocks-acyclic",
            `${edge.fromId} blocks ${edge.toId} would close a cycle; blocks must stay acyclic.`,
          );
        }
      }
      const relation = store.upsertRelation(toRelationUpsert(edge));
      return { relationId: relation.relationId, confidence: relation.confidence };
    },
  }),
  defineTool({
    name: "merge_entities",
    description:
      "Merge two entities that turned out to be the same one. Every edge and identity of the loser is " +
      "repointed to the survivor and the loser is deleted.",
    input: v.object({ survivorId: nonEmpty, loserId: nonEmpty }),
    output: v.object({ survivorId: v.string() }),
    run: ({ input }) => {
      store.mergeEntities(input.survivorId, input.loserId);
      return { survivorId: input.survivorId };
    },
  }),
  defineTool({
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
      const neighborhood = (entity: GraphEntity | undefined) => {
        if (entity === undefined) return { entities: [], relations: [] };
        const relations = [...store.relationsFrom(entity.entityId), ...store.relationsTo(entity.entityId)];
        return { entities: [publicEntity(entity)], relations: relations.map(publicRelation) };
      };
      if (input.platform !== undefined && input.externalId !== undefined) {
        return neighborhood(store.resolveIdentity(input.platform, input.externalId));
      }
      if (input.entityId !== undefined) {
        return neighborhood(store.getEntity(input.entityId));
      }
      const entities = store.findEntities({
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return { entities: entities.map(publicEntity), relations: [] };
    },
  }),
];
