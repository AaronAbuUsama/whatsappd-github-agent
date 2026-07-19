import { m as InstrumentationAlreadyInstalledError } from "./errors-DUgRtE8e.mjs";
import { $ as registerExecutionInterceptor } from "./conversation-projections-XMug3C6A.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/observation.ts
function createObservation(event, detail) {
	return freezeValue(cloneValue({
		...event,
		...detail
	}));
}
function cloneValue(value, seen = /* @__PURE__ */ new Map()) {
	if (value === null || typeof value !== "object") return value;
	const existing = seen.get(value);
	if (existing !== void 0) return existing;
	if (Array.isArray(value)) {
		const copy = [];
		seen.set(value, copy);
		for (const item of value) copy.push(cloneValue(item, seen));
		return copy;
	}
	const copy = {};
	seen.set(value, copy);
	for (const key of Reflect.ownKeys(value)) copy[key] = cloneValue(value[key], seen);
	return copy;
}
function freezeValue(value, seen = /* @__PURE__ */ new Set()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) freezeValue(value[key], seen);
	return Object.freeze(value);
}
//#endregion
//#region src/runtime/events.ts
/** Global, isolate-scoped subscription to live Flue runtime activity. */
const subscribers = /* @__PURE__ */ new Set();
/**
* Subscribe to live workflow-run or agent-interaction activity emitted in this isolate.
* The subscription does not replay durable workflow history or aggregate events
* across processes or Cloudflare Durable Object isolates.
*
* Usage (typically at the top of `app.ts`):

*
*     import { observe } from '@flue/runtime';
*
*     observe((event, ctx) => {
*       if (event.type === 'run_end' && event.isError) {
*         // ship to your error reporter, metrics sink, etc.
*       }
*     });
*
* The returned function unsubscribes the listener. Most error
* reporting and telemetry use cases register once at startup and
* never unsubscribe — the returned function is provided for tests
* and dynamic-wiring scenarios.
*
* Subscribers are invoked synchronously from the event emit path. They should
* treat events as read-only, remain cheap, and return quickly; returned promises
* are observed for rejection but are not awaited. Queue substantial work outside
* the callback rather than blocking emission.
*/
function observe(subscriber) {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}
/**
* Internal: dispatch a single event to every registered subscriber.
* Called from `createFlueContext`'s `emitEvent` after the per-context
* subscribers have run.
*/
function dispatchGlobalEvent(event, ctx, detail) {
	const observation = createObservation(event, detail);
	for (const subscriber of [...subscribers]) try {
		Promise.resolve(subscriber(observation, ctx)).catch(reportSubscriberFailure);
	} catch (error) {
		reportSubscriberFailure(error);
	}
}
function reportSubscriberFailure(error) {
	console.error("[flue:observe] subscriber failed:", error);
}
//#endregion
//#region src/instrumentation.ts
const installed = /* @__PURE__ */ new WeakMap();
const installedKeys = /* @__PURE__ */ new Map();
const ownerStorage = new AsyncLocalStorage();
function createInstrumentationOwner() {
	const disposers = /* @__PURE__ */ new Set();
	let disposePromise;
	let disposed = false;
	return {
		dispose() {
			disposed = true;
			disposePromise ??= Promise.allSettled([...disposers].reverse().map((dispose) => dispose())).then((results) => {
				const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "[flue] Instrumentation disposal failed.");
			});
			return disposePromise;
		},
		add(dispose) {
			if (disposed) {
				dispose().catch(() => void 0);
				return;
			}
			disposers.add(dispose);
		}
	};
}
function runWithInstrumentationOwner(owner, fn) {
	return ownerStorage.run(owner, fn);
}
function instrument(instrumentation) {
	const existing = installed.get(instrumentation);
	if (existing) return existing;
	const key = instrumentation.key;
	if (key && installedKeys.has(key)) throw new InstrumentationAlreadyInstalledError();
	if (key) installedKeys.set(key, instrumentation);
	let stopObserving;
	let stopIntercepting;
	try {
		stopObserving = observe(instrumentation.observe);
		stopIntercepting = registerExecutionInterceptor(instrumentation.interceptor);
	} catch (error) {
		if (key) installedKeys.delete(key);
		throw error;
	}
	let disposePromise;
	const dispose = () => {
		disposePromise ??= Promise.resolve().then(async () => {
			stopObserving();
			stopIntercepting();
			try {
				await instrumentation.dispose();
			} finally {
				installed.delete(instrumentation);
				if (key && installedKeys.get(key) === instrumentation) installedKeys.delete(key);
			}
		});
		return disposePromise;
	};
	installed.set(instrumentation, dispose);
	ownerStorage.getStore()?.add(dispose);
	return dispose;
}
//#endregion
export { observe as a, dispatchGlobalEvent as i, instrument as n, runWithInstrumentationOwner as r, createInstrumentationOwner as t };
