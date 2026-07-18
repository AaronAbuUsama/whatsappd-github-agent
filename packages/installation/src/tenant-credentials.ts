import { createClient, type Client } from "@libsql/client";
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
  createClient({ url, ...(authToken === undefined ? {} : { authToken }) });

const whatsappSchema = `
  CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )
`;

/** A whatsappd SessionStore backed by the tenant's isolated libSQL database. */
export const libsqlStore = (database: TenantCredentialDatabase): SessionStore => {
  const client = createTenantClient(database);
  let ready: Promise<void> | undefined;
  const connect = async (): Promise<Client> => {
    ready ??= client.execute(whatsappSchema).then(() => undefined);
    await ready;
    return client;
  };

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
    credential_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )
`;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_CONFLICT_RETRIES = 8;
const credentialOperations = new Map<string, Promise<void>>();

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortReason(signal);
};

const abortable = async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  if (signal === undefined) return await operation;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
};

const serializeCredentialOperation = async <T>(
  databaseUrl: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const predecessor = credentialOperations.get(databaseUrl) ?? Promise.resolve();
  const current = predecessor.then(async () => {
    throwIfAborted(signal);
    return await operation();
  });
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  credentialOperations.set(databaseUrl, tail);
  void tail.finally(() => {
    if (credentialOperations.get(databaseUrl) === tail) credentialOperations.delete(databaseUrl);
  });
  return await abortable(current, signal);
};

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

interface StoredCredential {
  readonly credential: ReturnType<typeof validateChatGptOAuthCredential> | undefined;
  readonly revision: number | undefined;
}

/** A ChatGptCredentialStore whose atomic modify seam is persisted in libSQL. */
export const createLibsqlChatGptCredentialStore = (database: TenantCredentialDatabase): ChatGptCredentialStore => {
  const client = createTenantClient(database);
  let ready: Promise<void> | undefined;
  const connect = async (): Promise<Client> => {
    ready ??= client.execute(modelSchema).then(() => undefined);
    await ready;
    return client;
  };

  const readStored = async (providerId: string): Promise<StoredCredential> => {
    const result = await (
      await connect()
    ).execute({
      sql: "SELECT credential_json, revision FROM model_credentials WHERE provider_id = ?",
      args: [providerId],
    });
    const row = result.rows[0];
    if (row === undefined) return { credential: undefined, revision: undefined };
    const serialized = row.credential_json;
    const revision = Number(row.revision);
    if (typeof serialized !== "string" || !Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("The managed ChatGPT credential row is malformed.");
    }
    return { credential: validateChatGptOAuthCredential(JSON.parse(serialized)), revision };
  };

  const store: ChatGptCredentialStore = {
    async read(providerId, signal) {
      assertChatGptProvider(providerId);
      throwIfAborted(signal);
      return (await readStored(providerId)).credential;
    },
    async modify(providerId, change, signal) {
      assertChatGptProvider(providerId);
      return await serializeCredentialOperation(
        database.url,
        async () => {
          for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
            throwIfAborted(signal);
            const current = await readStored(providerId);
            const next = await change(current.credential);
            if (next === undefined) return current.credential;
            const credential = validateChatGptOAuthCredential(next);
            const serialized = serializeCredential(credential);
            const result =
              current.revision === undefined
                ? await (
                    await connect()
                  ).execute({
                    sql: `
                      INSERT INTO model_credentials (provider_id, credential_json, revision, updated_at_ms)
                      VALUES (?, ?, 1, ?)
                      ON CONFLICT(provider_id) DO NOTHING
                    `,
                    args: [providerId, serialized, Date.now()],
                  })
                : await (
                    await connect()
                  ).execute({
                    sql: `
                      UPDATE model_credentials
                      SET credential_json = ?, revision = revision + 1, updated_at_ms = ?
                      WHERE provider_id = ? AND revision = ?
                    `,
                    args: [serialized, Date.now(), providerId, current.revision],
                  });
            if (result.rowsAffected === 1) return credential;
          }
          throw new Error("The managed ChatGPT credential changed too many times to update safely.");
        },
        signal,
      );
    },
    async replace(providerId, next, signal) {
      assertChatGptProvider(providerId);
      const serialized = serializeCredential(next);
      await serializeCredentialOperation(
        database.url,
        async () => {
          throwIfAborted(signal);
          await (
            await connect()
          ).execute({
            sql: `
              INSERT INTO model_credentials (provider_id, credential_json, revision, updated_at_ms)
              VALUES (?, ?, 1, ?)
              ON CONFLICT(provider_id) DO UPDATE SET
                credential_json = excluded.credential_json,
                revision = model_credentials.revision + 1,
                updated_at_ms = excluded.updated_at_ms
            `,
            args: [providerId, serialized, Date.now()],
          });
        },
        signal,
      );
    },
    async delete(providerId, signal) {
      assertChatGptProvider(providerId);
      await serializeCredentialOperation(
        database.url,
        async () => {
          throwIfAborted(signal);
          await (
            await connect()
          ).execute({
            sql: "DELETE FROM model_credentials WHERE provider_id = ?",
            args: [providerId],
          });
        },
        signal,
      );
    },
  };

  return store;
};
