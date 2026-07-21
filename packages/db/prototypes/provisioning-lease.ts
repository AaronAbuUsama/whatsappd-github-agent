import assert from "node:assert/strict";

import { createClient, type Client } from "@libsql/client";

const nowMs = "cast(unixepoch('subsecond') * 1000 as integer)";

const schema = `
-- The real control DB already has this Better Auth table. The minimal copy keeps
-- this prototype self-contained while preserving the production foreign key.
CREATE TABLE user (
  id TEXT PRIMARY KEY
);

CREATE TABLE tenant (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  polar_subscription_id TEXT NOT NULL UNIQUE,
  tenant_db_name TEXT NOT NULL UNIQUE,
  tenant_db_url TEXT UNIQUE,
  tenant_db_token_ciphertext TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  desired_state TEXT NOT NULL DEFAULT 'stopped'
    CHECK (desired_state IN ('stopped', 'running', 'deleted'))
);

CREATE TABLE agent_instance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenant(id) ON DELETE CASCADE,
  creds_store_key TEXT NOT NULL UNIQUE
    REFERENCES tenant(tenant_db_name) ON DELETE CASCADE,
  dokploy_display_name TEXT NOT NULL UNIQUE,
  dokploy_creation_token TEXT NOT NULL UNIQUE,
  dokploy_application_id TEXT UNIQUE,
  dokploy_app_name TEXT UNIQUE,
  applied_config_version INTEGER NOT NULL DEFAULT 0,
  remote_config_operation_id TEXT UNIQUE,
  remote_config_owner_id TEXT,
  remote_config_fencing_token INTEGER,
  remote_config_target_version INTEGER,
  remote_config_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (remote_config_state IN (
      'idle', 'pending', 'confirmed', 'blocked_unknown'
    )),
  phase TEXT NOT NULL DEFAULT 'pending_input'
    CHECK (phase IN (
      'pending_input', 'provisioning', 'starting', 'running', 'stopping',
      'stopped', 'retryable_error', 'blocked_invariant'
    )),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL DEFAULT (${nowMs}),
  CHECK (
    (remote_config_state = 'idle'
      AND remote_config_operation_id IS NULL
      AND remote_config_owner_id IS NULL
      AND remote_config_fencing_token IS NULL
      AND remote_config_target_version IS NULL) OR
    (remote_config_state != 'idle'
      AND remote_config_operation_id IS NOT NULL
      AND remote_config_owner_id IS NOT NULL
      AND remote_config_fencing_token IS NOT NULL
      AND remote_config_fencing_token > 0
      AND remote_config_target_version IS NOT NULL
      AND remote_config_target_version > 0)
  )
);

CREATE TABLE provisioner_lease (
  creds_store_key TEXT PRIMARY KEY
    REFERENCES agent_instance(creds_store_key) ON DELETE CASCADE,
  owner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  expires_at_ms INTEGER,
  acquired_at_ms INTEGER,
  renewed_at_ms INTEGER,
  CHECK (
    (owner_id IS NULL AND expires_at_ms IS NULL) OR
    (owner_id IS NOT NULL AND expires_at_ms IS NOT NULL)
  )
);
`;

const acquireSql = `
INSERT INTO provisioner_lease (
  creds_store_key,
  owner_id,
  fencing_token,
  expires_at_ms,
  acquired_at_ms,
  renewed_at_ms
) VALUES (
  ?1,
  ?2,
  1,
  (${nowMs}) + ?3,
  (${nowMs}),
  (${nowMs})
)
ON CONFLICT (creds_store_key) DO UPDATE SET
  owner_id = excluded.owner_id,
  fencing_token = CASE
    WHEN provisioner_lease.owner_id = excluded.owner_id
      AND provisioner_lease.expires_at_ms > excluded.renewed_at_ms
      THEN provisioner_lease.fencing_token
    ELSE provisioner_lease.fencing_token + 1
  END,
  expires_at_ms = excluded.expires_at_ms,
  acquired_at_ms = CASE
    WHEN provisioner_lease.owner_id = excluded.owner_id
      AND provisioner_lease.expires_at_ms > excluded.renewed_at_ms
      THEN provisioner_lease.acquired_at_ms
    ELSE excluded.acquired_at_ms
  END,
  renewed_at_ms = excluded.renewed_at_ms
WHERE provisioner_lease.owner_id IS NULL
   OR provisioner_lease.owner_id = excluded.owner_id
   OR provisioner_lease.expires_at_ms <= excluded.renewed_at_ms
RETURNING owner_id, fencing_token, expires_at_ms;
`;

