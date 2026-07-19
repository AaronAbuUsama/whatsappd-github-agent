import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { runtimeInstallationId } from "@ambient-agent/installation/runtime-health.ts";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

import type {
  DokployApplication,
  DokployProvider,
  TenantDatabaseProvider,
  TenantSecretCodec,
} from "./provisioner";

export class ProvisionerProviderError extends Error {
  override readonly name = "ProvisionerProviderError";

  constructor(
    readonly provider: "turso" | "dokploy" | "runtime",
    readonly status: number,
  ) {
    super(`${provider}_http_${status}`);
  }
}

const parseEncryptionKey = (base64Key: string): Buffer => {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("TENANT_SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
};

export const createTenantSecretCodec = (base64Key: string): TenantSecretCodec => {
  const key = parseEncryptionKey(base64Key);
  const bridgeSecret = (tenantId: string): string =>
    createHmac("sha256", key).update(`ambient-agent-runtime-bridge\0${tenantId}`).digest("base64url");
  return {
    encrypt: (plaintext) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from("ambient-agent-tenant-token\0v1"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${nonce.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
    },
    decrypt: (encoded) => {
      const [version, nonceValue, tagValue, ciphertextValue, ...extra] = encoded.split(".");
      if (
        version !== "v1" ||
        !nonceValue ||
        !tagValue ||
        !ciphertextValue ||
        extra.length !== 0
      ) {
        throw new Error("tenant_token_ciphertext_invalid");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceValue, "base64url"));
        decipher.setAAD(Buffer.from("ambient-agent-tenant-token\0v1"));
        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertextValue, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("tenant_token_ciphertext_invalid");
      }
    },
    bridgeSecret,
    runtimeId: (tenantId) => runtimeInstallationId(bridgeSecret(tenantId)),
  };
};

const responseJson = async (response: Response, provider: "turso" | "dokploy" | "runtime"): Promise<unknown> => {
  if (!response.ok) throw new ProvisionerProviderError(provider, response.status);
  return await response.json().catch(() => undefined);
};

const databaseSchema = z
  .object({
    Hostname: z.string().min(1).optional(),
    hostname: z.string().min(1).optional(),
  })
  .passthrough();
const databaseUrlFrom = (value: unknown): string => {
  const envelope = z.object({ database: databaseSchema }).safeParse(value);
  const database = envelope.success ? envelope.data.database : databaseSchema.parse(value);
  const hostname = database.Hostname ?? database.hostname;
  if (!hostname) throw new ProvisionerProviderError("turso", 502);
  return `libsql://${hostname}`;
};

