import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { inspectManagedData } from "../../src/managed/installation.ts";
import type { ManagedPaths } from "../../src/managed/paths.ts";
import {
  runFirstRunSetup,
  type FirstRunPrompts,
  type FirstRunServices,
  type SetupReview,
} from "../../src/setup/first-run.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), "ambient-first-run-"));
  roots.push(parent);
  return { parent, dataDirectory: join(parent, "managed") };
};

const credential = {
  type: "oauth" as const,
  access: "chatgpt-access-must-not-leak",
  refresh: "chatgpt-refresh-must-not-leak",
  expires: 2_000_000_000_000,
};

const writeChatGptCredential = async (paths: ManagedPaths): Promise<void> => {
  await writeFile(paths.chatGptOAuthCredential, JSON.stringify(credential), { mode: 0o600 });
};

const setup = (events: string[]) => {
  const reviews: SetupReview[] = [];
  const services: FirstRunServices = {
    chatGptFor: (paths) => ({
      inspect: async () => ({ state: "missing" }),
      authenticate: async (callbacks) => {
        events.push("chatgpt.authenticate");
        callbacks.onDeviceCode({
          verificationUri: "https://auth.example/device",
          userCode: "SAFE-CODE",
          intervalSeconds: 5,
        });
        await writeChatGptCredential(paths);
      },
    }),
    whatsappFor: () => ({
      authenticate: async (callbacks) => {
        events.push("whatsapp.authenticate");
        callbacks.onPairing?.({ method: "qr", qr: "qr-must-not-leak", expiresAt: 60_000 });
        return { jid: "15550000000@s.whatsapp.net", pushName: "Ambient Agent" };
      },
      synchronizedChats: async () => {
        events.push("whatsapp.sync");
        return [
          { jid: "recent@g.us", name: "Recent Project", kind: "group", lastActivityAt: 2_000 },
          { jid: "older@g.us", name: "Older Project", kind: "group", lastActivityAt: 1_000 },
        ];
      },
      session: () => {
        throw new Error("not used during setup");
      },
      stop: async () => {
        events.push("whatsapp.stop");
      },
    }),
    discoverRepository: async () => "owner/discovered",
    discoverCredential: async () => ({ token: "github-token-must-not-leak", source: "GitHub CLI" }),
    verifyGitHub: async (token, repository) => {
      events.push(`github.verify:${repository}`);
      if (token !== "github-token-must-not-leak") throw new Error("sanitized access failure");
      if (repository === "owner/denied") throw new Error("sanitized access failure");
      return repository;
    },
  };
  const prompts: FirstRunPrompts = {
    selectChat: async (candidates) => {
      events.push("prompt.chat");
      return candidates[0]!.jid;
    },
    repository: async (discovered) => {
      events.push(`prompt.repository:${discovered ?? "none"}`);
      return discovered ?? "owner/manual";
    },
    githubCredential: async (discovered) => {
      events.push(`prompt.credential:${discovered?.source ?? "none"}`);
      return discovered ?? { token: "manual-token", source: "secure prompt" };
    },
    review: async (review) => {
      reviews.push(review);
      events.push("prompt.review");
      return true;
    },
    validationError: (field) => {
      events.push(`invalid:${field}`);
    },
  };
  return { services, prompts, reviews };
};