const renewSql = `
UPDATE provisioner_lease
SET expires_at_ms = (${nowMs}) + ?4,
    renewed_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND owner_id = ?2
  AND fencing_token = ?3
  AND expires_at_ms > (${nowMs})
RETURNING owner_id, fencing_token, expires_at_ms;
`;

const releaseSql = `
UPDATE provisioner_lease
SET owner_id = NULL,
    expires_at_ms = NULL,
    renewed_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND owner_id = ?2
  AND fencing_token = ?3
RETURNING fencing_token;
`;

const fencedPhaseWriteSql = `
UPDATE agent_instance
SET phase = ?4,
    last_error_code = ?5,
    updated_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND EXISTS (
    SELECT 1
    FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND provisioner_lease.owner_id = ?2
      AND provisioner_lease.fencing_token = ?3
      AND provisioner_lease.expires_at_ms > (${nowMs})
  )
RETURNING phase;
`;

const bindApplicationSql = `
UPDATE agent_instance
SET dokploy_application_id = ?4,
    dokploy_app_name = ?5,
    updated_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND (
    dokploy_application_id IS NULL OR
    (dokploy_application_id = ?4 AND dokploy_app_name = ?5)
  )
  AND EXISTS (
    SELECT 1
    FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND provisioner_lease.owner_id = ?2
      AND provisioner_lease.fencing_token = ?3
      AND provisioner_lease.expires_at_ms > (${nowMs})
  )
RETURNING dokploy_application_id;
`;

const beginRemoteConfigSql = `
UPDATE agent_instance
SET remote_config_operation_id = ?4,
    remote_config_owner_id = ?2,
    remote_config_fencing_token = ?3,
    remote_config_target_version = ?5,
    remote_config_state = 'pending',
    updated_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND remote_config_state IN ('idle', 'confirmed')
  AND ?5 > applied_config_version
  AND EXISTS (
    SELECT 1
    FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND provisioner_lease.owner_id = ?2
      AND provisioner_lease.fencing_token = ?3
      AND provisioner_lease.expires_at_ms > (${nowMs})
  )
RETURNING remote_config_operation_id;
`;

const confirmRemoteConfigSql = `
UPDATE agent_instance
SET remote_config_state = 'confirmed',
    applied_config_version = remote_config_target_version,
    updated_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND remote_config_operation_id = ?4
  AND remote_config_owner_id = ?2
  AND remote_config_fencing_token = ?3
  AND remote_config_state = 'pending'
  AND EXISTS (
    SELECT 1
    FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND provisioner_lease.owner_id = ?2
      AND provisioner_lease.fencing_token = ?3
      AND provisioner_lease.expires_at_ms > (${nowMs})
  )
RETURNING applied_config_version;
`;

const blockRemoteConfigSql = `
UPDATE agent_instance
SET remote_config_state = 'blocked_unknown',
    phase = 'blocked_invariant',
    last_error_code = 'dokploy_config_outcome_unknown',
    updated_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND remote_config_operation_id = ?4
  AND remote_config_state = 'pending'
  AND EXISTS (
    SELECT 1
    FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND provisioner_lease.owner_id = ?2
      AND provisioner_lease.fencing_token = ?3
      AND provisioner_lease.expires_at_ms > (${nowMs})
  )
RETURNING remote_config_state;
`;

const acknowledgeRemoteQuiescedSql = `
UPDATE agent_instance
SET remote_config_operation_id = NULL,
    remote_config_owner_id = NULL,
    remote_config_fencing_token = NULL,
    remote_config_target_version = NULL,
    remote_config_state = 'idle',
    phase = 'stopped',
    last_error_code = NULL,
    updated_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND remote_config_operation_id = ?4
  AND remote_config_state = 'blocked_unknown'
  AND EXISTS (
    SELECT 1
    FROM provisioner_lease
    WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
      AND provisioner_lease.owner_id = ?2
      AND provisioner_lease.fencing_token = ?3
      AND provisioner_lease.expires_at_ms > (${nowMs})
  )
RETURNING remote_config_state;
`;

type Lease = {
  ownerId: string;
  fencingToken: number;
  expiresAtMs: number;
};

