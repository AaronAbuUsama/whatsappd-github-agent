import { createClient, type Client, type InStatement, type Transaction } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionStore } from "whatsappd";

import {
  CHATGPT_PROVIDER_ID,
  type ChatGptCredentialStore,
  validateChatGptOAuthCredential,
} from "@ambient-agent/engine/model/chatgpt-authentication.ts";

export interface TenantCredentialDatabase {
  readonly url: string;
  readonly authToken?: string;
}

export interface TenantCredentialEnvironment {
  readonly TENANT_DB_URL?: string;
  readonly TENANT_DB_TOKEN?: string;
}

const configuredValue = (value: string | undefined): string | undefined => {
  const configured = value?.trim();
  return configured === undefined || configured.length === 0 ? undefined : configured;
};

/**
 * Resolve the provisioner-owned tenant DB contract. A partial contract is an
 * error: once either value is configured, callers may not fall back to files.
 */
export const tenantCredentialDatabaseFromEnvironment = (
  environment: TenantCredentialEnvironment = process.env,
): TenantCredentialDatabase | undefined => {
  const url = configuredValue(environment.TENANT_DB_URL);
  const authToken = configuredValue(environment.TENANT_DB_TOKEN);
  if (url === undefined && authToken === undefined) return undefined;
  if (url === undefined || authToken === undefined) {
    throw new Error("TENANT_DB_URL and TENANT_DB_TOKEN must be configured together.");
  }
  return { url, authToken };
};

const createTenantClient = ({ url, authToken }: TenantCredentialDatabase): Client =>
  createClient({ url, timeout: 0, ...(authToken === undefined ? {} : { authToken }) });

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
};

const isDatabaseBusy = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "SQLITE_BUSY";

const retryDatabaseBusy = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  const deadline = Date.now() + 30_000;
  let retryDelay = 10;
  for (;;) {
    throwIfAborted(signal);
    try {
      return await operation();
    } catch (cause) {
      if (!isDatabaseBusy(cause) || Date.now() >= deadline) throw cause;
      await delay(retryDelay, undefined, signal === undefined ? undefined : { signal });
      retryDelay = Math.min(retryDelay * 2, 100);
    }
  }
};

const initializeSchemas = async (client: Client, schemas: string | readonly string[]): Promise<void> => {
  for (const schema of typeof schemas === "string" ? [schemas] : schemas) {
    await retryDatabaseBusy(async () => {
      await client.execute(schema);
    });
  }
};

const initializeClient = (
  database: TenantCredentialDatabase,
  schema: string | readonly string[],
): (() => Promise<Client>) => {
  const client = createTenantClient(database);
  let ready: Promise<void> | undefined;
  return async () => {
    ready ??= initializeSchemas(client, schema).catch((cause: unknown) => {
      ready = undefined;
      throw cause;
    });
    await ready;
    return client;
  };
};

const whatsappSchema = `
  CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )
`;

/** A whatsappd SessionStore backed by the tenant's isolated libSQL database. */
export const libsqlStore = (database: TenantCredentialDatabase): SessionStore => {
  const connect = initializeClient(database, whatsappSchema);

  return {
    async read(key) {
      const result = await (
        await connect()
      ).execute({
        sql: "SELECT value FROM whatsapp_auth_state WHERE key = ?",
        args: [key],
      });
      const value = result.rows[0]?.value;
      return value === undefined || value === null ? null : String(value);
    },
    async write(entries) {
      const statements = Object.entries(entries).map(([key, value]) =>
        value === null
          ? { sql: "DELETE FROM whatsapp_auth_state WHERE key = ?", args: [key] }
          : {
              sql: `
                INSERT INTO whatsapp_auth_state (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
              `,
              args: [key, value],
            },
      );
      if (statements.length === 0) return;
      await (await connect()).batch(statements, "write");
    },
    async clear() {
      await (await connect()).execute("DELETE FROM whatsapp_auth_state");
    },
  };
};

