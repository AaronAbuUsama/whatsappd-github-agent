import type { Hono } from "hono";

import {
  createGitHubControlService,
  type GitHubAppConfiguration,
  type GitHubInstallationSource,
} from "@ambient-agent/api/github-control";
import { auth } from "@ambient-agent/auth";
import {
  GitHubControlStoreError,
  type GitHubAppRole,
  type GitHubControlStore,
} from "@ambient-agent/db/github-control";
import { githubAppClient } from "@ambient-agent/installation/github-app-client.ts";

export type GitHubAppServerConfiguration = GitHubAppConfiguration & { readonly privateKey: string };

const roles = new Set<GitHubAppRole>(["coder", "reviewer", "planner"]);
const roleFrom = (value: string): GitHubAppRole | undefined =>
  roles.has(value as GitHubAppRole) ? (value as GitHubAppRole) : undefined;

export const createGitHubInstallationSource = (
  apps: Readonly<Record<GitHubAppRole, GitHubAppServerConfiguration>>,
): GitHubInstallationSource => ({
  installation: async (configuration, installationId) => {
    const serverConfiguration = apps[configuration.role];
    const client = githubAppClient({
      appId: serverConfiguration.appId,
      installationId: String(installationId),
      privateKey: serverConfiguration.privateKey,
    });
    const [installation, repositories] = await Promise.all([
      client.rest.apps.getInstallation({ installation_id: installationId }),
      client.paginate(client.rest.apps.listReposAccessibleToInstallation, { per_page: 100 }),
    ]);
    const account = installation.data.account;
    const accountLogin = account && "login" in account ? account.login : undefined;
    if (typeof accountLogin !== "string" || accountLogin.length === 0) {
      throw new Error("GitHub installation has no repository account login");
    }
    return {
      accountLogin,
      repositories: repositories.map((repository) => ({
        id: repository.id,
        owner: repository.owner.login,
        name: repository.name,
      })),
    };
  },
});

const errorStatus = (cause: unknown): 400 | 403 | 409 | 500 => {
  if (!(cause instanceof GitHubControlStoreError)) return 500;
  if (cause.code === "tenant_scope") return 403;
  if (cause.code === "delivery_collision" || cause.code === "installation_collision") return 409;
  return 400;
};

const errorMessage = (cause: unknown): string =>
  cause instanceof GitHubControlStoreError ? cause.message : "GitHub control request failed";

export const installGitHubRoutes = (
  app: Hono,
  options: {
    readonly store: GitHubControlStore;
    readonly apps: Readonly<Record<GitHubAppRole, GitHubAppServerConfiguration>>;
    readonly installations?: GitHubInstallationSource;
  },
): void => {
  const service = createGitHubControlService({
    store: options.store,
    apps: options.apps,
    installations: options.installations ?? createGitHubInstallationSource(options.apps),
  });

  app.post("/api/github/installations/:role", async (context) => {
    const role = roleFrom(context.req.param("role"));
    if (role === undefined) return context.json({ error: "unknown GitHub App role" }, 404);
    const session = await auth.api.getSession({ headers: context.req.raw.headers });
    if (!session?.user) return context.json({ error: "authentication required" }, 401);
    const body = (await context.req.json().catch(() => undefined)) as { readonly tenantId?: unknown } | undefined;
    if (typeof body?.tenantId !== "string" || body.tenantId.length === 0) {
      return context.json({ error: "tenantId is required" }, 400);
    }
    try {
      return context.json(
        await service.beginInstallation({ tenantId: body.tenantId, userId: session.user.id, role }),
        201,
      );
    } catch (cause) {
      return context.json({ error: errorMessage(cause) }, errorStatus(cause));
    }
  });

  app.get("/api/github/installations/:role/callback", async (context) => {
    const role = roleFrom(context.req.param("role"));
    if (role === undefined) return context.json({ error: "unknown GitHub App role" }, 404);
    const state = context.req.query("state");
    const installationId = Number(context.req.query("installation_id"));
    if (!state || !Number.isSafeInteger(installationId) || installationId <= 0) {
      return context.json({ error: "GitHub callback state or installation is missing" }, 400);
    }
    try {
      return context.json(await service.completeInstallation({ role, state, installationId }));
    } catch (cause) {
      return context.json({ error: errorMessage(cause) }, errorStatus(cause));
    }
  });

  app.get("/api/github/repositories/:role", async (context) => {
    const role = roleFrom(context.req.param("role"));
    if (role === undefined) return context.json({ error: "unknown GitHub App role" }, 404);
    const session = await auth.api.getSession({ headers: context.req.raw.headers });
    if (!session?.user) return context.json({ error: "authentication required" }, 401);
    const tenantId = context.req.query("tenantId");
    if (!tenantId) return context.json({ error: "tenantId is required" }, 400);
    return context.json(await options.store.repositories(tenantId, session.user.id, role));
  });

  app.put("/api/github/repositories/:role", async (context) => {
    const role = roleFrom(context.req.param("role"));
    if (role === undefined) return context.json({ error: "unknown GitHub App role" }, 404);
    const session = await auth.api.getSession({ headers: context.req.raw.headers });
    if (!session?.user) return context.json({ error: "authentication required" }, 401);
    const body = (await context.req.json().catch(() => undefined)) as
      | { readonly tenantId?: unknown; readonly repositoryIds?: unknown; readonly defaultRepositoryId?: unknown }
      | undefined;
    if (
      typeof body?.tenantId !== "string" ||
      !Array.isArray(body.repositoryIds) ||
      !body.repositoryIds.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
      typeof body.defaultRepositoryId !== "number" ||
      !Number.isSafeInteger(body.defaultRepositoryId) ||
      body.defaultRepositoryId <= 0
    ) {
      return context.json({ error: "repository selection is malformed" }, 400);
    }
    try {
      await options.store.replaceRepositorySelection({
        tenantId: body.tenantId,
        userId: session.user.id,
        role,
        repositoryIds: body.repositoryIds as number[],
        defaultRepositoryId: body.defaultRepositoryId,
        nowMs: Date.now(),
      });
      return context.json({ updated: true });
    } catch (cause) {
      return context.json({ error: errorMessage(cause) }, errorStatus(cause));
    }
  });

  app.post("/api/github/webhooks/:role", async (context) => {
    const role = roleFrom(context.req.param("role"));
    if (role === undefined) return context.json({ error: "unknown GitHub App role" }, 404);
    const body = await context.req.text();
    try {
      const result = await service.receiveWebhook({
        role,
        signature: context.req.header("x-hub-signature-256"),
        deliveryGuid: context.req.header("x-github-delivery"),
        eventName: context.req.header("x-github-event"),
        body,
      });
      return context.json(result.body, result.status);
    } catch (cause) {
      return context.json({ error: errorMessage(cause) }, errorStatus(cause));
    }
  });
};
