import * as v from "valibot";

import type { GraphEntity, GraphEntityType, GraphRelationType, GraphStore } from "./store.ts";

/**
 * State injection — the read side (MEMORY-STATE-SPEC §5). `computeGraphDigest` is
 * plain deterministic code: a one-hop edge walk seeded from keys already in the
 * window, resolved through `graph_identities`. No model round-trip, no cache — it is
 * recomputed live at the `dispatchSpeaker` funnel every window, so a fact another
 * thread's Scribe wrote seconds ago is visible this turn. That staleness is the
 * cross-thread-memory feature.
 *
 * The type + schema live here in the engine so `inputs.ts` can carry the digest as a
 * flat `graphContext?` field on every input-union member; the thin
 * `buildGraphDigest(seeds)` that reads `getGraphStore()` (and the three consumers —
 * Speaker funnel, Coder/Reviewer/Planner Specialists) sits in the graph capability.
 */

/** A seed identity present in the window — a WhatsApp jid, a GitHub login, or an `owner/repo[#n]`. */
export interface DigestIdentitySeed {
  readonly platform: "whatsapp" | "github";
  readonly externalId: string;
}

export interface DigestSeeds {
  /** The thread's chat id, resolved to its Thread entity via `(whatsapp, chatId)`. */
  readonly chatId?: string;
  /** Participants + GitHub objects in view, resolved via `graph_identities`. */
  readonly identities: readonly DigestIdentitySeed[];
}

const digestEntitySchema = v.object({
  entityId: v.string(),
  type: v.string(),
  properties: v.record(v.string(), v.unknown()),
  confidence: v.number(),
  lowConfidence: v.boolean(),
  supportingAttestationIds: v.array(v.string()),
});
const digestRelationSchema = v.object({
  fromId: v.string(),
  relation: v.string(),
  toId: v.string(),
  confidence: v.number(),
  lowConfidence: v.boolean(),
  supportingAttestationIds: v.array(v.string()),
});
const digestCommitmentSchema = v.object({
  entityId: v.string(),
  type: v.string(),
  properties: v.record(v.string(), v.unknown()),
  confidence: v.number(),
  lowConfidence: v.boolean(),
  overdue: v.boolean(),
  supportingAttestationIds: v.array(v.string()),
});

/**
 * A down-flow work item surfaced onto the digest (§3.8, S3): one active Bounded Workflow
 * plus its latest streamed Milestone, so a Speaker turn sees in-flight work without a pull.
 */
const digestWorkItemSchema = v.object({
  workId: v.string(),
  specialist: v.string(),
  sourceSurfaceId: v.string(),
  startedAt: v.string(),
  latestMilestone: v.optional(v.object({ note: v.string(), at: v.string() })),
});

/** The pushed digest — one shape, shared by the Speaker input and the Specialist job input. */
export const graphDigestSchema = v.object({
  schemaVersion: v.literal("graph-digest.v1"),
  projectionVersion: v.string(),
  seeds: v.array(v.string()),
  entities: v.array(digestEntitySchema),
  relations: v.array(digestRelationSchema),
  commitments: v.array(digestCommitmentSchema),
  // Optional so Specialist-job digests and pre-existing rows parse unchanged.
  workItems: v.optional(v.array(digestWorkItemSchema)),
});

export type DigestWorkItem = v.InferOutput<typeof digestWorkItemSchema>;

/**
 * Compose active work items onto a computed graph digest, never replacing it (§5.4 — the
 * funnel composes rather than replaces). Returns the same digest when there is no work. The
 * appended items are held inside the same MAX_GRAPH_DIGEST_BYTES budget as the base digest:
 * capped, then trimmed oldest-first until the whole graphContext fits.
 */
export const composeWorkItems = (digest: GraphDigest, workItems: readonly DigestWorkItem[]): GraphDigest => {
  if (workItems.length === 0) return digest;
  // Input is oldest-first; keep the most recent work — cap to the newest N, then drop oldest-first
  // (shift from the front) until the whole graphContext fits, so a Speaker sees what is most in flight.
  const composed = { ...digest, workItems: workItems.slice(-MAX_WORK_ITEMS) };
  while (Buffer.byteLength(JSON.stringify(composed)) > MAX_GRAPH_DIGEST_BYTES && composed.workItems.length > 0) {
    composed.workItems.shift();
  }
  return composed.workItems.length === 0 ? digest : composed;
};

export type GraphDigest = v.InferOutput<typeof graphDigestSchema>;
export type DigestEntity = v.InferOutput<typeof digestEntitySchema>;
export type DigestRelation = v.InferOutput<typeof digestRelationSchema>;
export type DigestCommitment = v.InferOutput<typeof digestCommitmentSchema>;

export interface DigestOptions {
  readonly now?: () => Date;
  /**
   * Facts at or below this confidence are flagged for the Speaker to confirm (§5 D5).
   * ponytail: a single default threshold; θ is prompt/eval-tuned, not settled here.
   */
  readonly lowConfidenceThreshold?: number;
}

const DEFAULT_LOW_CONFIDENCE = 0.75;
const MAX_ENTITIES = 64;
const MAX_RELATIONS = 128;
const MAX_COMMITMENTS = 32;
const MAX_WORK_ITEMS = 32;
const MAX_SUPPORTING_ATTESTATIONS = 8;
export const MAX_GRAPH_DIGEST_BYTES = 64 * 1024;

