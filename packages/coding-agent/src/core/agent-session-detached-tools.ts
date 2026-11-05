import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@bastani/pi-ai/compat";
import type {
	AfterToolCallResult,
	AgentEvent,
	AgentMessage,
	AgentTool,
	AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { deliverHeldTaskCompletions } from "./agent-session-tasks.js";
import { finalizeToolResult } from "./agent-session-tool-hooks.ts";
import type { ExtensionToolContext } from "./extensions/context-types.ts";
import { sessionGenerationClosing, trackSessionWork } from "./session-lifecycle-work.ts";
import { MAX_TOOL_DETACHMENT_AFTER_MS, ToolDetachmentError } from "./tool-detachment-errors.ts";
import {
	resolveToolConcurrency,
	type ToolConcurrencyMode,
	type ToolExecutionScheduler,
} from "./tools/tool-concurrency.ts";

/** How long a call of a `detachable` tool runs inline before the session lets it go on without the session. */
export interface ToolDetachmentPolicy {
	/** Milliseconds a detachable call may run inline; a call still running after that detaches. */
	readonly afterMs: number;
}

/** The outcome of a detached tool call, in the shape the agent loop records as that call's result. */
export interface DetachedToolResult {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly result: AgentToolResult;
	readonly isError: boolean;
}

/** A tool call that outlived the run that issued it. */
export interface DetachedToolCall {
	readonly toolCallId: string;
	readonly toolName: string;
	/** Settles once the operation ends. Never rejects: a thrown error becomes an `isError` result. */
	readonly result: Promise<DetachedToolResult>;
	/** Cancel the operation; `reason` reaches the tool through its abort signal. */
	abort(reason?: Error | DOMException | string): void;
}

interface DetachmentState {
	policy: ToolDetachmentPolicy | undefined;
	/** Calls detached by the session's runs and not yet taken by the host. */
	readonly detached: Map<string, DetachedToolCall>;
	/** How each detachable tool's work starts, by tool name. */
	readonly executes: Map<string, DetachableExecute>;
	readonly concurrency: Map<string, AgentTool["concurrency"]>;
	/** For a tool that detaches only some of its calls, which ones, by tool name. */
	readonly detachesCall: Map<string, DetachesCall>;
}

const states = new WeakMap<object, DetachmentState>();

const DETACHED_PLACEHOLDER_TEXT =
	"This tool call continues after the run ends; its result is recorded when it arrives.";

function detachmentState(session: AgentSession): DetachmentState {
	let state = states.get(session);
	if (state === undefined) {
		state = {
			policy: undefined,
			detached: new Map(),
			executes: new Map(),
			concurrency: new Map(),
			detachesCall: new Map(),
		};
		states.set(session, state);
	}
	return state;
}

export function isDetachedToolCall(session: AgentSession, toolCallId: string): boolean {
	return states.get(session)?.detached.has(toolCallId) === true;
}

/** Whether `toolCallId` is a call of the assistant message the loop is executing, not a call nested inside a tool. */
function isTopLevelToolCall(session: AgentSession, toolCallId: string): boolean {
	const messages = session.agent.state.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return message.content.some((part) => part.type === "toolCall" && part.id === toolCallId);
	}
	return false;
}

function errorToolResult(error: Error | DOMException | string | object): AgentToolResult {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: undefined,
	};
}

/**
 * Runs a callback in the async context of this module's load, outside every session. A detachable call's work and
 * every reaction waiting on it start here: a promise reaction keeps the async context it was created in alive, so work
 * started inside a session would keep that session reachable for as long as the call runs.
 */
const outsideAnySession = AsyncLocalStorage.snapshot();

type ToolParams = Parameters<AgentTool["execute"]>[1];
type ToolUpdate = Parameters<AgentTool["execute"]>[3];

/**
 * Starts a detachable call's work directly on its tool definition, outside the session's tool wrappers: a wrapper
 * awaiting the work would hold the session's extension runner for as long as the call waits.
 */
export type DetachableExecute = (
	toolCallId: string,
	params: ToolParams,
	signal: AbortSignal,
	onUpdate: ToolUpdate,
	context: ExtensionToolContext,
) => ReturnType<AgentTool["execute"]>;

