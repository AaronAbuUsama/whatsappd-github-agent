import * as v from "valibot";

import type { EntityUpsert, GraphRelationType, RelationUpsert } from "@ambient-agent/engine/graph/store.ts";
export { GraphConstraintError, isGraphConstraintError } from "@ambient-agent/engine/graph/store.ts";

/**
 * Typing lives here, at the tool boundary (MEMORY-STATE-SPEC §3): one valibot schema
 * per entity/relation type, validated before commit. The database enforces only the
 * enums, keys, and uniqueness. Two rules valibot cannot express — `blocks` acyclic and
 * `made_by` exactly-one — are store checks that raise a typed error after retry deduplication.
 */

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));
const entityId = nonEmpty;
const confidence = v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)));
const platform = v.picklist(["whatsapp", "github"]);
const identitySchema = v.object({ platform, externalId: nonEmpty, displayName: v.optional(nonEmpty) });
const githubNode = { repo: nonEmpty, title: nonEmpty, state: nonEmpty, cachedAt: nonEmpty } as const;
const githubNumber = v.pipe(v.number(), v.integer(), v.minValue(1));

// The eleven entity types, one schema each, discriminated on `type`.
export const entitySchema = v.variant("type", [
  v.object({ type: v.literal("person"), identity: identitySchema, name: v.optional(nonEmpty), confidence }),
  v.object({ type: v.literal("agent"), identity: identitySchema, name: v.optional(nonEmpty), confidence }),
  v.object({ type: v.literal("thread"), chatId: nonEmpty, confidence }),
  v.object({ type: v.literal("topic"), id: v.optional(entityId), label: nonEmpty, confidence }),
  v.object({
    type: v.literal("commitment"),
    id: v.optional(entityId),
    description: nonEmpty,
    status: v.picklist(["open", "done", "dropped"]),
    due: v.optional(nonEmpty),
    confidence,
  }),
  v.object({
    type: v.literal("goal"),
    id: v.optional(entityId),
    description: nonEmpty,
    target: v.optional(nonEmpty),
    confidence,
  }),
  v.object({ type: v.literal("repository"), ...githubNode, number: v.optional(githubNumber), confidence }),
  v.object({ type: v.literal("issue"), ...githubNode, number: githubNumber, confidence }),
  v.object({ type: v.literal("pull_request"), ...githubNode, number: githubNumber, confidence }),
  v.object({ type: v.literal("milestone"), ...githubNode, number: githubNumber, confidence }),
  v.object({ type: v.literal("project"), ...githubNode, number: githubNumber, confidence }),
]);

export type EntityInput = v.InferOutput<typeof entitySchema>;

// The eleven relation types, one schema each, discriminated on `relation`. The
// from/to type rules in the spec are documentation; the database and these schemas
// carry only what they can enforce cheaply.
const edge = <R extends GraphRelationType>(relation: R) =>
  v.object({ relation: v.literal(relation), fromId: entityId, toId: entityId, confidence });

export const relationSchema = v.variant("relation", [
  edge("participates_in"),
  edge("interested_in"),
  edge("discusses"),
  edge("mentions"),
  edge("works_on"),
  edge("made_by"),
  edge("about"),
  edge("resolves"),
  edge("part_of"),
  edge("blocks"),
  edge("advances"),
]);

export type RelationInput = v.InferOutput<typeof relationSchema>;

/** Derive the store upsert — including the natural key for keyed types — from a validated entity. */
export const toEntityUpsert = (entity: EntityInput): EntityUpsert => {
  const shared = { confidence: entity.confidence };
  switch (entity.type) {
    case "person":
    case "agent":
      return {
        type: entity.type,
        properties: { name: entity.name },
        identity: {
          platform: entity.identity.platform,
          externalId: entity.identity.externalId,
          displayName: entity.identity.displayName,
        },
        ...shared,
      };
    case "thread":
      return {
        type: "thread",
        properties: { chatId: entity.chatId },
        identity: { platform: "whatsapp", externalId: entity.chatId },
        ...shared,
      };
    case "topic":
      return { type: "topic", properties: { label: entity.label }, id: entity.id, ...shared };
    case "commitment":
      return {
        type: "commitment",
        properties: { description: entity.description, status: entity.status, due: entity.due },
        id: entity.id,
        ...shared,
      };
    case "goal":
      return {
        type: "goal",
        properties: { description: entity.description, target: entity.target },
        id: entity.id,
        ...shared,
      };
    case "repository":
      return {
        type: "repository",
        properties: {
          repo: entity.repo,
          number: entity.number,
          title: entity.title,
          state: entity.state,
          cached_at: entity.cachedAt,
        },
        identity: { platform: "github", externalId: entity.repo },
        ...shared,
      };
    case "issue":
    case "pull_request":
      return {
        type: entity.type,
        properties: {
          repo: entity.repo,
          number: entity.number,
          title: entity.title,
          state: entity.state,
          cached_at: entity.cachedAt,
        },
        identity: { platform: "github", externalId: `${entity.repo}#${entity.number}` },
        ...shared,
      };
    case "milestone":
      return {
        type: "milestone",
        properties: {
          repo: entity.repo,
          number: entity.number,
          title: entity.title,
          state: entity.state,
          cached_at: entity.cachedAt,
        },
        identity: { platform: "github", externalId: `${entity.repo}/milestones/${entity.number}` },
        ...shared,
      };
    case "project":
      return {
        type: "project",
        properties: {
          repo: entity.repo,
          number: entity.number,
          title: entity.title,
          state: entity.state,
          cached_at: entity.cachedAt,
        },
        identity: { platform: "github", externalId: `${entity.repo}/projects/${entity.number}` },
        ...shared,
      };
  }
};

export const toRelationUpsert = (edge: RelationInput): RelationUpsert => ({
  fromId: edge.fromId,
  relation: edge.relation,
  toId: edge.toId,
  confidence: edge.confidence,
});
