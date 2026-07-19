import type { Client, Transaction } from "@libsql/client";

export type GitHubAppRole = "coder" | "reviewer" | "planner";

export type GitHubRepositoryGrant = {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly selected: boolean;
  readonly isDefault: boolean;
};

export type GitHubInstallationCallback = {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: GitHubAppRole;
  readonly expiresAtMs: number;
  readonly installationId: number | null;
  readonly accountLogin: string | null;
  readonly completedAtMs: number | null;
};

export type VerifiedGitHubDelivery = {
  readonly githubAppId: string;
  readonly deliveryGuid: string;
  readonly eventName: string;
  readonly installationRole: GitHubAppRole;
  readonly installationId: number | null;
  readonly payloadJson: string;
  readonly payloadSha256: string;
  readonly receivedAtMs: number;
};

export type GitHubInstallationWebhookMutation = {
  readonly role: GitHubAppRole;
  readonly installationId: number;
  readonly eventName: string;
  readonly action: string;
  readonly added: readonly Omit<GitHubRepositoryGrant, "selected" | "isDefault">[];
  readonly removedIds: readonly number[];
  readonly nowMs: number;
};

export type GitHubDeliveryOutboxRecord = VerifiedGitHubDelivery & {
  readonly tenantId: string | null;
  readonly state: "pending" | "acked";
  readonly attemptCount: number;
  readonly nextAttemptAtMs: number;
  readonly claimId: string | null;
  readonly claimExpiresAtMs: number | null;
  readonly lastError: string | null;
  readonly tenantResultJson: string | null;
  readonly acknowledgedAtMs: number | null;
};

export type GitHubRuntimeTarget = {
  readonly tenantId: string;
  readonly runtimeId: string;
  readonly baseUrl: string;
};

export type GitHubControlStoreErrorCode =
  | "tenant_scope"
  | "installation_state"
  | "installation_state_expired"
  | "installation_collision"
  | "repository_scope"
  | "delivery_collision"
  | "delivery_claim";

export class GitHubControlStoreError extends Error {
  override readonly name = "GitHubControlStoreError";