/** The session's tool context for a call that runs inline, bound to the call's own abort signal. */
export type DetachableContext = (toolCallId: string, signal: AbortSignal) => ExtensionToolContext;

/** Whether one call of a tool may detach, decided from the call's arguments. */
export type DetachesCall = (params: ToolParams) => boolean;

/**
 * What a detachable call's work reaches of its session, only while the call runs inline. Detaching clears it, so
 * the work keeps neither the agent loop nor the session's context reachable for as long as it goes on.
 */
interface InlineSession {
	onUpdate: ToolUpdate;
	context: ExtensionToolContext | undefined;
}

/** Session-free facts a detached call's context still answers. */
interface DetachedCallFacts {
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly cwd: string;
}

/*
 * The helpers below are module-level on purpose. A closure keeps every scope it is nested in, so a reaction created
 * inside a function that can see the session would keep the session reachable while the call waits.
 */

function startOperation(
	toolName: string,
	execute: DetachableExecute,
	params: ToolParams,
	inline: InlineSession,
	facts: DetachedCallFacts,
	createContext: DetachableContext | undefined,
	start?: Promise<void>,
): { readonly call: DetachedToolCall; readonly settled: Promise<AgentToolResult> } {
	return outsideAnySession(() => {
		const controller = new AbortController();
		if (createContext !== undefined) inline.context = createContext(facts.toolCallId, controller.signal);
		const onUpdate = inline.onUpdate === undefined ? undefined : forwardedUpdate(inline);
		const context = callContext(inline, facts);
		const settled = invokeDetached(execute, facts.toolCallId, params, controller.signal, onUpdate, context, start);
		return { settled, call: detachedCall(toolName, facts.toolCallId, settled, controller) };
	});
}

function invokeDetached(
	execute: DetachableExecute,
	toolCallId: string,
	params: ToolParams,
	signal: AbortSignal,
	onUpdate: ToolUpdate,
	context: ExtensionToolContext,
	start: Promise<void> = Promise.resolve(),
): Promise<AgentToolResult> {
	return start.then(() => execute(toolCallId, params, signal, onUpdate, context));
}

/** Progress a call reports reaches the agent loop while the call runs inline; once it detaches, it is dropped. */
function forwardedUpdate(inline: InlineSession): NonNullable<ToolUpdate> {
	return (partialResult) => inline.onUpdate?.(partialResult);
}

/**
 * The context a detachable call's work receives: the session's tool context while the call runs inline. Once the call
 * detaches it answers only `cwd`, and any other use throws {@link ToolDetachmentError} `context-detached`.
 */
function callContext(inline: InlineSession, facts: DetachedCallFacts): ExtensionToolContext {
	return new Proxy({} as ExtensionToolContext, {
		get(_target, key) {
			const live = inline.context;
			if (live !== undefined) return Reflect.get(live, key);
			if (key === "cwd") return facts.cwd;
			// Not a thenable, and nothing for inspection to find.
			if (key === "then" || typeof key === "symbol") return undefined;
			throw new ToolDetachmentError("context-detached", {
				sessionId: facts.sessionId,
				toolCallId: facts.toolCallId,
			});
		},
		has(_target, key) {
			const live = inline.context;
			return live === undefined ? key === "cwd" : Reflect.has(live, key);
		},
	});
}

function detachedCall(
	toolName: string,
	toolCallId: string,
	settled: Promise<AgentToolResult>,
	controller: AbortController,
): DetachedToolCall {
	const result = settled.then(
		(value): DetachedToolResult => ({ toolCallId, toolName, result: value, isError: value.isError === true }),
		(error: Error | DOMException | string | object): DetachedToolResult => ({
			toolCallId,
			toolName,
			result: errorToolResult(error),
			isError: true,
		}),
	);
	return { toolCallId, toolName, result, abort: (reason) => controller.abort(reason) };
}

/** Resolve `gate` with INLINE once the work settles, from outside every session. */
function openGateWhenSettled(settled: Promise<AgentToolResult>, gate: { resolve(value: symbol): void }): void {
	outsideAnySession(() => {
		settled.then(
			() => gate.resolve(INLINE),
			() => gate.resolve(INLINE),
		);
	});
}

const INLINE = Symbol("inline");
const DETACH = Symbol("detach");

interface SchedulerPermit {
	readonly grantedLater: Promise<void> | undefined;
	release(): void;
}