export const createTursoPlatformClient = (options: {
  readonly organization: string;
  readonly group: string;
  readonly platformToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}): TenantDatabaseProvider => {
  const fetch = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "https://api.turso.tech/v1").replace(/\/+$/u, "");
  const organization = encodeURIComponent(options.organization);
  const request = async (path: string, init: RequestInit = {}): Promise<Response> =>
    await fetch(`${baseUrl}/organizations/${organization}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.platformToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });

  return {
    ensureDatabase: async (name, beforeMutation) => {
      const databasePath = `/databases/${encodeURIComponent(name)}`;
      const existing = await request(databasePath);
      if (existing.ok) return { url: databaseUrlFrom(await existing.json()) };
      if (existing.status !== 404) throw new ProvisionerProviderError("turso", existing.status);

      await beforeMutation();
      const created = await request("/databases", {
        method: "POST",
        body: JSON.stringify({ name, group: options.group }),
      });
      if (created.status === 409) {
        return { url: databaseUrlFrom(await responseJson(await request(databasePath), "turso")) };
      }
      return { url: databaseUrlFrom(await responseJson(created, "turso")) };
    },
    mintToken: async (name, beforeMutation) => {
      await beforeMutation();
      const response = await request(
        `/databases/${encodeURIComponent(name)}/auth/tokens?authorization=full-access`,
        { method: "POST", body: "{}" },
      );
      const parsed = z.object({ jwt: z.string().min(1) }).parse(await responseJson(response, "turso"));
      return parsed.jwt;
    },
  };
};

const applicationSchema = z
  .object({
    applicationId: z.string().min(1),
    appName: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
  })
  .passthrough();

const applicationFrom = (value: unknown): DokployApplication => {
  const parsed = applicationSchema.parse(value);
  return {
    applicationId: parsed.applicationId,
    appName: parsed.appName,
    name: parsed.name,
    description: parsed.description ?? null,
  };
};

const mountSchema = z
  .object({
    mountId: z.string().min(1),
    type: z.enum(["bind", "volume", "file"]),
    mountPath: z.string(),
    volumeName: z.string().nullable().optional(),
    filePath: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
  })
  .passthrough();

type DokployMount = z.infer<typeof mountSchema>;

const sameJson = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);

const sameEnvironment = (encoded: unknown, expected: Readonly<Record<string, string>>): boolean => {
  if (typeof encoded !== "string") return false;
  const parsed = parseDotenv(encoded);
  const keys = Object.keys(parsed).sort();
  const expectedKeys = Object.keys(expected).sort();
  return sameJson(keys, expectedKeys) && expectedKeys.every((key) => parsed[key] === expected[key]);
};

const encodeEnvironment = (environment: Readonly<Record<string, string>>): string =>
  Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");

export const createDokployProvider = (options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly environmentId: string;
  readonly serverId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly observationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}): DokployProvider => {
  const fetch = options.fetch ?? globalThis.fetch;
  const root = options.baseUrl.replace(/\/+$/u, "");
  const baseUrl = root.endsWith("/api") ? root : `${root}/api`;
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> =>
    await responseJson(
      await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          "x-api-key": options.apiKey,
          "content-type": "application/json",
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 8_000),
      }),
      "dokploy",
    );
  const get = async (path: string): Promise<unknown> => await request(path);
  const post = async (path: string, body: unknown): Promise<unknown> =>
    await request(path, { method: "POST", body: JSON.stringify(body) });
  const mountsFor = async (applicationId: string): Promise<DokployMount[]> =>
    z.array(mountSchema).parse(
      await get(
        `/mounts.listByServiceId?serviceId=${encodeURIComponent(applicationId)}&serviceType=application`,
      ),
    );
  const upsertMount = async (
    applicationId: string,
    mounts: DokployMount[],
    desired: {
      readonly type: "volume" | "file";
      readonly mountPath: string;
      readonly volumeName?: string;
      readonly filePath?: string;
      readonly content?: string;
    },
    beforeMutation: () => Promise<void>,
  ): Promise<void> => {
    const existing = mounts.find((mount) => mount.mountPath === desired.mountPath);
    if (existing) {
      const matches =
        existing.type === desired.type &&
        (existing.volumeName ?? null) === (desired.volumeName ?? null) &&
        (existing.filePath ?? null) === (desired.filePath ?? null) &&
        (existing.content ?? null) === (desired.content ?? null);
      if (matches) return;
      await beforeMutation();
      await post("/mounts.update", { mountId: existing.mountId, ...desired });
      Object.assign(existing, desired);
      return;
    }
    await beforeMutation();
    const created = mountSchema.parse(
      await post("/mounts.create", {
        ...desired,
        serviceType: "application",
        serviceId: applicationId,
      }),
    );
    mounts.push(created);
  };

  return {
    listApplications: async () => {
      const value = z
        .object({ applications: z.array(applicationSchema) })
        .passthrough()
        .parse(await get(`/environment.one?environmentId=${encodeURIComponent(options.environmentId)}`));
      return value.applications.map(applicationFrom);
    },
    inspectApplication: async (applicationId) => {
      try {
        return applicationFrom(await get(`/application.one?applicationId=${encodeURIComponent(applicationId)}`));
      } catch (error) {
        if (error instanceof ProvisionerProviderError && error.status === 404) return null;
        throw error;
      }
    },
    createApplication: async (input, beforeMutation) => {
      await beforeMutation();
      return applicationFrom(
        await post("/application.create", {
          ...input,
          environmentId: options.environmentId,
          serverId: options.serverId,
        }),
      );
    },
    deleteApplication: async (applicationId, beforeMutation) => {
      await beforeMutation();
      await post("/application.delete", { applicationId });
    },
    prepareApplication: async (manifest, beforeMutation) => {
      await beforeMutation();
      await post("/application.saveDockerProvider", {
        applicationId: manifest.applicationId,
        dockerImage: manifest.dockerImage,
        username: null,
        password: null,
        registryUrl: null,
      });
      await beforeMutation();
      await post("/application.saveEnvironment", {
        applicationId: manifest.applicationId,
        env: encodeEnvironment(manifest.environment),
        buildArgs: null,
        buildSecrets: null,
        createEnvFile: false,
      });
      await beforeMutation();
      await post("/application.update", {
        applicationId: manifest.applicationId,
        sourceType: "docker",
        dockerImage: manifest.dockerImage,
        command: manifest.command,
        replicas: manifest.replicas,
        autoDeploy: manifest.autoDeploy,
        placementSwarm: manifest.placementSwarm,
        networkSwarm: manifest.networkSwarm,
        updateConfigSwarm: manifest.updateConfigSwarm,
        rollbackConfigSwarm: manifest.rollbackConfigSwarm,
        healthCheckSwarm: manifest.healthCheckSwarm,
      });
      const mounts = await mountsFor(manifest.applicationId);
      await upsertMount(
        manifest.applicationId,
        mounts,
        {
          type: "volume",
          mountPath: manifest.dataMountPath,
          volumeName: manifest.dataVolumeName,
        },
        beforeMutation,
      );
      await upsertMount(
        manifest.applicationId,
        mounts,
        {
          type: "file",
          mountPath: manifest.configMountPath,
          filePath: manifest.configFileName,
          content: manifest.configJson,
        },
        beforeMutation,
      );
    },
    manifestMatches: async (manifest) => {
      const [applicationValue, mounts] = await Promise.all([
        get(`/application.one?applicationId=${encodeURIComponent(manifest.applicationId)}`),
        mountsFor(manifest.applicationId),
      ]);
      const application = applicationSchema.parse(applicationValue);
      const volume = mounts.find((mount) => mount.mountPath === manifest.dataMountPath);
      const config = mounts.find((mount) => mount.mountPath === manifest.configMountPath);
      return (
        application.dockerImage === manifest.dockerImage &&
        application.sourceType === "docker" &&
        application.command === manifest.command &&
        application.replicas === manifest.replicas &&
        application.autoDeploy === manifest.autoDeploy &&
        sameJson(application.placementSwarm, manifest.placementSwarm) &&
        sameJson(application.networkSwarm, manifest.networkSwarm) &&
        sameJson(application.updateConfigSwarm, manifest.updateConfigSwarm) &&
        sameJson(application.rollbackConfigSwarm, manifest.rollbackConfigSwarm) &&
        sameJson(application.healthCheckSwarm, manifest.healthCheckSwarm) &&
        sameEnvironment(application.env, manifest.environment) &&
        volume?.type === "volume" &&
        volume.volumeName === manifest.dataVolumeName &&
        config?.type === "file" &&
        config.filePath === manifest.configFileName &&
        config.content === manifest.configJson
      );
    },
    deployApplication: async (applicationId, beforeMutation) => {
      await beforeMutation();
      await post("/application.deploy", { applicationId });
    },
    startApplication: async (applicationId, beforeMutation) => {
      await beforeMutation();
      await post("/application.start", { applicationId });
    },
    stopApplication: async (applicationId, beforeMutation) => {
      await beforeMutation();
      await post("/application.stop", { applicationId });
    },
    waitForTaskCount: async (appName, expected) => {
      const deadline = Date.now() + (options.observationTimeoutMs ?? 8_000);
      let count = -1;
      do {
        const services = z
          .array(z.object({ Name: z.string(), Replicas: z.string() }).passthrough())
          .parse(await get(`/swarm.getNodeApps?serverId=${encodeURIComponent(options.serverId)}`));
        const service = services.find((candidate) => candidate.Name === appName);
        count = service ? Number.parseInt(service.Replicas.split("/")[0] ?? "", 10) : 0;
        if (count === expected) return count;
        await new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 250));
      } while (Date.now() < deadline);
      return count;
    },
    health: async (runtimeUrl, runtimeId) => {
      try {
        const response = await fetch(`${runtimeUrl.replace(/\/+$/u, "")}/health`, {
          signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
        });
        const value = z.object({ ok: z.literal(true), runtimeId: z.string() }).parse(
          await responseJson(response, "runtime"),
        );
        return value.runtimeId === runtimeId;
      } catch {
        return false;
      }
    },
  };
};