const modelSchema = `
  CREATE TABLE IF NOT EXISTS model_credentials (
    provider_id TEXT PRIMARY KEY NOT NULL,
    credential_json TEXT NOT NULL
  )
`;
const modelLeaseSchema = `
  CREATE TABLE IF NOT EXISTS model_credential_leases (
    provider_id TEXT PRIMARY KEY NOT NULL,
    owner_token TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )
`;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const LEASE_DURATION_MS = 15_000;
const LEASE_HEARTBEAT_MS = 5_000;
const localCredentialOperations = new Map<string, Promise<void>>();

const beginWriteTransaction = async (client: Client, signal?: AbortSignal): Promise<Transaction> =>
  await retryDatabaseBusy(async () => await client.transaction("write"), signal);

/** Keep the local libSQL driver from synchronously contending with itself. */
const serializeLocalCredentialOperation = async <T>(databaseUrl: string, operation: () => Promise<T>): Promise<T> => {
  const predecessor = localCredentialOperations.get(databaseUrl) ?? Promise.resolve();
  const current = predecessor.then(operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  localCredentialOperations.set(databaseUrl, tail);
  void tail.finally(() => {
    if (localCredentialOperations.get(databaseUrl) === tail) localCredentialOperations.delete(databaseUrl);
  });
  return await current;
};

interface TenantCredentialSnapshot {
  readonly whatsapp: ReadonlyArray<readonly [key: string, value: string]>;
  readonly models: ReadonlyArray<readonly [providerId: string, credentialJson: string]>;
}

type TenantCredentialRollbackScope = "all" | "whatsapp";

const captureTenantCredentials = async (
  database: TenantCredentialDatabase,
  scope: TenantCredentialRollbackScope,
): Promise<TenantCredentialSnapshot> => {
  const client = createTenantClient(database);
  try {
    await initializeSchemas(
      client,
      scope === "all" ? [whatsappSchema, modelSchema, modelLeaseSchema] : [whatsappSchema],
    );
    const results = await client.batch([
      "SELECT key, value FROM whatsapp_auth_state ORDER BY key",
      ...(scope === "all" ? ["SELECT provider_id, credential_json FROM model_credentials ORDER BY provider_id"] : []),
    ], "read");
    const whatsapp = results[0]!;
    const models = results[1];
    return {
      whatsapp: whatsapp.rows.map((row) => {
        if (typeof row.key !== "string" || typeof row.value !== "string") {
          throw new Error("The tenant WhatsApp credential table is malformed.");
        }
        return [row.key, row.value] as const;
      }),
      models:
        models?.rows.map((row) => {
          if (typeof row.provider_id !== "string" || typeof row.credential_json !== "string") {
            throw new Error("The tenant model credential table is malformed.");
          }
          return [row.provider_id, row.credential_json] as const;
        }) ?? [],
    };
  } finally {
    client.close();
  }
};

const restoreTenantCredentials = async (
  database: TenantCredentialDatabase,
  snapshot: TenantCredentialSnapshot,
  scope: TenantCredentialRollbackScope,
): Promise<void> => {
  const client = createTenantClient(database);
  try {
    await initializeSchemas(
      client,
      scope === "all" ? [whatsappSchema, modelSchema, modelLeaseSchema] : [whatsappSchema],
    );
    const transaction = await beginWriteTransaction(client);
    try {
      await transaction.batch([
        "DELETE FROM whatsapp_auth_state",
        ...(scope === "all" ? ["DELETE FROM model_credentials"] : []),
        ...snapshot.whatsapp.map(([key, value]) => ({
          sql: "INSERT INTO whatsapp_auth_state (key, value) VALUES (?, ?)",
          args: [key, value],
        })),
        ...snapshot.models.map(([providerId, credentialJson]) => ({
          sql: "INSERT INTO model_credentials (provider_id, credential_json) VALUES (?, ?)",
          args: [providerId, credentialJson],
        })),
      ]);
      await transaction.commit();
    } finally {
      transaction.close();
    }
  } finally {
    client.close();
  }
};

const withCredentialRollback = async <T>(
  database: TenantCredentialDatabase,
  operation: () => Promise<T>,
  scope: TenantCredentialRollbackScope,
): Promise<T> => {
  const snapshot = await captureTenantCredentials(database, scope);
  try {
    return await operation();
  } catch (cause) {
    try {
      await restoreTenantCredentials(database, snapshot, scope);
    } catch (rollbackCause) {
      throw new AggregateError([cause, rollbackCause], "Tenant credential rollback failed.");
    }
    throw cause;
  }
};

/** Restore both tenant secret stores when a multi-step first-run workflow fails. */
export const withTenantCredentialRollback = async <T>(
  database: TenantCredentialDatabase,
  operation: () => Promise<T>,
): Promise<T> => await withCredentialRollback(database, operation, "all");

/** Restore only WhatsApp state when a pairing workflow fails. */
export const withTenantWhatsAppCredentialRollback = async <T>(
  database: TenantCredentialDatabase,
  operation: () => Promise<T>,
): Promise<T> => await withCredentialRollback(database, operation, "whatsapp");

const assertChatGptProvider = (providerId: string): void => {
  if (providerId !== CHATGPT_PROVIDER_ID) {
    throw new Error(`Unsupported managed model provider ${JSON.stringify(providerId)}.`);
  }
};

const serializeCredential = (value: unknown): string => {
  const credential = validateChatGptOAuthCredential(value);
  const serialized = JSON.stringify(credential);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw new Error("The managed ChatGPT credential exceeds the 1 MiB storage limit.");
  }
  return serialized;
};

