import { E as SessionAlreadyExistsError, N as SubmissionAbortedError, O as SessionNotFoundError, X as toHttpResponse, w as RuntimeUnavailableError } from "./errors-DUgRtE8e.mjs";
import { A as admitDetachedWorkflow, B as generateSessionAffinityKey, F as handleWorkflowRequest, H as generateWorkflowRunId, I as invokeDirectAttached, J as agentStreamPath, L as invokeWorkflowAttached, M as assertWorkflowDefinition, N as failRecoveredRun, P as handleAgentRequest, R as generateConversationId, at as resolveAgentProfile, et as assertResolvedAgentProfile, it as extendAgentProfile, j as assertAgentDispatchAdmissionInput, q as SqliteEventStreamStore, w as reduceConversationRecords } from "./conversation-projections-XMug3C6A.mjs";
import { m as parseSkillMarkdown, n as createSkillReference, t as buildPackagedSkill } from "./skill-package-B-Co0HMC.mjs";
import { a as observe, i as dispatchGlobalEvent, r as runWithInstrumentationOwner, t as createInstrumentationOwner } from "./instrumentation-DMZ8Niqr.mjs";
import { i as createFlueFs, l as createCallHandle, n as bashFactoryToSessionEnv, r as createCwdSessionEnv, s as abortErrorFor } from "./sandbox-tx-XM70E.mjs";
import { c as handleStreamHead, d as handleAgentConversationHead, f as handleAgentConversationRead, l as handleStreamRead, n as createDefaultFlueApp, o as handleRunRouteRequest, p as loadReducedConversationState, t as configureFlueRuntime, u as handleAgentAttachmentRead } from "./flue-app-DweeRG3g.mjs";
import { _ as createSessionStorageKey, d as SUBMISSION_SESSION_NAME, f as clampLimit, g as createActionScopeName, h as assertPublicSessionName, i as encodeRunCursor, n as MAX_LIST_LIMIT, r as decodeRunCursor, u as SUBMISSION_HARNESS_NAME, v as createTaskSessionName } from "./run-store-CYeXjR-d.mjs";
import { l as resetProviderRuntime, o as hasRegisteredProvider, u as resolveRegisteredModel } from "./providers-CsCcTxMU.mjs";
import { C as LEASE_DURATION_MS, _ as Session, b as discoverSessionContext, d as createDirectAgentSubmissionInput, f as createDispatchAgentSubmissionInput, g as submissionSyntheticRequest, h as reconcileInterruptedSubmission, m as processSubmission, n as SqliteConversationStreamStore, p as materializeAgentSubmissionSession, t as InMemoryConversationStreamStore, u as createAgentSubmissionObserverRegistry, v as createPublicSession, y as execShellWithEvents } from "./conversation-stream-store-Bitz7UoW.mjs";
import { t as InMemoryAttachmentStore } from "./attachment-store-C1jHXs6y.mjs";
import { a as ensureSqlAgentExecutionTables, i as createSqlAgentExecutionStoreFromSql, n as SqliteAttachmentStore, r as ensureSqlAttachmentTable, t as createSqlRunStore } from "./sql-run-store-DRLffFXh.mjs";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Bash, InMemoryFs } from "just-bash";
//#region src/conversation-writer.ts
/**
* How long streamed deltas are coalesced before being appended to the durable
* stream. The timer only governs mid-block streaming cadence — block boundaries
* and message completion flush immediately. Lower = smoother live streaming
* (deltas reach observers sooner, in smaller batches) at the cost of more
* durable writes; higher = fewer writes but burstier streaming.
*/
const CANONICAL_FLUSH_DELAY_MS = 1e3;
var ConversationRecordWriter = class ConversationRecordWriter {
	store;
	path;
	claim;
	onFailed;
	lifecycle = { status: "active" };
	tail = Promise.resolve();
	nextProducerSequence;
	reducedState;
	pendingRecords = [];
	pendingOptions;
	pendingTimer;
	pendingFlush;
	flushing;
	resolvePending;
	rejectPending;
	constructor(store, path, claim, onFailed) {
		this.store = store;
		this.path = path;
		this.claim = claim;
		this.onFailed = onFailed;
		this.nextProducerSequence = claim.nextProducerSequence;
	}
	static async create(options) {
		await options.store.createStream(options.path, options.identity);
		const claim = await options.store.acquireProducer(options.path, options.producerId);
		return new ConversationRecordWriter(options.store, options.path, claim, options.onFailed);
	}
	async loadReducedState() {
		this.assertActive();
		this.reducedState ??= await loadReducedConversationState({
			store: this.store,
			path: this.path
		});
		this.assertActive();
		return this.reducedState;
	}
	async getConversationLeaf(conversationId) {
		return (await this.loadReducedState()).conversations.get(conversationId)?.activeLeafId ?? null;
	}
	async hasConversationEntry(conversationId, entryId) {
		return (await this.loadReducedState()).conversations.get(conversationId)?.entries.has(entryId) ?? false;
	}
	async hasRecord(recordId) {
		return (await this.loadReducedState()).recordsById.has(recordId);
	}
	async getRecord(recordId) {
		return (await this.loadReducedState()).recordsById.get(recordId);
	}
	async getConversation(conversationId) {
		return (await this.loadReducedState()).conversations.get(conversationId);
	}
	async findInProgressAssistant(conversationId, submissionId) {
		return [...(await this.getConversation(conversationId))?.inProgressMessages.values() ?? []].find((message) => message.submissionId === submissionId);
	}
	async findConversation(harness, session) {
		const matches = [...(await this.loadReducedState()).conversations.values()].filter((conversation) => conversation.harness === harness && conversation.session === session);
		if (matches.length > 1) throw new Error("[flue] Multiple active canonical conversations share one session scope.");
		return matches[0];
	}
	get offset() {
		return this.reducedState?.recordsThroughOffset ?? this.claim.offset;
	}
	get failed() {
		return this.lifecycle.status === "failed";
	}
	append(records, options = {}) {
		try {
			this.assertActive();
			return this.appendBatch(records, options);
		} catch (error) {
			return Promise.reject(error);
		}
	}
	enqueue(records, options = {}) {
		try {
			this.assertActive();
			if (this.pendingRecords.length > 0 && !sameAppendOptions(this.pendingOptions ?? {}, options)) throw new Error("[flue] Canonical batch ownership changed before the pending batch flushed.");
			this.pendingOptions = options;
			this.pendingRecords.push(...records);
			this.pendingFlush ??= new Promise((resolve, reject) => {
				this.resolvePending = resolve;
				this.rejectPending = reject;
			});
			this.pendingTimer ??= setTimeout(() => {
				this.flush().catch(() => {});
			}, CANONICAL_FLUSH_DELAY_MS);
			return this.pendingFlush;
		} catch (error) {
			return Promise.reject(error);
		}
	}
	flush() {
		try {
			this.assertActive();
			if (this.flushing) {
				if (this.pendingRecords.length === 0) return this.flushing;
				return this.flushing.then(() => this.flush());
			}
			if (this.pendingTimer) clearTimeout(this.pendingTimer);
			this.pendingTimer = void 0;
			if (this.pendingRecords.length === 0) return Promise.resolve({ offset: this.reducedState?.recordsThroughOffset ?? this.claim.offset });
			const records = this.pendingRecords;
			const options = this.pendingOptions ?? {};
			const resolve = this.resolvePending;
			const reject = this.rejectPending;
			this.pendingRecords = [];
			this.pendingOptions = void 0;
			this.pendingFlush = void 0;
			this.resolvePending = void 0;
			this.rejectPending = void 0;
			const operation = this.appendBatch(records, options).then((result) => {
				resolve?.(result);
				return result;
			}, (error) => {
				reject?.(error);
				throw error;
			});
			this.flushing = operation;
			operation.then(() => {
				if (this.flushing === operation) this.flushing = void 0;
			}, () => {});
			return operation;
		} catch (error) {
			return Promise.reject(error);
		}
	}
	appendBatch(records, options) {
		const operation = this.tail.then(async () => {
			this.assertActive();
			const reduced = this.reducedState ? reduceConversationRecords(this.reducedState, records, this.reducedState.recordsThroughOffset) : void 0;
			const producerSequence = this.nextProducerSequence;
			const input = {
				path: this.path,
				producerId: this.claim.producerId,
				producerEpoch: this.claim.producerEpoch,
				incarnation: this.claim.incarnation,
				producerSequence,
				...options.submission ? { submission: options.submission } : {},
				records
			};
			try {
				let result;
				try {
					result = await this.store.append(input);
				} catch (firstError) {
					try {
						result = await this.store.append(input);
					} catch {
						throw firstError;
					}
				}
				this.nextProducerSequence = producerSequence + 1;
				if (reduced) {
					reduced.recordsThroughOffset = result.offset;
					this.reducedState = reduced;
				}
				return result;
			} catch (error) {
				throw this.fail(error);
			}
		});
		this.tail = operation.then(() => {}, () => {});
		return operation;
	}
	assertActive() {
		if (this.lifecycle.status === "failed") throw this.lifecycle.error;
	}
	fail(error) {
		if (this.lifecycle.status === "failed") return this.lifecycle.error;
		this.lifecycle = {
			status: "failed",
			error
		};
		this.onFailed?.(this);
		if (this.pendingTimer) clearTimeout(this.pendingTimer);
		this.pendingTimer = void 0;
		this.pendingRecords = [];
		this.pendingOptions = void 0;
		const reject = this.rejectPending;
		this.pendingFlush = void 0;
		this.resolvePending = void 0;
		this.rejectPending = void 0;
		reject?.(error);
		return error;
	}
	async ensureChildConversation(input) {
		const state = await this.loadReducedState();
		const parent = state.conversations.get(input.parent.conversationId);
		if (!parent || parent.harness !== input.parent.harness || parent.session !== input.parent.session) throw new Error("[flue] Canonical child parent is missing or conflicts with its scope.");
		const existing = state.conversations.get(input.child.conversationId);
		const retained = parent.childConversations.get(input.child.conversationId);
		if (existing || retained) {
			if (!existing || !retained || existing.harness !== input.child.harness || existing.session !== input.child.session || existing.affinityKey !== input.child.affinityKey || existing.parentConversationId !== input.parent.conversationId || JSON.stringify(retained) !== JSON.stringify(input.ref)) throw new Error("[flue] Canonical child conversation conflicts with retained topology.");
			return { offset: state.recordsThroughOffset };
		}
		const timestamp = input.child.createdAt;
		return this.append([{
			v: 1,
			id: `record_conversation_created_${input.child.conversationId}`,
			type: "conversation_created",
			conversationId: input.child.conversationId,
			harness: input.child.harness,
			session: input.child.session,
			timestamp,
			affinityKey: input.child.affinityKey,
			createdAt: input.child.createdAt,
			...input.child.kind === "task" ? {
				kind: "task",
				parentConversationId: input.parent.conversationId,
				taskId: input.child.taskId,
				...input.child.agent ? { agent: input.child.agent } : {}
			} : {
				kind: "action",
				parentConversationId: input.parent.conversationId,
				actionInvocationId: input.child.actionInvocationId
			}
		}, {
			v: 1,
			id: `record_child_retained_${input.parent.conversationId}_${input.child.conversationId}`,
			type: "child_session_retained",
			conversationId: input.parent.conversationId,
			harness: input.parent.harness,
			session: input.parent.session,
			timestamp,
			child: input.ref
		}]);
	}
	async ensureConversation(input) {
		const state = await this.loadReducedState();
		const existing = state.conversations.get(input.conversationId);
		if (existing) {
			if (existing.harness !== input.harness || existing.session !== input.session || existing.affinityKey !== input.affinityKey || existing.parentConversationId !== input.parentConversationId || existing.taskId !== input.taskId || existing.actionInvocationId !== input.actionInvocationId) throw new Error("[flue] Canonical conversation identity conflicts with the requested session.");
			return { offset: state.recordsThroughOffset };
		}
		const timestamp = input.timestamp ?? input.createdAt;
		return this.append([{
			...input,
			v: 1,
			id: `record_conversation_created_${input.conversationId}`,
			type: "conversation_created",
			timestamp
		}]);
	}
};
function sameAppendOptions(left, right) {
	return left.submission?.submissionId === right.submission?.submissionId && left.submission?.attemptId === right.submission?.attemptId;
}
//#endregion
//#region src/harness.ts
const DEFAULT_SESSION_NAME = "default";
var Harness = class Harness {
	instanceId;
	name;
	config;
	env;
	eventCallback;
	agentTools;
	toolFactory;
	conversationWriter;
	attachmentStore;
	actions;
	executionContext;
	scopeName;
	scopeDepth;
	retainSession;
	sessions = {
		get: (name) => this.openSession(name, "get"),
		create: (name) => this.openSession(name, "create")
	};
	fs;
	openSessions = /* @__PURE__ */ new Map();
	pendingSessionOperations = /* @__PURE__ */ new Map();
	activeShellCalls = /* @__PURE__ */ new Set();
	scopeAbortController = new AbortController();
	closePromise;
	constructor(instanceId, name, config, env, eventCallback, agentTools, toolFactory, conversationWriter, attachmentStore, actions = config.actions ?? [], executionContext = {}, scopeName, scopeDepth = 0, retainSession, scopeSignal) {
		this.instanceId = instanceId;
		this.name = name;
		this.config = config;
		this.env = env;
		this.eventCallback = eventCallback;
		this.agentTools = agentTools;
		this.toolFactory = toolFactory;
		this.conversationWriter = conversationWriter;
		this.attachmentStore = attachmentStore;
		this.actions = actions;
		this.executionContext = executionContext;
		this.scopeName = scopeName;
		this.scopeDepth = scopeDepth;
		this.retainSession = retainSession;
		this.fs = createFlueFs(env);
		if (scopeSignal) if (scopeSignal.aborted) this.scopeAbortController.abort(scopeSignal.reason);
		else scopeSignal.addEventListener("abort", () => this.scopeAbortController.abort(scopeSignal.reason), { once: true });
	}
	async session(name) {
		return this.openSession(name, "get-or-create");
	}
	shell(command, options) {
		const call = createCallHandle(options?.signal ? AbortSignal.any([options.signal, this.scopeAbortController.signal]) : this.scopeAbortController.signal, (signal) => execShellWithEvents(this.env, (event, detail) => this.emit(event, detail), command, options, signal, this.executionContext));
		this.activeShellCalls.add(call);
		call.then(() => this.activeShellCalls.delete(call), () => this.activeShellCalls.delete(call));
		return call;
	}
	async openSession(name, mode) {
		const sessionName = normalizeSessionName(name);
		assertPublicSessionName(sessionName);
		return createPublicSession(await this.runSessionOperation(sessionName, () => this.loadSession(sessionName, mode)));
	}
	runSessionOperation(sessionName, operation) {
		const result = (this.pendingSessionOperations.get(sessionName) ?? Promise.resolve()).then(operation);
		const tail = result.then(() => {}, () => {});
		this.pendingSessionOperations.set(sessionName, tail);
		tail.then(() => {
			if (this.pendingSessionOperations.get(sessionName) === tail) this.pendingSessionOperations.delete(sessionName);
		});
		return result;
	}
	async loadSession(sessionName, mode) {
		if (this.scopeAbortController.signal.aborted) throw abortErrorFor(this.scopeAbortController.signal);
		const open = this.openSessions.get(sessionName);
		if (open) {
			if (mode === "create") throw new SessionAlreadyExistsError({
				session: sessionName,
				harness: this.name
			});
			return open;
		}
		const harnessScope = this.scopeName ? `${this.name}:${this.scopeName}` : this.name;
		let conversation = await this.conversationWriter.findConversation(harnessScope, sessionName);
		if (mode === "get" && !conversation) throw new SessionNotFoundError({
			session: sessionName,
			harness: this.name
		});
		if (mode === "create" && conversation) throw new SessionAlreadyExistsError({
			session: sessionName,
			harness: this.name
		});
		if (!conversation) {
			const identity = createConversationIdentity();
			if (this.retainSession) await this.retainSession(sessionName, identity, harnessScope);
			else await this.conversationWriter.ensureConversation({
				kind: "root",
				conversationId: identity.conversationId,
				harness: harnessScope,
				session: sessionName,
				affinityKey: identity.affinityKey,
				createdAt: identity.createdAt
			});
			conversation = await this.conversationWriter.findConversation(harnessScope, sessionName);
			if (!conversation) throw new SessionNotFoundError({
				session: sessionName,
				harness: this.name
			});
		}
		const session = new Session({
			name: sessionName,
			conversation,
			config: this.config,
			env: this.env,
			onAgentEvent: this.decorateEventCallback(this.eventCallback),
			agentTools: this.agentTools,
			toolFactory: this.toolFactory,
			delegationDepth: this.scopeDepth,
			createTaskSession: (taskOptions) => this.createTaskSession(taskOptions),
			actions: this.actions,
			createActionHarness: (actionOptions) => this.createActionHarness(actionOptions),
			scopeSignal: this.scopeAbortController.signal,
			onClose: () => this.openSessions.delete(sessionName),
			conversationWriter: this.conversationWriter,
			attachmentStore: this.attachmentStore,
			executionContext: {
				...this.executionContext,
				harness: harnessScope
			}
		});
		await session.initializeCanonicalContext();
		this.openSessions.set(sessionName, session);
		return session;
	}
	async createTaskSession(options) {
		const sessionName = createTaskSessionName(options.parentSession, options.taskId);
		const taskEnv = options.cwd ? createCwdSessionEnv(options.parentEnv, options.parentEnv.resolvePath(options.cwd)) : options.parentEnv;
		const taskAgent = options.agent;
		const instructions = taskAgent ? taskAgent.instructions : this.config.instructions;
		const definitionSkills = taskAgent ? taskAgent.skills : this.config.definitionSkills;
		const localContext = await discoverSessionContext(taskEnv, instructions, definitionSkills);
		const taskModel = taskAgent?.model !== void 0 ? this.config.resolveModel(taskAgent.model) : this.config.model;
		if (!taskModel) throw new Error(`[flue] Subagent model "${taskAgent?.model}" could not be resolved.`);
		const taskConfig = {
			...this.config,
			systemPrompt: localContext.systemPrompt,
			instructions,
			definitionSkills,
			skills: localContext.skills,
			actions: taskAgent ? taskAgent.actions : this.config.actions,
			subagents: taskAgent ? Object.fromEntries((taskAgent.subagents ?? []).filter((agent) => agent.name !== void 0).map((agent) => [agent.name, agent])) : this.config.subagents,
			model: taskModel,
			thinkingLevel: taskAgent?.thinkingLevel ?? this.config.thinkingLevel,
			compaction: taskAgent?.compaction ?? this.config.compaction
		};
		const harnessScope = this.scopeName ? `${this.name}:${this.scopeName}` : this.name;
		const conversationId = options.existing?.conversationId ?? await this.createChildConversation(options, harnessScope, sessionName, taskAgent);
		const eventCallback = this.eventCallback ? (event, observation) => {
			this.eventCallback?.({
				...event,
				harness: event.harness ?? this.name,
				parentSession: event.parentSession ?? options.parentSession,
				taskId: event.taskId ?? options.taskId
			}, observation);
		} : void 0;
		const conversation = await this.conversationWriter.getConversation(conversationId);
		if (!conversation) throw new SessionNotFoundError({
			session: sessionName,
			harness: this.name
		});
		const session = new Session({
			name: sessionName,
			conversation,
			config: taskConfig,
			env: taskEnv,
			onAgentEvent: eventCallback,
			agentTools: taskAgent ? taskAgent.tools ?? [] : this.agentTools,
			toolFactory: this.toolFactory,
			delegationDepth: options.depth,
			createTaskSession: (childOptions) => this.createTaskSession(childOptions),
			actions: taskConfig.actions ?? [],
			createActionHarness: (actionOptions) => this.createActionHarness(actionOptions),
			scopeSignal: this.scopeAbortController.signal,
			conversationWriter: this.conversationWriter,
			attachmentStore: this.attachmentStore,
			executionContext: {
				...this.executionContext,
				harness: harnessScope,
				taskId: options.taskId
			}
		});
		await session.initializeCanonicalContext();
		return session;
	}
	/** Mint a fresh child conversation identity and durably record its creation
	*  plus the parent's retained link. Returns the new child conversation id. */
	async createChildConversation(options, harnessScope, sessionName, taskAgent) {
		const identity = createConversationIdentity();
		await this.conversationWriter.ensureChildConversation({
			parent: {
				conversationId: options.parentConversationId,
				harness: harnessScope,
				session: options.parentSession
			},
			child: {
				kind: "task",
				conversationId: identity.conversationId,
				harness: harnessScope,
				session: sessionName,
				affinityKey: identity.affinityKey,
				createdAt: identity.createdAt,
				parentConversationId: options.parentConversationId,
				taskId: options.taskId,
				...taskAgent?.name ? { agent: taskAgent.name } : {}
			},
			ref: {
				conversationId: identity.conversationId,
				harness: harnessScope,
				session: sessionName,
				type: "task",
				taskId: options.taskId,
				...options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {},
				...options.parentAssistantEntryId ? { parentAssistantEntryId: options.parentAssistantEntryId } : {}
			}
		});
		return identity.conversationId;
	}
	createActionHarness = (options) => {
		const scope = createActionScopeName(options.invocationId);
		const nestedScope = this.scopeName ? `${this.scopeName}:${scope}` : scope;
		return new Harness(this.instanceId, this.name, options.config, options.env, options.eventCallback ?? this.eventCallback, options.tools, this.toolFactory, this.conversationWriter, this.attachmentStore, options.actions, options.executionContext, nestedScope, options.depth, (session, conversation, harnessScope) => options.retainSession(session, conversation, harnessScope), options.signal);
	};
	close() {
		if (this.closePromise) return this.closePromise;
		this.scopeAbortController.abort();
		for (const call of this.activeShellCalls) call.abort();
		for (const session of this.openSessions.values()) session.abort();
		this.closePromise = (async () => {
			await Promise.allSettled([...this.pendingSessionOperations.values(), ...this.activeShellCalls]);
			this.activeShellCalls.clear();
			const sessions = [...this.openSessions.values()];
			await Promise.allSettled(sessions.map((session) => session.close()));
			this.openSessions.clear();
		})();
		return this.closePromise;
	}
	emit(event, observation) {
		this.eventCallback?.({
			...event,
			harness: event.harness ?? this.name
		}, observation);
	}
	decorateEventCallback(callback) {
		return callback ? (event, observation) => {
			callback({
				...event,
				harness: event.harness ?? this.name
			}, observation);
		} : void 0;
	}
};
function normalizeSessionName(name) {
	return name ?? DEFAULT_SESSION_NAME;
}
function createConversationIdentity() {
	return {
		conversationId: generateConversationId(),
		affinityKey: generateSessionAffinityKey(),
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
//#endregion
//#region src/client.ts
function createFlueContext(config) {
	const subscribers = /* @__PURE__ */ new Set();
	let handlerUnsubscribe;
	const pendingEventCallbacks = /* @__PURE__ */ new Set();
	let eventCallbackError;
	let eventIndex = config.initialEventIndex ?? 0;
	let submissionId;
	let conversationWriter = config.conversationWriter;
	let attachmentStore = config.attachmentStore;
	let localConversationRuntime;
	const createEvent = (event) => ({
		...event,
		...config.runId === void 0 ? { instanceId: config.id } : { runId: config.runId },
		...config.dispatchId === void 0 ? {} : { dispatchId: config.dispatchId },
		...submissionId === void 0 ? {} : { submissionId },
		...config.agentName === void 0 ? {} : { agentName: config.agentName },
		v: 3,
		eventIndex: eventIndex++,
		timestamp: (/* @__PURE__ */ new Date()).toISOString()
	});
	const publishEvent = (decorated, observation) => {
		for (const subscriber of subscribers) try {
			const callback = subscriber(decorated);
			if (callback instanceof Promise) {
				const pending = callback.catch((error) => {
					eventCallbackError ??= error;
				}).finally(() => pendingEventCallbacks.delete(pending));
				pendingEventCallbacks.add(pending);
			}
		} catch (error) {
			eventCallbackError ??= error;
		}
		dispatchGlobalEvent(decorated, ctx, observation);
	};
	const emitEvent = (event, observation) => {
		const decorated = createEvent(event);
		publishEvent(decorated, observation);
		return decorated;
	};
	const ctx = {
		get id() {
			return config.id;
		},
		get runId() {
			return config.runId;
		},
		get agentName() {
			return config.agentName;
		},
		get env() {
			return config.env;
		},
		get req() {
			return config.req;
		},
		async initializeRootHarness(agent) {
			if (!conversationWriter || !attachmentStore) {
				localConversationRuntime ??= createLocalConversationRuntime(config);
				const local = await localConversationRuntime;
				conversationWriter ??= local.writer;
				attachmentStore ??= local.attachments;
			}
			return initializeRootHarness(agent, {
				...config,
				conversationWriter,
				attachmentStore
			}, emitEvent);
		},
		log: {
			info(message, attributes) {
				emitEvent({
					type: "log",
					level: "info",
					message,
					attributes: normalizeLogAttributes(attributes)
				});
			},
			warn(message, attributes) {
				emitEvent({
					type: "log",
					level: "warn",
					message,
					attributes: normalizeLogAttributes(attributes)
				});
			},
			error(message, attributes) {
				emitEvent({
					type: "log",
					level: "error",
					message,
					attributes: normalizeLogAttributes(attributes)
				});
			}
		},
		createEvent,
		publishEvent,
		emitEvent,
		subscribeEvent(callback) {
			subscribers.add(callback);
			return () => subscribers.delete(callback);
		},
		async flushEventCallbacks() {
			await Promise.all(pendingEventCallbacks);
			if (eventCallbackError !== void 0) {
				const error = eventCallbackError;
				eventCallbackError = void 0;
				throw error;
			}
		},
		setEventCallback(callback) {
			handlerUnsubscribe?.();
			handlerUnsubscribe = callback ? ctx.subscribeEvent(callback) : void 0;
		},
		setSubmissionId(value) {
			submissionId = value;
		},
		setConversationWriter(value) {
			conversationWriter = value;
		},
		setAttachmentStore(value) {
			attachmentStore = value;
		}
	};
	return ctx;
}
async function createLocalConversationRuntime(config) {
	const store = new InMemoryConversationStreamStore();
	const path = config.runId === void 0 ? agentStreamPath(config.agentName ?? "agent", config.id) : `workflow-executions/${config.runId}`;
	return {
		writer: await ConversationRecordWriter.create({
			store,
			path,
			identity: {
				agentName: config.agentName ?? "workflow",
				instanceId: config.id
			},
			producerId: `execution:${config.runId ?? config.id}`
		}),
		attachments: new InMemoryAttachmentStore()
	};
}
async function initializeRootHarness(agent, config, emitEvent) {
	const resolvedOptions = await agent.initialize({
		id: config.id,
		env: config.env
	});
	const definition = assertResolvedAgentProfile(extendAgentProfile(resolveAgentProfile(resolvedOptions), {}), "defineAgent()");
	if (typeof definition.model !== "string") throw new Error("[flue] defineAgent() requires a model. Return { model: \"provider-id/model-id\" } or a profile with a model.");
	const resolvedModel = config.agentConfig.resolveModel(definition.model);
	if (!resolvedModel) throw new Error(`[flue] defineAgent() model "${definition.model}" could not be resolved.`);
	const { env: baseEnv, toolFactory } = await resolveSessionEnv(config.id, resolvedOptions.sandbox, config);
	const env = resolvedOptions.cwd ? createCwdSessionEnv(baseEnv, baseEnv.resolvePath(resolvedOptions.cwd)) : baseEnv;
	const localContext = await discoverSessionContext(env, definition.instructions, definition.skills);
	const agentConfig = {
		...config.agentConfig,
		systemPrompt: localContext.systemPrompt,
		instructions: definition.instructions,
		definitionSkills: definition.skills,
		skills: localContext.skills,
		actions: definition.actions,
		subagents: Object.fromEntries((definition.subagents ?? []).filter((candidate) => candidate.name !== void 0).map((candidate) => [candidate.name, candidate])),
		model: resolvedModel,
		thinkingLevel: definition.thinkingLevel ?? config.agentConfig.thinkingLevel,
		compaction: definition.compaction ?? config.agentConfig.compaction,
		durability: definition.durability
	};
	if (!config.conversationWriter || !config.attachmentStore) throw new Error("[flue] Canonical conversation runtime is not configured.");
	return new Harness(config.id, "default", agentConfig, env, emitEvent, definition.tools ?? [], toolFactory, config.conversationWriter, config.attachmentStore, definition.actions, config.runId === void 0 ? { instanceId: config.id } : { runId: config.runId });
}
function normalizeLogAttributes(attributes) {
	if (!attributes) return void 0;
	if (!(attributes.error instanceof Error)) return attributes;
	return {
		...attributes,
		error: serializeLogError(attributes.error)
	};
}
function serializeLogError(error) {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack
	};
}
function isSandboxFactory(value) {
	return typeof value === "object" && value !== null && "createSessionEnv" in value && typeof value.createSessionEnv === "function";
}
/** Resolve sandbox option to its session environment and optional tool factory. */
async function resolveSessionEnv(id, sandbox, config) {
	if (sandbox === void 0) return { env: await config.createDefaultEnv() };
	if (isSandboxFactory(sandbox)) return {
		env: await sandbox.createSessionEnv({ id }),
		toolFactory: sandbox.tools
	};
	throw new Error("[flue] Invalid sandbox option returned from defineAgent().");
}
//#endregion
//#region src/cloudflare/agent-execution-store.ts
function createSqlConversationStores(storage) {
	const sql = storage.sql;
	const transactionSync = storage.transactionSync;
	const runTransaction = (closure) => transactionSync.call(storage, closure);
	ensureSqlAttachmentTable(sql);
	return {
		conversationStreamStore: new SqliteConversationStreamStore(sql, runTransaction),
		attachmentStore: new SqliteAttachmentStore(sql, runTransaction)
	};
}
function createSqlAgentExecutionStore(storage, className) {
	const sql = storage?.sql;
	const transactionSync = storage?.transactionSync;
	if (!sql || typeof sql.exec !== "function" || typeof transactionSync !== "function") throw new Error(`[flue] Cloudflare durable agent class "${className}" requires Durable Object SQLite. Add "${className}" to a Wrangler migration's "new_sqlite_classes" list before its first deploy; do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted to SQLite in place.`);
	try {
		ensureSqlAgentExecutionTables(sql);
		const runTransaction = (closure) => transactionSync.call(storage, closure);
		return createSqlAgentExecutionStoreFromSql(sql, runTransaction);
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`[flue] Cloudflare durable agent class "${className}" could not initialize its SQLite execution store. Underlying error: ${detail}`, { cause });
	}
}
//#endregion
//#region src/cloudflare/agent-coordinator.ts
const CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH = "/__flue/internal/dispatch";
const FLUE_AGENT_SUBMISSION_WAKE_CALLBACK = "__flueWakeAgentSubmissions";
const FLUE_AGENT_SUBMISSION_WAKE_SECONDS = 30;
const FLUE_AGENT_SUBMISSION_ATTEMPT_STALE_MS = 900 * 1e3;
const FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER = "flue:submission-attempt";
function createCloudflareAgentRuntime(options) {
	const coordinators = /* @__PURE__ */ new WeakMap();
	const observers = createAgentSubmissionObserverRegistry();
	const activeAttempts = /* @__PURE__ */ new Set();
	const getCoordinator = (instance) => {
		const coordinator = coordinators.get(instance);
		if (!coordinator) throw new Error("[flue] Generated Cloudflare agent coordinator was not initialized.");
		return coordinator;
	};
	return {
		prepare({ storage, className, agentName }) {
			return {
				agentName,
				executionStore: createSqlAgentExecutionStore(storage, className),
				...createSqlConversationStores(storage)
			};
		},
		attach(instance, prepared) {
			coordinators.set(instance, new CloudflareAgentCoordinator(instance, prepared, options, observers, activeAttempts));
		},
		onStart(instance, inherited) {
			return getCoordinator(instance).onStart(inherited);
		},
		wakeSubmissions(instance) {
			return getCoordinator(instance).wakeSubmissions();
		},
		onRequest(instance, request) {
			return getCoordinator(instance).onRequest(request);
		},
		onFiberRecovered(instance, ctx, inherited) {
			return getCoordinator(instance).onFiberRecovered(ctx, inherited);
		}
	};
}
var CloudflareAgentCoordinator = class {
	instance;
	prepared;
	options;
	observers;
	activeAttempts;
	constructor(instance, prepared, options, observers, activeAttempts) {
		this.instance = instance;
		this.prepared = prepared;
		this.options = options;
		this.observers = observers;
		this.activeAttempts = activeAttempts;
	}
	conversationWriter;
	conversationWriterCreation;
	conversationMaterialization = Promise.resolve();
	/**
	* Abort controllers for in-flight attempt fibers in this isolate, keyed by
	* submissionId, so an incoming cancel request can abort the running attempt.
	* The DO is single-threaded but interleaves at `await` points, so a cancel
	* request can set the controller while the fiber is suspended on provider
	* I/O. If the isolate is evicted the controller is gone and the abort
	* falls back to the durable `abortRequestedAt` + reconcile path.
	*/
	activeControllers = /* @__PURE__ */ new Map();
	onStart(inherited) {
		return this.runWithInstanceContext(async () => {
			await this.restoreSubmissionWake();
			await inherited();
			await this.reconcileSubmissions({ driverAlreadyArmed: true });
		});
	}
	wakeSubmissions() {
		return this.runWithInstanceContext(async () => {
			if (!await this.submissions.hasUnsettledSubmissions()) return;
			await this.armSubmissionWake({ idempotent: false });
			await this.reconcileSubmissions({ driverAlreadyArmed: true });
		});
	}
	onRequest(request) {
		return this.runWithInstanceContext(() => this.routeRequest(request));
	}
	async routeRequest(request) {
		if (isInternalDispatchRequest(request)) return this.admitDispatch(request);
		if (isAbortRequest(request, this.agentName, this.instance.name)) {
			const aborted = await this.abortInstance();
			return Response.json({ aborted });
		}
		const method = request.method;
		if (method === "GET" || method === "HEAD") {
			const streamPath = agentStreamPath(this.agentName, this.instance.name);
			const segments = new URL(request.url).pathname.split("/");
			const attachmentId = method === "GET" && segments.length >= 4 && segments[segments.length - 2] === "attachments" && segments[segments.length - 3] === this.instance.name && segments[segments.length - 4] === this.agentName ? decodeURIComponent(segments[segments.length - 1]) : void 0;
			if (attachmentId) return handleAgentAttachmentRead({
				conversationStore: this.prepared.conversationStreamStore,
				attachmentStore: this.prepared.attachmentStore,
				path: streamPath,
				attachmentId: decodeURIComponent(attachmentId)
			});
			if (method === "HEAD") return await handleAgentConversationHead(this.prepared.conversationStreamStore, streamPath);
			return handleAgentConversationRead({
				store: this.prepared.conversationStreamStore,
				path: streamPath,
				request
			});
		}
		return handleAgentRequest({
			request,
			id: this.instance.name,
			agentName: this.agentName,
			conversationStreamStore: this.prepared.conversationStreamStore,
			admitAttachedSubmission: (payload, onEvent, waitForResult, traceCarrier) => this.admitAttachedSubmission(payload, onEvent, waitForResult, traceCarrier)
		});
	}
	onFiberRecovered(ctx, inherited) {
		return this.runWithInstanceContext(async () => {
			if (ctx.name !== FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER) return inherited();
			const submissionId = ctx.snapshot?.submissionId;
			const attemptId = ctx.snapshot?.attemptId;
			if (typeof submissionId !== "string" || typeof attemptId !== "string") return inherited();
			await this.restoreSubmissionWake();
			await this.submissions.requestSubmissionRecovery({
				submissionId,
				attemptId
			});
			await this.reconcileSubmissions({ driverAlreadyArmed: true });
		});
	}
	get agentName() {
		return this.prepared.agentName;
	}
	get executionStore() {
		return this.prepared.executionStore;
	}
	get submissions() {
		return this.executionStore.submissions;
	}
	runWithInstanceContext(callback) {
		return this.options.runWithInstanceContext(this.instance, this.agentName, callback);
	}
	async ensureConversationWriter() {
		if (this.conversationWriter && !this.conversationWriter.failed) return this.conversationWriter;
		if (!this.conversationWriterCreation) {
			const creation = ConversationRecordWriter.create({
				store: this.prepared.conversationStreamStore,
				path: agentStreamPath(this.agentName, this.instance.name),
				identity: {
					agentName: this.agentName,
					instanceId: this.instance.name
				},
				producerId: this.instance.ctx.id.toString(),
				onFailed: (writer) => {
					if (this.conversationWriter === writer) this.conversationWriter = void 0;
				}
			});
			this.conversationWriterCreation = creation;
			creation.then((writer) => {
				if (!writer.failed) this.conversationWriter = writer;
				if (this.conversationWriterCreation === creation) this.conversationWriterCreation = void 0;
			}, () => {
				if (this.conversationWriterCreation === creation) this.conversationWriterCreation = void 0;
			});
		}
		return this.conversationWriterCreation;
	}
	createContext(request, initialEventIndex, dispatchId) {
		return this.options.createContext({
			executionStore: this.executionStore,
			instance: this.instance,
			agentName: this.agentName,
			request,
			initialEventIndex,
			dispatchId
		});
	}
	createDurableContext(request, dispatchId) {
		const ctx = this.createContext(request, void 0, dispatchId);
		ctx.setConversationWriter?.(this.conversationWriter);
		ctx.setAttachmentStore?.(this.prepared.attachmentStore);
		return ctx;
	}
	assertAgentsDurabilityApi(method) {
		if (typeof this.instance[method] !== "function") throw new Error(`[flue] The installed "agents" package does not provide the required Cloudflare Agents SDK method "${method}". Install or upgrade the "agents" package in your project.`);
	}
	armSubmissionWake(options = {}) {
		this.assertAgentsDurabilityApi("schedule");
		return this.instance.schedule(options.delaySeconds ?? FLUE_AGENT_SUBMISSION_WAKE_SECONDS, FLUE_AGENT_SUBMISSION_WAKE_CALLBACK, void 0, { idempotent: options.idempotent ?? true });
	}
	async restoreSubmissionWake() {
		if (!await this.submissions.hasUnsettledSubmissions()) return false;
		await this.armSubmissionWake();
		return true;
	}
	async reconcileSubmissions(options = {}) {
		if (!await this.submissions.hasUnsettledSubmissions()) return false;
		if (!options.driverAlreadyArmed) await this.restoreSubmissionWake();
		try {
			for (const submission of await this.submissions.listUnreadySubmissions()) {
				const agent = this.options.agents.find((record) => record.name === submission.input.agent)?.definition;
				if (!agent || submission.input.agent !== this.agentName || submission.input.id !== this.instance.name) {
					console.error("[flue:submission-reconciliation]", {
						agentName: this.agentName,
						instanceId: this.instance.name,
						submissionId: submission.submissionId,
						sessionKey: submission.sessionKey,
						operation: "materialize_submission",
						outcome: "agent_unavailable"
					});
					continue;
				}
				try {
					await this.materializeSubmissionConversation(submission.input, agent);
					await this.submissions.markSubmissionCanonicalReady(submission.submissionId);
				} catch (error) {
					this.logSubmissionReconciliationFailure(submission, "materialize_submission", error);
				}
			}
			for (const settlement of await this.submissions.listPendingSubmissionSettlements()) {
				const submission = await this.submissions.getSubmission(settlement.submissionId);
				if (!submission || this.activeAttempts.has(this.submissionAttemptLocalKey(submission))) continue;
				const writer = await this.ensureConversationWriter();
				const attempt = {
					submissionId: settlement.submissionId,
					attemptId: settlement.attemptId
				};
				const canonical = await writer.getRecord(settlement.recordId);
				if (!canonical) await writer.append([settlement.record], { submission: attempt });
				else if (JSON.stringify(canonical) !== JSON.stringify(settlement.record)) throw new Error("[flue] Pending settlement does not match its canonical record. Clear incompatible beta persistence.");
				if (await this.submissions.finalizeSubmissionSettlement(attempt, settlement.recordId)) {
					if (settlement.record.outcome === "completed") this.observers.complete(settlement.submissionId, settlement.record.result);
					if (settlement.record.outcome === "failed") {
						const error = settlement.record.error;
						this.observers.fail(settlement.submissionId, new Error(error?.message ?? "Agent submission failed."));
					}
				}
			}
			let attemptMarkers;
			try {
				attemptMarkers = await this.listActiveAttemptMarkers();
			} catch (error) {
				attemptMarkers = /* @__PURE__ */ new Set();
				console.error("[flue:submission-reconciliation]", {
					agentName: this.agentName,
					instanceId: this.instance.name,
					operation: "list_attempt_markers",
					outcome: "degraded_to_empty_marker_set"
				}, error);
			}
			for (const submission of await this.submissions.listRunningSubmissions()) {
				if (this.activeAttempts.has(this.submissionAttemptLocalKey(submission))) continue;
				if (attemptMarkers.has(submissionAttemptMarkerKey(submission)) && submission.recoveryRequestedAt === void 0) continue;
				try {
					await this.reconcileInterruptedSubmission(submission);
				} catch (error) {
					this.logSubmissionReconciliationFailure(submission, "reconcile_submission", error);
				}
			}
			for (const submission of await this.submissions.listRunnableSubmissions()) {
				const claimed = await this.submissions.claimSubmission({
					submissionId: submission.submissionId,
					attemptId: crypto.randomUUID(),
					ownerId: this.instance.ctx.id.toString(),
					leaseExpiresAt: 0
				});
				if (!claimed) continue;
				try {
					await this.startSubmissionAttempt(claimed);
				} catch (error) {
					this.logSubmissionReconciliationFailure(claimed, "start_submission", error);
				}
			}
		} catch (error) {
			console.error("[flue:submission-reconciliation]", {
				agentName: this.agentName,
				instanceId: this.instance.name,
				operation: "reconcile",
				outcome: "deferred_to_scheduled_wake"
			}, error);
			return true;
		}
		return await this.submissions.hasUnsettledSubmissions();
	}
	logSubmissionReconciliationFailure(submission, operation, error) {
		console.error("[flue:submission-reconciliation]", {
			agentName: this.agentName,
			instanceId: this.instance.name,
			submissionId: submission.submissionId,
			sessionKey: submission.sessionKey,
			attemptId: submission.attemptId,
			operation,
			outcome: "deferred_to_scheduled_wake"
		}, error);
	}
	async reconcileInterruptedSubmission(submission) {
		const conversationWriter = await this.ensureConversationWriter();
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.definition;
		if (!agent) throw new Error("[flue] Agent target unavailable during durable reconciliation.");
		const reconciled = await reconcileInterruptedSubmission(this.submissions, submission, agent, (dispatchId) => this.createDurableContext(submissionSyntheticRequest(submission.input), dispatchId), {
			ownerId: this.instance.ctx.id.toString(),
			leaseExpiresAt: 0
		}, conversationWriter);
		if (reconciled.disposition === "replacement") await this.startSubmissionAttempt(reconciled.submission);
		else if (submission.kind === "direct") {
			if (reconciled.disposition === "completed") this.observers.complete(submission.submissionId, reconciled.result);
			else if (reconciled.disposition === "failed") this.observers.fail(submission.submissionId, reconciled.error);
		}
	}
	async startSubmissionAttempt(submission) {
		if (submission.status !== "running" || !submission.attemptId) return;
		const attempt = {
			submissionId: submission.submissionId,
			attemptId: submission.attemptId
		};
		const attemptKey = this.submissionAttemptLocalKey(submission);
		if (this.activeAttempts.has(attemptKey)) return;
		this.assertAgentsDurabilityApi("runFiber");
		this.activeAttempts.add(attemptKey);
		const controller = new AbortController();
		this.activeControllers.set(submission.submissionId, controller);
		let running;
		try {
			await this.submissions.insertAttemptMarker(attempt);
			running = this.instance.runFiber(FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER, async (fiberCtx) => {
				fiberCtx.stash({
					submissionId: submission.submissionId,
					attemptId: submission.attemptId
				});
				await this.runWithInstanceContext(() => this.processSubmissionEntry(submission, controller.signal));
			});
		} catch (error) {
			this.activeAttempts.delete(attemptKey);
			this.activeControllers.delete(submission.submissionId);
			await this.deleteAttemptMarkerSafely(attempt);
			throw error;
		}
		running.catch((error) => {
			console.error("[flue:submission-processing]", {
				agentName: this.agentName,
				instanceId: this.instance.name,
				submissionId: submission.submissionId,
				operation: "process",
				outcome: "failed"
			}, error);
		}).finally(() => {
			this.activeAttempts.delete(attemptKey);
			this.activeControllers.delete(submission.submissionId);
			this.deleteAttemptMarkerSafely(attempt);
		});
	}
	async abortInstance() {
		const sessionKey = createSessionStorageKey(this.instance.name, SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME);
		const affected = await this.submissions.requestSessionAbort(sessionKey);
		if (affected.length === 0) return false;
		for (const submissionId of affected) this.activeControllers.get(submissionId)?.abort(new SubmissionAbortedError());
		await this.armSubmissionWake({ idempotent: false });
		await this.reconcileSubmissions({ driverAlreadyArmed: true });
		return true;
	}
	/**
	* Delete the attempt marker at settlement. Deletion failures are logged
	* rather than thrown: a leftover marker only delays reconciliation of
	* this attempt until the staleness cutoff expires.
	*/
	async deleteAttemptMarkerSafely(attempt) {
		try {
			await this.submissions.deleteAttemptMarker(attempt);
		} catch (error) {
			console.error("[flue:submission-reconciliation]", {
				agentName: this.agentName,
				instanceId: this.instance.name,
				submissionId: attempt.submissionId,
				attemptId: attempt.attemptId,
				operation: "delete_attempt_marker",
				outcome: "marker_left_until_stale"
			}, error);
		}
	}
	submissionAttemptLocalKey(submission) {
		return `${this.instance.ctx.id.toString()}:${submission.attemptId}`;
	}
	async listActiveAttemptMarkers() {
		const keys = /* @__PURE__ */ new Set();
		for (const marker of await this.submissions.listAttemptMarkers()) {
			if (Date.now() - marker.createdAt > FLUE_AGENT_SUBMISSION_ATTEMPT_STALE_MS) continue;
			keys.add(`${marker.submissionId}:${marker.attemptId}`);
		}
		return keys;
	}
	materializeSubmissionConversation(input, agent) {
		const operation = this.conversationMaterialization.then(async () => {
			await this.ensureConversationWriter();
			await materializeAgentSubmissionSession(this.createDurableContext(submissionSyntheticRequest(input), input.kind === "dispatch" ? input.dispatchId : void 0), agent, input, this.prepared.attachmentStore);
		});
		this.conversationMaterialization = operation.catch(() => {});
		return operation;
	}
	async processSubmissionEntry(submission, signal) {
		const conversationWriter = await this.ensureConversationWriter();
		await processSubmission({
			submissions: this.submissions,
			submission,
			resolveAgent: (name) => {
				const agent = this.options.agents.find((record) => record.name === name)?.definition;
				if (!agent) throw new Error("[flue] Agent target unavailable during durable processing.");
				return agent;
			},
			createContext: (dispatchId) => this.createDurableContext(submissionSyntheticRequest(submission.input), dispatchId),
			observers: this.observers,
			conversationWriter,
			onInteractionStart: this.options.onInteractionStart,
			signal,
			onSettled: () => {
				this.reconcileSubmissions().catch((error) => {
					console.error("[flue:submission-reconciliation]", {
						agentName: this.agentName,
						instanceId: this.instance.name,
						operation: "settlement",
						outcome: "reconcile_failed"
					}, error);
				});
			}
		});
	}
	async admitAttachedSubmission(payload, onEvent, waitForResult, traceCarrier) {
		waitForResult ??= true;
		const input = createDirectAgentSubmissionInput({
			agent: this.agentName,
			id: this.instance.name,
			payload,
			traceCarrier
		});
		const attachment = this.observers.attach(input.submissionId, { onEvent });
		try {
			const agent = this.options.agents.find((record) => record.name === this.agentName)?.definition;
			if (!agent) throw new Error("[flue] Agent target unavailable during durable admission.");
			if ((await this.submissions.admitDirect(input)).canonicalReadyAt === null) {
				await this.materializeSubmissionConversation(input, agent);
				await this.submissions.markSubmissionCanonicalReady(input.submissionId);
			}
			const offset = (await this.ensureConversationWriter()).offset;
			await this.armSubmissionWake();
			await this.reconcileSubmissions({ driverAlreadyArmed: true });
			if (!waitForResult) return {
				submissionId: input.submissionId,
				offset
			};
			return {
				submissionId: input.submissionId,
				offset,
				result: await attachment.completion
			};
		} catch (error) {
			this.observers.fail(input.submissionId, error);
			throw error;
		} finally {
			attachment.detach();
		}
	}
	async admitDispatch(request) {
		const input = await request.json();
		assertAgentDispatchAdmissionInput(input);
		if (input.agent !== this.agentName || input.id !== this.instance.name) return new Response("Invalid internal dispatch target.", { status: 400 });
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.definition;
		if (!agent) return new Response("Dispatch target unavailable.", { status: 404 });
		const admission = await this.submissions.admitDispatch(input);
		if (admission.kind === "retained_receipt") return Response.json({
			dispatchId: admission.receipt.submissionId,
			acceptedAt: new Date(admission.receipt.acceptedAt).toISOString()
		});
		if (admission.kind === "conflict") return new Response("Conflicting internal dispatch replay.", { status: 409 });
		if (admission.submission.canonicalReadyAt === null) {
			await this.materializeSubmissionConversation({
				...input,
				kind: "dispatch",
				submissionId: input.dispatchId
			}, agent);
			if (!await this.submissions.markSubmissionCanonicalReady(input.dispatchId)) throw new Error("[flue] Dispatch admission disappeared before canonical readiness.");
		}
		await this.armSubmissionWake();
		await this.reconcileSubmissions({ driverAlreadyArmed: true });
		return Response.json({
			dispatchId: admission.submission.submissionId,
			acceptedAt: input.acceptedAt
		});
	}
};
function submissionAttemptMarkerKey(submission) {
	return `${submission.submissionId}:${submission.attemptId}`;
}
function isInternalDispatchRequest(request) {
	return request.method === "POST" && new URL(request.url).pathname === "/__flue/internal/dispatch";
}
/**
* Whether the request is an abort for this agent instance
* (`POST .../agents/<name>/<id>/abort`). Matched by exact tail position (not a
* loose substring) so an agent or instance named "abort" cannot misroute.
*/
function isAbortRequest(request, agentName, instanceName) {
	if (request.method !== "POST") return false;
	const segments = new URL(request.url).pathname.split("/");
	const n = segments.length;
	if (n < 4) return false;
	return segments[n - 1] === "abort" && decodeURIComponent(segments[n - 2]) === instanceName && decodeURIComponent(segments[n - 3]) === agentName;
}
//#endregion
//#region src/node/agent-coordinator.ts
/**
* Create a `DispatchQueue` backed by a `NodeAgentCoordinator`.
*
* Dispatches go through proper SQL admission, claim, and settlement
* instead of fire-and-forget inline processing. The
* coordinator also reconciles interrupted work from a previous process
* on startup and drains queued submissions after each dispatch.
*/
function createNodeDispatchQueue(coordinator) {
	return { async enqueue(input) {
		const admission = await coordinator.admitDispatch(input);
		if (admission.kind === "retained_receipt") return {
			dispatchId: admission.receipt.submissionId,
			acceptedAt: new Date(admission.receipt.acceptedAt).toISOString()
		};
		if (admission.kind === "conflict") throw new Error(`[flue] dispatch() target agent "${input.agent}" rejected a conflicting dispatch replay.`);
		return {
			dispatchId: admission.submission.submissionId,
			acceptedAt: input.acceptedAt
		};
	} };
}
function createNodeAgentCoordinator(options) {
	const { submissions, agents, createContext, conversationStreamStore, attachmentStore, onInteractionStart, activityGate } = options;
	const observers = createAgentSubmissionObserverRegistry();
	const conversationWriters = /* @__PURE__ */ new Map();
	const conversationMaterializations = /* @__PURE__ */ new Map();
	/** Unique identifier for this coordinator instance. Used as the owner
	*  for lease-based submission ownership. */
	const ownerId = crypto.randomUUID();
	/** Heartbeat interval handle; started with the claim loop. */
	let heartbeatInterval = null;
	/** Periodic lease-scan wake timer; wakes the claim loop so expired
	*  leases are discovered even when no new work arrives. */
	let leaseScanInterval = null;
	/** Submissions currently being processed, keyed by submissionId. */
	const activeSubmissions = /* @__PURE__ */ new Map();
	const activityLeases = /* @__PURE__ */ new Map();
	/**
	* Wake signal. The claim loop sleeps on `wakePromise` when there is
	* nothing to do. Callers resolve it via `wake()` to trigger a new
	* claim pass. The loop re-creates the promise each iteration.
	*/
	let wakeResolve = null;
	let wakePromise = null;
	/**
	* When a claim pass is already running, `wake()` sets this flag so
	* the current pass loops again after finishing its claims. Same
	* cooperative pattern as the old `driveAgainRequested`.
	*/
	let claimPassRunning = false;
	let wakeRequested = false;
	/** Whether the claim loop has been started. */
	let loopRunning = false;
	/** Whether the coordinator is shutting down. When true, the claim
	*  loop stops claiming new work and admissions are rejected. */
	let stopping = false;
	function resetWakePromise() {
		wakePromise = new Promise((resolve) => {
			wakeResolve = resolve;
		});
	}
	function wake() {
		if (claimPassRunning) {
			wakeRequested = true;
			return;
		}
		if (wakeResolve) {
			const resolve = wakeResolve;
			wakeResolve = null;
			resolve();
		}
	}
	function getConversationWriter(input) {
		if (!conversationStreamStore) return Promise.resolve(void 0);
		const path = agentStreamPath(input.agent, input.id);
		let writer = conversationWriters.get(path);
		if (!writer) {
			writer = ConversationRecordWriter.create({
				store: conversationStreamStore,
				path,
				identity: {
					agentName: input.agent,
					instanceId: input.id
				},
				producerId: ownerId,
				onFailed: () => {
					if (conversationWriters.get(path) === writer) conversationWriters.delete(path);
				}
			});
			conversationWriters.set(path, writer);
			writer.catch(() => {
				if (conversationWriters.get(path) === writer) conversationWriters.delete(path);
			});
		}
		return writer;
	}
	function makeSubmissionContext(input, writer) {
		return (dispatchId) => {
			const ctx = createContext({
				id: input.id,
				agentName: input.agent,
				request: submissionSyntheticRequest(input),
				dispatchId
			});
			ctx.setConversationWriter?.(writer);
			ctx.setAttachmentStore?.(attachmentStore);
			return ctx;
		};
	}
	function materializeSubmissionConversation(input, agent) {
		const path = agentStreamPath(input.agent, input.id);
		const materialized = (conversationMaterializations.get(path) ?? Promise.resolve()).then(async () => {
			await materializeAgentSubmissionSession(makeSubmissionContext(input, await getConversationWriter(input))(input.kind === "dispatch" ? input.dispatchId : void 0), agent, input, attachmentStore);
		});
		conversationMaterializations.set(path, materialized);
		materialized.then(() => {
			if (conversationMaterializations.get(path) === materialized) conversationMaterializations.delete(path);
		}, () => {
			if (conversationMaterializations.get(path) === materialized) conversationMaterializations.delete(path);
		});
		return materialized;
	}
	function resolveAgent(name) {
		const agent = agents.find((record) => record.name === name)?.definition;
		if (!agent) throw new Error(`[flue] submission target agent "${name}" has no agent definition.`);
		return agent;
	}
	/**
	* Start processing a claimed submission as an independent async task.
	* Adds itself to `activeSubmissions`, removes on completion, and
	* wakes the claim loop so it can pick up newly-runnable work (e.g.
	* the next queued submission for the same session).
	*/
	function spawnSubmissionTask(claimed) {
		const controller = new AbortController();
		const task = (async () => {
			const conversationWriter = await getConversationWriter(claimed.input);
			return processSubmission({
				submissions,
				submission: claimed,
				resolveAgent,
				createContext: makeSubmissionContext(claimed.input, conversationWriter),
				observers,
				conversationWriter,
				onInteractionStart,
				signal: controller.signal,
				isShutdownAbort: (error) => stopping && error instanceof DOMException && error.name === "AbortError"
			});
		})().catch((error) => {
			if (error instanceof DOMException && error.name === "AbortError") return;
			console.error("[flue:submission-processing]", {
				submissionId: claimed.submissionId,
				operation: "process_submission",
				outcome: "failed"
			}, error);
		}).finally(() => {
			activeSubmissions.delete(claimed.submissionId);
			activityLeases.get(claimed.submissionId)?.release();
			activityLeases.delete(claimed.submissionId);
			wake();
		});
		activeSubmissions.set(claimed.submissionId, {
			task,
			abort: controller
		});
	}
	/**
	* Run a single claim pass: list runnable submissions, attempt to
	* claim each, and spawn processing tasks for successful claims.
	* Returns whether any progress was made.
	*/
	async function runClaimPass() {
		await reconcileUnreadySubmissions();
		await periodicLeaseScan();
		const runnable = await submissions.listRunnableSubmissions();
		let progressed = false;
		for (const submission of runnable) {
			if (activeSubmissions.has(submission.submissionId)) continue;
			const claimed = await submissions.claimSubmission({
				submissionId: submission.submissionId,
				attemptId: crypto.randomUUID(),
				ownerId,
				leaseExpiresAt: Date.now() + LEASE_DURATION_MS
			});
			if (!claimed) continue;
			progressed = true;
			spawnSubmissionTask(claimed);
		}
		return progressed;
	}
	/**
	* Persistent claim loop. Runs for the lifetime of the coordinator.
	* Woken by admissions and submission settlements.
	*
	* The wake mechanism has two modes:
	* - **Flag mode** (`claimPassRunning = true`): `wake()` sets `wakeRequested`
	*   so the current pass re-checks after finishing.
	* - **Promise mode** (`claimPassRunning = false`): `wake()` resolves the
	*   sleep promise to start a new pass.
	*
	* To avoid losing wakes in the transition between modes, the sleep
	* promise is reset BEFORE `claimPassRunning` is cleared, and
	* `wakeRequested` is checked after clearing the flag.
	*/
	async function claimLoop() {
		while (!stopping) {
			claimPassRunning = true;
			try {
				let progressed;
				do {
					wakeRequested = false;
					progressed = await runClaimPass();
				} while (progressed || wakeRequested);
			} catch (error) {
				console.error("[flue:claim-loop] Error in claim pass, retrying:", error);
				await new Promise((r) => setTimeout(r, 1e3));
				wakeRequested = true;
			} finally {
				resetWakePromise();
				claimPassRunning = false;
			}
			if (wakeRequested) {
				wakeRequested = false;
				continue;
			}
			await wakePromise;
		}
	}
	/** Start the claim loop and lease heartbeat if not already running. */
	function ensureClaimLoop() {
		if (loopRunning) return;
		loopRunning = true;
		claimLoop().catch((error) => {
			console.error("[flue:claim-loop] Fatal error in claim loop:", error);
			loopRunning = false;
		});
		if (!heartbeatInterval) {
			heartbeatInterval = setInterval(() => {
				const ids = [...activeSubmissions.keys()];
				if (ids.length === 0) return;
				submissions.renewLeases(ownerId, ids).catch((error) => {
					console.error("[flue:lease-heartbeat] Failed to renew leases:", error);
				});
			}, 1e4);
			if (typeof heartbeatInterval === "object" && "unref" in heartbeatInterval) heartbeatInterval.unref();
		}
		if (!leaseScanInterval) {
			leaseScanInterval = setInterval(() => wake(), LEASE_SCAN_INTERVAL_MS);
			if (typeof leaseScanInterval === "object" && "unref" in leaseScanInterval) leaseScanInterval.unref();
		}
	}
	/** Interval (ms) between periodic expired-lease scans in the claim loop. */
	const LEASE_SCAN_INTERVAL_MS = 15e3;
	/** Timestamp of the last expired-lease scan. */
	let lastLeaseScanAt = 0;
	/**
	* Check for expired leases periodically during the claim loop. This
	* catches submissions stranded when a replacement process starts before
	* the old process's 30s lease expires. Without this, `reconcileSubmissions`
	* at startup would miss still-leased submissions and they'd be stranded
	* until the next full restart after the lease expires.
	*/
	async function periodicLeaseScan() {
		const now = Date.now();
		if (now - lastLeaseScanAt < LEASE_SCAN_INTERVAL_MS) return;
		lastLeaseScanAt = now;
		await reconcileRunningSubmissions();
	}
	/** In-flight expired-lease reconciliation pass, if any. */
	let reconcilePassInFlight = null;
	/**
	* Reconcile submissions whose leases have expired. Single-flight:
	* concurrent callers share one pass instead of running two. Without
	* this, startup's `reconcileSubmissions()` and the claim loop's first
	* `periodicLeaseScan` (started by `ensureClaimLoop` just before the
	* direct call) would each list the same expired submissions and run
	* `reconcileInterruptedSubmission` twice per submission with
	* independent fresh Sessions — the attempt-replacement CAS picks one
	* winner, and the loser can append a spurious interruption advisory
	* to session history before its settlement CAS is rejected.
	*/
	function reconcileRunningSubmissions() {
		reconcilePassInFlight ??= runReconciliationPass().finally(() => {
			reconcilePassInFlight = null;
		});
		return reconcilePassInFlight;
	}
	async function reconcileUnreadySubmissions() {
		for (const submission of await submissions.listUnreadySubmissions()) {
			const agent = agents.find((record) => record.name === submission.input.agent)?.definition;
			if (!agent) {
				console.error("[flue:submission-reconciliation]", {
					submissionId: submission.submissionId,
					operation: "materialize_submission",
					outcome: "agent_unavailable"
				});
				continue;
			}
			try {
				await materializeSubmissionConversation(submission.input, agent);
				await submissions.markSubmissionCanonicalReady(submission.submissionId);
			} catch (error) {
				console.error("[flue:submission-reconciliation]", {
					submissionId: submission.submissionId,
					operation: "materialize_submission",
					outcome: "failed"
				}, error);
			}
		}
	}
	async function runReconciliationPass() {
		await reconcileUnreadySubmissions();
		for (const settlement of await submissions.listPendingSubmissionSettlements()) {
			const submission = await submissions.getSubmission(settlement.submissionId);
			if (!submission || submission.kind !== "direct") continue;
			if (activeSubmissions.has(submission.submissionId) || submission.leaseExpiresAt > Date.now()) continue;
			const writer = await getConversationWriter(submission.input);
			if (!writer) continue;
			const attempt = {
				submissionId: settlement.submissionId,
				attemptId: settlement.attemptId
			};
			const canonical = await writer.getRecord(settlement.recordId);
			if (!canonical) await writer.append([settlement.record], { submission: attempt });
			else if (JSON.stringify(canonical) !== JSON.stringify(settlement.record)) throw new Error("[flue] Pending settlement does not match its canonical record. Clear incompatible beta persistence.");
			if (await submissions.finalizeSubmissionSettlement(attempt, settlement.recordId)) {
				if (settlement.record.outcome === "completed") observers.complete(settlement.submissionId, settlement.record.result);
				if (settlement.record.outcome === "failed") {
					const error = settlement.record.error;
					observers.fail(settlement.submissionId, new Error(error?.message ?? "Agent submission failed."));
				}
			}
		}
		for (const submission of await submissions.listExpiredSubmissions()) {
			if (activeSubmissions.has(submission.submissionId)) continue;
			const agentName = submission.input.agent;
			const agent = agents.find((record) => record.name === agentName)?.definition;
			if (!agent) {
				console.error("[flue:submission-reconciliation]", {
					submissionId: submission.submissionId,
					operation: "reconcile_submission",
					outcome: "agent_unavailable"
				});
				continue;
			}
			try {
				const conversationWriter = await getConversationWriter(submission.input);
				const reconciled = await reconcileInterruptedSubmission(submissions, submission, agent, makeSubmissionContext(submission.input, conversationWriter), {
					ownerId,
					leaseExpiresAt: Date.now() + LEASE_DURATION_MS
				}, conversationWriter);
				if (reconciled.disposition === "replacement") spawnSubmissionTask(reconciled.submission);
				else if (submission.kind === "direct") {
					if (reconciled.disposition === "completed") observers.complete(submission.submissionId, reconciled.result);
					else if (reconciled.disposition === "failed") observers.fail(submission.submissionId, reconciled.error);
				}
			} catch (error) {
				console.error("[flue:submission-reconciliation]", {
					submissionId: submission.submissionId,
					operation: "reconcile_submission",
					outcome: "failed"
				}, error);
			}
		}
	}
	return {
		async reconcileSubmissions() {
			if (!await submissions.hasUnsettledSubmissions()) return;
			await reconcileUnreadySubmissions();
			ensureClaimLoop();
			await reconcileRunningSubmissions();
			await this.waitForIdle();
		},
		async admitDispatch(input) {
			if (stopping) throw new Error("[flue] Coordinator is shutting down.");
			const activityLease = activityGate?.enter();
			try {
				const agent = agents.find((record) => record.name === input.agent)?.definition;
				if (!agent) throw new Error(`[flue] dispatch target agent "${input.agent}" has no agent definition.`);
				const admission = await submissions.admitDispatch(input);
				if (admission.kind !== "submission") {
					activityLease?.release();
					return admission;
				}
				let submission = admission.submission;
				if (submission.canonicalReadyAt === null) {
					await materializeSubmissionConversation(createDispatchAgentSubmissionInput(input), agent);
					submission = await submissions.markSubmissionCanonicalReady(submission.submissionId) ?? submission;
				}
				if (activityLease) activityLeases.set(submission.submissionId, activityLease);
				ensureClaimLoop();
				wake();
				return {
					kind: "submission",
					submission
				};
			} catch (error) {
				activityLease?.release();
				throw error;
			}
		},
		async abortInstance(_agentName, instanceId) {
			const sessionKey = createSessionStorageKey(instanceId, SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME);
			const affected = await submissions.requestSessionAbort(sessionKey);
			if (affected.length === 0) return false;
			let hasInactive = false;
			for (const submissionId of affected) {
				const active = activeSubmissions.get(submissionId);
				if (active) active.abort.abort(new SubmissionAbortedError());
				else hasInactive = true;
			}
			ensureClaimLoop();
			wake();
			if (hasInactive) reconcileRunningSubmissions().catch((error) => {
				console.error("[flue:submission-abort] reconcile after abort failed:", error);
			});
			return true;
		},
		createAdmission(agentName, instanceId) {
			return async (payload, onEvent, waitForResult, traceCarrier) => {
				waitForResult ??= true;
				if (stopping) throw new Error("[flue] Coordinator is shutting down.");
				const activityLease = activityGate?.enter();
				const agent = agents.find((record) => record.name === agentName)?.definition;
				if (!agent) {
					activityLease?.release();
					throw new Error(`[flue] direct prompt target agent "${agentName}" has no agent definition.`);
				}
				const input = createDirectAgentSubmissionInput({
					agent: agentName,
					id: instanceId,
					payload,
					traceCarrier
				});
				const attachment = observers.attach(input.submissionId, { onEvent });
				try {
					if ((await submissions.admitDirect(input)).canonicalReadyAt === null) {
						await materializeSubmissionConversation(input, agent);
						if (!await submissions.markSubmissionCanonicalReady(input.submissionId)) throw new Error("[flue] Direct admission disappeared before canonical readiness.");
					}
					const offset = (await getConversationWriter(input))?.offset ?? "-1";
					if (activityLease) activityLeases.set(input.submissionId, activityLease);
					ensureClaimLoop();
					wake();
					if (!waitForResult) return {
						submissionId: input.submissionId,
						offset
					};
					return {
						submissionId: input.submissionId,
						offset,
						result: await attachment.completion
					};
				} catch (error) {
					activityLease?.release();
					observers.fail(input.submissionId, error);
					throw error;
				} finally {
					attachment.detach();
				}
			};
		},
		async waitForIdle() {
			while (true) {
				if (stopping) return;
				if (activeSubmissions.size > 0) await Promise.allSettled([...activeSubmissions.values()].map((s) => s.task));
				if (stopping) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
				if (activeSubmissions.size === 0) {
					if ((await submissions.listRunnableSubmissions()).length === 0) break;
					if (stopping) return;
					wake();
				}
			}
		},
		async shutdown(timeoutMs = 3e4) {
			if (stopping) return;
			stopping = true;
			wake();
			for (const { abort } of activeSubmissions.values()) abort.abort(new DOMException("Coordinator shutting down.", "AbortError"));
			if (activeSubmissions.size > 0) {
				const settlement = Promise.allSettled([...activeSubmissions.values()].map((s) => s.task));
				const timeout = new Promise((resolve) => {
					const timer = setTimeout(resolve, timeoutMs);
					settlement.finally(() => clearTimeout(timer));
				});
				await Promise.race([settlement, timeout]);
			}
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
			if (leaseScanInterval) {
				clearInterval(leaseScanInterval);
				leaseScanInterval = null;
			}
			if (activeSubmissions.size > 0) {
				const abandoned = [...activeSubmissions.keys()];
				console.error(`[flue:shutdown] ${abandoned.length} submission(s) did not settle within ${timeoutMs}ms and will be reclaimed on next startup:`, abandoned);
			}
		}
	};
}
//#endregion
//#region src/node/run-store.ts
/** In-memory `RunStore` for explicitly non-durable (no-database) setups. */
var InMemoryRunStore = class {
	runs = /* @__PURE__ */ new Map();
	async createRun(input) {
		if (this.runs.has(input.runId)) return;
		this.runs.set(input.runId, {
			runId: input.runId,
			workflowName: input.workflowName,
			status: "active",
			startedAt: input.startedAt,
			input: input.input,
			traceCarrier: input.traceCarrier
		});
	}
	async endRun(input) {
		const existing = await this.getRun(input.runId);
		if (!existing) return;
		this.runs.set(input.runId, {
			...existing,
			status: input.isError ? "errored" : "completed",
			endedAt: input.endedAt,
			isError: input.isError,
			durationMs: input.durationMs,
			result: input.result,
			error: input.error
		});
	}
	async getRun(runId) {
		return this.runs.get(runId) ?? null;
	}
	async lookupRun(runId) {
		const record = this.runs.get(runId);
		return record ? {
			runId: record.runId,
			workflowName: record.workflowName
		} : null;
	}
	async listRuns(opts = {}) {
		const limit = clampLimit(opts.limit, 100, MAX_LIST_LIMIT);
		const cursor = decodeRunCursor(opts.cursor);
		const all = [...this.runs.values()].filter((record) => matchesListFilter(record, opts)).sort(compareRecordsDesc).map(recordToPointer);
		const startIndex = cursor ? all.findIndex((pointer) => isAfterCursor(pointer, cursor)) : 0;
		if (startIndex === -1) return { runs: [] };
		const page = all.slice(startIndex, startIndex + limit);
		const last = page.at(-1);
		return {
			runs: page,
			nextCursor: startIndex + limit < all.length && last ? encodeRunCursor(last) : void 0
		};
	}
};
function recordToPointer(record) {
	return {
		runId: record.runId,
		workflowName: record.workflowName,
		status: record.status,
		startedAt: record.startedAt,
		...record.endedAt !== void 0 ? { endedAt: record.endedAt } : {},
		...record.durationMs !== void 0 ? { durationMs: record.durationMs } : {},
		...record.isError !== void 0 ? { isError: record.isError } : {}
	};
}
function matchesListFilter(record, opts) {
	if (opts.status && record.status !== opts.status) return false;
	if (opts.workflowName && record.workflowName !== opts.workflowName) return false;
	return true;
}
function compareRecordsDesc(a, b) {
	const byStarted = b.startedAt.localeCompare(a.startedAt);
	if (byStarted !== 0) return byStarted;
	return b.runId.localeCompare(a.runId);
}
function isAfterCursor(pointer, cursor) {
	if (pointer.startedAt < cursor.startedAt) return true;
	if (pointer.startedAt > cursor.startedAt) return false;
	return pointer.runId < cursor.runId;
}
//#endregion
//#region src/runtime/dev-lifecycle-logger.ts
function installDevLifecycleLogger(write = console.log) {
	const workflowNames = /* @__PURE__ */ new Map();
	return {
		onAgentInteractionStart(interaction) {
			write(`[agent] ${interaction.agentName}@${interaction.instanceId} started`);
		},
		dispose: observe((event) => {
			if (event.type === "run_start" || event.type === "run_resume") {
				workflowNames.set(event.runId, event.workflowName);
				write(`[workflow] ${event.workflowName}@${event.runId} ${event.type === "run_start" ? "started" : "resumed"}`);
				return;
			}
			if (event.type !== "run_end") return;
			const workflowName = workflowNames.get(event.runId);
			workflowNames.delete(event.runId);
			const subject = workflowName ? `${workflowName}@${event.runId}` : event.runId;
			write(event.isError ? `[workflow] ${subject} failed in ${event.durationMs}ms` : `[workflow] ${subject} completed in ${event.durationMs}ms`);
		})
	};
}
//#endregion
//#region src/runtime/runtime-activity-gate.ts
function createRuntimeActivityGate() {
	let isPaused = false;
	let active = 0;
	let idleWaiters = [];
	function releaseIdleWaiters() {
		if (active !== 0) return;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiters) resolve();
	}
	return {
		enter() {
			if (isPaused) throw new RuntimeUnavailableError({ state: "draining" });
			active += 1;
			let released = false;
			return { release() {
				if (released) return;
				released = true;
				active -= 1;
				releaseIdleWaiters();
			} };
		},
		pause() {
			isPaused = true;
		},
		waitForIdle() {
			if (active === 0) return Promise.resolve();
			return new Promise((resolve) => idleWaiters.push(resolve));
		}
	};
}
//#endregion
//#region src/internal.ts
/**
* Internal runtime helpers consumed by the generated server entry point.
*
* This subpath is NOT part of the public API. It exists solely so the build
* plugins (Node, Cloudflare) can emit stable bare-specifier imports that
* resolve through normal package-exports resolution at both build time and
* runtime, for both workspace-linked and published-npm installs.
*
* User agent code should never import from here.
*/
/**
* Resolve a `provider-id/model-id` model specifier to a pi-ai Model.
* Registered provider IDs win over pi-ai's catalog; registrations for
* catalog provider IDs hydrate metadata from the catalog with the
* registration's options layered on top.
*/
function resolveModel(model) {
	const modelSpecifier = model;
	const slash = modelSpecifier.indexOf("/");
	if (slash === -1) throw new Error(`[flue] Invalid model specifier "${modelSpecifier}". Use the "provider-id/model-id" format (e.g. "anthropic/claude-haiku-4-5").`);
	const providerId = modelSpecifier.slice(0, slash);
	const modelId = modelSpecifier.slice(slash + 1);
	const registered = resolveRegisteredModel(providerId, modelId);
	if (registered) {
		if (modelId === "") throw new Error(`[flue] Invalid model specifier "${modelSpecifier}". Provider ID "${providerId}" is registered via registerProvider(), but no model ID was given. Use "${providerId}/<model-id>".`);
		return registered;
	}
	const resolved = getModel(providerId, modelId);
	if (!resolved) throw new Error(`[flue] Unknown model specifier "${modelSpecifier}". Provider ID "${providerId}" / model ID "${modelId}" is not registered with @earendil-works/pi-ai or via registerProvider().`);
	return resolved;
}
//#endregion
export { Bash, CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH, InMemoryAttachmentStore, InMemoryConversationStreamStore, InMemoryFs, InMemoryRunStore, RuntimeUnavailableError, SqliteConversationStreamStore, SqliteEventStreamStore, admitDetachedWorkflow, assertWorkflowDefinition, bashFactoryToSessionEnv, buildPackagedSkill, configureFlueRuntime, createCloudflareAgentRuntime, createDefaultFlueApp, createFlueContext, createInstrumentationOwner, createNodeAgentCoordinator, createNodeDispatchQueue, createRuntimeActivityGate, createSkillReference, createSqlConversationStores, createSqlRunStore, failRecoveredRun, generateWorkflowRunId, handleAgentConversationHead, handleAgentConversationRead, handleRunRouteRequest, handleStreamHead, handleStreamRead, handleWorkflowRequest, hasRegisteredProvider, initializeRootHarness, installDevLifecycleLogger, invokeDirectAttached, invokeWorkflowAttached, parseSkillMarkdown, resetProviderRuntime, resolveModel, runWithInstrumentationOwner, toHttpResponse };