function takeSchedulerPermit(scheduler: ToolExecutionScheduler, mode: ToolConcurrencyMode): SchedulerPermit {
	return outsideAnySession(() => {
		const granted = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		let grantedNow = false;
		void scheduler.schedule(mode, () => {
			grantedNow = true;
			granted.resolve();
			return held.promise;
		});
		return { grantedLater: grantedNow ? undefined : granted.promise, release: () => held.resolve() };
	});
}

function releaseWhenSettled(settled: Promise<AgentToolResult>, permit: SchedulerPermit): void {
	outsideAnySession(() => {
		settled.then(
			() => permit.release(),
			() => permit.release(),
		);
	});
}

/** Forget the session's detachable tools before its tools are registered again, so a removed tool is not one. */
export function forgetDetachableTools(session: AgentSession): void {
	states.get(session)?.executes.clear();
	states.get(session)?.concurrency.clear();
	states.get(session)?.detachesCall.clear();
}

/**
 * Run a call of a detachable tool inline until the session's detachment policy elapses, then let it go on without
 * the run. The loop then records a placeholder that never reaches the transcript, listeners, or the provider, and
 * the run ends after its turn so the host can release the session and hand the result back later.
 *
 * The call keeps its declared concurrency: it starts once the calls before it in the session's scheduler allow, and
 * it holds its place there until its work settles, also after it detaches, so an exclusive call never overlaps another
 * call of the session.
 */
export function detachableTool(
	session: AgentSession,
	tool: AgentTool,
	execute: DetachableExecute,
	createContext: DetachableContext,
	detachesCall?: DetachesCall,
): AgentTool {
	const state = detachmentState(session);
	state.executes.set(tool.name, execute);
	state.concurrency.set(tool.name, tool.concurrency);
	if (detachesCall !== undefined) state.detachesCall.set(tool.name, detachesCall);
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const policy = state.policy;
			if (policy === undefined || !isTopLevelToolCall(session, toolCallId) || detachesCall?.(params) === false)
				return tool.execute(toolCallId, params, signal, onUpdate);
			const permit = takeSchedulerPermit(
				session._toolExecutionScheduler,
				resolveToolConcurrency(tool.concurrency, params as Record<string, unknown>),
			);
			if (permit.grantedLater !== undefined) await permit.grantedLater;
			const inline: InlineSession = { onUpdate, context: undefined };
			let operation: ReturnType<typeof startOperation>;
			try {
				operation = startOperation(
					tool.name,
					execute,
					params,
					inline,
					detachedCallFacts(session, toolCallId),
					createContext,
				);
			} catch (error) {
				permit.release();
				throw error;
			}
			const { call, settled } = operation;
			releaseWhenSettled(settled, permit);
			const forwardAbort = (): void => call.abort(signal?.reason);
			if (signal?.aborted) forwardAbort();
			else signal?.addEventListener("abort", forwardAbort, { once: true });
			// The run waits on this gate alone: it settles at the threshold even while the call goes on, so no reaction
			// created in the run's context stays on the call once it detaches.
			const gate = Promise.withResolvers<symbol>();
			openGateWhenSettled(settled, gate);
			const timer = setTimeout(() => gate.resolve(DETACH), policy.afterMs);
			try {
				if ((await gate.promise) === INLINE) return await settled;
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", forwardAbort);
			}
			inline.onUpdate = undefined;
			inline.context = undefined;
			state.detached.set(toolCallId, call);
			return {
				content: [{ type: "text", text: DETACHED_PLACEHOLDER_TEXT }],
				details: undefined,
				terminate: true,
			};
		},
	};
}

function detachedCallFacts(session: AgentSession, toolCallId: string): DetachedCallFacts {
	return { sessionId: session.sessionManager.getSessionId(), toolCallId, cwd: session._cwd };
}

function isDetachedPlaceholder(detached: ReadonlyMap<string, DetachedToolCall>, message: AgentMessage): boolean {
	return message.role === "toolResult" && detached.has((message as ToolResultMessage).toolCallId);
}

/**
 * The placeholder a detached call leaves in the loop is no tool result: drop its events, take it out of the live
 * transcript, and leave it out of the turn and run summaries. Returns the event to process, or `undefined`.
 */
