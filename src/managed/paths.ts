import { homedir } from "node:os";
import { posix, win32, type PlatformPath } from "node:path";

export interface ManagedPathEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly dataDirectory?: string;
}

export interface ManagedPaths {
  readonly root: string;
  readonly config: string;
  readonly credentials: string;
  readonly githubCredential: string;
  readonly chatGptOAuthCredential: string;
  readonly legacyPiAuthCredential: string;
  readonly applicationDatabase: string;
  readonly flueDatabase: string;
  readonly whatsapp: string;
  readonly logs: string;
}

export const resolveManagedDataDirectory = (options: ManagedPathEnvironment = {}): string => {
  const platform = options.platform ?? process.platform;
  const paths: PlatformPath = platform === "win32" ? win32 : posix;
  if (options.dataDirectory !== undefined) {
    const dataDirectory = options.dataDirectory.trim();
    if (!dataDirectory || !paths.isAbsolute(dataDirectory)) {
      throw new Error("The managed data directory must be an absolute path.");
    }
    return dataDirectory;
  }

  if (platform === "win32") {
    const environment = options.environment ?? process.env;
    const configured = environment.LOCALAPPDATA?.trim();
    const base =
      configured && win32.isAbsolute(configured)
        ? configured
        : win32.join(fallbackHome(options, paths), "AppData", "Local");
    return win32.join(base, "ambient-agent");
  }
  // ADR 0015: the owner must be able to find the data from memory, like ~/.ssh.
  return posix.join(fallbackHome(options, paths), ".ambient-agent");
};

const fallbackHome = (options: ManagedPathEnvironment, paths: PlatformPath): string => {
  const home = (options.homeDirectory ?? homedir()).trim();
  if (!home || !paths.isAbsolute(home)) {
    throw new Error("The home directory must be an absolute path.");
  }
  return home;
};

/** Pre-ADR-0015 platform-native default; only the one-time migration reads it. */
export const resolveLegacyManagedDataDirectory = (options: ManagedPathEnvironment = {}): string | undefined => {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return undefined;
  if (platform === "darwin") {
    return posix.join(fallbackHome(options, posix), "Library", "Application Support", "ambient-agent");
  }
  const environment = options.environment ?? process.env;
  const configured = environment.XDG_DATA_HOME?.trim();
  const base =
    configured && posix.isAbsolute(configured) ? configured : posix.join(fallbackHome(options, posix), ".local", "share");
  return posix.join(base, "ambient-agent");
};

export const managedPaths = (options: ManagedPathEnvironment = {}): ManagedPaths => {
  const root = resolveManagedDataDirectory(options);
  const paths: PlatformPath = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const credentials = paths.join(root, "credentials");
  return {
    root,
    config: paths.join(root, "config.json"),
    credentials,
    githubCredential: paths.join(credentials, "github.json"),
    chatGptOAuthCredential: paths.join(credentials, "chatgpt-oauth.json"),
    legacyPiAuthCredential: paths.join(credentials, "pi-auth.json"),
    applicationDatabase: paths.join(root, "application.sqlite"),
    flueDatabase: paths.join(root, "flue.sqlite"),
    whatsapp: paths.join(root, "whatsapp"),
    logs: paths.join(root, "logs"),
  };
};