type CredentialExecutor = Pick<Client | Transaction, "execute">;
type CredentialMutation =
  | { readonly type: "unchanged" }
  | { readonly type: "replace"; readonly serialized: string }
  | { readonly type: "delete" };

/** A ChatGptCredentialStore whose atomic modify seam is persisted in libSQL. */
export const createLibsqlChatGptCredentialStore = (database: TenantCredentialDatabase): ChatGptCredentialStore => {
  const connect = initializeClient(database, [modelSchema, modelLeaseSchema]);

  const readStored = async (executor: CredentialExecutor, providerId: string) => {
    const result = await executor.execute({
      sql: "SELECT credential_json FROM model_credentials WHERE provider_id = ?",
      args: [providerId],
    });
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const serialized = row.credential_json;
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_BYTES) {
      throw new Error("The managed ChatGPT credential row is malformed.");
    }
    return validateChatGptOAuthCredential(JSON.parse(serialized));
  };

  const readStoredFresh = async (providerId: string) => {
    await connect();
    const reader = createTenantClient(database);
    try {
      return await readStored(reader, providerId);
    } finally {
      reader.close();
    }
  };

  const executeFresh = async (
    statement: InStatement,
    signal?: AbortSignal,
  ) => {
    await connect();
    return await retryDatabaseBusy(async () => {
      const client = createTenantClient(database);
      try {
        return await client.execute(statement);
      } finally {
        client.close();
      }
    }, signal);
  };

  const acquireLease = async (providerId: string, signal?: AbortSignal) => {
    const ownerToken = randomUUID();
    let retryDelay = 20;
    for (;;) {
      throwIfAborted(signal);
      const result = await executeFresh(
        {
          sql: `
            INSERT INTO model_credential_leases (provider_id, owner_token, expires_at_ms)
            VALUES (?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?)
            ON CONFLICT(provider_id) DO UPDATE SET
              owner_token = excluded.owner_token,
              expires_at_ms = excluded.expires_at_ms
            WHERE model_credential_leases.expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
          `,
          args: [providerId, ownerToken, LEASE_DURATION_MS],
        },
        signal,
      );
      if (result.rowsAffected === 1) break;
      await delay(retryDelay, undefined, signal === undefined ? undefined : { signal });
      retryDelay = Math.min(retryDelay * 2, 500);
    }

    const heartbeatAbort = new AbortController();
    let heartbeatFailure: unknown;
    const heartbeat = (async () => {
      try {
        for (;;) {
          await delay(LEASE_HEARTBEAT_MS, undefined, { signal: heartbeatAbort.signal });
          const renewed = await executeFresh(
            {
              sql: `
                UPDATE model_credential_leases
                SET expires_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?
                WHERE provider_id = ? AND owner_token = ?
              `,
              args: [LEASE_DURATION_MS, providerId, ownerToken],
            },
            heartbeatAbort.signal,
          );
          if (renewed.rowsAffected !== 1) throw new Error("The managed ChatGPT credential lease was lost.");
        }
      } catch (cause) {
        if (!heartbeatAbort.signal.aborted) heartbeatFailure = cause;
      }
    })();

    const stopHeartbeat = async (): Promise<void> => {
      heartbeatAbort.abort();
      await heartbeat;
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
    };
    const abandon = async (): Promise<void> => {
      heartbeatAbort.abort();
      await heartbeat;
      await executeFresh({
        sql: "DELETE FROM model_credential_leases WHERE provider_id = ? AND owner_token = ?",
        args: [providerId, ownerToken],
      });
    };
    const finalize = async (mutation: CredentialMutation): Promise<void> => {
      await stopHeartbeat();
      if (mutation.type === "replace") {
        const result = await executeFresh({
          sql: `
            INSERT INTO model_credentials (provider_id, credential_json)
            SELECT ?, ?
            WHERE EXISTS (
              SELECT 1 FROM model_credential_leases
              WHERE provider_id = ?
                AND owner_token = ?
                AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
            )
            ON CONFLICT(provider_id) DO UPDATE SET credential_json = excluded.credential_json
          `,
          args: [providerId, mutation.serialized, providerId, ownerToken],
        });
        if (result.rowsAffected !== 1) {
          throw new Error("The managed ChatGPT credential lease expired before the credential update.");
        }
      } else if (mutation.type === "delete") {
        await executeFresh({
          sql: `
            DELETE FROM model_credentials
            WHERE provider_id = ?
              AND EXISTS (
                SELECT 1 FROM model_credential_leases
                WHERE provider_id = ?
                  AND owner_token = ?
                  AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
              )
          `,
          args: [providerId, providerId, ownerToken],
        });
      }
      const released = await executeFresh({
        sql: `
          DELETE FROM model_credential_leases
          WHERE provider_id = ?
            AND owner_token = ?
            AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        `,
        args: [providerId, ownerToken],
      });
      if (released.rowsAffected !== 1) {
        throw new Error("The managed ChatGPT credential lease expired before release.");
      }
    };
    return { abandon, finalize };
  };

  const runLeased = async <T>(
    providerId: string,
    operation: (lease: Awaited<ReturnType<typeof acquireLease>>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const lease = await acquireLease(providerId, signal);
    try {
      return await operation(lease);
    } catch (cause) {
      try {
        await lease.abandon();
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], "Managed ChatGPT credential lease cleanup failed.");
      }
      throw cause;
    }
  };

  const store: ChatGptCredentialStore = {
    async read(providerId, signal) {
      assertChatGptProvider(providerId);
      throwIfAborted(signal);
      return await readStoredFresh(providerId);
    },
    async modify(providerId, change, signal) {
      assertChatGptProvider(providerId);
      return await serializeLocalCredentialOperation(database.url, async () => {
        throwIfAborted(signal);
        return await runLeased(
          providerId,
          async (lease) => {
            const current = await readStoredFresh(providerId);
            const next = await change(current);
            throwIfAborted(signal);
            if (next === undefined) {
              await lease.finalize({ type: "unchanged" });
              return current;
            }
            const credential = validateChatGptOAuthCredential(next);
            await lease.finalize({ type: "replace", serialized: serializeCredential(credential) });
            return credential;
          },
          signal,
        );
      });
    },
    async replace(providerId, next, signal) {
      assertChatGptProvider(providerId);
      const serialized = serializeCredential(next);
      await serializeLocalCredentialOperation(database.url, async () => {
        throwIfAborted(signal);
        await runLeased(
          providerId,
          async (lease) => await lease.finalize({ type: "replace", serialized }),
          signal,
        );
      });
    },
    async delete(providerId, signal) {
      assertChatGptProvider(providerId);
      await serializeLocalCredentialOperation(database.url, async () => {
        throwIfAborted(signal);
        await runLeased(
          providerId,
          async (lease) => await lease.finalize({ type: "delete" }),
          signal,
        );
      });
    },
  };

  return store;
};