export function withoutDetachedPlaceholders(session: AgentSession, event: AgentEvent): AgentEvent | undefined {
	const detached = states.get(session)?.detached;
	if (detached === undefined || detached.size === 0) return event;
	switch (event.type) {
		case "tool_execution_end":
			return detached.has(event.toolCallId) ? undefined : event;
		case "message_start":
			return isDetachedPlaceholder(detached, event.message) ? undefined : event;
		case "message_end": {
			if (!isDetachedPlaceholder(detached, event.message)) return event;
			// Agent-core appended the placeholder to its live transcript before notifying listeners.
			const messages = session.agent.state.messages;
			const index = messages.lastIndexOf(event.message);
			if (index >= 0) messages.splice(index, 1);
			return undefined;
		}
		case "turn_end": {
			const toolResults = event.toolResults.filter((result) => !detached.has(result.toolCallId));
			return toolResults.length === event.toolResults.length ? event : { ...event, toolResults };
		}
		case "agent_end": {
			const messages = event.messages.filter((message) => !isDetachedPlaceholder(detached, message));
			return messages.length === event.messages.length ? event : { ...event, messages };
		}
		default:
			return event;
	}
}

export function setToolDetachment(this: AgentSession, policy: ToolDetachmentPolicy | undefined): void {
	if (
		policy !== undefined &&
		!(Number.isFinite(policy.afterMs) && policy.afterMs >= 0 && policy.afterMs <= MAX_TOOL_DETACHMENT_AFTER_MS)
	)
		throw new ToolDetachmentError("invalid-policy", {
			sessionId: this.sessionManager.getSessionId(),
			field: "afterMs",
			value: String(policy.afterMs),
		});
	detachmentState(this).policy = policy === undefined ? undefined : { afterMs: policy.afterMs };
}

export function takeDetachedToolCalls(this: AgentSession): DetachedToolCall[] {
	const detached = states.get(this)?.detached;
	if (detached === undefined) return [];
	const calls = [...detached.values()];
	detached.clear();
	return calls;
}

/** A call of a detachable tool in the transcript, with how its tool's work starts in this session. */
interface DetachableCall {
	readonly toolCall: ToolCall;
	readonly execute: DetachableExecute;
}

/**
 * The last assistant message of the transcript, the calls of detachable tools it is still waiting on, and whether that
 * message issued a detachable call at all: a transcript that ends on such a turn has not had the model's answer yet.
 * A tool is detachable in this session when the session registered how its work starts.
 */
function pendingDetachableCalls(session: AgentSession): {
	readonly assistant: AssistantMessage | undefined;
	readonly calls: readonly DetachableCall[];
	readonly endsOnDetachableTurn: boolean;
} {
	const none = { assistant: undefined, calls: [], endsOnDetachableTurn: false };
	const messages = session.sessionManager.buildSessionProjection().messages;
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role !== "assistant") index--;
	const assistant = messages[index] as AssistantMessage | undefined;
	if (assistant?.stopReason !== "toolUse") return none;
	const later = messages.slice(index + 1);
	// A later turn already moved past the call; only a transcript that ends on it is waiting.
	if (later.some((message) => message.role === "user" || message.role === "assistant")) return none;
	const answered = new Set(
		later.flatMap((message) => (message.role === "toolResult" ? [(message as ToolResultMessage).toolCallId] : [])),
	);
	const state = states.get(session);
	const detachable = assistant.content.flatMap((block): DetachableCall[] => {
		if (block.type !== "toolCall") return [];
		const execute = state?.executes.get(block.name);
		if (execute === undefined) return [];
		if (state?.detachesCall.get(block.name)?.(block.arguments as ToolParams) === false) return [];
		return [{ toolCall: block as ToolCall, execute }];
	});
	return {
		assistant,
		calls: detachable.filter(({ toolCall }) => !answered.has(toolCall.id)),
		endsOnDetachableTurn: detachable.length > 0,
	};
}

/**
 * Whether the transcript ends on a turn that issued a detachable call and has no answer from the model yet, with or
 * without its results: a session reopened after its process died continues that turn instead of being prompted again.
 */
export function hasPendingDetachedTurn(this: AgentSession): boolean {
	return pendingDetachableCalls(this).endsOnDetachableTurn;
}

