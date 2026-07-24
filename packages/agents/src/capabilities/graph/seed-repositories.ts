import type { EntityUpsert, GraphStore } from "@ambient-agent/engine/graph/store.ts";

/**
 * S2 (#19) — seed the repositories the operator authorized, and the surface→repository
 * relations, as Graph facts with provenance (§5, §11:601-604). This is the enabler that
 * lets the Brain resolve "which repository" per decision from Graph relations instead of
 * guessing (F4 root cause) — #249 consumes these entities and `works_on` edges.
 *
 * Authorization stays in config. This seed carries the *relation* the Brain resolves, never
 * the permission boundary: the fail-closed allowlist check lives in `createIssueManagementPolicy`
 * (`issue-management/runtime.ts`) and is enforced against `allowedRepositories` at the effect
 * boundary — a Repository entity in the Graph (config-seeded or discovered from conversation)
 * never grants write access on its own. See the negative-assertion test in
 * `tests/graph/seed-repositories.test.ts`.
 *
 * Deterministic ingester append (§5.5): no model judgment, anchored to the config source. The
 * evidence ids are stable references to that source, so re-running against unchanged config is a
 * no-op (the store dedups by attestation id). New repos → new entities; a removed repo's entity
 * lingers (append-only) but is inert because authorization is the config check, not entity presence.
 */

const AUTHOR = { kind: "ingester", id: "config-authorization" } as const;

const repoEvidenceId = (repository: string): string => `config-authorization:repo:${repository.toLowerCase()}`;
const surfaceEvidenceId = (chat: string, repository: string): string =>
  `config-authorization:surface:${chat.toLowerCase()}:${repository.toLowerCase()}`;

export interface RepositoryFactSeed {
  /** The config write allowlist (`github.allowedRepositories`) — the repos the Brain may know exist. */
  readonly allowedRepositories: readonly string[];
  /** The explicit per-surface routing (`github.surfaceRepositories`) the Brain resolves from the Graph. */
  readonly surfaceRepositories: readonly { readonly chat: string; readonly repository: string }[];
}

const attestEntity = (store: GraphStore, evidenceId: string, input: EntityUpsert): string => {
  const result = store.attest({ context: { author: AUTHOR, evidenceIds: [evidenceId] }, claim: { kind: "entity", input } });
  if (result.kind === "entity") return result.entity.entityId;
  if (result.kind === "entity-receipt") return result.entityId;
  throw new Error("Expected an Entity Attestation while seeding repository facts.");
};

const repositoryEntity = (repository: string): EntityUpsert => ({
  type: "repository",
  // Matches the `repo` natural key graph-extraction uses (schemas.ts), so a config-seeded
  // repository and one discovered from conversation converge on one entity — no second migration.
  properties: { repo: repository },
  identity: { platform: "github", externalId: repository },
});

const threadEntity = (chat: string): EntityUpsert => ({
  type: "thread",
  properties: { chatId: chat },
  identity: { platform: "whatsapp", externalId: chat },
});

/**
 * Idempotent, safe to call on every boot and (once #179/S8 lands) on authorization change.
 * ponytail: seeds only what config asserts — the default-repository fallback for an unmapped
 * surface stays deterministic code in app.ts, not an over-asserted Graph edge.
 */
export const seedRepositoryFacts = (store: GraphStore, seed: RepositoryFactSeed): void => {
  for (const repository of seed.allowedRepositories) {
    attestEntity(store, repoEvidenceId(repository), repositoryEntity(repository));
  }
  for (const { chat, repository } of seed.surfaceRepositories) {
    const evidenceId = surfaceEvidenceId(chat, repository);
    const threadId = attestEntity(store, evidenceId, threadEntity(chat));
    const repositoryId = attestEntity(store, evidenceId, repositoryEntity(repository));
    store.attest({
      context: { author: AUTHOR, evidenceIds: [evidenceId] },
      claim: { kind: "relation", input: { fromId: threadId, relation: "works_on", toId: repositoryId } },
    });
  }
};
