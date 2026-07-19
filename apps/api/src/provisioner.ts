import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

import type { Client } from "@libsql/client";

import {
  acknowledgeRemoteQuiescence,
  beginRemoteConfig,
  bindDokployApplication,
  blockRemoteConfig,
  confirmRemoteConfig,
  listProvisioningTenantIds,
  readProvisioningTarget,
  writeAgentObservation,
  writeTenantDatabaseCredentials,
  type ProvisioningTarget,
} from "@ambient-agent/db/provisioner-control";
import { acquireLease, releaseLease, renewLease, type ProvisionerLease } from "@ambient-agent/db/control-db";

export interface TenantDatabaseProvider {
  ensureDatabase(
    name: string,
    beforeMutation: () => Promise<void>,
  ): Promise<{ readonly url: string }>;
  mintToken(name: string, beforeMutation: () => Promise<void>): Promise<string>;
}

export interface DokployApplication {
  readonly applicationId: string;
  readonly appName: string;
  readonly name: string;
  readonly description: string | null;
}

export interface DokployManifest {
  readonly applicationId: string;
  readonly dockerImage: string;
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly configJson: string;
  readonly dataVolumeName: string;
  readonly dataMountPath: string;
  readonly configFileName: string;
  readonly configMountPath: string;
  readonly replicas: 1;
  readonly autoDeploy: false;
  readonly placementSwarm: { readonly Constraints: readonly [string] };
  readonly networkSwarm: readonly [{ readonly Target: string }];
  readonly updateConfigSwarm: { readonly Parallelism: 1; readonly Order: "stop-first" };
  readonly rollbackConfigSwarm: { readonly Parallelism: 1; readonly Order: "stop-first" };
  readonly healthCheckSwarm: {
    readonly Test: readonly string[];
    readonly Interval: number;
    readonly Timeout: number;
    readonly StartPeriod: number;
    readonly Retries: number;
  };
}

export interface DokployProvider {
  listApplications(): Promise<readonly DokployApplication[]>;
  inspectApplication(applicationId: string): Promise<DokployApplication | null>;
  createApplication(
    input: {
      readonly name: string;
      readonly appName: string;
      readonly description: string;
    },
    beforeMutation: () => Promise<void>,
  ): Promise<DokployApplication>;
  deleteApplication(applicationId: string, beforeMutation: () => Promise<void>): Promise<void>;
  prepareApplication(manifest: DokployManifest, beforeMutation: () => Promise<void>): Promise<void>;
  manifestMatches(manifest: DokployManifest): Promise<boolean>;
  deployApplication(applicationId: string, beforeMutation: () => Promise<void>): Promise<void>;
  startApplication(applicationId: string, beforeMutation: () => Promise<void>): Promise<void>;
  stopApplication(applicationId: string, beforeMutation: () => Promise<void>): Promise<void>;
  waitForTaskCount(appName: string, expected: 0 | 1): Promise<number>;
  health(baseUrl: string, runtimeId: string): Promise<boolean>;
}

export interface TenantSecretCodec {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  bridgeSecret(tenantId: string): string;
  runtimeId(tenantId: string): string;
}

export interface TenantProvisionerConfiguration {
  readonly runtimeImage: string;
  readonly workerHostname: string;
  readonly networkName: string;
  readonly dataDirectory: string;
  readonly port: number;
}

export interface TenantProvisionerOptions {
  readonly client: Client;
  readonly turso: TenantDatabaseProvider;
  readonly dokploy: DokployProvider;
  readonly secrets: TenantSecretCodec;
  readonly configuration: TenantProvisionerConfiguration;
  readonly createId?: () => string;
}

export type ReconcileResult = {
  readonly tenantId: string;
  readonly status: "not_found" | "lease_busy" | "lease_lost" | "stopped" | "running" | "blocked" | "retryable_error";
  readonly applicationId?: string;
  readonly taskCount?: number;
  readonly errorCode?: string;
};

class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
}

class ProvisioningInvariantError extends Error {
  override readonly name = "ProvisioningInvariantError";

  constructor(readonly code: string) {
    super(code);
  }
}

class RetryableProvisioningError extends Error {
  override readonly name = "RetryableProvisioningError";

  constructor(readonly code: string) {
    super(code);
  }
}

