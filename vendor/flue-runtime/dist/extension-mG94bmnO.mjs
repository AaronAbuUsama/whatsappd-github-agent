import { T as SandboxOperationUnsupportedError } from "./errors-DUgRtE8e.mjs";
import { a as createSandboxSessionEnv, s as abortErrorFor } from "./sandbox-tx-XM70E.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/cloudflare/cf-sandbox.ts
/** Wraps a @cloudflare/sandbox instance (from getSandbox()) into SessionEnv. */
/**
* Wrap a Cloudflare Sandbox Durable Object stub into a Flue
* {@link SandboxFactory}:
*
* ```ts
* import { getSandbox } from '@cloudflare/sandbox';
* import { cloudflareSandbox } from '@flue/runtime/cloudflare';
*
* export default defineAgent(({ id, env }) => ({
*   sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
* }));
* ```
*/
function cloudflareSandbox(sandbox, options) {
	return { createSessionEnv: async () => cfSandboxToSessionEnv(sandbox, options?.cwd) };
}
function cfSandboxToSessionEnv(sandbox, cwd = "/workspace") {
	return createSandboxSessionEnv({
		async readFile(path) {
			return (await sandbox.readFile(path)).content;
		},
		async readFileBuffer(path) {
			const file = await sandbox.readFile(path, { encoding: "base64" });
			const binary = atob(file.content);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			return bytes;
		},
		async writeFile(path, content) {
			if (typeof content === "string") await sandbox.writeFile(path, content);
			else {
				let binary = "";
				for (const byte of content) binary += String.fromCharCode(byte);
				const b64 = btoa(binary);
				await sandbox.writeFile(path, b64, { encoding: "base64" });
			}
		},
		async stat(path) {
			const quoted = `'${path.replace(/'/g, "'\\''")}'`;
			const result = await sandbox.exec(`stat -L -c '%s/%Y/%F' ${quoted} && stat -c '%F' ${quoted}`);
			if (!result.success) throw new Error(`stat failed for ${path}: ${result.stderr}`);
			const [target = "", self = ""] = (result.stdout ?? "").trim().split("\n");
			const [size = "0", mtime = "0", type = ""] = target.split("/");
			return {
				isFile: type.includes("regular"),
				isDirectory: type === "directory",
				isSymbolicLink: self.trim() === "symbolic link",
				size: parseInt(size, 10),
				mtime: /* @__PURE__ */ new Date(parseInt(mtime, 10) * 1e3)
			};
		},
		async readdir(path) {
			const result = await sandbox.exec(`find '${path.replace(/'/g, "'\\''")}' -mindepth 1 -maxdepth 1 -printf '%f\\0'`);
			if (!result.success) throw new Error(`readdir failed for ${path}: ${result.stderr}`);
			return result.stdout.split("\0").filter((s) => s.length > 0);
		},
		async exists(path) {
			return (await sandbox.exists(path)).exists;
		},
		async mkdir(path, opts) {
			await sandbox.mkdir(path, opts);
		},
		async rm(path, opts) {
			const unsupported = [opts?.recursive ? "recursive" : void 0, opts?.force ? "force" : void 0].filter((option) => option !== void 0);
			if (unsupported.length > 0) throw new SandboxOperationUnsupportedError({
				operation: "rm",
				provider: "Cloudflare Sandbox",
				options: unsupported
			});
			await sandbox.deleteFile(path);
		},
		async exec(command, execOpts) {
			const externalSignal = execOpts?.signal;
			if (externalSignal?.aborted) throw abortErrorFor(externalSignal);
			const result = await sandbox.exec(command, {
				cwd: execOpts?.cwd,
				env: execOpts?.env,
				timeout: execOpts?.timeoutMs
			});
			if (externalSignal?.aborted) throw abortErrorFor(externalSignal);
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				exitCode: result.exitCode ?? (result.success ? 0 : 1)
			};
		}
	}, cwd);
}
//#endregion
//#region src/cloudflare/context.ts
/**
* Cloudflare environment context injection.
*
* Durable Objects are single-threaded, but async executions can still interleave
* at await points. AsyncLocalStorage keeps Cloudflare runtime primitives scoped
* to the request/fiber that invoked them instead of sharing a module global.
*/
const contextStorage = new AsyncLocalStorage();
function runWithCloudflareContext(ctx, fn) {
	return contextStorage.run(ctx, fn);
}
function getCloudflareContext() {
	const ctx = contextStorage.getStore();
	if (!ctx) throw new Error("[flue] Not running in a Cloudflare context. This function can only be called inside a Cloudflare Worker or Durable Object.");
	return ctx;
}
function getDurableObjectIdentity() {
	const ctx = getCloudflareContext();
	if (!ctx.durableObjectIdentity) throw new Error("[flue] Durable Object identity is not available in this Cloudflare context.");
	return ctx.durableObjectIdentity;
}
//#endregion
//#region src/cloudflare/extension.ts
const CLOUDFLARE_EXTENSION = Symbol.for("@flue/runtime/cloudflare-extension");
function extend(extension) {
	if (typeof extension !== "object" || extension === null || Array.isArray(extension)) throw new Error("[flue] extend() expects an object containing optional base and wrap callbacks.");
	const unknownKeys = Object.keys(extension).filter((key) => key !== "base" && key !== "wrap");
	if (unknownKeys.length > 0) throw new Error(`[flue] extend() received unknown option(s): ${unknownKeys.join(", ")}.`);
	return {
		...extension,
		[CLOUDFLARE_EXTENSION]: true
	};
}
function resolveCloudflareExtension(mod, name, kind) {
	const extension = mod.cloudflare;
	if (extension === void 0) return {
		base: identity,
		wrap: identity
	};
	if (!isCloudflareExtension(extension)) throw new Error(`[flue] ${kind} "${name}" cloudflare export must be created with extend({ base, wrap }) from "@flue/runtime/cloudflare".`);
	const base = extension.base === void 0 ? identity : extension.base;
	const wrap = extension.wrap === void 0 ? identity : extension.wrap;
	if (typeof base !== "function") throw new Error(`[flue] ${kind} "${name}" cloudflare.base must be a function.`);
	if (typeof wrap !== "function") throw new Error(`[flue] ${kind} "${name}" cloudflare.wrap must be a function.`);
	return {
		base(Base) {
			return assertExtensionClass(base(Base), Base, name, kind);
		},
		wrap(Final) {
			return assertExtensionWrapper(wrap(Final), Final, name, kind);
		}
	};
}
function identity(value) {
	return value;
}
function isCloudflareExtension(value) {
	return typeof value === "object" && value !== null && CLOUDFLARE_EXTENSION in value && value[CLOUDFLARE_EXTENSION] === true;
}
function assertExtensionClass(value, Base, name, kind) {
	if (typeof value !== "function" || value !== Base && !(value.prototype instanceof Base) || !isConstructable(value)) throw new Error(`[flue] ${kind} "${name}" cloudflare.base must return the received class or a subclass.`);
	return value;
}
function assertExtensionWrapper(value, Final, name, kind) {
	if (typeof value !== "function" || value !== Final && value.prototype !== Final.prototype || !isConstructable(value)) throw new Error(`[flue] ${kind} "${name}" cloudflare.wrap(Final) must return the received class or a constructor proxy.`);
	return value;
}
function isConstructable(value) {
	try {
		Reflect.construct(Function, [], value);
		return true;
	} catch {
		return false;
	}
}
//#endregion
export { runWithCloudflareContext as a, getDurableObjectIdentity as i, resolveCloudflareExtension as n, cfSandboxToSessionEnv as o, getCloudflareContext as r, cloudflareSandbox as s, extend as t };
