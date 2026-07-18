import { createClient, type Client, type Config } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema";

export type ControlDbOptions = Pick<Config, "url" | "authToken">;

export async function openControlDb(options: ControlDbOptions) {
  const client = createClient(options);

  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const result = await client.execute("PRAGMA foreign_keys");
    if (Number(result.rows[0]?.foreign_keys) !== 1) {
      throw new Error("control_db_foreign_keys_disabled");
    }

    return { client, db: drizzle({ client, schema }) };
  } catch (error) {
    client.close();
    throw error;
  }
}

const nowMs = "cast(unixepoch('subsecond') * 1000 as integer)";
const provisionerLeaseTtlMs = 30_000;

const acquireLeaseSql = `
INSERT INTO provisioner_lease (
  creds_store_key, owner_id, fencing_token,
  expires_at_ms, acquired_at_ms, renewed_at_ms
) VALUES (
  ?1, ?2, 1,
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

const renewLeaseSql = `
UPDATE provisioner_lease
SET expires_at_ms = (${nowMs}) + ?4,
    renewed_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND owner_id = ?2
  AND fencing_token = ?3
  AND expires_at_ms > (${nowMs})
RETURNING owner_id, fencing_token, expires_at_ms;
`;

const releaseLeaseSql = `
UPDATE provisioner_lease
SET owner_id = NULL,
    expires_at_ms = NULL,
    renewed_at_ms = (${nowMs})
WHERE creds_store_key = ?1
  AND owner_id = ?2
  AND fencing_token = ?3
RETURNING fencing_token;
`;

const writeAgentPhaseSql = `
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

export type ProvisionerLease = {
  ownerId: string;
  fencingToken: number;
  expiresAtMs: number;
};

export type AgentPhase = (typeof schema.agentInstance.$inferSelect)["phase"];

function leaseFromRow(row: Record<string, unknown> | undefined): ProvisionerLease | null {
  if (!row) return null;
  return {
    ownerId: String(row.owner_id),
    fencingToken: Number(row.fencing_token),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

export async function acquireLease(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  ownerId: string,
): Promise<ProvisionerLease | null> {
  const result = await client.execute({
    sql: acquireLeaseSql,
    args: [credsStoreKey, ownerId, provisionerLeaseTtlMs],
  });
  return leaseFromRow(result.rows[0]);
}

export async function renewLease(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
): Promise<ProvisionerLease | null> {
  const result = await client.execute({
    sql: renewLeaseSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, provisionerLeaseTtlMs],
  });
  return leaseFromRow(result.rows[0]);
}

export async function releaseLease(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
): Promise<boolean> {
  const result = await client.execute({
    sql: releaseLeaseSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken],
  });
  return result.rows.length === 1;
}

export async function writeAgentPhase(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
  phase: AgentPhase,
  errorCode: string | null = null,
): Promise<boolean> {
  const result = await client.execute({
    sql: writeAgentPhaseSql,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, phase, errorCode],
  });
  return result.rows.length === 1;
}