/**
 * Whether the transcript ends on a turn still waiting for the result of a call of a detachable tool. Nothing may come
 * between such a call and its result, so input that would land there waits until the turn resumes.
 */
export function waitsOnDetachedResults(session: AgentSession): boolean {
	if (!states.get(session)?.executes.size) return false;
	return pendingDetachableCalls(session).calls.length > 0;
}

/**
 * Start again every call of a detachable tool that the transcript ends on without a result: the process that ran
 * them is gone. Each runs with its original id and arguments, so a call may run more than once. The work runs
 * detached from the start: it reports no progress and its context answers only `cwd`.
 */
export function redispatchDetachedToolCalls(this: AgentSession): DetachedToolCall[] {
	const concurrency = states.get(this)?.concurrency;
	return pendingDetachableCalls(this).calls.map(({ toolCall, execute }) => {
		this._reissuedToolCallIds.add(toolCall.id);
		const inline: InlineSession = { onUpdate: undefined, context: undefined };
		const facts = detachedCallFacts(this, toolCall.id);
		const params = toolCall.arguments as ToolParams;
		const permit = takeSchedulerPermit(
			this._toolExecutionScheduler,
			resolveToolConcurrency(concurrency?.get(toolCall.name), params as Record<string, unknown>),
		);
		const { call, settled } = startOperation(
			toolCall.name,
			execute,
			params,
			inline,
			facts,
			undefined,
			permit.grantedLater,
		);
		releaseWhenSettled(settled, permit);
		return call;
	});
}

function resultMessage(result: DetachedToolResult): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: result.toolCallId,
		toolName: result.toolName,
		content: result.result.content,
		details: result.result.details,
		...(result.result.usage === undefined ? {} : { usage: result.result.usage }),
		isError: result.isError,
		timestamp: Date.now(),
	};
}

/** A result with what the session's finalization replaced, merged the way the agent loop merges an inline call's. */
function withReplacement(
	detached: DetachedToolResult,
	replacement: AfterToolCallResult | undefined,
): DetachedToolResult {
	if (replacement === undefined) return detached;
	const { structuredContent: reported, ...rest } = detached.result;
	// Structured content not replaced along with the content may no longer match it.
	const structuredContent = replacement.structuredContent ?? (replacement.content ? undefined : reported);
	return {
		...detached,
		result: {
			...rest,
			content: replacement.content ?? rest.content,
			details: (replacement.details ?? rest.details) as AgentToolResult["details"],
			usage: replacement.usage ?? rest.usage,
			...(structuredContent === undefined ? {} : { structuredContent }),
		},
		isError: replacement.isError ?? detached.isError,
	};
}

/** A detached call's result as it enters history: finalized exactly as the result of an inline call is. */
async function finalizedResult(
	session: AgentSession,
	toolCall: ToolCall,
	reported: DetachedToolResult,
): Promise<DetachedToolResult> {
	// A result handed back across a process boundary may omit its content, as an untyped tool's may.
	const detached = { ...reported, result: { ...reported.result, content: reported.result.content ?? [] } };
	try {
		const replacement = await finalizeToolResult(session, {
			toolCall,
			args: toolCall.arguments,
			result: detached.result,
			isError: detached.isError,
			parentToolCallId: undefined,
			releasedStage: true,
		});
		return withReplacement(detached, replacement);
	} catch (error) {
		// As the agent loop does when an inline call's finalization throws: the call fails with that error.
		return { ...detached, result: errorToolResult(error as Error | string | object), isError: true };
	}
}

/**
 * Wait for the save of a result the session just recorded. A save that failed fails the continuation, which rejects
 * with it; the session's event queue goes on past it, as it does past a failed save inside the agent loop, so the
 * session's later barriers and its disposal do not report the same failure again.
 */
async function resultSaved(session: AgentSession): Promise<void> {
	const queue = session._agentEventQueue;
	try {
		await queue;
	} catch (error) {
		if (session._agentEventQueue === queue) session._agentEventQueue = queue.catch(() => {});
		throw error;
	}
}

/** A new result and the call of the pending turn it answers. */
interface Answer {
	readonly toolCall: ToolCall;
	readonly result: DetachedToolResult;
}

