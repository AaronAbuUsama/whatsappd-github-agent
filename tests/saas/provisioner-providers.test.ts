import { Buffer } from "node:buffer";

import { describe, expect, test } from "vitest";

import type { DokployManifest } from "../../apps/api/src/provisioner";
import {
  createDokployProvider,
  createTenantSecretCodec,
  createTursoPlatformClient,
} from "../../apps/api/src/provisioner-providers";
import { runtimeInstallationId } from "../../packages/installation/src/runtime-health";

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("tenant provisioner provider adapters", () => {
  test("envelope-encrypts tenant tokens and derives isolated bridge credentials", () => {
    const codec = createTenantSecretCodec(Buffer.alloc(32, 7).toString("base64"));
    const ciphertext = codec.encrypt("tenant-token-private");

    expect(ciphertext).toMatch(/^v1\./u);
    expect(ciphertext).not.toContain("tenant-token-private");
    expect(codec.decrypt(ciphertext)).toBe("tenant-token-private");
    expect(codec.bridgeSecret("tenant-one")).not.toBe(codec.bridgeSecret("tenant-two"));
    expect(codec.runtimeId("tenant-one")).toBe(runtimeInstallationId(codec.bridgeSecret("tenant-one")));
  });

  test("creates one deterministic Turso database and mints only database-scoped tokens", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    let exists = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/databases/tenant-db-one") && init?.method !== "POST") {
        return exists
          ? json({ database: { Name: "tenant-db-one", Hostname: "tenant-db-one.turso.io" } })
          : json({ error: "not found" }, 404);
      }
      if (url.endsWith("/databases") && init?.method === "POST") {
        exists = true;
        return json({ database: { Name: "tenant-db-one", Hostname: "tenant-db-one.turso.io" } });
      }
      if (url.includes("/databases/tenant-db-one/auth/tokens")) return json({ jwt: "scoped-jwt-one" });
      return json({ error: "unexpected request" }, 500);
    };
    const turso = createTursoPlatformClient({
      organization: "ambient-org",
      group: "default",
      platformToken: "platform-secret",
      fetch,
    });
    let mutations = 0;
    const beforeMutation = async () => {
      mutations += 1;
    };

    expect(await turso.ensureDatabase("tenant-db-one", beforeMutation)).toEqual({
      url: "libsql://tenant-db-one.turso.io",
    });
    expect(await turso.ensureDatabase("tenant-db-one", beforeMutation)).toEqual({
      url: "libsql://tenant-db-one.turso.io",
    });
    expect(await turso.mintToken("tenant-db-one", beforeMutation)).toBe("scoped-jwt-one");
    expect(mutations).toBe(2);
    expect(requests.find((request) => request.init?.method === "POST")?.init?.body).toBe(
      JSON.stringify({ name: "tenant-db-one", group: "default" }),
    );
    const tokenRequest = requests.find((request) => request.url.includes("/auth/tokens"));
    expect(tokenRequest?.url).toContain("authorization=full-access");
    expect(tokenRequest?.init?.headers).toMatchObject({ Authorization: "Bearer platform-secret" });
  });

  test("writes and reads back the complete safe Dokploy manifest and repeats lifecycle calls", async () => {
    const calls: Array<{ readonly path: string; readonly method: string; readonly body?: unknown }> = [];
    const mounts: Record<string, unknown>[] = [];
    const application: Record<string, unknown> = {
      applicationId: "app-1",
      appName: "ambient-one-random",
      name: "Ambient One",
      description: "ambient-agent-creation:creation-one",
      env: "",
    };
    let replicas = "0/0";
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ path: `${url.pathname}${url.search}`, method, ...(body === undefined ? {} : { body }) });
      if (url.hostname === "dokploy.example") {
        expect(init?.headers).toMatchObject({ "x-api-key": "dokploy-secret" });
      } else {
        expect(init?.headers).not.toMatchObject({ "x-api-key": expect.any(String) });
      }

      if (url.pathname.endsWith("/environment.one")) return json({ applications: [application] });
      if (url.pathname.endsWith("/application.one")) return json(application);
      if (url.pathname.endsWith("/application.create")) return json(application);
      if (url.pathname.endsWith("/application.saveDockerProvider")) {
        Object.assign(application, { dockerImage: body?.dockerImage, sourceType: "docker" });
        return json(true);
      }
      if (url.pathname.endsWith("/application.saveEnvironment")) {
        application.env = body?.env;
        return json(true);
      }
      if (url.pathname.endsWith("/application.update")) {
        Object.assign(application, body);
        return json(application);
      }
      if (url.pathname.endsWith("/mounts.listByServiceId")) return json(mounts);
      if (url.pathname.endsWith("/mounts.create")) {
        const mount = { mountId: `mount-${mounts.length + 1}`, ...body };
        mounts.push(mount);
        return json(mount);
      }
      if (url.pathname.endsWith("/mounts.update")) {
        const mount = mounts.find((candidate) => candidate.mountId === body?.mountId);
        if (mount) Object.assign(mount, body);
        return json(mount);
      }
      if (url.pathname.endsWith("/application.start")) {
        replicas = "1/1";
        return json(true);
      }
      if (url.pathname.endsWith("/application.stop")) {
        replicas = "0/0";
        return json(true);
      }
      if (url.pathname.endsWith("/application.deploy") || url.pathname.endsWith("/application.delete")) {
        return json(true);
      }
      if (url.pathname.endsWith("/swarm.getNodeApps")) {
        return json([{ Name: "ambient-one-random", Replicas: replicas }]);
      }
      if (url.hostname === "ambient-one-random" && url.pathname === "/health") {
        return json({ ok: true, runtimeId: "runtime-one" });
      }
      return json({ error: "unexpected request" }, 500);
    };
    const dokploy = createDokployProvider({
      baseUrl: "https://dokploy.example",
      apiKey: "dokploy-secret",
      environmentId: "environment-one",
      serverId: "server-one",
      fetch,
      pollIntervalMs: 1,
      observationTimeoutMs: 20,
    });
    let mutations = 0;
    const beforeMutation = async () => {
      mutations += 1;
    };
    const manifest: DokployManifest = {
      applicationId: "app-1",
      dockerImage: "ghcr.io/ambient/runtime:sha-one",
      command: "node dist/cli/setup.js",
      environment: {
        TENANT_DB_URL: "libsql://tenant-db-one.turso.io",
        TENANT_DB_TOKEN: "tenant-token-one",
        AMBIENT_AGENT_CONFIG_VERSION: "1",
        AMBIENT_AGENT_RUNTIME_PROFILE: "setup",
        AMBIENT_AGENT_RUNTIME_ID: "runtime-one",
        AMBIENT_AGENT_RUNTIME_BRIDGE_SECRET: "bridge-one",
        PORT: "3000",
      },
      configJson: "{}",
      dataVolumeName: "ambient-one-data",
      dataMountPath: "/root/.ambient-agent",
      configFileName: "config.json",
      configMountPath: "/root/.ambient-agent/config.json",
      replicas: 1,
      autoDeploy: false,
      placementSwarm: { Constraints: ["node.hostname==worker-one"] },
      networkSwarm: [{ Target: "dokploy-network" }],
      updateConfigSwarm: { Parallelism: 1, Order: "stop-first" },
      rollbackConfigSwarm: { Parallelism: 1, Order: "stop-first" },
      healthCheckSwarm: {
        Test: ["CMD-SHELL", "node health.js"],
        Interval: 30,
        Timeout: 5,
        StartPeriod: 20,
        Retries: 3,
      },
    };

    expect(await dokploy.listApplications()).toHaveLength(1);
    expect(await dokploy.inspectApplication("app-1")).toMatchObject({ applicationId: "app-1" });
    await dokploy.prepareApplication(manifest, beforeMutation);
    expect(await dokploy.manifestMatches(manifest)).toBe(true);
    await dokploy.startApplication("app-1", beforeMutation);
    await dokploy.startApplication("app-1", beforeMutation);
    expect(await dokploy.waitForTaskCount("ambient-one-random", 1)).toBe(1);
    expect(await dokploy.health("http://ambient-one-random:3000", "runtime-one")).toBe(true);
    await dokploy.stopApplication("app-1", beforeMutation);
    await dokploy.stopApplication("app-1", beforeMutation);
    expect(await dokploy.waitForTaskCount("ambient-one-random", 0)).toBe(0);

    expect(mutations).toBe(9);
    const update = calls.find((call) => call.path.endsWith("/application.update"));
    expect(update?.body).toMatchObject({
      replicas: 1,
      autoDeploy: false,
      placementSwarm: { Constraints: ["node.hostname==worker-one"] },
      updateConfigSwarm: { Parallelism: 1, Order: "stop-first" },
      rollbackConfigSwarm: { Parallelism: 1, Order: "stop-first" },
    });
    expect(calls.filter((call) => call.path.endsWith("/application.start"))).toHaveLength(2);
    expect(calls.filter((call) => call.path.endsWith("/application.stop"))).toHaveLength(2);
    expect(JSON.stringify(calls)).toContain("TENANT_DB_TOKEN");
    expect(JSON.stringify(calls)).not.toContain("platform-secret");
  });
});