const entitled = (target: ProvisioningTarget): boolean =>
  target.entitlementStatus === "active" || target.entitlementStatus === "trialing";

const wantsRunning = (target: ProvisioningTarget): boolean =>
  entitled(target) &&
  target.tenantDesiredState === "running" &&
  (target.desiredMode === "setup" || target.desiredMode === "operate");

const creationMarker = (target: ProvisioningTarget): string =>
  `ambient-agent-creation:${target.dokployCreationToken}`;

const applicationMatchesTarget = (application: DokployApplication, target: ProvisioningTarget): boolean =>
  application.name === target.dokployDisplayName && application.description === creationMarker(target);

const appNameBase = (target: ProvisioningTarget): string => {
  const normalized = target.tenantDbName.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-").replaceAll(/-+/gu, "-");
  return `ambient-${normalized}`.slice(0, 48).replace(/-$/u, "");
};

const volumeNameFor = (target: ProvisioningTarget): string => {
  const identity = createHash("sha256").update(target.credsStoreKey).digest("hex").slice(0, 12);
  return `${appNameBase(target).slice(0, 40)}-${identity}-data`;
};

const runtimeBaseUrl = (appName: string, port: number): string => `http://${appName}:${port}`;

const manifestFor = (
  target: ProvisioningTarget,
  application: DokployApplication,
  token: string,
  secrets: TenantSecretCodec,
  configuration: TenantProvisionerConfiguration,
): DokployManifest => {
  const setup = target.desiredMode === "setup";
  const dataDirectory = configuration.dataDirectory.replace(/\/+$/u, "");
  return {
    applicationId: application.applicationId,
    dockerImage: configuration.runtimeImage,
    command: setup
      ? "node dist/cli/setup.js"
      : `node dist/cli/main.js --data-dir ${dataDirectory} start --log-format json`,
    environment: {
      TENANT_DB_URL: target.tenantDbUrl!,
      TENANT_DB_TOKEN: token,
      AMBIENT_AGENT_CONFIG_VERSION: String(target.configVersion),
      AMBIENT_AGENT_RUNTIME_PROFILE: setup ? "setup" : "operate",
      AMBIENT_AGENT_RUNTIME_ID: secrets.runtimeId(target.tenantId),
      AMBIENT_AGENT_RUNTIME_BRIDGE_SECRET: secrets.bridgeSecret(target.tenantId),
      HOME: posix.dirname(dataDirectory),
      PORT: String(configuration.port),
    },
    configJson: target.configJson,
    dataVolumeName: volumeNameFor(target),
    dataMountPath: dataDirectory,
    configFileName: "config.json",
    configMountPath: `${dataDirectory}/config.json`,
    replicas: 1,
    autoDeploy: false,
    placementSwarm: { Constraints: [`node.hostname==${configuration.workerHostname}`] },
    networkSwarm: [{ Target: configuration.networkName }],
    updateConfigSwarm: { Parallelism: 1, Order: "stop-first" },
    rollbackConfigSwarm: { Parallelism: 1, Order: "stop-first" },
    healthCheckSwarm: {
      Test: [
        "CMD-SHELL",
        `node -e "fetch('http://127.0.0.1:${configuration.port}/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"`,
      ],
      Interval: 30_000_000_000,
      Timeout: 5_000_000_000,
      StartPeriod: 20_000_000_000,
      Retries: 3,
    },
  };
};

const safeErrorCode = (error: unknown): string => {
  if (error instanceof RetryableProvisioningError || error instanceof ProvisioningInvariantError) return error.code;
  return "provisioner_remote_error";
};