/** Record each answer as its call's result, in the order given, and refresh the session's context from them. */
async function recordAnswers(session: AgentSession, answers: readonly Answer[]): Promise<void> {
	for (const answer of answers) session._reissuedToolCallIds.add(answer.result.toolCallId);
	try {
		for (const answer of answers) {
			const result = await finalizedResult(session, answer.toolCall, answer.result);
			const message = resultMessage(result);
			// Through the session's event pipeline, as the agent loop records a result: hosts see the call end,
			// and the result is persisted as that call's result.
			session._handleAgentEvent({
				type: "tool_execution_end",
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				result: result.result,
				isError: result.isError,
			});
			session._handleAgentEvent({ type: "message_start", message });
			session._handleAgentEvent({ type: "message_end", message });
			await resultSaved(session);
		}
	} finally {
		for (const answer of answers) session._reissuedToolCallIds.delete(answer.result.toolCallId);
		session._refreshFinalizedContext();
	}
}

/**
 * Record answers of a turn that still waits on other calls, without continuing it. The session counts as running
 * meanwhile, as it does while a continuation records its results, so a second resume is refused as busy instead of
 * recording beside this one, where neither would see the turn complete and continue it.
 */
function recordWithoutContinuing(session: AgentSession, answers: readonly Answer[]): Promise<void> {
	return trackSessionWork(session, async () => {
		session._activePromptCount += 1;
		try {
			await recordAnswers(session, answers);
		} finally {
			session._activePromptCount -= 1;
		}
	});
}

/**
 * Record the results of detached calls the transcript is waiting on, each as its own call's result right after its
 * call, then continue the turn that issued them once every detachable call of that turn has its result. Results may
 * arrive together or across several calls: until the last one arrives, the session records what it is given and
 * resolves without continuing. A result for a call that already has one, or repeated in `results`, is ignored. With
 * no new result, a transcript that ends on a detachable turn whose every call has its result continues that turn
 * (its process stopped before the model answered), and a turn still waiting on a call is left as it is. Each result
 * is finalized as an inline call's is: extension `tool_result` handlers, image normalization and the
 * oversized-output spill.
 */
export async function resumeDetachedTurn(this: AgentSession, results: readonly DetachedToolResult[]): Promise<void> {
	const sessionId = this.sessionManager.getSessionId();
	// A closed session records nothing: the results stay with the caller for the session reopened from the store.
	if (this._disposed || sessionGenerationClosing.has(this))
		throw new ToolDetachmentError("session-closed", { sessionId });
	if (this.isStreaming || this._activePromptCount > 0) throw new ToolDetachmentError("session-busy", { sessionId });
	const { assistant, calls, endsOnDetachableTurn } = pendingDetachableCalls(this);
	const issued = new Map(
		assistant?.content.flatMap((block) => (block.type === "toolCall" ? [[block.id, block] as const] : [])) ?? [],
	);
	const recorded = new Set(
		this.sessionManager
			.buildSessionProjection()
			.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
	);
	const pending = results.filter((result) => {
		if (recorded.has(result.toolCallId)) return false;
		recorded.add(result.toolCallId);
		return true;
	});
	const answers = pending.flatMap((result) => {
		const toolCall = issued.get(result.toolCallId);
		return toolCall === undefined ? [] : [{ toolCall, result }];
	});
	const unknown = pending.find((result) => !issued.has(result.toolCallId));
	if (unknown !== undefined)
		throw new ToolDetachmentError("unknown-tool-call", { sessionId, toolCallId: unknown.toolCallId });
	if (pending.length === 0 && !(endsOnDetachableTurn && [...issued.keys()].every((id) => recorded.has(id)))) return;
	const detached = states.get(this)?.detached;
	for (const result of pending) detached?.delete(result.toolCallId);
	// The turn continues only once every detachable call it issued has a result; until then the results wait for it.
	if (calls.some(({ toolCall }) => !recorded.has(toolCall.id))) {
		await recordWithoutContinuing(this, answers);
		return;
	}
	await this._runAgentContinuation(() => recordAnswers(this, answers));
	deliverHeldTaskCompletions(this);
}

export const agentSessionDetachedToolMethods = {
	setToolDetachment,
	hasPendingDetachedTurn,
	takeDetachedToolCalls,
	redispatchDetachedToolCalls,
	resumeDetachedTurn,
};