describe("transactional first-run setup", () => {
  it("authenticates, discovers services, reviews non-secret values, and only then promotes", async () => {
    const paths = await fixture();
    const events: string[] = [];
    const { services, prompts, reviews } = setup(events);

    const result = await runFirstRunSetup({
      dataDirectory: paths.dataDirectory,
      interactive: true,
      services,
      prompts,
      chatGptCallbacks: { onDeviceCode: () => undefined },
      whatsappCallbacks: {},
    });

    expect(result).toMatchObject({ created: true, inspection: { state: "ready" } });
    expect(events).toEqual([
      "chatgpt.authenticate",
      "whatsapp.authenticate",
      "whatsapp.sync",
      "prompt.chat",
      "whatsapp.stop",
      "prompt.repository:owner/discovered",
      "prompt.credential:GitHub CLI",
      "github.verify:owner/discovered",
      "prompt.review",
    ]);
    expect(reviews).toEqual([
      {
        dataDirectory: paths.dataDirectory,
        chat: { jid: "recent@g.us", name: "Recent Project", kind: "group" },
        repository: "owner/discovered",
        chatGptCredentialSource: "fresh device authorization",
        whatsappCredentialSource: "fresh pairing",
        githubCredentialSource: "GitHub CLI",
      },
    ]);
    const serializedReview = JSON.stringify(reviews);
    expect(serializedReview).not.toContain("must-not-leak");
    const config = await readFile(join(paths.dataDirectory, "config.json"), "utf8");
    expect(config).toContain("recent@g.us");
    expect(config).toContain("owner/discovered");
  });

  it("honors an explicit chat during interactive setup instead of prompting for another", async () => {
    const paths = await fixture();
    const events: string[] = [];
    const { services, prompts, reviews } = setup(events);
    prompts.selectChat = async () => {
      throw new Error("interactive chat selection must not run when --chat was supplied");
    };

    await expect(
      runFirstRunSetup({
        dataDirectory: paths.dataDirectory,
        interactive: true,
        scripted: { chat: "older@g.us" },
        services,
        prompts,
        chatGptCallbacks: { onDeviceCode: () => undefined },
        whatsappCallbacks: {},
      }),
    ).resolves.toMatchObject({ created: true });

    expect(reviews).toMatchObject([{ chat: { jid: "older@g.us", name: "Older Project", kind: "group" } }]);
  });

  it("retries invalid chat and GitHub fields without repeating provider authentication", async () => {
    const paths = await fixture();
    const events: string[] = [];
    const { services, prompts } = setup(events);
    const chats = ["not-from-sync@g.us", "older@g.us"];
    const repositories = ["not a repository", "owner/denied", "owner/allowed"];
    prompts.selectChat = async () => chats.shift()!;
    prompts.repository = async () => repositories.shift()!;

    await expect(
      runFirstRunSetup({
        dataDirectory: paths.dataDirectory,
        interactive: true,
        services,
        prompts,
        chatGptCallbacks: { onDeviceCode: () => undefined },
        whatsappCallbacks: {},
      }),
    ).resolves.toMatchObject({ created: true });

    expect(events.filter((event) => event === "chatgpt.authenticate")).toHaveLength(1);
    expect(events.filter((event) => event === "whatsapp.authenticate")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining(["invalid:chat", "invalid:repository", "invalid:github"]));
  });

  it("reuses ready managed ChatGPT auth and an adopted WhatsApp session", async () => {
    const paths = await fixture();
    const events: string[] = [];
    const { services, prompts, reviews } = setup(events);
    const authenticate = vi.fn(async () => undefined);
    const reusedServices: FirstRunServices = {
      ...services,
      chatGptFor: (managed) => ({
        inspect: async () => {
          await writeChatGptCredential(managed);
          return { state: "ready" };
        },
        authenticate,
      }),
      whatsappFor: () => ({
        authenticate: async () => ({ jid: "15550000000@s.whatsapp.net" }),
        synchronizedChats: async () => [
          { jid: "adopted@g.us", name: "Adopted Chat", kind: "group", lastActivityAt: 3_000 },
        ],
        session: () => {
          throw new Error("not used during setup");
        },
        stop: async () => undefined,
      }),
    };

    await expect(
      runFirstRunSetup({
        dataDirectory: paths.dataDirectory,
        interactive: true,
        services: reusedServices,
        prompts,
        chatGptCallbacks: { onDeviceCode: () => undefined },
        whatsappCallbacks: {},
      }),
    ).resolves.toMatchObject({ created: true });

    expect(authenticate).not.toHaveBeenCalled();
    expect(reviews).toMatchObject([
      {
        chatGptCredentialSource: "existing managed credential",
        whatsappCredentialSource: "existing managed session",
      },
    ]);
  });

  it.each(["chatgpt", "whatsapp", "chat", "github", "review"] as const)(
    "removes the stage when setup is cancelled during %s",
    async (stage) => {
      const paths = await fixture();
      const events: string[] = [];
      const baseline = setup(events);
      let services = baseline.services;
      let prompts = baseline.prompts;
      if (stage === "chatgpt") {
        services = {
          ...services,
          chatGptFor: () => ({
            inspect: async () => ({ state: "missing" }),
            authenticate: async () => {
              throw new Error("cancelled during ChatGPT setup");
            },
          }),
        };
      } else if (stage === "whatsapp") {
        services = {
          ...services,
          whatsappFor: () => ({
            authenticate: async () => {
              throw new Error("cancelled during WhatsApp setup");
            },
            synchronizedChats: async () => [],
            session: () => {
              throw new Error("not used during setup");
            },
            stop: async () => undefined,
          }),
        };
      } else if (stage === "chat") {
        prompts = {
          ...prompts,
          selectChat: async () => {
            throw new Error("cancelled during chat selection");
          },
        };
      } else if (stage === "github") {
        prompts = {
          ...prompts,
          repository: async () => {
            throw new Error("cancelled during GitHub setup");
          },
        };
      } else {
        prompts = { ...prompts, review: async () => false };
      }

      await expect(
        runFirstRunSetup({
          dataDirectory: paths.dataDirectory,
          interactive: true,
          services,
          prompts,
          chatGptCallbacks: { onDeviceCode: () => undefined },
          whatsappCallbacks: {},
        }),
      ).rejects.toThrow(/cancelled/i);
      await expect(lstat(paths.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(inspectManagedData(paths)).resolves.toMatchObject({ state: "absent" });
    },
  );

  it("removes the private stage when review is cancelled and never exposes secrets", async () => {
    const paths = await fixture();
    const events: string[] = [];
    const { services, prompts } = setup(events);
    prompts.review = async () => false;

    await expect(
      runFirstRunSetup({
        dataDirectory: paths.dataDirectory,
        interactive: true,
        services,
        prompts,
        chatGptCallbacks: { onDeviceCode: () => undefined },
        whatsappCallbacks: {},
      }),
    ).rejects.toThrow("cancelled before promotion");
    await expect(lstat(paths.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inspectManagedData(paths)).resolves.toMatchObject({ state: "absent" });
  });

  it("does not promote when the timeout fires while final review is pending", async () => {
    const paths = await fixture();
    const events: string[] = [];
    const { services, prompts } = setup(events);
    const controller = new AbortController();
    prompts.review = async () => {
      controller.abort(new DOMException("The operation timed out with secret details.", "TimeoutError"));
      return true;
    };

    await expect(
      runFirstRunSetup({
        dataDirectory: paths.dataDirectory,
        interactive: true,
        services,
        prompts,
        chatGptCallbacks: { onDeviceCode: () => undefined },
        whatsappCallbacks: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled or timed out before promotion");
    await expect(lstat(paths.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inspectManagedData(paths)).resolves.toMatchObject({ state: "absent" });
  });

  it("fails non-interactive setup before writing when managed provider credentials are absent", async () => {
    const paths = await fixture();
    const events: string[] = [];
    const { services, prompts } = setup(events);

    await expect(
      runFirstRunSetup({
        dataDirectory: paths.dataDirectory,
        interactive: false,
        services,
        prompts,
        scripted: {
          chat: "recent@g.us",
          repository: "owner/repository",
          githubCredential: { token: "scripted-secret", source: "token file" },
        },
        chatGptCallbacks: { onDeviceCode: () => undefined },
        whatsappCallbacks: {},
      }),
    ).rejects.toThrow("valid managed ChatGPT credential");
    await expect(lstat(paths.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(events).toEqual([]);
  });

  it("removes the stage and reports a sanitized timeout during GitHub verification", async () => {
    const paths = await fixture();
    const events: string[] = [];
    const baseline = setup(events);
    const signal = AbortSignal.abort(new DOMException("The operation timed out with secret details.", "TimeoutError"));
    const services: FirstRunServices = {
      ...baseline.services,
      verifyGitHub: async (_token, _repository, verificationSignal) => {
        verificationSignal?.throwIfAborted();
        return "owner/repository";
      },
    };

    await expect(
      runFirstRunSetup({
        dataDirectory: paths.dataDirectory,
        interactive: true,
        services,
        prompts: baseline.prompts,
        chatGptCallbacks: { onDeviceCode: () => undefined },
        whatsappCallbacks: {},
        signal,
      }),
    ).rejects.toThrow("GitHub verification timed out");
    await expect(lstat(paths.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