export const createTenantProvisioner = (options: TenantProvisionerOptions) => {
  const createId = options.createId ?? randomUUID;

  const reconcileTenant = async (tenantId: string): Promise<ReconcileResult> => {
    const initial = await readProvisioningTarget(options.client, tenantId);
    if (!initial) return { tenantId, status: "not_found" };
    const ownerId = `provisioner:${createId()}`;
    let lease = await acquireLease(options.client, initial.credsStoreKey, ownerId);
    if (!lease) return { tenantId, status: "lease_busy" };
    let target = initial;

    const assertLease = async (): Promise<void> => {
      const renewed = await renewLease(options.client, target.credsStoreKey, lease!);
      if (!renewed) throw new LeaseLostError("lease_lost");
      lease = renewed;
    };

    const observe = async (
      observedState: Parameters<typeof writeAgentObservation>[3]["observedState"],
      phase: Parameters<typeof writeAgentObservation>[3]["phase"],
      errorCode: string | null,
      baseUrl: string | null = target.runtimeBaseUrl,
    ): Promise<void> => {
      if (!(await writeAgentObservation(options.client, target.credsStoreKey, lease!, {
        observedState,
        phase,
        runtimeBaseUrl: baseUrl,
        errorCode,
      }))) {
        throw new LeaseLostError("lease_lost");
      }
    };

    const stopAndObserve = async (application: DokployApplication): Promise<number> => {
      try {
        await options.dokploy.stopApplication(application.applicationId, assertLease);
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
      }
      const taskCount = await options.dokploy.waitForTaskCount(application.appName, 0);
      if (taskCount !== 0) throw new RetryableProvisioningError("dokploy_zero_tasks_not_observed");
      return taskCount;
    };

    const startAndObserve = async (application: DokployApplication): Promise<number> => {
      try {
        await options.dokploy.startApplication(application.applicationId, assertLease);
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
      }
      const taskCount = await options.dokploy.waitForTaskCount(application.appName, 1);
      if (taskCount > 1) throw new ProvisioningInvariantError("dokploy_multiple_tasks_observed");
      if (taskCount !== 1) throw new RetryableProvisioningError("dokploy_one_task_not_observed");
      return taskCount;
    };

    const cleanupLosers = async (
      applications: readonly DokployApplication[],
      winner: DokployApplication,
    ): Promise<void> => {
      for (const application of applications) {
        if (application.applicationId === winner.applicationId) continue;
        await stopAndObserve(application);
        await options.dokploy.deleteApplication(application.applicationId, assertLease);
      }
    };

    const ensureApplication = async (): Promise<DokployApplication> => {
      let marked = (await options.dokploy.listApplications())
        .filter((application) => applicationMatchesTarget(application, target))
        .sort((left, right) => left.applicationId.localeCompare(right.applicationId));

      if (target.dokployApplicationId) {
        const bound = await options.dokploy.inspectApplication(target.dokployApplicationId);
        if (
          !bound ||
          !applicationMatchesTarget(bound, target) ||
          (target.dokployAppName !== null && bound.appName !== target.dokployAppName)
        ) {
          throw new ProvisioningInvariantError("dokploy_bound_application_mismatch");
        }
        await cleanupLosers(marked, bound);
        return bound;
      }

      if (marked.length === 0) {
        try {
          const created = await options.dokploy.createApplication(
            {
              name: target.dokployDisplayName,
              appName: appNameBase(target),
              description: creationMarker(target),
            },
            assertLease,
          );
          marked = [created];
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          marked = (await options.dokploy.listApplications())
            .filter((application) => applicationMatchesTarget(application, target))
            .sort((left, right) => left.applicationId.localeCompare(right.applicationId));
          if (marked.length === 0) throw new RetryableProvisioningError("dokploy_create_outcome_unobserved");
        }
      }

      const winner = marked[0];
      if (!winner) throw new RetryableProvisioningError("dokploy_application_not_found");
      if (
        !(await bindDokployApplication(
          options.client,
          target.credsStoreKey,
          lease!,
          winner.applicationId,
          winner.appName,
        ))
      ) {
        throw new LeaseLostError("lease_lost");
      }
      target = (await readProvisioningTarget(options.client, tenantId)) ?? target;
      await cleanupLosers(marked, winner);
      return winner;
    };

    const recordRetryable = async (errorCode: string): Promise<ReconcileResult> => {
      await observe("failed", "retryable_error", errorCode);
      return { tenantId, status: "retryable_error", errorCode };
    };

    const recordInvariant = async (
      application: DokployApplication | null,
      errorCode: string,
    ): Promise<ReconcileResult> => {
      if (application) {
        try {
          await stopAndObserve(application);
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
        }
      }
      await observe("uncertain", "blocked_invariant", errorCode);
      return { tenantId, status: "blocked", applicationId: application?.applicationId, errorCode };
    };

    let application: DokployApplication | null = null;
    try {
      target = (await readProvisioningTarget(options.client, tenantId)) ?? initial;

      if (target.remoteConfigState === "pending" && target.remoteConfigOperationId) {
        if (target.dokployApplicationId) {
          application = await options.dokploy.inspectApplication(target.dokployApplicationId);
          if (application) {
            try {
              await stopAndObserve(application);
            } catch (error) {
              if (error instanceof LeaseLostError) throw error;
            }
          }
        }
        if (
          !(await blockRemoteConfig(
            options.client,
            target.credsStoreKey,
            lease,
            target.remoteConfigOperationId,
          ))
        ) {
          throw new LeaseLostError("lease_lost");
        }
        return {
          tenantId,
          status: "blocked",
          applicationId: application?.applicationId,
          errorCode: "dokploy_config_outcome_unknown",
        };
      }

      if (target.remoteConfigState === "blocked_unknown") {
        return {
          tenantId,
          status: "blocked",
          applicationId: target.dokployApplicationId ?? undefined,
          errorCode: "dokploy_config_outcome_unknown",
        };
      }

      if (!wantsRunning(target)) {
        let taskCount = 0;
        if (target.dokployApplicationId) {
          application = await options.dokploy.inspectApplication(target.dokployApplicationId);
          if (!application) return await recordInvariant(null, "dokploy_bound_application_missing");
          taskCount = await stopAndObserve(application);
        }
        await observe("stopped", "stopped", null, application ? runtimeBaseUrl(application.appName, options.configuration.port) : null);
        return {
          tenantId,
          status: "stopped",
          taskCount,
          applicationId: application?.applicationId,
        };
      }

      await observe("provisioning", "provisioning", null);

      let token: string;
      if (target.tenantDbUrl === null && target.tenantDbTokenCiphertext === null) {
        if (target.appliedConfigVersion > 0) {
          return await recordInvariant(null, "tenant_credentials_missing_for_applied_config");
        }
        const database = await options.turso.ensureDatabase(target.tenantDbName, assertLease);
        const mintedToken = await options.turso.mintToken(target.tenantDbName, assertLease);
        const ciphertext = options.secrets.encrypt(mintedToken);
        if (
          !(await writeTenantDatabaseCredentials(
            options.client,
            target.credsStoreKey,
            lease,
            database.url,
            ciphertext,
          ))
        ) {
          throw new LeaseLostError("lease_lost");
        }
        target = (await readProvisioningTarget(options.client, tenantId)) ?? target;
        token = mintedToken;
      } else if (target.tenantDbUrl !== null && target.tenantDbTokenCiphertext !== null) {
        try {
          token = options.secrets.decrypt(target.tenantDbTokenCiphertext);
        } catch {
          return await recordInvariant(null, "tenant_token_decryption_failed");
        }
      } else {
        return await recordInvariant(null, "tenant_credentials_incomplete");
      }

      application = await ensureApplication();
      const baseUrl = runtimeBaseUrl(application.appName, options.configuration.port);
      if (target.appliedConfigVersion > target.configVersion) {
        return await recordInvariant(application, "tenant_config_version_regressed");
      }
      const manifest = manifestFor(target, application, token, options.secrets, options.configuration);

      if (target.appliedConfigVersion !== target.configVersion) {
        const currentTasks = await options.dokploy.waitForTaskCount(application.appName, 0);
        if (currentTasks > 1) return await recordInvariant(application, "dokploy_multiple_tasks_observed");
        if (currentTasks !== 0) await stopAndObserve(application);
        const operationId = `remote-config:${createId()}`;
        if (
          !(await beginRemoteConfig(
            options.client,
            target.credsStoreKey,
            lease,
            operationId,
            target.configVersion,
          ))
        ) {
          throw new LeaseLostError("lease_lost");
        }
        try {
          await options.dokploy.prepareApplication(manifest, assertLease);
          if (!(await options.dokploy.manifestMatches(manifest))) {
            throw new Error("manifest read-back mismatch");
          }
          await options.dokploy.deployApplication(application.applicationId, assertLease);
          await options.dokploy.startApplication(application.applicationId, assertLease);
          const startedTasks = await options.dokploy.waitForTaskCount(application.appName, 1);
          if (startedTasks > 1) throw new Error("multiple tasks after pending start");
          if (startedTasks !== 1) throw new Error("one task not observed after pending start");
          if (!(await options.dokploy.health(baseUrl, options.secrets.runtimeId(tenantId)))) {
            throw new Error("runtime health mismatch");
          }
          if (!(await options.dokploy.manifestMatches(manifest))) {
            throw new Error("final manifest read-back mismatch");
          }
          if (
            !(await confirmRemoteConfig(
              options.client,
              target.credsStoreKey,
              lease,
              operationId,
            ))
          ) {
            throw new LeaseLostError("lease_lost");
          }
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          try {
            await stopAndObserve(application);
          } catch (stopError) {
            if (stopError instanceof LeaseLostError) throw stopError;
          }
          if (!(await blockRemoteConfig(options.client, target.credsStoreKey, lease, operationId))) {
            throw new LeaseLostError("lease_lost");
          }
          return {
            tenantId,
            status: "blocked",
            applicationId: application.applicationId,
            errorCode: "dokploy_config_outcome_unknown",
          };
        }
      } else {
        if (!(await options.dokploy.manifestMatches(manifest))) {
          return await recordInvariant(application, "dokploy_manifest_drift");
        }
        await startAndObserve(application);
        if (!(await options.dokploy.health(baseUrl, options.secrets.runtimeId(tenantId)))) {
          return await recordRetryable("tenant_runtime_unhealthy");
        }
      }

      await observe("healthy", "running", null, baseUrl);
      return { tenantId, status: "running", applicationId: application.applicationId, taskCount: 1 };
    } catch (error) {
      if (error instanceof LeaseLostError) return { tenantId, status: "lease_lost" };
      if (error instanceof ProvisioningInvariantError) {
        try {
          return await recordInvariant(application, error.code);
        } catch (writeError) {
          if (writeError instanceof LeaseLostError) return { tenantId, status: "lease_lost" };
          throw writeError;
        }
      }
      try {
        return await recordRetryable(safeErrorCode(error));
      } catch (writeError) {
        if (writeError instanceof LeaseLostError) return { tenantId, status: "lease_lost" };
        throw writeError;
      }
    } finally {
      await releaseLease(options.client, target.credsStoreKey, lease);
    }
  };

  const reconcilePendingTenants = async (): Promise<readonly ReconcileResult[]> => {
    const tenantIds = await listProvisioningTenantIds(options.client);
    return await Promise.all(tenantIds.map(reconcileTenant));
  };

  const acknowledgeQuiescence = async (input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly actorId: string;
    readonly evidenceNote: string;
  }): Promise<boolean> => {
    const target = await readProvisioningTarget(options.client, input.tenantId);
    if (!target) return false;
    let lease: ProvisionerLease | null = await acquireLease(
      options.client,
      target.credsStoreKey,
      `operator:${createId()}`,
    );
    if (!lease) return false;
    const renew = async (): Promise<void> => {
      const renewed = await renewLease(options.client, target.credsStoreKey, lease!);
      if (!renewed) throw new LeaseLostError("lease_lost");
      lease = renewed;
    };
    try {
      const marked = (await options.dokploy.listApplications()).filter((application) =>
        applicationMatchesTarget(application, target),
      );
      if (target.dokployApplicationId) {
        const bound = await options.dokploy.inspectApplication(target.dokployApplicationId);
        if (
          bound &&
          (!applicationMatchesTarget(bound, target) ||
            (target.dokployAppName !== null && bound.appName !== target.dokployAppName))
        ) {
          return false;
        }
        if (bound && !marked.some((application) => application.applicationId === bound.applicationId)) {
          marked.push(bound);
        }
      }
      for (const application of marked) {
        try {
          await options.dokploy.stopApplication(application.applicationId, renew);
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
        }
        if ((await options.dokploy.waitForTaskCount(application.appName, 0)) !== 0) return false;
      }
      return await acknowledgeRemoteQuiescence(options.client, target.credsStoreKey, lease, {
        operationId: input.operationId,
        actorId: input.actorId,
        evidenceNote: input.evidenceNote,
        auditId: `operator-audit:${createId()}`,
      });
    } finally {
      await releaseLease(options.client, target.credsStoreKey, lease);
    }
  };

  return { reconcileTenant, reconcilePendingTenants, acknowledgeQuiescence };
};