function leaseFromRow(row: Record<string, unknown> | undefined): Lease | null {
  if (!row) return null;
  return {
    ownerId: String(row.owner_id),
    fencingToken: Number(row.fencing_token),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

async function acquire(db: Client, credsStoreKey: string, ownerId: string, ttlMs: number): Promise<Lease | null> {
  const result = await db.execute({
    sql: acquireSql,
    args: [credsStoreKey, ownerId, ttlMs],
  });
  return leaseFromRow(result.rows[0]);
}

async function renew(db: Client, lease: Lease, credsStoreKey: string, ttlMs: number) {
  const result = await db.execute({
    sql: renewSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, ttlMs],
  });
  return leaseFromRow(result.rows[0]);
}

async function release(db: Client, lease: Lease, credsStoreKey: string) {
  const result = await db.execute({
    sql: releaseSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken],
  });
  return result.rows.length === 1;
}

async function writePhase(
  db: Client,
  lease: Lease,
  credsStoreKey: string,
  phase: string,
  errorCode: string | null = null,
) {
  const result = await db.execute({
    sql: fencedPhaseWriteSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, phase, errorCode],
  });
  return result.rows.length === 1;
}

async function bindApplication(
  db: Client,
  lease: Lease,
  credsStoreKey: string,
  applicationId: string,
  appName: string,
) {
  const result = await db.execute({
    sql: bindApplicationSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, applicationId, appName],
  });
  return result.rows.length === 1;
}

async function beginRemoteConfig(
  db: Client,
  lease: Lease,
  credsStoreKey: string,
  operationId: string,
  targetVersion: number,
) {
  const result = await db.execute({
    sql: beginRemoteConfigSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, operationId, targetVersion],
  });
  return result.rows.length === 1;
}

async function confirmRemoteConfig(db: Client, lease: Lease, credsStoreKey: string, operationId: string) {
  const result = await db.execute({
    sql: confirmRemoteConfigSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, operationId],
  });
  return result.rows.length === 1;
}

async function blockRemoteConfig(db: Client, lease: Lease, credsStoreKey: string, operationId: string) {
  const result = await db.execute({
    sql: blockRemoteConfigSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, operationId],
  });
  return result.rows.length === 1;
}

async function acknowledgeRemoteQuiesced(db: Client, lease: Lease, credsStoreKey: string, operationId: string) {
  const result = await db.execute({
    sql: acknowledgeRemoteQuiescedSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, operationId],
  });
  return result.rows.length === 1;
}