  constructor(
    readonly code: GitHubControlStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type OutboxRow = Record<string, unknown>;

const callbackFromRow = (row: Record<string, unknown>): GitHubInstallationCallback => ({
  tenantId: String(row.tenant_id),
  userId: String(row.user_id),
  role: String(row.role) as GitHubAppRole,
  expiresAtMs: Number(row.expires_at_ms),
  installationId: row.installation_id === null ? null : Number(row.installation_id),
  accountLogin: row.account_login === null ? null : String(row.account_login),
  completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
});

const outboxFromRow = (row: OutboxRow): GitHubDeliveryOutboxRecord => ({
  githubAppId: String(row.github_app_id),
  deliveryGuid: String(row.delivery_guid),
  eventName: String(row.event_name),
  installationRole: String(row.installation_role) as GitHubAppRole,
  installationId: row.installation_id === null ? null : Number(row.installation_id),
  tenantId: row.tenant_id === null ? null : String(row.tenant_id),
  payloadJson: String(row.payload_json),
  payloadSha256: String(row.payload_sha256),
  state: String(row.state) as GitHubDeliveryOutboxRecord["state"],
  attemptCount: Number(row.attempt_count),
  nextAttemptAtMs: Number(row.next_attempt_at_ms),
  claimId: row.claim_id === null ? null : String(row.claim_id),
  claimExpiresAtMs: row.claim_expires_at_ms === null ? null : Number(row.claim_expires_at_ms),
  lastError: row.last_error === null ? null : String(row.last_error),
  tenantResultJson: row.tenant_result_json === null ? null : String(row.tenant_result_json),
  receivedAtMs: Number(row.received_at_ms),
  acknowledgedAtMs: row.acknowledged_at_ms === null ? null : Number(row.acknowledged_at_ms),
});

const selectOutbox = `
  SELECT github_app_id, delivery_guid, event_name, installation_role, installation_id, tenant_id,
         payload_json, payload_sha256, state, attempt_count, next_attempt_at_ms,
         claim_id, claim_expires_at_ms, last_error, tenant_result_json,
         received_at_ms, acknowledged_at_ms
    FROM github_delivery_outbox
`;

const withWriteTransaction = async <Value>(client: Client, run: (transaction: Transaction) => Promise<Value>) => {
  const transaction = await client.transaction("write");
  try {
    const value = await run(transaction);
    await transaction.commit();
    return value;
  } finally {
    transaction.close();
  }
};

const requireCallback = (
  row: Record<string, unknown> | undefined,
  role: GitHubAppRole,
  nowMs: number,
): GitHubInstallationCallback => {
  if (row === undefined || row.role !== role) {
    throw new GitHubControlStoreError("installation_state", "GitHub installation state does not match this callback");
  }
  const callback = callbackFromRow(row);
  if (callback.completedAtMs === null && callback.expiresAtMs <= nowMs) {
    throw new GitHubControlStoreError("installation_state_expired", "GitHub installation state has expired");
  }
  return callback;
};

const applyInstallationWebhookWith = async (
  transaction: Transaction,
  input: GitHubInstallationWebhookMutation,
): Promise<void> => {
  const installation = await transaction.execute({
    sql: `SELECT tenant_id, status FROM github_installation WHERE installation_id = ?1 AND role = ?2`,
    args: [input.installationId, input.role],
  });
  const tenantId = installation.rows[0]?.tenant_id;
  if (tenantId === undefined) return;
  if (input.eventName === "installation" && ["deleted", "suspend"].includes(input.action)) {
    await transaction.execute({
      sql: "DELETE FROM github_repository WHERE tenant_id = ?1 AND installation_role = ?2",
      args: [tenantId, input.role],
    });
    await transaction.execute({
      sql: `UPDATE github_installation
              SET status = 'revoked', updated_at_ms = ?3
            WHERE tenant_id = ?1 AND role = ?2 AND installation_id = ?4`,
      args: [tenantId, input.role, input.nowMs, input.installationId],
    });
    await transaction.execute({
      sql: `INSERT INTO delivery_route (tenant_id, status, observed_at_ms, updated_at_ms)
            VALUES (?1, 'degraded', ?2, ?2)
            ON CONFLICT (tenant_id) DO UPDATE SET
              status = 'degraded', observed_at_ms = excluded.observed_at_ms,
              updated_at_ms = excluded.updated_at_ms`,
      args: [tenantId, input.nowMs],
    });
    return;
  }
  if (input.eventName !== "installation_repositories" || installation.rows[0]?.status !== "installed") return;
  for (const repository of input.added) {
    await transaction.execute({
      sql: `INSERT INTO github_repository (
        tenant_id, installation_role, installation_id, repository_id, owner, name,
        selected, is_default, updated_at_ms
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7)
      ON CONFLICT (tenant_id, installation_role, installation_id, repository_id) DO UPDATE SET
        owner = excluded.owner, name = excluded.name, updated_at_ms = excluded.updated_at_ms`,
      args: [
        tenantId,
        input.role,
        input.installationId,
        repository.id,
        repository.owner,
        repository.name,
        input.nowMs,
      ],
    });
  }
  for (const repositoryId of input.removedIds) {
    await transaction.execute({
      sql: `DELETE FROM github_repository
             WHERE tenant_id = ?1 AND installation_role = ?2
               AND installation_id = ?3 AND repository_id = ?4`,
      args: [tenantId, input.role, input.installationId, repositoryId],
    });
  }
};

export const createGitHubControlStore = (client: Client, options: { readonly claimTtlMs?: number } = {}) => {
  // One batch is delivered sequentially. Keep the default lease longer than
  // 25 bounded 10-second tenant requests so another relay cannot reclaim the
  // tail of a healthy batch while it is still being processed.
  const claimTtlMs = options.claimTtlMs ?? 5 * 60_000;

  return {
    beginInstallation: async (input: {
      readonly stateHash: string;
      readonly tenantId: string;
      readonly userId: string;
      readonly role: GitHubAppRole;
      readonly createdAtMs: number;
      readonly expiresAtMs: number;
    }): Promise<void> => {
      const result = await client.execute({
        sql: `INSERT INTO github_installation_callback (
          state_hash, tenant_id, user_id, role, created_at_ms, expires_at_ms
        )
        SELECT ?1, tenant.id, tenant.user_id, ?4, ?5, ?6
          FROM tenant
         WHERE tenant.id = ?2 AND tenant.user_id = ?3`,
        args: [input.stateHash, input.tenantId, input.userId, input.role, input.createdAtMs, input.expiresAtMs],
      });
      if (result.rowsAffected !== 1) {
        throw new GitHubControlStoreError("tenant_scope", "GitHub installation tenant is not owned by this user");
      }
    },

    installationCallback: async (
      stateHash: string,
      role: GitHubAppRole,
      nowMs: number,
    ): Promise<GitHubInstallationCallback> => {
      const result = await client.execute({
        sql: `SELECT tenant_id, user_id, role, expires_at_ms, installation_id, account_login, completed_at_ms
                FROM github_installation_callback
               WHERE state_hash = ?1`,
        args: [stateHash],
      });
      return requireCallback(result.rows[0] as Record<string, unknown> | undefined, role, nowMs);
    },

    completeInstallation: async (input: {
      readonly stateHash: string;
      readonly role: GitHubAppRole;
      readonly installationId: number;
      readonly accountLogin: string;
      readonly repositories: readonly Omit<GitHubRepositoryGrant, "selected" | "isDefault">[];
      readonly nowMs: number;
    }): Promise<"installed" | "duplicate"> =>
      await withWriteTransaction(client, async (transaction) => {
        const callbackResult = await transaction.execute({
          sql: `SELECT tenant_id, user_id, role, expires_at_ms, installation_id, account_login, completed_at_ms
                  FROM github_installation_callback
                 WHERE state_hash = ?1`,
          args: [input.stateHash],
        });
        const callback = requireCallback(
          callbackResult.rows[0] as Record<string, unknown> | undefined,
          input.role,
          input.nowMs,
        );
        if (callback.completedAtMs !== null) {
          if (callback.installationId === input.installationId) return "duplicate";
          throw new GitHubControlStoreError(
            "installation_state",
            "GitHub installation state was already consumed by another installation",
          );
        }
        if (input.repositories.length === 0) {
          throw new GitHubControlStoreError("repository_scope", "GitHub installation granted no repositories");
        }

        const collision = await transaction.execute({
          sql: `SELECT tenant_id, role
                  FROM github_installation
                 WHERE installation_id = ?1
                   AND (tenant_id != ?2 OR role != ?3)`,
          args: [input.installationId, callback.tenantId, input.role],
        });
        if (collision.rows.length > 0) {
          throw new GitHubControlStoreError(
            "installation_collision",
            "GitHub installation is already bound to another tenant",
          );
        }

        await transaction.execute({
          sql: "DELETE FROM github_repository WHERE tenant_id = ?1 AND installation_role = ?2",
          args: [callback.tenantId, input.role],
        });
        await transaction.execute({
          sql: `INSERT INTO github_installation (
            tenant_id, role, installation_id, status, account_login, updated_at_ms
          ) VALUES (?1, ?2, ?3, 'installed', ?4, ?5)
          ON CONFLICT (tenant_id, role) DO UPDATE SET
            installation_id = excluded.installation_id,
            status = 'installed',
            account_login = excluded.account_login,
            updated_at_ms = excluded.updated_at_ms`,
          args: [callback.tenantId, input.role, input.installationId, input.accountLogin, input.nowMs],
        });
        for (const repository of input.repositories) {
          await transaction.execute({
            sql: `INSERT INTO github_repository (
              tenant_id, installation_role, installation_id, repository_id, owner, name,
              selected, is_default, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7)`,
            args: [
              callback.tenantId,
              input.role,
              input.installationId,
              repository.id,
              repository.owner,
              repository.name,
              input.nowMs,
            ],
          });
        }
        await transaction.execute({
          sql: `UPDATE github_installation_callback
                   SET installation_id = ?2, account_login = ?3, completed_at_ms = ?4
                 WHERE state_hash = ?1 AND completed_at_ms IS NULL`,
          args: [input.stateHash, input.installationId, input.accountLogin, input.nowMs],
        });
        await transaction.execute({
          sql: `UPDATE github_delivery_outbox
                   SET tenant_id = ?1
                 WHERE tenant_id IS NULL AND installation_id = ?2 AND installation_role = ?3`,
          args: [callback.tenantId, input.installationId, input.role],
        });
        return "installed";
      }),

    repositories: async (
      tenantId: string,
      userId: string,
      role: GitHubAppRole,
    ): Promise<readonly GitHubRepositoryGrant[]> => {
      const result = await client.execute({
        sql: `SELECT repository_id, owner, name, selected, is_default
                FROM github_repository
                JOIN github_installation
                  ON github_installation.tenant_id = github_repository.tenant_id
                 AND github_installation.role = github_repository.installation_role
                 AND github_installation.installation_id = github_repository.installation_id
                JOIN tenant ON tenant.id = github_repository.tenant_id
               WHERE github_repository.tenant_id = ?1
                 AND tenant.user_id = ?2
                 AND github_repository.installation_role = ?3
                 AND github_installation.status = 'installed'
               ORDER BY lower(owner), lower(name), repository_id`,
        args: [tenantId, userId, role],
      });
      return result.rows.map((row) => ({
        id: Number(row.repository_id),
        owner: String(row.owner),
        name: String(row.name),
        selected: Number(row.selected) === 1,
        isDefault: Number(row.is_default) === 1,
      }));
    },

    replaceRepositorySelection: async (input: {
      readonly tenantId: string;
      readonly userId: string;
      readonly role: GitHubAppRole;
      readonly repositoryIds: readonly number[];
      readonly defaultRepositoryId: number;
      readonly nowMs: number;
    }): Promise<void> =>
      await withWriteTransaction(client, async (transaction) => {
        const repositoryIds = [...new Set(input.repositoryIds)];
        if (repositoryIds.length === 0 || !repositoryIds.includes(input.defaultRepositoryId)) {
          throw new GitHubControlStoreError(
            "repository_scope",
            "A default repository must be included in the selected repository set",
          );
        }
        const installation = await transaction.execute({
          sql: `SELECT github_installation.installation_id
                  FROM github_installation
                  JOIN tenant ON tenant.id = github_installation.tenant_id
                 WHERE github_installation.tenant_id = ?1
                   AND tenant.user_id = ?2
                   AND github_installation.role = ?3
                   AND github_installation.status = 'installed'`,
          args: [input.tenantId, input.userId, input.role],
        });
        const installationId = installation.rows[0]?.installation_id;
        if (installationId === undefined || installationId === null) {
          throw new GitHubControlStoreError("tenant_scope", "GitHub installation is not owned by this user");
        }
        const placeholders = repositoryIds.map(() => "?").join(", ");
        const granted = await transaction.execute({
          sql: `SELECT repository_id
                  FROM github_repository
                 WHERE tenant_id = ?
                   AND installation_role = ?
                   AND installation_id = ?
                   AND repository_id IN (${placeholders})`,
          args: [input.tenantId, input.role, installationId, ...repositoryIds],
        });
        if (granted.rows.length !== repositoryIds.length) {
          throw new GitHubControlStoreError(
            "repository_scope",
            "Repository selection contains a grant from another tenant or installation",
          );
        }
        await transaction.execute({
          sql: `UPDATE github_repository
                   SET selected = 0, is_default = 0, updated_at_ms = ?4
                 WHERE tenant_id = ?1 AND installation_role = ?2 AND installation_id = ?3`,
          args: [input.tenantId, input.role, installationId, input.nowMs],
        });
        for (const repositoryId of repositoryIds) {
          await transaction.execute({
            sql: `UPDATE github_repository
                     SET selected = 1, is_default = ?5, updated_at_ms = ?6
                   WHERE tenant_id = ?1 AND installation_role = ?2
                     AND installation_id = ?3 AND repository_id = ?4`,
            args: [
              input.tenantId,
              input.role,
              installationId,
              repositoryId,
              repositoryId === input.defaultRepositoryId ? 1 : 0,
              input.nowMs,
            ],
          });
        }
      }),

    acceptDelivery: async (
      delivery: VerifiedGitHubDelivery,
      installationMutation?: GitHubInstallationWebhookMutation,
    ): Promise<{ readonly action: "inserted" | "duplicate"; readonly record: GitHubDeliveryOutboxRecord }> =>
      await withWriteTransaction(client, async (transaction) => {
        const route =
          delivery.installationId === null
            ? undefined
            : await transaction.execute({
                sql: `SELECT tenant_id
                        FROM github_installation
                       WHERE installation_id = ?1 AND role = ?2 AND status = 'installed'`,
                args: [delivery.installationId, delivery.installationRole],
              });
        const tenantId = route?.rows[0]?.tenant_id === undefined ? null : String(route.rows[0]?.tenant_id);
        const inserted = await transaction.execute({
          sql: `INSERT INTO github_delivery_outbox (
            github_app_id, delivery_guid, event_name, installation_role, installation_id, tenant_id,
            payload_json, payload_sha256, next_attempt_at_ms, received_at_ms
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
          ON CONFLICT (github_app_id, delivery_guid) DO NOTHING
          RETURNING github_app_id, delivery_guid, event_name, installation_role, installation_id, tenant_id,
                    payload_json, payload_sha256, state, attempt_count, next_attempt_at_ms,
                    claim_id, claim_expires_at_ms, last_error, tenant_result_json,
                    received_at_ms, acknowledged_at_ms`,
          args: [
            delivery.githubAppId,
            delivery.deliveryGuid,
            delivery.eventName,
            delivery.installationRole,
            delivery.installationId,
            tenantId,
            delivery.payloadJson,
            delivery.payloadSha256,
            delivery.receivedAtMs,
          ],
        });
        let outcome: { readonly action: "inserted" | "duplicate"; readonly record: GitHubDeliveryOutboxRecord };
        if (inserted.rows[0] !== undefined) {
          outcome = { action: "inserted", record: outboxFromRow(inserted.rows[0] as OutboxRow) };
        } else {
          const existing = await transaction.execute({
            sql: `${selectOutbox} WHERE github_app_id = ?1 AND delivery_guid = ?2`,
            args: [delivery.githubAppId, delivery.deliveryGuid],
          });
          const record = outboxFromRow(existing.rows[0] as OutboxRow);
          if (
            record.eventName !== delivery.eventName ||
            record.installationRole !== delivery.installationRole ||
            record.installationId !== delivery.installationId ||
            record.payloadSha256 !== delivery.payloadSha256
          ) {
            throw new GitHubControlStoreError(
              "delivery_collision",
              `GitHub App delivery ${delivery.githubAppId}:${delivery.deliveryGuid} changed identity`,
            );
          }
          outcome = { action: "duplicate", record };
        }
        if (installationMutation !== undefined) {
          if (
            installationMutation.role !== delivery.installationRole ||
            installationMutation.installationId !== delivery.installationId ||
            installationMutation.eventName !== delivery.eventName
          ) {
            throw new GitHubControlStoreError(
              "delivery_collision",
              "GitHub installation mutation does not match its admitted delivery",
            );
          }
          await applyInstallationWebhookWith(transaction, installationMutation);
        }
        return outcome;
      }),

    routePendingDeliveries: async (): Promise<number> => {
      const result = await client.execute(`
        UPDATE github_delivery_outbox
           SET tenant_id = (
             SELECT github_installation.tenant_id
               FROM github_installation
              WHERE github_installation.installation_id = github_delivery_outbox.installation_id
                AND github_installation.role = github_delivery_outbox.installation_role
                AND github_installation.status = 'installed'
           )
         WHERE tenant_id IS NULL
           AND installation_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM github_installation
              WHERE github_installation.installation_id = github_delivery_outbox.installation_id
                AND github_installation.role = github_delivery_outbox.installation_role
                AND github_installation.status = 'installed'
           )
      `);
      return result.rowsAffected;
    },

    claimDueDeliveries: async (
      nowMs: number,
      claimId: string,
      limit: number,
    ): Promise<readonly GitHubDeliveryOutboxRecord[]> => {
      const result = await client.execute({
        sql: `UPDATE github_delivery_outbox
                 SET claim_id = ?1,
                     claim_expires_at_ms = ?2,
                     attempt_count = attempt_count + 1
               WHERE rowid IN (
                 SELECT rowid FROM github_delivery_outbox
                  WHERE state = 'pending'
                    AND tenant_id IS NOT NULL
                    AND next_attempt_at_ms <= ?3
                    AND (claim_id IS NULL OR claim_expires_at_ms <= ?3)
                  ORDER BY next_attempt_at_ms, received_at_ms, github_app_id, delivery_guid
                  LIMIT ?4
               )
               RETURNING github_app_id, delivery_guid, event_name, installation_role, installation_id, tenant_id,
                         payload_json, payload_sha256, state, attempt_count, next_attempt_at_ms,
                         claim_id, claim_expires_at_ms, last_error, tenant_result_json,
                         received_at_ms, acknowledged_at_ms`,
        args: [claimId, nowMs + claimTtlMs, nowMs, limit],
      });
      return result.rows.map((row) => outboxFromRow(row as OutboxRow));
    },

    acknowledgeDelivery: async (input: {
      readonly githubAppId: string;
      readonly deliveryGuid: string;
      readonly tenantId: string;
      readonly claimId: string;
      readonly resultJson: string;
      readonly acknowledgedAtMs: number;
    }): Promise<void> => {
      const result = await client.execute({
        sql: `UPDATE github_delivery_outbox
                 SET state = 'acked', tenant_result_json = ?5, acknowledged_at_ms = ?6,
                     claim_id = NULL, claim_expires_at_ms = NULL, last_error = NULL
               WHERE github_app_id = ?1 AND delivery_guid = ?2 AND tenant_id = ?3
                 AND state = 'pending' AND claim_id = ?4`,
        args: [
          input.githubAppId,
          input.deliveryGuid,
          input.tenantId,
          input.claimId,
          input.resultJson,
          input.acknowledgedAtMs,
        ],
      });
      if (result.rowsAffected !== 1) {
        throw new GitHubControlStoreError("delivery_claim", "GitHub delivery acknowledgement lost its claim");
      }
    },

    retryDelivery: async (input: {
      readonly githubAppId: string;
      readonly deliveryGuid: string;
      readonly tenantId: string;
      readonly claimId: string;
      readonly nextAttemptAtMs: number;
      readonly error: string;
    }): Promise<void> => {
      const result = await client.execute({
        sql: `UPDATE github_delivery_outbox
                 SET next_attempt_at_ms = ?5, last_error = ?6,
                     claim_id = NULL, claim_expires_at_ms = NULL
               WHERE github_app_id = ?1 AND delivery_guid = ?2 AND tenant_id = ?3
                 AND state = 'pending' AND claim_id = ?4`,
        args: [
          input.githubAppId,
          input.deliveryGuid,
          input.tenantId,
          input.claimId,
          input.nextAttemptAtMs,
          input.error,
        ],
      });
      if (result.rowsAffected !== 1) {
        throw new GitHubControlStoreError("delivery_claim", "GitHub delivery retry lost its claim");
      }
    },

    delivery: async (githubAppId: string, deliveryGuid: string): Promise<GitHubDeliveryOutboxRecord | undefined> => {
      const result = await client.execute({
        sql: `${selectOutbox} WHERE github_app_id = ?1 AND delivery_guid = ?2`,
        args: [githubAppId, deliveryGuid],
      });
      return result.rows[0] === undefined ? undefined : outboxFromRow(result.rows[0] as OutboxRow);
    },

    runtimeTarget: async (tenantId: string): Promise<GitHubRuntimeTarget | null> => {
      const result = await client.execute({
        sql: `SELECT id, runtime_base_url
                FROM agent_instance
               WHERE tenant_id = ?1
                 AND applied_mode = 'operate'
                 AND runtime_base_url IS NOT NULL`,
        args: [tenantId],
      });
      const row = result.rows[0];
      return row === undefined
        ? null
        : { tenantId, runtimeId: String(row.id), baseUrl: String(row.runtime_base_url) };
    },
  };
};

export type GitHubControlStore = ReturnType<typeof createGitHubControlStore>;