/** Roll-up edges followed for one extra hop off GitHub work-in-view (§5 D3, "secondary hops"). */
const SECONDARY_HOPS: readonly GraphRelationType[] = ["resolves", "part_of", "advances"];
const SECONDARY_HOP_TYPES: ReadonlySet<GraphEntityType> = new Set(["issue", "pull_request", "milestone"]);

const isOverdue = (due: unknown, nowMs: number): boolean => {
  if (typeof due !== "string") return false;
  const dueMs = Date.parse(due);
  // ponytail: only flags ISO-ish parseable dues; free-text dues never flag overdue.
  return !Number.isNaN(dueMs) && dueMs < nowMs;
};

export const computeGraphDigest = (store: GraphStore, seeds: DigestSeeds, options: DigestOptions = {}): GraphDigest => {
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const threshold = options.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE;
  const low = (confidence: number): boolean => confidence <= threshold;

  // 1. Resolve seed keys → entity ids through graph_identities.
  const seedIds = new Set<string>();
  if (seeds.chatId !== undefined) {
    const thread = store.resolveIdentity("whatsapp", seeds.chatId, "thread");
    if (thread !== undefined) seedIds.add(thread.entityId);
  }
  for (const seed of seeds.identities) {
    const entity = store.resolveIdentity(seed.platform, seed.externalId);
    if (entity !== undefined) seedIds.add(entity.entityId);
  }

  // 2. One-hop walk out of every seed (both directions), collecting neighbours + edges.
  const entities = new Map<string, GraphEntity>();
  const relations = new Map<string, DigestRelation>();
  const remember = (entity: GraphEntity | undefined): void => {
    if (entity !== undefined && !entities.has(entity.entityId)) entities.set(entity.entityId, entity);
  };
  const edgeKey = (fromId: string, relation: string, toId: string): string => `${fromId}\u0000${relation}\u0000${toId}`;
  const record = (edge: ReturnType<GraphStore["relationsFrom"]>[number]): void => {
    relations.set(edgeKey(edge.fromId, edge.relation, edge.toId), {
      fromId: edge.fromId,
      relation: edge.relation,
      toId: edge.toId,
      confidence: edge.confidence,
      lowConfidence: low(edge.confidence),
      supportingAttestationIds: edge.attestationIds.slice(-MAX_SUPPORTING_ATTESTATIONS),
    });
  };

  for (const seedId of seedIds) remember(store.getEntity(seedId));
  for (const seedId of seedIds) {
    for (const edge of store.relationsFrom(seedId)) {
      record(edge);
      remember(store.getEntity(edge.toId));
    }
    for (const edge of store.relationsTo(seedId)) {
      record(edge);
      remember(store.getEntity(edge.fromId));
    }
  }

  // 3. Secondary hop: roll-ups off the GitHub work-in-view discovered above. Snapshot
  //    first so newly-remembered roll-up nodes are not themselves re-walked.
  for (const entity of Array.from(entities.values())) {
    if (!SECONDARY_HOP_TYPES.has(entity.type)) continue;
    for (const relation of SECONDARY_HOPS) {
      for (const edge of store.relationsFrom(entity.entityId, relation)) {
        record(edge);
        remember(store.getEntity(edge.toId));
      }
    }
  }

  // 4. Split open Commitments out of the flat neighbourhood; flag overdue ones.
  const commitments: DigestCommitment[] = [];
  const plainEntities: DigestEntity[] = [];
  for (const entity of entities.values()) {
    if (entity.type === "commitment") {
      if (entity.properties.status !== "open") continue;
      commitments.push({
        entityId: entity.entityId,
        type: entity.type,
        properties: entity.properties,
        confidence: entity.confidence,
        lowConfidence: low(entity.confidence),
        overdue: isOverdue(entity.properties.due, nowMs),
        supportingAttestationIds: entity.attestationIds.slice(-MAX_SUPPORTING_ATTESTATIONS),
      });
      continue;
    }
    plainEntities.push({
      entityId: entity.entityId,
      type: entity.type,
      properties: entity.properties,
      confidence: entity.confidence,
      lowConfidence: low(entity.confidence),
      supportingAttestationIds: entity.attestationIds.slice(-MAX_SUPPORTING_ATTESTATIONS),
    });
  }

  const digest: GraphDigest = {
    schemaVersion: "graph-digest.v1",
    projectionVersion: store.projectionVersion(),
    seeds: [...seedIds].sort().slice(0, MAX_ENTITIES),
    entities: plainEntities.sort((left, right) => left.entityId.localeCompare(right.entityId)).slice(0, MAX_ENTITIES),
    relations: [...relations.values()]
      .sort((left, right) => edgeKey(left.fromId, left.relation, left.toId).localeCompare(edgeKey(right.fromId, right.relation, right.toId)))
      .slice(0, MAX_RELATIONS),
    commitments: commitments
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
      .slice(0, MAX_COMMITMENTS),
  };
  while (Buffer.byteLength(JSON.stringify(digest)) > MAX_GRAPH_DIGEST_BYTES) {
    if (digest.relations.length > 0) digest.relations.pop();
    else if (digest.entities.length > 0) digest.entities.pop();
    else if (digest.commitments.length > 0) digest.commitments.pop();
    else break;
  }
  return digest;
};

/** True when a digest carries nothing worth spending a transcript turn on. */
export const isEmptyDigest = (digest: GraphDigest): boolean =>
  digest.entities.length === 0
  && digest.relations.length === 0
  && digest.commitments.length === 0
  && (digest.workItems ?? []).length === 0;
