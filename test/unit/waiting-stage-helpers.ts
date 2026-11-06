import type { DetachedToolCall, DetachedToolResult, SessionManager } from "@bastani/atomic";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

export const TOOL = "wait_for_ci";

/** The fake long tool's backing service: one pending result per dispatched call, finished only by the test. */
export class FakeCiService {
	readonly pending = new Map<string, PromiseWithResolvers<DetachedToolResult>>();
	dispatches = 0;
	aborted = 0;

	dispatch(toolCallId: string): DetachedToolCall {
		this.dispatches += 1;
		const deferred = Promise.withResolvers<DetachedToolResult>();
		this.pending.set(toolCallId, deferred);
		return {
			toolCallId,
			toolName: TOOL,
			result: deferred.promise,
			abort: () => {
				this.aborted += 1;
			},
		};
	}

	finishAll(): void {
		for (const toolCallId of [...this.pending.keys()]) this.finish(toolCallId);
	}

	finish(toolCallId: string): void {
		this.pending.get(toolCallId)?.resolve({
			toolCallId,
			toolName: TOOL,
			result: { content: [{ type: "text", text: "ci passed" }], details: undefined },
			isError: false,
		});
		this.pending.delete(toolCallId);
	}
}

export interface Counters {
	created: number;
	disposed: number;
	peakLive: number;
	userPrompts: Map<string, number>;
	continued: Map<string, number>;
	/** Text queued into a session, in order, as `<stage>: <kind> <text>`. */
	queued: string[];
	runSignal: AbortSignal | undefined;
}

export interface DetachingAdapterOptions {
	/** False: prompts finish their turn without a tool call. */
	readonly detach?: boolean;
	/** Only prompts whose text this accepts end on a call of the fake long tool; the others finish their turn. */
	readonly detachWhen?: (text: string) => boolean;
	/** Holds every prompt until this settles. */
	readonly promptGate?: Promise<void>;
	/** Fails every session creation after the first `n`. */
	readonly failCreationAfter?: number;
	/** What a failed creation throws; a plain "session store unreachable" error unless given. */
	readonly creationFailure?: () => Error;
	/** Each session's disposal waits for what this returns when it is disposed. */
	readonly beforeDispose?: () => Promise<void>;
	/**
	 * Sessions expose their stored transcript as `messages` and say whether it ends on an unanswered call, as an
	 * `AgentSession` reopened by a durable resume does.
	 */
	readonly resumable?: boolean;
	/** How many calls of the fake long tool each detaching prompt ends on; one by default. */
	readonly callsPerTurn?: number;
}

/**
 * Stage sessions whose every prompt ends on a call of the fake long tool that detaches, the way an `AgentSession` with a
 * detachment policy does: the call is saved in the session's store before it is dispatched, and the run ends on it.
 */
export function detachingAdapters(
	service: FakeCiService,
	counters: Counters,
	adapterOptions: DetachingAdapterOptions = {},
): StageAdapters {
	return {
		sessionStore: new MemorySessionStore(),
		agentSession: {
			async create(options, meta) {
				counters.runSignal ??= meta?.signal;
				if (adapterOptions.failCreationAfter !== undefined && counters.created >= adapterOptions.failCreationAfter)
					throw adapterOptions.creationFailure?.() ?? new Error("session store unreachable");
				const manager = options.sessionManager as SessionManager;
				const stageName = meta?.stageName ?? "stage";
				counters.created += 1;
				counters.peakLive = Math.max(counters.peakLive, counters.created - counters.disposed);
				let detached: DetachedToolCall[] = [];
				let detachable = false;
				const callsPerTurn = adapterOptions.callsPerTurn ?? 1;
				const toolCallIds = Array.from({ length: callsPerTurn }, (_, index) =>
					callsPerTurn === 1 ? `call-${stageName}` : `call-${stageName}-${index + 1}`,
				);
				const pendingCall = (): boolean => {
					const messages = manager.buildSessionProjection().messages;
					const last = messages.at(-1);
					return last?.role === "assistant" && last.stopReason === "toolUse";
				};
				const session: StageSessionRuntime = {
					...mockSession(manager),
					setToolDetachment(policy: { readonly afterMs: number } | undefined) {
						detachable = policy !== undefined;
					},
					async prompt(text: string) {
						counters.userPrompts.set(stageName, (counters.userPrompts.get(stageName) ?? 0) + 1);
						await adapterOptions.promptGate;
						await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
						if (adapterOptions.detach === false || adapterOptions.detachWhen?.(text) === false) return;
						await manager.appendMessage({
							role: "assistant",
							content: toolCallIds.map((id) => ({
								type: "toolCall" as const,
								id,
								name: TOOL,
								arguments: { run: stageName },
							})),
							api: "faux",
							provider: "faux",
							model: "faux",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: Date.now(),
						});
						const calls = toolCallIds.map((id) => service.dispatch(id));
						if (detachable) {
							detached = calls;
							return;
						}
						for (const result of await Promise.all(calls.map((call) => call.result)))
							await manager.appendMessage({
								role: "toolResult",
								toolCallId: result.toolCallId,
								toolName: result.toolName,
								content: result.result.content,
								isError: result.isError,
								timestamp: Date.now(),
							});
					},
					takeDetachedToolCalls() {
						const taken = detached;
						detached = [];
						return taken;
					},
					redispatchDetachedToolCalls() {
						return pendingCall() ? toolCallIds.map((id) => service.dispatch(id)) : [];
					},
					async resumeDetachedTurn(results: readonly DetachedToolResult[]) {
						counters.continued.set(stageName, (counters.continued.get(stageName) ?? 0) + 1);
						for (const result of results)
							await manager.appendMessage({
								role: "toolResult",
								toolCallId: result.toolCallId,
								toolName: result.toolName,
								content: result.result.content,
								isError: result.isError,
								timestamp: Date.now(),
							});
					},
					async steer(text: string) {
						counters.queued.push(`${stageName}: steer ${text}`);
					},
					async followUp(text: string) {
						counters.queued.push(`${stageName}: followUp ${text}`);
					},
					async dispose() {
						await adapterOptions.beforeDispose?.();
						counters.disposed += 1;
					},
				};
				if (adapterOptions.resumable === true)
					Object.defineProperties(session, {
						messages: { get: () => manager.buildSessionProjection().messages },
						hasPendingDetachedTurn: { value: pendingCall },
					});
				return session;
			},
		},
	};
}

export function counters(): Counters {
	return {
		created: 0,
		disposed: 0,
		peakLive: 0,
		userPrompts: new Map(),
		continued: new Map(),
		queued: [],
		runSignal: undefined,
	};
}
