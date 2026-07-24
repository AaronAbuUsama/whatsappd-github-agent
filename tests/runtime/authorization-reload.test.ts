import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { applyManagedAuthorization } from "../../apps/runtime/src/host/authorization-reload.ts";
import { createManagedConfig } from "../../packages/installation/src/schema.ts";
import {
  atomicWriteManagedConfig,
  readManagedConfig,
  writeManagedConfiguration,
} from "../../packages/installation/src/configuration.ts";
import { createManagedConfigStore } from "../../packages/installation/src/managed-config-store.ts";
import { makeManagedChatGate } from "../../packages/engine/src/coalescer/chat-gate.ts";
import { createIssueManagementPolicy } from "../../packages/agents/src/capabilities/issue-management/runtime.ts";
import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { seedRepositoryFacts } from "../../packages/agents/src/capabilities/graph/seed-repositories.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporaryDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "authorization-reload-"));
  dirs.push(directory);
  return directory;
};

const config = (overrides: {
  managedChats?: string[];
  allowedRepositories?: string[];
  reviewRepositories?: string[];
  port?: number;
}) => {
  const base = createManagedConfig(overrides.managedChats ?? ["team@g.us"], "acme/widgets");
  return {
    ...base,
    runtime: { ...base.runtime, ...(overrides.port === undefined ? {} : { port: overrides.port }) },
    github: {
      ...base.github,
      allowedRepositories: overrides.allowedRepositories ?? base.github.allowedRepositories,
      reviewRepositories: overrides.reviewRepositories ?? base.github.reviewRepositories,
    },
  };
};

const githubCredential = {
  schemaVersion: 1,
  kind: "github-app",
  appId: "1",
  installationId: "2",
  privateKey: "PRIVATE-KEY",
  webhookSecret: "secret",
} as const;

describe("applyManagedAuthorization (#179)", () => {
  it("applies exactly the authorization knobs, in place", () => {
    const reloadedChats: string[][] = [];
    const reloadedRepos: string[][] = [];
    const reseeded: string[][] = [];
    const reviewRepositories: string[] = ["acme/widgets"];
    const reviewIdentity = reviewRepositories;

    applyManagedAuthorization(
      config({
        managedChats: ["team@g.us", "second@g.us"],
        allowedRepositories: ["acme/widgets", "acme/gadgets"],
        reviewRepositories: ["acme/widgets"],
      }),
      {
        reloadManagedChats: (chats) => reloadedChats.push([...chats]),
        policy: { reload: (repos) => reloadedRepos.push([...repos]) },
        reviewRepositories,
        reseedRepositoryGraph: (cfg) => reseeded.push([...cfg.github.allowedRepositories]),
      },
    );

    expect(reloadedChats).toEqual([["team@g.us", "second@g.us"]]);
    expect(reloadedRepos).toEqual([["acme/widgets", "acme/gadgets"]]);
    expect(reseeded).toEqual([["acme/widgets", "acme/gadgets"]]);
    // Spliced in place — the ingress keeps reading the same array reference.
    expect(reviewRepositories).toBe(reviewIdentity);
    expect(reviewRepositories).toEqual(["acme/widgets"]);
  });

  it("never reaches a restart-only knob: a changed port/model in the same config is not applied", () => {
    // The targets object structurally exposes only the authorization surfaces. A port change riding
    // along in the configuration has nowhere to go — this is the negative guarantee in code.
    const reloadedChats: string[][] = [];
    applyManagedAuthorization(config({ port: 9999, managedChats: ["team@g.us"] }), {
      reloadManagedChats: (chats) => reloadedChats.push([...chats]),
      policy: { reload: () => undefined },
      reviewRepositories: [],
      reseedRepositoryGraph: () => undefined,
    });
    expect(reloadedChats).toEqual([["team@g.us"]]);
  });

  it("reload after the REAL CLI config-write path (writeManagedConfiguration) engages the gate (#179 fix 1)", async () => {
    const directory = temporaryDir();
    const configPath = join(directory, "config.json");
    const credentialPath = join(directory, "github-planner.json");
    await atomicWriteManagedConfig(configPath, config({ managedChats: ["team@g.us"] }));
    await atomicWriteManagedConfig(credentialPath, githubCredential);

    // The DB store, seeded from config.json at boot, and the live gate the runtime holds.
    const store = createManagedConfigStore(":memory:");
    store.replace(await readManagedConfig(configPath));
    const gate = makeManagedChatGate(store.current().managedChats);
    expect(gate.allowed("added@g.us", true)).toBe(false);

    // The operator runs the ACTUAL command path: `ambient-agent config` commits through
    // writeManagedConfiguration, which writes config.json — NOT the store.
    await writeManagedConfiguration(
      configPath,
      credentialPath,
      config({ managedChats: ["team@g.us", "added@g.us"] }),
      githubCredential,
    );

    // The SIGHUP reload re-reads config.json, refreshes the store, and applies it.
    store.replace(await readManagedConfig(configPath));
    applyManagedAuthorization(store.current(), {
      reloadManagedChats: (chatIds) => gate.reload(chatIds),
      policy: { reload: () => undefined },
      reviewRepositories: [],
      reseedRepositoryGraph: () => undefined,
    });

    expect(gate.allowed("added@g.us", true)).toBe(true);
    store.close();
  });

  it("seeds a newly-authorized repository into the Graph on reload, no restart (#179 fix 3)", () => {
    const graph = createGraphStore(":memory:");
    const policy = createIssueManagementPolicy("acme/widgets", ["acme/widgets"]);
    seedRepositoryFacts(graph, { allowedRepositories: ["acme/widgets"], surfaceRepositories: [] });
    expect(graph.findEntities({ type: "repository" }).map((entity) => entity.properties.repo)).toEqual([
      "acme/widgets",
    ]);

    applyManagedAuthorization(config({ allowedRepositories: ["acme/widgets", "acme/gadgets"] }), {
      reloadManagedChats: () => undefined,
      policy,
      reviewRepositories: [],
      reseedRepositoryGraph: (cfg) =>
        seedRepositoryFacts(graph, {
          allowedRepositories: cfg.github.allowedRepositories,
          surfaceRepositories: cfg.github.surfaceRepositories,
        }),
    });

    // The live-added repo is both authorized AND a Graph entity the Brain's lookup can resolve.
    expect(policy.authorize("acme/gadgets")).toEqual({ owner: "acme", repo: "gadgets" });
    expect(
      graph
        .findEntities({ type: "repository" })
        .map((entity) => entity.properties.repo)
        .sort(),
    ).toEqual(["acme/gadgets", "acme/widgets"]);
    graph.close();
  });
});