async function selfCheck() {
  const db = createClient({ url: "file::memory:" });
  const key = "tenant-db-tenant-a";

  try {
    await db.execute("PRAGMA foreign_keys = ON");
    const foreignKeys = await db.execute("PRAGMA foreign_keys");
    assert.equal(
      Number(foreignKeys.rows[0]?.foreign_keys),
      1,
      "control DB startup must enable and verify foreign-key enforcement",
    );
    await db.executeMultiple(schema);
    await db.execute({ sql: "INSERT INTO user (id) VALUES (?1)", args: ["user-a"] });
    await db.execute({
      sql: `INSERT INTO tenant (
        id, user_id, polar_subscription_id, tenant_db_name, tenant_db_url,
        tenant_db_token_ciphertext
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      args: ["tenant-a", "user-a", "sub-a", key, "libsql://tenant-a", "ciphertext-a"],
    });
    await db.execute({
      sql: `INSERT INTO agent_instance (
        id, tenant_id, creds_store_key, dokploy_display_name,
        dokploy_creation_token
      ) VALUES (?1, ?2, ?3, ?4, ?5)`,
      args: ["agent-a", "tenant-a", key, "Ambient tenant tenant-a", "create-tenant-a"],
    });
    await assert.rejects(
      db.execute({
        sql: `UPDATE agent_instance
          SET remote_config_operation_id = 'invalid-null-fence',
              remote_config_owner_id = 'invalid-owner',
              remote_config_fencing_token = NULL,
              remote_config_target_version = 1,
              remote_config_state = 'pending'
          WHERE creds_store_key = ?1`,
        args: [key],
      }),
      /CHECK constraint failed/,
      "a non-idle remote operation requires a fencing token",
    );
    await assert.rejects(
      db.execute({
        sql: `UPDATE agent_instance
          SET remote_config_operation_id = 'invalid-null-version',
              remote_config_owner_id = 'invalid-owner',
              remote_config_fencing_token = 1,
              remote_config_target_version = NULL,
              remote_config_state = 'pending'
          WHERE creds_store_key = ?1`,
        args: [key],
      }),
      /CHECK constraint failed/,
      "a non-idle remote operation requires a target version",
    );

    const first = await acquire(db, key, "reconcile-a", 30_000);
    assert(first, "the first reconciler acquires the lease");
    assert.equal(first.fencingToken, 1);
    assert.equal(await acquire(db, key, "reconcile-b", 30_000), null);

    const renewed = await renew(db, first, key, 30_000);
    assert.equal(renewed?.fencingToken, first.fencingToken);
    assert.equal(await writePhase(db, first, key, "provisioning"), true);

    await db.execute({
      sql: `UPDATE provisioner_lease
        SET expires_at_ms = (${nowMs}) - 1
        WHERE creds_store_key = ?1`,
      args: [key],
    });

    const takeover = await acquire(db, key, "reconcile-b", 30_000);
    assert(takeover, "a new reconciler takes over only after expiry");
    assert.equal(takeover.fencingToken, 2);
    assert.equal(await renew(db, first, key, 30_000), null);
    assert.equal(await release(db, first, key), false);
    assert.equal(await writePhase(db, first, key, "running"), false);
    assert.equal(await writePhase(db, takeover, key, "running"), true);
    assert.equal(await release(db, takeover, key), true);

    const third = await acquire(db, key, "reconcile-c", 30_000);
    assert(third);
    assert.equal(third.fencingToken, 3, "fencing tokens never reset after release");
    assert.equal(await bindApplication(db, first, key, "app-stale", "generated-stale"), false);
    assert.equal(await bindApplication(db, third, key, "app-winner", "generated-winner"), true);
    assert.equal(await bindApplication(db, third, key, "app-loser", "generated-loser"), false);
    assert.equal(await beginRemoteConfig(db, third, key, "remote-op-a", 1), true);

    await db.execute({
      sql: `UPDATE provisioner_lease
        SET expires_at_ms = (${nowMs}) - 1
        WHERE creds_store_key = ?1`,
      args: [key],
    });
    const fourth = await acquire(db, key, "reconcile-d", 30_000);
    assert(fourth);
    assert.equal(fourth.fencingToken, 4);
    assert.equal(await confirmRemoteConfig(db, third, key, "remote-op-a"), false);
    assert.equal(
      await confirmRemoteConfig(db, fourth, key, "remote-op-a"),
      false,
      "a successor cannot confirm another owner's remote config write",
    );
    assert.equal(
      await beginRemoteConfig(db, fourth, key, "remote-op-b", 1),
      false,
      "a successor cannot supersede an in-flight remote config write",
    );
    assert.equal(await blockRemoteConfig(db, fourth, key, "remote-op-a"), true);
    assert.equal(await acknowledgeRemoteQuiesced(db, third, key, "remote-op-a"), false);
    assert.equal(await beginRemoteConfig(db, fourth, key, "remote-op-b", 1), false);
    assert.equal(await acknowledgeRemoteQuiesced(db, fourth, key, "remote-op-a"), true);
    assert.equal(await beginRemoteConfig(db, fourth, key, "remote-op-b", 1), true);
    assert.equal(await confirmRemoteConfig(db, fourth, key, "remote-op-b"), true);

    await db.execute({
      sql: `INSERT INTO tenant (
        id, user_id, polar_subscription_id, tenant_db_name
      ) VALUES (?1, ?2, ?3, ?4)`,
      args: ["tenant-b", "user-a", "sub-b", "tenant-db-tenant-b"],
    });
    const pending = await db.execute({
      sql: `SELECT tenant_db_url, tenant_db_token_ciphertext
        FROM tenant WHERE id = ?1`,
      args: ["tenant-b"],
    });
    assert.equal(pending.rows[0]?.tenant_db_url, null);
    assert.equal(pending.rows[0]?.tenant_db_token_ciphertext, null);
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO agent_instance (
          id, tenant_id, creds_store_key, dokploy_display_name,
          dokploy_creation_token
        ) VALUES (?1, ?2, ?3, ?4, ?5)`,
        args: ["agent-b", "tenant-b", key, "Ambient tenant tenant-b", "create-tenant-b"],
      }),
      /UNIQUE constraint failed/,
      "one creds store cannot be bound to a second agent instance",
    );

    await db.execute({ sql: "DELETE FROM user WHERE id = ?1", args: ["user-a"] });
    for (const table of ["tenant", "agent_instance", "provisioner_lease"]) {
      const count = await db.execute(`SELECT count(*) AS count FROM ${table}`);
      assert.equal(Number(count.rows[0]?.count), 0, `${table} cascades on user deletion`);
    }

    console.log("provisioning lease self-check: ok");
  } finally {
    db.close();
  }
}

await selfCheck();
