import { describe, expect, it } from "vite-plus/test";
import { posix, win32 } from "node:path";

import {
  managedPaths,
  resolveLegacyManagedDataDirectory,
  resolveManagedDataDirectory,
} from "@ambient-agent/core/managed/paths.ts";

describe("managed data paths", () => {
  it("uses ~/.ambient-agent on macOS and Linux, ignoring XDG_DATA_HOME", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "darwin",
        homeDirectory: "/Users/alice",
        environment: {},
      }),
    ).toBe("/Users/alice/.ambient-agent");
    expect(
      resolveManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: { XDG_DATA_HOME: "/data" },
      }),
    ).toBe("/home/alice/.ambient-agent");
  });

  it("resolves the pre-ADR-0015 legacy directory per platform", () => {
    expect(
      resolveLegacyManagedDataDirectory({
        platform: "darwin",
        homeDirectory: "/Users/alice",
        environment: {},
      }),
    ).toBe(posix.join("/Users/alice", "Library", "Application Support", "ambient-agent"));
    expect(
      resolveLegacyManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: { XDG_DATA_HOME: "/data" },
      }),
    ).toBe(posix.join("/data", "ambient-agent"));
    expect(
      resolveLegacyManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: {},
      }),
    ).toBe("/home/alice/.local/share/ambient-agent");
    expect(resolveLegacyManagedDataDirectory({ platform: "win32", homeDirectory: "C:\\Users\\alice" })).toBeUndefined();
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveManagedDataDirectory({
        platform: "win32",
        homeDirectory: "C:\\Users\\alice",
        environment: { LOCALAPPDATA: "D:\\Local" },
      }),
    ).toBe(win32.join("D:\\Local", "ambient-agent"));
  });

  it("uses the selected platform path dialect for every derived Windows path", () => {
    expect(managedPaths({ platform: "win32", dataDirectory: "D:\\Agent" })).toEqual({
      root: "D:\\Agent",
      config: "D:\\Agent\\config.json",
      credentials: "D:\\Agent\\credentials",
      githubCredential: "D:\\Agent\\credentials\\github.json",
      chatGptOAuthCredential: "D:\\Agent\\credentials\\chatgpt-oauth.json",
      legacyPiAuthCredential: "D:\\Agent\\credentials\\pi-auth.json",
      applicationDatabase: "D:\\Agent\\application.sqlite",
      flueDatabase: "D:\\Agent\\flue.sqlite",
      whatsapp: "D:\\Agent\\whatsapp",
      logs: "D:\\Agent\\logs",
    });
  });

  it("ignores empty or relative legacy environment overrides and rejects relative explicit roots", () => {
    expect(
      resolveLegacyManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: { XDG_DATA_HOME: "relative-data" },
      }),
    ).toBe("/home/alice/.local/share/ambient-agent");
    expect(
      resolveLegacyManagedDataDirectory({
        platform: "linux",
        homeDirectory: "/home/alice",
        environment: { XDG_DATA_HOME: "   " },
      }),
    ).toBe("/home/alice/.local/share/ambient-agent");
    expect(() => resolveManagedDataDirectory({ platform: "linux", dataDirectory: "relative-data" })).toThrow(
      "absolute path",
    );
  });

  it("rejects a relative fallback home on every platform", () => {
    expect(() =>
      resolveManagedDataDirectory({
        platform: "linux",
        homeDirectory: "relative-home",
        environment: {},
      }),
    ).toThrow("home directory must be an absolute path");
    expect(() =>
      resolveManagedDataDirectory({
        platform: "win32",
        homeDirectory: "relative-home",
        environment: {},
      }),
    ).toThrow("home directory must be an absolute path");
    expect(() =>
      resolveLegacyManagedDataDirectory({
        platform: "linux",
        homeDirectory: "relative-home",
        environment: {},
      }),
    ).toThrow("home directory must be an absolute path");
  });

  it("derives the complete stable skeleton from an injected root", () => {
    const paths = managedPaths({ platform: "linux", dataDirectory: "/managed" });
    expect(paths).toEqual({
      root: "/managed",
      config: posix.join("/managed", "config.json"),
      credentials: posix.join("/managed", "credentials"),
      githubCredential: posix.join("/managed", "credentials", "github.json"),
      chatGptOAuthCredential: posix.join("/managed", "credentials", "chatgpt-oauth.json"),
      legacyPiAuthCredential: posix.join("/managed", "credentials", "pi-auth.json"),
      applicationDatabase: posix.join("/managed", "application.sqlite"),
      flueDatabase: posix.join("/managed", "flue.sqlite"),
      whatsapp: posix.join("/managed", "whatsapp"),
      logs: posix.join("/managed", "logs"),
    });
  });
});
