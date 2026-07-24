import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type GraphEntityType =
  | "person"
  | "agent"
  | "thread"
  | "topic"
  | "commitment"
  | "repository"
  | "issue"
  | "pull_request"
  | "project"
  | "milestone"
  | "goal";

export type GraphRelationType =
  | "participates_in"
  | "interested_in"
  | "discusses"
  | "mentions"
  | "works_on"
  | "made_by"
  | "about"
  | "resolves"
  | "part_of"
  | "blocks"
  | "advances";

export type GraphPlatform = "whatsapp" | "github";
export type GraphAuthorKind = "scribe" | "brain" | "ingester" | "migration";
export type GraphIdentityScope = "actor" | Exclude<GraphEntityType, "person" | "agent">;

export class GraphConstraintError extends Error {
  readonly constraint: "blocks-acyclic" | "made-by-single";
  constructor(constraint: "blocks-acyclic" | "made-by-single", message: string) {
    super(message);
    this.name = "GraphConstraintError";
    this.constraint = constraint;
  }
}

export const isGraphConstraintError = (value: unknown): value is GraphConstraintError =>
  value instanceof GraphConstraintError;

export interface GraphProvenance {
  readonly chatId?: string;
  readonly messageId?: string;
  readonly deliveryId?: string;
}

export interface GraphIdentityRef {
  readonly platform: GraphPlatform;
  readonly externalId: string;
  readonly displayName?: string;
}

