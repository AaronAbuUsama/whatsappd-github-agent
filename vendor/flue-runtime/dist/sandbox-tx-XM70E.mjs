//#region src/abort.ts
/** Build a standard `AbortError` (`DOMException`) carrying the signal's reason as `cause`. */
function abortErrorFor(signal) {
	const reason = signal.reason;
	const message = reason instanceof Error && reason.message ? reason.message : typeof reason === "string" && reason ? reason : "The operation was aborted.";
	const error = new DOMException(message, "AbortError");
	try {
		Object.defineProperty(error, "cause", {
			value: reason,
			configurable: true
		});
	} catch {}
	return error;
}
/**
* Translate a millisecond deadline into an `AbortSignal` and compose it with
* the caller's signal. Single implementation of the timeout-to-signal
* cancellation composition shared by the LLM bash tool and the
* signal-translating `SessionEnv` adapters (bash factory, local).
*
* Returns both signals: callers that distinguish a recoverable timeout from
* a host abort (the bash tool's 124-shaped result) need `timeoutSignal` on
* its own; everything downstream gets `mergedSignal`.
*/
function composeTimeoutSignal(timeoutMs, signal) {
	const timeoutSignal = typeof timeoutMs === "number" ? AbortSignal.timeout(timeoutMs) : void 0;
	return {
		timeoutSignal,
		mergedSignal: signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : signal ?? timeoutSignal
	};
}
/**
* Wrap an async `run` function in a `CallHandle`. The handle's internal
* signal fires when `externalSignal` aborts or when `handle.abort()` is
* called.
*/
function createCallHandle(externalSignal, run) {
	const controller = new AbortController();
	let externalListener;
	if (externalSignal) if (externalSignal.aborted) controller.abort(externalSignal.reason);
	else {
		externalListener = () => controller.abort(externalSignal.reason);
		externalSignal.addEventListener("abort", externalListener, { once: true });
	}
	const promise = run(controller.signal).finally(() => {
		if (externalListener && externalSignal) externalSignal.removeEventListener("abort", externalListener);
	});
	promise.catch(() => {});
	return {
		signal: controller.signal,
		abort(reason) {
			controller.abort(reason);
		},
		then(onFulfilled, onRejected) {
			return promise.then(onFulfilled, onRejected);
		},
		catch(onRejected) {
			return promise.catch(onRejected);
		},
		finally(onFinally) {
			return promise.finally(onFinally);
		},
		[Symbol.toStringTag]: "Promise"
	};
}
//#endregion
//#region src/sandbox.ts
/**
* Sandbox adapters: wraps BashFactory or SandboxApi into SessionEnv.
*/
/** Adapt a SessionEnv to the public FlueFs surface. */
function createFlueFs(env) {
	return {
		readFile: (path) => env.readFile(path),
		readFileBuffer: (path) => env.readFileBuffer(path),
		writeFile: (path, content) => env.writeFile(path, content),
		stat: (path) => env.stat(path),
		readdir: (path) => env.readdir(path),
		exists: (path) => env.exists(path),
		mkdir: (path, options) => env.mkdir(path, options),
		rm: (path, options) => env.rm(path, options)
	};
}
/**
* Shared implementation of the `FlueFs.writeFile` parent-creation guarantee.
* Every `SessionEnv` adapter (local, bash factory, SandboxApi wrapper) routes
* writes through here so the cross-mode contract has exactly one
* implementation.
*
* Lazy by design: try the write first so the happy path costs a single call
* (no extra remote round-trip per write). When the write fails — most often a
* missing parent directory — `mkdir -p` the parent and retry once. Mkdir
* errors are ignored so that when the original failure was something else
* entirely, the retry reproduces it and its error propagates unchanged.
*/
async function writeFileCreatingParents(write, mkdirParent) {
	try {
		await write();
		return;
	} catch {}
	try {
		await mkdirParent();
	} catch {}
	await write();
}
/** Parent directory of an absolute POSIX path (`/a/b.txt` → `/a`, `/a.txt` → `/`). */
function posixParentDir(p) {
	return p.replace(/\/[^/]*$/, "") || "/";
}
/** Collapse `.`/`..`/empty segments of a POSIX path into a normalized absolute path. */
function normalizePath(p) {
	const parts = p.split("/");
	const result = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") result.pop();
		else result.push(part);
	}
	return `/${result.join("/")}`;
}
/** Resolve a possibly-relative POSIX path against `cwd`, normalizing the result. */
function makeResolvePath(cwd) {
	return (p) => {
		if (p.startsWith("/")) return normalizePath(p);
		if (cwd === "/") return normalizePath(`/${p}`);
		return normalizePath(`${cwd}/${p}`);
	};
}
function createCwdSessionEnv(parentEnv, cwd) {
	const scopedCwd = normalizePath(cwd);
	const resolvePath = makeResolvePath(scopedCwd);
	return {
		exec: (cmd, opts) => parentEnv.exec(cmd, {
			cwd: opts?.cwd !== void 0 ? resolvePath(opts.cwd) : scopedCwd,
			env: opts?.env,
			timeoutMs: opts?.timeoutMs,
			signal: opts?.signal
		}),
		readFile: (p) => parentEnv.readFile(resolvePath(p)),
		readFileBuffer: (p) => parentEnv.readFileBuffer(resolvePath(p)),
		writeFile: (p, c) => parentEnv.writeFile(resolvePath(p), c),
		stat: (p) => parentEnv.stat(resolvePath(p)),
		readdir: (p) => parentEnv.readdir(resolvePath(p)),
		exists: (p) => parentEnv.exists(resolvePath(p)),
		mkdir: (p, o) => parentEnv.mkdir(resolvePath(p), o),
		rm: (p, o) => parentEnv.rm(resolvePath(p), o),
		cwd: scopedCwd,
		resolvePath
	};
}
/**
* Wrap a just-bash factory into a {@link SandboxFactory}:
* `defineAgent(() => ({ sandbox: bash(() => new Bash({ fs })) }))`.
*/
function bash(factory) {
	return { createSessionEnv: () => bashFactoryToSessionEnv(factory) };
}
async function bashFactoryToSessionEnv(factory) {
	const bash = await factory();
	assertBashLike(bash);
	return createBashSessionEnv(bash);
}
function createBashSessionEnv(bash) {
	const fs = bash.fs;
	const cwd = bash.getCwd();
	const resolve = (p) => p.startsWith("/") ? p : fs.resolvePath(cwd, p);
	return {
		exec: async (cmd, opts) => {
			if (opts?.signal?.aborted) throw abortErrorFor(opts.signal);
			const { mergedSignal } = composeTimeoutSignal(opts?.timeoutMs, opts?.signal);
			const result = await bash.exec(cmd, opts ? {
				cwd: opts.cwd,
				env: opts.env,
				signal: mergedSignal
			} : void 0);
			if (opts?.signal?.aborted) throw abortErrorFor(opts.signal);
			return result;
		},
		readFile: (p) => fs.readFile(resolve(p)),
		readFileBuffer: (p) => fs.readFileBuffer(resolve(p)),
		writeFile: (p, content) => {
			const resolved = resolve(p);
			return writeFileCreatingParents(() => fs.writeFile(resolved, content), () => fs.mkdir(posixParentDir(resolved), { recursive: true }));
		},
		stat: (p) => fs.stat(resolve(p)),
		readdir: (p) => fs.readdir(resolve(p)),
		exists: (p) => fs.exists(resolve(p)),
		mkdir: (p, o) => fs.mkdir(resolve(p), o),
		rm: (p, o) => fs.rm(resolve(p), o),
		cwd,
		resolvePath: resolve
	};
}
/** Duck-type detection for just-bash Bash instances. */
function isBashLike(value) {
	return typeof value === "object" && value !== null && "exec" in value && "getCwd" in value && "fs" in value && typeof value.exec === "function" && typeof value.getCwd === "function" && typeof value.fs === "object" && value.fs !== null;
}
function assertBashLike(value) {
	if (!isBashLike(value)) throw new Error("[flue] BashFactory must return a Bash-like object.");
}
/** Wrap a SandboxApi into SessionEnv. No just-bash, no intermediate filesystem layer. */
function createSandboxSessionEnv(api, cwd) {
	const resolvePath = makeResolvePath(cwd);
	return {
		async exec(command, options) {
			const signal = options?.signal;
			if (signal?.aborted) throw abortErrorFor(signal);
			const result = await api.exec(command, {
				cwd: options?.cwd !== void 0 ? resolvePath(options.cwd) : cwd,
				env: options?.env,
				timeoutMs: options?.timeoutMs,
				signal
			});
			if (signal?.aborted) throw abortErrorFor(signal);
			return result;
		},
		async readFile(path) {
			return api.readFile(resolvePath(path));
		},
		async readFileBuffer(path) {
			return api.readFileBuffer(resolvePath(path));
		},
		async writeFile(path, content) {
			const resolved = resolvePath(path);
			return writeFileCreatingParents(() => api.writeFile(resolved, content), () => api.mkdir(posixParentDir(resolved), { recursive: true }));
		},
		async stat(path) {
			return api.stat(resolvePath(path));
		},
		async readdir(path) {
			return api.readdir(resolvePath(path));
		},
		async exists(path) {
			return api.exists(resolvePath(path));
		},
		async mkdir(path, options) {
			return api.mkdir(resolvePath(path), options);
		},
		async rm(path, options) {
			return api.rm(resolvePath(path), options);
		},
		cwd,
		resolvePath
	};
}
//#endregion
export { createSandboxSessionEnv as a, composeTimeoutSignal as c, createFlueFs as i, createCallHandle as l, bashFactoryToSessionEnv as n, writeFileCreatingParents as o, createCwdSessionEnv as r, abortErrorFor as s, bash as t };