export interface GraphEntity {
  readonly entityId: string;
  readonly type: GraphEntityType;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly confidence: number;
  readonly provenance: GraphProvenance;
  readonly attestationIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GraphRelation {
  readonly relationId: string;
  readonly fromId: string;
  readonly relation: GraphRelationType;
  readonly toId: string;
  readonly confidence: number;
  readonly provenance: GraphProvenance;
  readonly attestationIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EntityUpsert {
  readonly type: GraphEntityType;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly identity?: GraphIdentityRef;
  readonly id?: string;
}

export interface RelationUpsert {
  readonly fromId: string;
  readonly relation: GraphRelationType;
  readonly toId: string;
  readonly confidence?: number;
}

export interface EntityQuery {
  readonly type?: GraphEntityType;
  readonly query?: string;
  readonly limit?: number;
}

export interface GraphAttestationAuthor {
  readonly kind: GraphAuthorKind;
  readonly id: string;
}

export interface GraphAttestationContext {
  readonly author: GraphAttestationAuthor;
  readonly evidenceIds: readonly string[];
  readonly batchId?: string;
}

export type GraphClaimDraft =
  | { readonly kind: "entity"; readonly input: EntityUpsert }
  | { readonly kind: "relation"; readonly input: RelationUpsert }
  | { readonly kind: "merge"; readonly survivorId: string; readonly loserId: string }
  | { readonly kind: "ruling"; readonly action: "confirm" | "overrule"; readonly targetAttestationId: string };

export interface GraphEntityClaim {
  readonly kind: "entity";
  readonly entityId: string;
  readonly type: GraphEntityType;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly identity?: GraphIdentityRef;
}

export interface GraphRelationClaim {
  readonly kind: "relation";
  readonly relationId: string;
  readonly fromId: string;
  readonly relation: GraphRelationType;
  readonly toId: string;
}

export interface GraphMergeClaim {
  readonly kind: "merge";
  readonly survivorId: string;
  readonly loserId: string;
}

export interface GraphRulingClaim {
  readonly kind: "ruling";
  readonly action: "confirm" | "overrule";
  readonly targetAttestationId: string;
}

export type GraphClaim = GraphEntityClaim | GraphRelationClaim | GraphMergeClaim | GraphRulingClaim;

export interface GraphAttestation {
  readonly id: string;
  readonly author: GraphAttestationAuthor;
  readonly claim: GraphClaim;
  readonly confidence: number;
  readonly evidenceSetId: string;
  readonly evidenceIds: readonly string[];
  readonly batchId?: string;
  readonly attestedAt: string;
}

export type GraphAttestationResult =
  | { readonly kind: "entity"; readonly attestation: GraphAttestation; readonly entity: GraphEntity }
  | {
      readonly kind: "entity-receipt";
      readonly attestation: GraphAttestation;
      readonly entityId: string;
      readonly type: GraphEntityType;
      readonly confidence: number;
    }
  | { readonly kind: "relation"; readonly attestation: GraphAttestation; readonly relation: GraphRelation }
  | {
      readonly kind: "relation-receipt";
      readonly attestation: GraphAttestation;
      readonly relationId: string;
      readonly confidence: number;
    }
  | { readonly kind: "merge"; readonly attestation: GraphAttestation; readonly survivor: GraphEntity }
  | {
      readonly kind: "merge-receipt";
      readonly attestation: GraphAttestation;
      readonly survivorId: string;
    }
  | { readonly kind: "ruling"; readonly attestation: GraphAttestation };

export interface GraphStore {
  /** Append one immutable, evidence-bearing claim and refresh the deterministic read Projection. */
  attest(input: { readonly context: GraphAttestationContext; readonly claim: GraphClaimDraft }): GraphAttestationResult;
  attestations(): readonly GraphAttestation[];
  projectionVersion(): string;
  getEntity(entityId: string): GraphEntity | undefined;
  resolveIdentity(platform: GraphPlatform, externalId: string, type?: GraphEntityType): GraphEntity | undefined;
  relationsFrom(fromId: string, relation?: GraphRelationType): readonly GraphRelation[];
  relationsTo(toId: string, relation?: GraphRelationType): readonly GraphRelation[];
  findEntities(query: EntityQuery): readonly GraphEntity[];
  blocksReachable(fromId: string, toId: string): boolean;
  close(): void;
}

interface EntityRow {
  entity_id: string;
  type: GraphEntityType;
  properties_json: string;
  confidence: number;
  source_chat_id: string | null;
  source_message_id: string | null;
  source_delivery_id: string | null;
  supporting_attestation_ids_json: string;
  created_at: string;
  updated_at: string;
}

interface RelationRow {
  relation_id: string;
  from_id: string;
  relation: GraphRelationType;
  to_id: string;
  confidence: number;
  source_chat_id: string | null;
  source_message_id: string | null;
  source_delivery_id: string | null;
  supporting_attestation_ids_json: string;
  created_at: string;
  updated_at: string;
}

interface IdentityRow {
  platform: GraphPlatform;
  external_id: string;
  scope: GraphIdentityScope;
  entity_id: string;
  display_name: string | null;
}

interface AttestationRow {
  attestation_id: string;
  author_kind: GraphAuthorKind;
  author_id: string;
  claim_kind: GraphClaim["kind"];
  claim_json: string;
  confidence: number;
  evidence_set_id: string;
  evidence_ids_json: string;
  batch_id: string | null;
  attested_at: string;
}

const TYPE_LIST =
  "'person','agent','thread','topic','commitment','repository','issue','pull_request','project','milestone','goal'";
const RELATION_LIST =
  "'participates_in','interested_in','discusses','mentions','works_on','made_by','about','resolves','part_of','blocks','advances'";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS graph_entities (
    entity_id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN (${TYPE_LIST})),
    properties_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source_chat_id TEXT, source_message_id TEXT, source_delivery_id TEXT,
    supporting_attestation_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS graph_relations (
    relation_id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
    relation TEXT NOT NULL CHECK (relation IN (${RELATION_LIST})),
    to_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
    confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source_chat_id TEXT, source_message_id TEXT, source_delivery_id TEXT,
    supporting_attestation_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (from_id, relation, to_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS graph_relations_to_idx ON graph_relations(to_id, relation);
  CREATE INDEX IF NOT EXISTS graph_relations_from_idx ON graph_relations(from_id, relation);
  CREATE TABLE IF NOT EXISTS graph_identities (
    platform TEXT NOT NULL CHECK (platform IN ('whatsapp','github')),
    external_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
    display_name TEXT,
    PRIMARY KEY (platform, external_id, scope)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS graph_attestations (
    attestation_id TEXT PRIMARY KEY,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('scribe','brain','ingester','migration')),
    author_id TEXT NOT NULL,
    claim_kind TEXT NOT NULL CHECK (claim_kind IN ('entity','relation','merge','ruling')),
    claim_json TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    evidence_set_id TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    batch_id TEXT,
    attested_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS graph_attestations_batch_idx ON graph_attestations(batch_id, attested_at);
  CREATE TRIGGER IF NOT EXISTS graph_attestations_no_update
    BEFORE UPDATE ON graph_attestations
    BEGIN SELECT RAISE(ABORT, 'Graph Attestations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS graph_attestations_no_delete
    BEFORE DELETE ON graph_attestations
    BEGIN SELECT RAISE(ABORT, 'Graph Attestations are immutable'); END;
  CREATE TABLE IF NOT EXISTS graph_projection_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version TEXT NOT NULL,
    rebuilt_at TEXT NOT NULL
  ) STRICT;
`;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

const required = (value: string, label: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
};

const canonicalEvidence = (evidenceIds: readonly string[]): readonly string[] => {
  const evidence = [...new Set(evidenceIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (evidence.length === 0) throw new Error("Every Attestation requires a non-empty Evidence Set.");
  return evidence;
};

const stripUndefined = (properties: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));

const entityNaturalKey = (input: EntityUpsert): string => {
  if (input.identity !== undefined) {
    return `${input.type}:identity:${input.identity.platform}:${required(input.identity.externalId, "External identity")}`;
  }
  if (input.id !== undefined) return `${input.type}:id:${required(input.id, "Entity id")}`;
  const key =
    input.type === "topic" ? "label" : input.type === "commitment" || input.type === "goal" ? "description" : undefined;
  const value = key === undefined ? undefined : input.properties[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${input.type} requires a stable identity, id, or natural key.`);
  }
  return `${input.type}:${key}:${value.trim()}`;
};

const identityScope = (type: GraphEntityType): GraphIdentityScope =>
  type === "person" || type === "agent" ? "actor" : type;

const normalizeEntityClaim = (input: EntityUpsert): GraphEntityClaim => {
  const naturalKey = entityNaturalKey(input);
  const scope = identityScope(input.type);
  const entityId =
    input.identity !== undefined
      ? `${scope}_${hash(`${input.identity.platform}:${required(input.identity.externalId, "External identity")}`).slice(0, 12)}`
      : input.id !== undefined
        ? required(input.id, "Entity id")
        : `${input.type}_${hash(naturalKey).slice(0, 12)}`;
  return {
    kind: "entity",
    entityId,
    type: input.type,
    properties: stripUndefined(input.properties),
    ...(input.identity === undefined
      ? {}
      : {
          identity: {
            platform: input.identity.platform,
            externalId: required(input.identity.externalId, "External identity"),
            ...(input.identity.displayName === undefined
              ? {}
              : { displayName: required(input.identity.displayName, "Identity display name") }),
          },
        }),
  };
};

const normalizeRelationClaim = (input: RelationUpsert): GraphRelationClaim => {
  const fromId = required(input.fromId, "Relation source");
  const toId = required(input.toId, "Relation target");
  return {
    kind: "relation",
    relationId: `rel_${hash(`${fromId}:${input.relation}:${toId}`).slice(0, 12)}`,
    fromId,
    relation: input.relation,
    toId,
  };
};

const confidenceFor = (draft: GraphClaimDraft, author: GraphAttestationAuthor): number => {
  const candidate =
    draft.kind === "merge" || draft.kind === "ruling"
      ? 1
      : (draft.input.confidence ?? (author.kind === "scribe" ? 0.5 : 1));
  if (!Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
    throw new Error("Attestation Confidence must be between 0 and 1.");
  }
  return candidate;
};

const decodeProvenance = (
  row: Pick<EntityRow, "source_chat_id" | "source_message_id" | "source_delivery_id">,
): GraphProvenance => ({
  ...(row.source_chat_id === null ? {} : { chatId: row.source_chat_id }),
  ...(row.source_message_id === null ? {} : { messageId: row.source_message_id }),
  ...(row.source_delivery_id === null ? {} : { deliveryId: row.source_delivery_id }),
});

const decodeEntity = (row: EntityRow): GraphEntity => ({
  entityId: row.entity_id,
  type: row.type,
  properties: JSON.parse(row.properties_json) as Record<string, unknown>,
  confidence: row.confidence,
  provenance: decodeProvenance(row),
  attestationIds: JSON.parse(row.supporting_attestation_ids_json) as string[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const decodeRelation = (row: RelationRow): GraphRelation => ({
  relationId: row.relation_id,
  fromId: row.from_id,
  relation: row.relation,
  toId: row.to_id,
  confidence: row.confidence,
  provenance: decodeProvenance(row),
  attestationIds: JSON.parse(row.supporting_attestation_ids_json) as string[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const decodeAttestation = (row: AttestationRow): GraphAttestation => ({
  id: row.attestation_id,
  author: { kind: row.author_kind, id: row.author_id },
  claim: JSON.parse(row.claim_json) as GraphClaim,
  confidence: row.confidence,
  evidenceSetId: row.evidence_set_id,
  evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
  ...(row.batch_id === null ? {} : { batchId: row.batch_id }),
  attestedAt: row.attested_at,
});

/**
 * Incremental Evidence Set folding for the normal append path. Attestations connected
 * through any shared raw evidence form one dependent component whose contribution is
 * its strongest Confidence. Independent components compound. Brain rulings and merges
 * rebuild these small indexes from the immutable log; ordinary Scribe append is nearly
 * constant-time for a repeated claim instead of refolding years of support.
 */
class EvidenceConfidenceAccumulator {
  readonly #parent: number[] = [];
  readonly #size: number[] = [];
  readonly #confidence: number[] = [];
  readonly #evidenceOwner = new Map<string, number>();
  #certainComponents = 0;
  #logFailure = 0;

  #find(index: number): number {
    let root = index;
    while (this.#parent[root] !== root) root = this.#parent[root]!;
    while (this.#parent[index] !== index) {
      const next = this.#parent[index]!;
      this.#parent[index] = root;
      index = next;
    }
    return root;
  }

  #removeContribution(confidence: number): void {
    if (confidence === 1) this.#certainComponents -= 1;
    else this.#logFailure -= Math.log1p(-confidence);
  }

  #addContribution(confidence: number): void {
    if (confidence === 1) this.#certainComponents += 1;
    else this.#logFailure += Math.log1p(-confidence);
  }

  #union(left: number, right: number): number {
    let leftRoot = this.#find(left);
    let rightRoot = this.#find(right);
    if (leftRoot === rightRoot) return leftRoot;
    if (this.#size[leftRoot]! < this.#size[rightRoot]!) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    this.#removeContribution(this.#confidence[leftRoot]!);
    this.#removeContribution(this.#confidence[rightRoot]!);
    this.#parent[rightRoot] = leftRoot;
    this.#size[leftRoot] = this.#size[leftRoot]! + this.#size[rightRoot]!;
    this.#confidence[leftRoot] = Math.max(this.#confidence[leftRoot]!, this.#confidence[rightRoot]!);
    this.#addContribution(this.#confidence[leftRoot]!);
    return leftRoot;
  }

  add(attestation: GraphAttestation): void {
    const index = this.#parent.length;
    this.#parent.push(index);
    this.#size.push(1);
    this.#confidence.push(attestation.confidence);
    this.#addContribution(attestation.confidence);
    let root = index;
    for (const evidenceId of attestation.evidenceIds) {
      const owner = this.#evidenceOwner.get(evidenceId);
      if (owner !== undefined) root = this.#union(root, owner);
    }
    root = this.#find(root);
    for (const evidenceId of attestation.evidenceIds) this.#evidenceOwner.set(evidenceId, root);
  }

  value(): number {
    if (this.#certainComponents > 0) return 1;
    return 1 - Math.exp(this.#logFailure);
  }
}

const MAX_PROJECTED_SUPPORT_IDS = 256;
const projectedSupportIds = (attestations: readonly GraphAttestation[]): string =>
  JSON.stringify(attestations.slice(-MAX_PROJECTED_SUPPORT_IDS).map(({ id }) => id));

const ensureProjectionColumns = (database: DatabaseSync): void => {
  const ensure = (table: string): void => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "supporting_attestation_ids_json")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN supporting_attestation_ids_json TEXT NOT NULL DEFAULT '[]'`);
    }
  };
  ensure("graph_entities");
  ensure("graph_relations");
};

const ensureIdentityScopes = (database: DatabaseSync): void => {
  const columns = database.prepare("PRAGMA table_info(graph_identities)").all() as unknown as Array<{ name: string }>;
  if (columns.some(({ name }) => name === "scope")) return;
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE TABLE graph_identities_scoped (
        platform TEXT NOT NULL CHECK (platform IN ('whatsapp','github')),
        external_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
        display_name TEXT,
        PRIMARY KEY (platform, external_id, scope)
      ) STRICT;
      INSERT INTO graph_identities_scoped (platform, external_id, scope, entity_id, display_name)
        SELECT i.platform, i.external_id,
          CASE WHEN e.type IN ('person','agent') THEN 'actor' ELSE e.type END,
          i.entity_id, i.display_name
        FROM graph_identities i JOIN graph_entities e ON e.entity_id = i.entity_id;
      DROP TABLE graph_identities;
      ALTER TABLE graph_identities_scoped RENAME TO graph_identities;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } catch (cause) {
    database.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
    throw cause;
  }
};

export interface GraphStoreOptions {
  readonly now?: () => Date;
}

export const createGraphStore = (databasePath: string, options: GraphStoreOptions = {}): GraphStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const now = options.now ?? (() => new Date());
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA);
  ensureProjectionColumns(database);
  ensureIdentityScopes(database);

  const transaction = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  };

  const selectEntity = database.prepare("SELECT * FROM graph_entities WHERE entity_id = ?");
  const selectIdentity = database.prepare(
    "SELECT entity_id FROM graph_identities WHERE platform = ? AND external_id = ? ORDER BY CASE scope WHEN 'actor' THEN 0 ELSE 1 END, scope LIMIT 1",
  );
  const selectScopedIdentity = database.prepare(
    "SELECT entity_id FROM graph_identities WHERE platform = ? AND external_id = ? AND scope = ?",
  );
  const selectRelation = database.prepare(
    "SELECT * FROM graph_relations WHERE from_id = ? AND relation = ? AND to_id = ?",
  );
  const selectAttestation = database.prepare("SELECT * FROM graph_attestations WHERE attestation_id = ?");

  const getEntity = (entityId: string): GraphEntity | undefined => {
    const row = selectEntity.get(entityId) as unknown as EntityRow | undefined;
    return row === undefined ? undefined : decodeEntity(row);
  };

  const resolveIdentityId = (platform: GraphPlatform, externalId: string, type?: GraphEntityType): string | undefined =>
    (
      (type === undefined
        ? selectIdentity.get(platform, externalId)
        : selectScopedIdentity.get(platform, externalId, identityScope(type))) as unknown as
        | { entity_id: string }
        | undefined
    )?.entity_id;

  const attestationRows = (): readonly AttestationRow[] =>
    database.prepare("SELECT * FROM graph_attestations ORDER BY rowid").all() as unknown as AttestationRow[];

  const hasConversationArchive =
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_events'").get() !==
    undefined;
  const hasGithubEvents =
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'brain_github_events'").get() !==
    undefined;
  const evidenceProvenance = (evidenceIds: readonly string[]): GraphProvenance => {
    for (const evidenceId of evidenceIds) {
      const row = hasConversationArchive
        ? (database
            .prepare("SELECT chat_id, provider_message_id FROM conversation_events WHERE event_id = ?")
            .get(evidenceId) as { chat_id: string; provider_message_id: string } | undefined)
        : undefined;
      if (row !== undefined) return { chatId: row.chat_id, messageId: row.provider_message_id };
      if (evidenceId.startsWith("github-delivery:")) {
        return { deliveryId: evidenceId.slice("github-delivery:".length) };
      }
      // A GitHub up-inbox event (brain_github_events) is its own evidence: resolve the origin webhook
      // delivery id so a GitHub-origin derived fact stays provenance-complete (§10).
      if (evidenceId.startsWith("github-event:") && hasGithubEvents) {
        const event = database
          .prepare("SELECT delivery_id FROM brain_github_events WHERE event_id = ?")
          .get(evidenceId) as { delivery_id: string } | undefined;
        if (event !== undefined) return { deliveryId: event.delivery_id };
      }
    }
    return {};
  };

  const canonicalEntity = (entityId: string, merges: ReadonlyMap<string, string>): string => {
    let current = entityId;
    const visited = new Set<string>();
    while (merges.has(current) && !visited.has(current)) {
      visited.add(current);
      current = merges.get(current)!;
    }
    return current;
  };

  let merges = new Map<string, string>();
  let entityGroups = new Map<string, GraphAttestation[]>();
  let relationGroups = new Map<string, GraphAttestation[]>();
  let rulings = new Map<string, GraphAttestation>();
  let attestationOrder = new Map<string, number>();

  interface ProjectionCandidate {
    readonly value: unknown;
    readonly confidence: EvidenceConfidenceAccumulator;
    readonly support: GraphAttestation[];
    authority: number;
    last: number;
  }

  interface EntityProjectionAccumulator {
    readonly first: GraphAttestation & { readonly claim: GraphEntityClaim };
    latest: GraphAttestation & { readonly claim: GraphEntityClaim };
    readonly types: Map<string, ProjectionCandidate>;
    readonly properties: Map<string, Map<string, ProjectionCandidate>>;
    readonly identities: Map<
      string,
      { readonly identity: GraphIdentityRef; readonly scope: GraphIdentityScope; readonly order: number }
    >;
    readonly commonSupport: GraphAttestation[];
  }

  interface RelationProjectionAccumulator {
    readonly first: GraphAttestation & { readonly claim: GraphRelationClaim };
    latest: GraphAttestation & { readonly claim: GraphRelationClaim };
    readonly confidence: EvidenceConfidenceAccumulator;
    readonly support: GraphAttestation[];
  }

  let entityAccumulators = new Map<string, EntityProjectionAccumulator>();
  let relationAccumulators = new Map<string, RelationProjectionAccumulator>();

  const uniqueAttestations = (values: readonly GraphAttestation[]): GraphAttestation[] => [
    ...new Map(values.map((attestation) => [attestation.id, attestation])).values(),
  ];

  const boundedSupport = (values: readonly GraphAttestation[]): GraphAttestation[] =>
    uniqueAttestations(values)
      .sort((left, right) => (attestationOrder.get(left.id) ?? 0) - (attestationOrder.get(right.id) ?? 0))
      .slice(-MAX_PROJECTED_SUPPORT_IDS);

  const indexAttestations = (attestations: readonly GraphAttestation[]): void => {
    attestationOrder = new Map(attestations.map((attestation, index) => [attestation.id, index]));
    const nextRulings = new Map<string, GraphAttestation>();
    for (const attestation of attestations) {
      if (attestation.claim.kind === "ruling") {
        nextRulings.set(attestation.claim.targetAttestationId, attestation);
      }
    }
    const active = (attestation: GraphAttestation): boolean => {
      const ruling = nextRulings.get(attestation.id);
      return ruling === undefined || ruling.claim.kind !== "ruling" || ruling.claim.action !== "overrule";
    };
    const nextMerges = new Map<string, string>();
    const mergeByLoser = new Map<string, GraphAttestation>();
    for (const attestation of attestations) {
      if (attestation.claim.kind === "merge" && active(attestation)) {
        nextMerges.set(attestation.claim.loserId, canonicalEntity(attestation.claim.survivorId, nextMerges));
        mergeByLoser.set(attestation.claim.loserId, attestation);
      }
    }
    const mergeSupport = (entityId: string): GraphAttestation[] => {
      const support: GraphAttestation[] = [];
      const visited = new Set<string>();
      let current = entityId;
      while (nextMerges.has(current) && !visited.has(current)) {
        visited.add(current);
        const ruling = mergeByLoser.get(current);
        if (ruling !== undefined) {
          support.push(ruling);
          const confirmation = nextRulings.get(ruling.id);
          if (confirmation?.claim.kind === "ruling" && confirmation.claim.action === "confirm") {
            support.push(confirmation);
          }
        }
        current = nextMerges.get(current)!;
      }
      return support;
    };

    const nextEntities = new Map<string, GraphAttestation[]>();
    const nextRelations = new Map<string, GraphAttestation[]>();
    const append = (
      target: Map<string, GraphAttestation[]>,
      key: string,
      values: readonly GraphAttestation[],
    ): void => {
      const group = target.get(key);
      if (group === undefined) target.set(key, [...values]);
      else group.push(...values);
    };
    for (const attestation of attestations) {
      if (!active(attestation)) continue;
      if (attestation.claim.kind === "entity") {
        const id = canonicalEntity(attestation.claim.entityId, nextMerges);
        append(nextEntities, id, [attestation, ...mergeSupport(attestation.claim.entityId)]);
      } else if (attestation.claim.kind === "relation") {
        const fromId = canonicalEntity(attestation.claim.fromId, nextMerges);
        const toId = canonicalEntity(attestation.claim.toId, nextMerges);
        const key = `${fromId}:${attestation.claim.relation}:${toId}`;
        append(nextRelations, key, [
          attestation,
          ...mergeSupport(attestation.claim.fromId),
          ...mergeSupport(attestation.claim.toId),
        ]);
      }
    }
    for (const [key, group] of nextEntities) nextEntities.set(key, uniqueAttestations(group));
    for (const [key, group] of nextRelations) nextRelations.set(key, uniqueAttestations(group));
    merges = nextMerges;
    entityGroups = nextEntities;
    relationGroups = nextRelations;
    rulings = nextRulings;
    rebuildAccumulators();
  };

  const confirmationsFor = (attestations: readonly GraphAttestation[]): GraphAttestation[] =>
    attestations.flatMap((attestation) => {
      const ruling = rulings.get(attestation.id);
      return ruling?.claim.kind === "ruling" && ruling.claim.action === "confirm" ? [ruling] : [];
    });

  const authorityFor = (attestation: GraphAttestation): number => {
    if (confirmationsFor([attestation]).length > 0 || attestation.author.kind === "brain") return 3;
    if (attestation.author.kind === "ingester") return 2;
    if (attestation.author.kind === "migration") return 1;
    return 0;
  };

  const appendCandidate = (
    candidates: Map<string, ProjectionCandidate>,
    value: unknown,
    attestation: GraphAttestation,
    order: number,
  ): void => {
    const key = canonicalJson(value);
    let candidate = candidates.get(key);
    if (candidate === undefined) {
      candidate = {
        value,
        confidence: new EvidenceConfidenceAccumulator(),
        support: [],
        authority: authorityFor(attestation),
        last: order,
      };
      candidates.set(key, candidate);
    }
    candidate.authority = Math.max(candidate.authority, authorityFor(attestation));
    candidate.last = Math.max(candidate.last, order);
    const supporting = [attestation, ...confirmationsFor([attestation])];
    for (const item of supporting) candidate.confidence.add(item);
    candidate.support.splice(0, candidate.support.length, ...boundedSupport([...candidate.support, ...supporting]));
  };

  const appendEntityAccumulator = (
    accumulator: EntityProjectionAccumulator,
    attestation: GraphAttestation & { readonly claim: GraphEntityClaim },
  ): void => {
    const order = attestationOrder.get(attestation.id) ?? attestationOrder.size;
    accumulator.latest = attestation;
    appendCandidate(accumulator.types, attestation.claim.type, attestation, order);
    for (const [property, value] of Object.entries(attestation.claim.properties)) {
      let candidates = accumulator.properties.get(property);
      if (candidates === undefined) {
        candidates = new Map();
        accumulator.properties.set(property, candidates);
      }
      appendCandidate(candidates, value, attestation, order);
    }
    if (attestation.claim.identity !== undefined) {
      const scope = identityScope(attestation.claim.type);
      accumulator.identities.set(
        `${attestation.claim.identity.platform}:${attestation.claim.identity.externalId}:${scope}`,
        {
          identity: attestation.claim.identity,
          scope,
          order,
        },
      );
    }
  };

  const buildEntityAccumulator = (supporting: readonly GraphAttestation[]): EntityProjectionAccumulator | undefined => {
    const entities = supporting.filter(
      (attestation): attestation is GraphAttestation & { readonly claim: GraphEntityClaim } =>
        attestation.claim.kind === "entity",
    );
    const first = entities[0];
    if (first === undefined) return undefined;
    const accumulator: EntityProjectionAccumulator = {
      first,
      latest: first,
      types: new Map(),
      properties: new Map(),
      identities: new Map(),
      commonSupport: boundedSupport(
        supporting.filter(({ claim }) => claim.kind === "merge" || claim.kind === "ruling"),
      ),
    };
    for (const attestation of entities) appendEntityAccumulator(accumulator, attestation);
    return accumulator;
  };

  const buildRelationAccumulator = (
    supporting: readonly GraphAttestation[],
  ): RelationProjectionAccumulator | undefined => {
    const relations = supporting.filter(
      (attestation): attestation is GraphAttestation & { readonly claim: GraphRelationClaim } =>
        attestation.claim.kind === "relation",
    );
    const first = relations[0];
    if (first === undefined) return undefined;
    const confidence = new EvidenceConfidenceAccumulator();
    const support: GraphAttestation[] = [];
    for (const attestation of relations) {
      const supportingAttestations = [attestation, ...confirmationsFor([attestation])];
      for (const item of supportingAttestations) confidence.add(item);
      support.push(...supportingAttestations);
    }
    support.push(...supporting.filter(({ claim }) => claim.kind === "merge" || claim.kind === "ruling"));
    return { first, latest: relations.at(-1)!, confidence, support: boundedSupport(support) };
  };

  const appendRelationAccumulator = (
    accumulator: RelationProjectionAccumulator,
    attestation: GraphAttestation & { readonly claim: GraphRelationClaim },
  ): void => {
    accumulator.latest = attestation;
    const supporting = [attestation, ...confirmationsFor([attestation])];
    for (const item of supporting) accumulator.confidence.add(item);
    accumulator.support.splice(
      0,
      accumulator.support.length,
      ...boundedSupport([...accumulator.support, ...supporting]),
    );
  };

  function rebuildAccumulators(): void {
    entityAccumulators = new Map();
    relationAccumulators = new Map();
    for (const [entityId, supporting] of entityGroups) {
      const accumulator = buildEntityAccumulator(supporting);
      if (accumulator !== undefined) entityAccumulators.set(entityId, accumulator);
    }
    for (const [key, supporting] of relationGroups) {
      const accumulator = buildRelationAccumulator(supporting);
      if (accumulator !== undefined) relationAccumulators.set(key, accumulator);
    }
  }

  const chooseCandidate = (candidates: ReadonlyMap<string, ProjectionCandidate>): ProjectionCandidate => {
    let selected: ProjectionCandidate | undefined;
    for (const candidate of candidates.values()) {
      if (
        selected === undefined ||
        candidate.authority > selected.authority ||
        (candidate.authority === selected.authority && candidate.confidence.value() > selected.confidence.value()) ||
        (candidate.authority === selected.authority &&
          candidate.confidence.value() === selected.confidence.value() &&
          candidate.last > selected.last)
      ) {
        selected = candidate;
      }
    }
    if (selected === undefined) throw new Error("A projected Entity requires at least one supported candidate.");
    return selected;
  };

  const projectEntity = (entityId: string, accumulator: EntityProjectionAccumulator): void => {
    const typeChoice = chooseCandidate(accumulator.types);
    const propertyChoices = [...accumulator.properties].map(
      ([property, candidates]) => [property, chooseCandidate(candidates)] as const,
    );
    const choices = [typeChoice, ...propertyChoices.map(([, choice]) => choice)];
    const projectionSupport = boundedSupport([
      ...choices.flatMap(({ support }) => support),
      ...accumulator.commonSupport,
    ]);
    const last = projectionSupport.at(-1) ?? accumulator.latest;
    const provenance = evidenceProvenance(last.evidenceIds);
    database
      .prepare(`INSERT INTO graph_entities
          (entity_id, type, properties_json, confidence, source_chat_id, source_message_id,
           source_delivery_id, supporting_attestation_ids_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_id) DO UPDATE SET
            type = excluded.type,
            properties_json = excluded.properties_json,
            confidence = excluded.confidence,
            source_chat_id = excluded.source_chat_id,
            source_message_id = excluded.source_message_id,
            source_delivery_id = excluded.source_delivery_id,
            supporting_attestation_ids_json = excluded.supporting_attestation_ids_json,
            updated_at = excluded.updated_at`)
      .run(
        entityId,
        typeChoice.value as GraphEntityType,
        JSON.stringify(Object.fromEntries(propertyChoices.map(([property, choice]) => [property, choice.value]))),
        Math.min(...choices.map(({ confidence }) => confidence.value())),
        provenance.chatId ?? null,
        provenance.messageId ?? null,
        provenance.deliveryId ?? null,
        projectedSupportIds(projectionSupport),
        accumulator.first.attestedAt,
        last.attestedAt,
      );
    database.prepare("DELETE FROM graph_identities WHERE entity_id = ?").run(entityId);
    for (const { identity, scope } of accumulator.identities.values()) {
      database
        .prepare(`INSERT OR REPLACE INTO graph_identities
            (platform, external_id, scope, entity_id, display_name) VALUES (?, ?, ?, ?, ?)`)
        .run(identity.platform, identity.externalId, scope, entityId, identity.displayName ?? null);
    }
  };

  const projectRelation = (key: string, accumulator: RelationProjectionAccumulator): void => {
    const latest = accumulator.latest;
    const fromId = canonicalEntity(latest.claim.fromId, merges);
    const toId = canonicalEntity(latest.claim.toId, merges);
    if (fromId === toId || getEntity(fromId) === undefined || getEntity(toId) === undefined) return;
    const last = accumulator.support.at(-1) ?? latest;
    const provenance = evidenceProvenance(last.evidenceIds);
    database
      .prepare(`INSERT INTO graph_relations
          (relation_id, from_id, relation, to_id, confidence, source_chat_id, source_message_id,
           source_delivery_id, supporting_attestation_ids_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(from_id, relation, to_id) DO UPDATE SET
            confidence = excluded.confidence,
            source_chat_id = excluded.source_chat_id,
            source_message_id = excluded.source_message_id,
            source_delivery_id = excluded.source_delivery_id,
            supporting_attestation_ids_json = excluded.supporting_attestation_ids_json,
            updated_at = excluded.updated_at`)
      .run(
        `rel_${hash(key).slice(0, 12)}`,
        fromId,
        latest.claim.relation,
        toId,
        accumulator.confidence.value(),
        provenance.chatId ?? null,
        provenance.messageId ?? null,
        provenance.deliveryId ?? null,
        projectedSupportIds(accumulator.support),
        accumulator.first.attestedAt,
        last.attestedAt,
      );
  };

  const setProjectionVersion = (latest: GraphAttestation | undefined): string => {
    const version = latest === undefined ? "projection:empty" : `projection:${latest.id}`;
    database
      .prepare(`INSERT INTO graph_projection_meta (singleton, version, rebuilt_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, rebuilt_at = excluded.rebuilt_at`)
      .run(version, now().toISOString());
    return version;
  };

  const rebuildProjection = (): string => {
    const attestations = attestationRows().map(decodeAttestation);
    indexAttestations(attestations);
    database.exec("DELETE FROM graph_relations; DELETE FROM graph_identities; DELETE FROM graph_entities;");
    for (const [entityId, accumulator] of entityAccumulators) projectEntity(entityId, accumulator);
    for (const [key, accumulator] of relationAccumulators) projectRelation(key, accumulator);
    return setProjectionVersion(attestations.at(-1));
  };

  const projectAttestation = (attestation: GraphAttestation): void => {
    if (attestation.claim.kind === "merge" || attestation.claim.kind === "ruling") {
      rebuildProjection();
      return;
    }
    attestationOrder.set(attestation.id, attestationOrder.size);
    if (attestation.claim.kind === "entity") {
      const entityAttestation = attestation as GraphAttestation & { readonly claim: GraphEntityClaim };
      const entityId = canonicalEntity(attestation.claim.entityId, merges);
      const supporting = entityGroups.get(entityId) ?? [];
      supporting.push(attestation);
      try {
        let accumulator = entityAccumulators.get(entityId);
        if (accumulator === undefined) {
          accumulator = buildEntityAccumulator(supporting)!;
          entityAccumulators.set(entityId, accumulator);
        } else {
          appendEntityAccumulator(accumulator, entityAttestation);
        }
        projectEntity(entityId, accumulator);
        if (!entityGroups.has(entityId)) entityGroups.set(entityId, supporting);
      } catch (cause) {
        supporting.pop();
        const restored = buildEntityAccumulator(supporting);
        if (restored === undefined) entityAccumulators.delete(entityId);
        else entityAccumulators.set(entityId, restored);
        attestationOrder.delete(attestation.id);
        throw cause;
      }
    } else {
      const relationAttestation = attestation as GraphAttestation & { readonly claim: GraphRelationClaim };
      const fromId = canonicalEntity(attestation.claim.fromId, merges);
      const toId = canonicalEntity(attestation.claim.toId, merges);
      const key = `${fromId}:${attestation.claim.relation}:${toId}`;
      const supporting = relationGroups.get(key) ?? [];
      supporting.push(attestation);
      try {
        let accumulator = relationAccumulators.get(key);
        if (accumulator === undefined) {
          accumulator = buildRelationAccumulator(supporting)!;
          relationAccumulators.set(key, accumulator);
        } else {
          appendRelationAccumulator(accumulator, relationAttestation);
        }
        projectRelation(key, accumulator);
        if (!relationGroups.has(key)) relationGroups.set(key, supporting);
      } catch (cause) {
        supporting.pop();
        const restored = buildRelationAccumulator(supporting);
        if (restored === undefined) relationAccumulators.delete(key);
        else relationAccumulators.set(key, restored);
        attestationOrder.delete(attestation.id);
        throw cause;
      }
    }
    setProjectionVersion(attestation);
  };

  const migrateProjection = (): void => {
    const count = (database.prepare("SELECT count(*) AS count FROM graph_attestations").get() as { count: number })
      .count;
    if (count > 0) return;
    const entities = database
      .prepare("SELECT * FROM graph_entities ORDER BY created_at, entity_id")
      .all() as unknown as EntityRow[];
    if (entities.length === 0) return;
    const identities = database
      .prepare("SELECT * FROM graph_identities ORDER BY platform, external_id")
      .all() as unknown as IdentityRow[];
    const relations = database
      .prepare("SELECT * FROM graph_relations ORDER BY created_at, relation_id")
      .all() as unknown as RelationRow[];
    const insert = database.prepare(`INSERT OR IGNORE INTO graph_attestations
      (attestation_id, author_kind, author_id, claim_kind, claim_json, confidence,
       evidence_set_id, evidence_ids_json, batch_id, attested_at)
      VALUES (?, 'migration', 'legacy-graph', ?, ?, ?, ?, ?, NULL, ?)`);
    const hasGitHubDeliveries =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'github_ingress_deliveries'")
        .get() !== undefined;
    const legacyEvidence = (
      row: Pick<EntityRow, "entity_id" | "source_chat_id" | "source_message_id" | "source_delivery_id">,
    ): readonly string[] => {
      const evidenceIds: string[] = [];
      if (row.source_delivery_id !== null && hasGitHubDeliveries) {
        const found = database
          .prepare("SELECT 1 FROM github_ingress_deliveries WHERE delivery_id = ?")
          .get(row.source_delivery_id);
        if (found !== undefined) evidenceIds.push(`github-delivery:${row.source_delivery_id}`);
      }
      if (row.source_chat_id !== null && row.source_message_id !== null && hasConversationArchive) {
        const eventId = `arrival:${row.source_chat_id}:${row.source_message_id}`;
        if (database.prepare("SELECT 1 FROM conversation_events WHERE event_id = ?").get(eventId) !== undefined) {
          evidenceIds.push(eventId);
        }
      }
      return evidenceIds;
    };
    const insertClaim = (
      claim: GraphClaim,
      confidence: number,
      rawEvidenceIds: readonly string[],
      attestedAt: string,
    ): void => {
      const evidenceIds = canonicalEvidence(rawEvidenceIds);
      const evidenceSetId = `evidence-set:${hash(canonicalJson(evidenceIds))}`;
      const author = { kind: "migration", id: "legacy-graph" } as const;
      const id = `attestation:${hash(canonicalJson({ author, claim, confidence, evidenceIds }))}`;
      insert.run(
        id,
        claim.kind,
        canonicalJson(claim),
        confidence,
        evidenceSetId,
        JSON.stringify(evidenceIds),
        attestedAt,
      );
    };
    const migratedEntityIds = new Set<string>();
    for (const entity of entities) {
      const ownedIdentities = identities.filter(({ entity_id }) => entity_id === entity.entity_id);
      const properties = JSON.parse(entity.properties_json) as Record<string, unknown>;
      const evidenceIds = legacyEvidence(entity);
      if (evidenceIds.length === 0) {
        console.warn(
          `[graph] dropped legacy Entity ${entity.entity_id} without a verifiable raw Evidence Set; Historical Replay can reconstruct it`,
        );
        continue;
      }
      migratedEntityIds.add(entity.entity_id);
      const legacyClaim: GraphEntityClaim = {
        kind: "entity",
        entityId: entity.entity_id,
        type: entity.type,
        properties,
      };
      insertClaim(legacyClaim, entity.confidence, evidenceIds, entity.created_at);

      const aliases = ownedIdentities.map((identity) =>
        normalizeEntityClaim({
          type: entity.type,
          properties,
          identity: {
            platform: identity.platform,
            externalId: identity.external_id,
            ...(identity.display_name === null ? {} : { displayName: identity.display_name }),
          },
        }),
      );
      if (aliases.length === 0 && (entity.type === "topic" || entity.type === "commitment" || entity.type === "goal")) {
        aliases.push(normalizeEntityClaim({ type: entity.type, properties }));
      }
      for (const alias of aliases) {
        insertClaim(alias, entity.confidence, evidenceIds, entity.created_at);
        if (alias.entityId !== entity.entity_id) {
          insertClaim(
            { kind: "merge", survivorId: entity.entity_id, loserId: alias.entityId },
            1,
            evidenceIds,
            entity.created_at,
          );
        }
      }
    }
    for (const relation of relations) {
      if (!migratedEntityIds.has(relation.from_id) || !migratedEntityIds.has(relation.to_id)) continue;
      const claim: GraphRelationClaim = {
        kind: "relation",
        relationId: relation.relation_id,
        fromId: relation.from_id,
        relation: relation.relation,
        toId: relation.to_id,
      };
      const evidenceIds = legacyEvidence({ ...relation, entity_id: relation.relation_id });
      if (evidenceIds.length === 0) {
        console.warn(
          `[graph] dropped legacy Relation ${relation.relation_id} without a verifiable raw Evidence Set; Historical Replay can reconstruct it`,
        );
        continue;
      }
      insertClaim(claim, relation.confidence, evidenceIds, relation.created_at);
    }
  };

  const hasAttestations =
    (database.prepare("SELECT 1 FROM graph_attestations LIMIT 1").get() as { 1: number } | undefined) !== undefined;
  if (!hasAttestations) transaction(migrateProjection);
  const persistedAttestations = attestationRows().map(decodeAttestation);
  indexAttestations(persistedAttestations);
  const expectedVersion =
    persistedAttestations.length === 0 ? "projection:empty" : `projection:${persistedAttestations.at(-1)!.id}`;
  const persistedVersion = (
    database.prepare("SELECT version FROM graph_projection_meta WHERE singleton = 1").get() as
      | { version: string }
      | undefined
  )?.version;
  const projectedEntityCount = (
    database.prepare("SELECT count(*) AS count FROM graph_entities").get() as { count: number }
  ).count;
  const projectedRelationCount = (
    database.prepare("SELECT count(*) AS count FROM graph_relations").get() as { count: number }
  ).count;
  const expectedRelationCount = [...relationGroups.values()].filter((supporting) => {
    const latest = supporting.findLast(({ claim }) => claim.kind === "relation");
    if (latest?.claim.kind !== "relation") return false;
    const fromId = canonicalEntity(latest.claim.fromId, merges);
    const toId = canonicalEntity(latest.claim.toId, merges);
    return fromId !== toId && entityGroups.has(fromId) && entityGroups.has(toId);
  }).length;
  const expectedIdentityCount = new Set(
    [...entityGroups.values()].flatMap((supporting) =>
      supporting.flatMap((attestation) =>
        attestation.claim.kind === "entity" && attestation.claim.identity !== undefined
          ? [
              `${attestation.claim.identity.platform}:${attestation.claim.identity.externalId}:${identityScope(attestation.claim.type)}`,
            ]
          : [],
      ),
    ),
  ).size;
  const projectedIdentityCount = (
    database.prepare("SELECT count(*) AS count FROM graph_identities").get() as { count: number }
  ).count;
  if (
    persistedVersion !== expectedVersion ||
    projectedEntityCount !== entityGroups.size ||
    projectedRelationCount !== expectedRelationCount ||
    projectedIdentityCount !== expectedIdentityCount
  ) {
    transaction(rebuildProjection);
  }

  const attestationResult = (claim: GraphClaim, attestation: GraphAttestation): GraphAttestationResult => {
    if (claim.kind === "entity") {
      const entity = getEntity(canonicalEntity(claim.entityId, merges));
      return entity === undefined
        ? {
            kind: "entity-receipt",
            attestation,
            entityId: claim.entityId,
            type: claim.type,
            confidence: attestation.confidence,
          }
        : { kind: "entity", attestation, entity };
    }
    if (claim.kind === "relation") {
      const fromId = canonicalEntity(claim.fromId, merges);
      const toId = canonicalEntity(claim.toId, merges);
      const row = selectRelation.get(fromId, claim.relation, toId) as unknown as RelationRow | undefined;
      return row === undefined
        ? {
            kind: "relation-receipt",
            attestation,
            relationId: claim.relationId,
            confidence: attestation.confidence,
          }
        : { kind: "relation", attestation, relation: decodeRelation(row) };
    }
    if (claim.kind === "ruling") return { kind: "ruling", attestation };
    const survivor = getEntity(canonicalEntity(claim.survivorId, merges));
    return survivor === undefined
      ? { kind: "merge-receipt", attestation, survivorId: claim.survivorId }
      : { kind: "merge", attestation, survivor };
  };

  const blocksReachable = (fromId: string, toId: string): boolean => {
    const visited = new Set<string>();
    const stack = [fromId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === toId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const rows = database
        .prepare("SELECT * FROM graph_relations WHERE from_id = ? AND relation = 'blocks'")
        .all(current) as unknown as RelationRow[];
      for (const edge of rows) stack.push(edge.to_id);
    }
    return false;
  };

  const attest: GraphStore["attest"] = ({ context, claim: draft }) =>
    transaction(() => {
      const author = {
        kind: context.author.kind,
        id: required(context.author.id, "Attestation author"),
      };
      const evidenceIds = canonicalEvidence(context.evidenceIds);
      const evidenceSetId = `evidence-set:${hash(canonicalJson(evidenceIds))}`;
      const claim: GraphClaim =
        draft.kind === "entity"
          ? normalizeEntityClaim(draft.input)
          : draft.kind === "relation"
            ? normalizeRelationClaim(draft.input)
            : draft.kind === "merge"
              ? {
                  kind: "merge",
                  survivorId: required(draft.survivorId, "Merge survivor"),
                  loserId: required(draft.loserId, "Merge loser"),
                }
              : {
                  kind: "ruling",
                  action: draft.action,
                  targetAttestationId: required(draft.targetAttestationId, "Ruling target"),
                };
      const confidence = confidenceFor(draft, author);
      const id = `attestation:${hash(canonicalJson({ author, claim, confidence, evidenceIds }))}`;
      const existing = selectAttestation.get(id) as unknown as AttestationRow | undefined;
      if (existing !== undefined) return attestationResult(claim, decodeAttestation(existing));
      if (claim.kind === "relation") {
        if (getEntity(claim.fromId) === undefined || getEntity(claim.toId) === undefined) {
          throw new Error("A Relation Attestation requires both projected Entities to exist.");
        }
        if (claim.relation === "made_by") {
          const conflicting = database
            .prepare(
              "SELECT to_id FROM graph_relations WHERE from_id = ? AND relation = 'made_by' AND to_id <> ? LIMIT 1",
            )
            .get(claim.fromId, claim.toId) as { to_id: string } | undefined;
          if (conflicting !== undefined) {
            throw new GraphConstraintError(
              "made-by-single",
              `${claim.fromId} is already made_by ${conflicting.to_id}; a commitment has exactly one owner.`,
            );
          }
        }
        if (claim.relation === "blocks") {
          if (claim.fromId === claim.toId) {
            throw new GraphConstraintError("blocks-acyclic", `${claim.fromId} cannot block itself.`);
          }
          if (blocksReachable(claim.toId, claim.fromId)) {
            throw new GraphConstraintError(
              "blocks-acyclic",
              `${claim.fromId} blocks ${claim.toId} would close a cycle; blocks must stay acyclic.`,
            );
          }
        }
      }
      if (claim.kind === "merge") {
        if (author.kind !== "brain" && author.kind !== "migration") {
          throw new Error("Only the Brain may author a merge ruling.");
        }
        if (claim.survivorId === claim.loserId) throw new Error("Cannot merge an Entity into itself.");
        if (getEntity(claim.survivorId) === undefined || getEntity(claim.loserId) === undefined) {
          throw new Error("A merge ruling requires both projected Entities to exist.");
        }
        if (getEntity(claim.survivorId)!.type !== getEntity(claim.loserId)!.type) {
          throw new Error("A merge ruling requires both projected Entities to have the same type.");
        }
      }
      if (claim.kind === "ruling") {
        if (author.kind !== "brain") throw new Error("Only the Brain may author a confirm/overrule ruling.");
        const target = selectAttestation.get(claim.targetAttestationId) as unknown as AttestationRow | undefined;
        if (target === undefined) throw new Error(`Ruling target ${claim.targetAttestationId} does not exist.`);
        if (target.claim_kind !== "entity" && target.claim_kind !== "relation" && target.claim_kind !== "merge") {
          throw new Error("A confirm/overrule ruling must target an Entity, Relation, or merge Attestation.");
        }
      }
      const attestedAt = now().toISOString();
      const changed = database
        .prepare(`INSERT OR IGNORE INTO graph_attestations
          (attestation_id, author_kind, author_id, claim_kind, claim_json, confidence,
           evidence_set_id, evidence_ids_json, batch_id, attested_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          author.kind,
          author.id,
          claim.kind,
          canonicalJson(claim),
          confidence,
          evidenceSetId,
          JSON.stringify(evidenceIds),
          context.batchId ?? null,
          attestedAt,
        ).changes;
      if (changed > 0) {
        projectAttestation(decodeAttestation(selectAttestation.get(id) as unknown as AttestationRow));
      }
      const attestation = decodeAttestation(selectAttestation.get(id) as unknown as AttestationRow);
      return attestationResult(claim, attestation);
    });

  return {
    attest,
    attestations: () => attestationRows().map(decodeAttestation),
    projectionVersion: () =>
      (database.prepare("SELECT version FROM graph_projection_meta WHERE singleton = 1").get() as { version: string })
        .version,
    getEntity,
    resolveIdentity: (platform, externalId, type) => {
      const id = resolveIdentityId(platform, externalId, type);
      return id === undefined ? undefined : getEntity(id);
    },
    relationsFrom: (fromId, relation) => {
      const rows = (relation === undefined
        ? database.prepare("SELECT * FROM graph_relations WHERE from_id = ?").all(fromId)
        : database
            .prepare("SELECT * FROM graph_relations WHERE from_id = ? AND relation = ?")
            .all(fromId, relation)) as unknown as RelationRow[];
      return rows.map(decodeRelation);
    },
    relationsTo: (toId, relation) => {
      const rows = (relation === undefined
        ? database.prepare("SELECT * FROM graph_relations WHERE to_id = ?").all(toId)
        : database
            .prepare("SELECT * FROM graph_relations WHERE to_id = ? AND relation = ?")
            .all(toId, relation)) as unknown as RelationRow[];
      return rows.map(decodeRelation);
    },
    findEntities: ({ type, query, limit = 20 }) => {
      const clauses: string[] = [];
      const parameters: unknown[] = [];
      if (type !== undefined) {
        clauses.push("type = ?");
        parameters.push(type);
      }
      if (query !== undefined && query.trim().length > 0) {
        clauses.push("properties_json LIKE ? ESCAPE '\\'");
        parameters.push(`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      }
      const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
      return (
        database
          .prepare(`SELECT * FROM graph_entities ${where} ORDER BY updated_at DESC LIMIT ?`)
          .all(...(parameters as never[]), Math.max(1, Math.min(limit, 100))) as unknown as EntityRow[]
      ).map(decodeEntity);
    },
    blocksReachable,
    close: () => database.close(),
  };
};
