import { AgentRehydrateError, AgentReleaseConfigError, type AgentSessionActivity } from "./agent-rehydrate-errors.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { type AgentWakeDispatcher, agentWakeDispatcher } from "./agent-wake-dispatcher.ts";

/** What is left of a released session: plain data that names its stored conversation, and nothing live. */
export interface ReleasedAgentSession {
	readonly sessionId: string;
	readonly cwd: string;
	/** The session's JSONL file, when its store is the JSONL store. */
	readonly sessionFile?: string;
}

/** `createAgentSession({ releaseWhenIdle })`: release the session once it has been idle for `afterMs`. */
export interface ReleaseWhenIdleOptions {
	readonly afterMs: number;
}

/** The namespace of the wake keys idle sessions are released under. */
export const IDLE_RELEASE_NAMESPACE = "session-idle";
const IDLE_RELEASE_WAKE_ID = "idle-release";

/**
 * Validate `releaseWhenIdle` where it enters the SDK, before any store, session or timer exists. Returns the policy,
 * or `undefined` when unset.
 */
export function parseReleaseWhenIdle(
	value: ReleaseWhenIdleOptions | undefined,
	source: "sdk" | "settings" = "sdk",
): ReleaseWhenIdleOptions | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new AgentReleaseConfigError({ source, field: "releaseWhenIdle", value: describe(value) });
	const afterMs = (value as { readonly afterMs?: number | string }).afterMs;
	if (typeof afterMs !== "number" || !Number.isFinite(afterMs) || afterMs < 0)
		throw new AgentReleaseConfigError({ source, field: "releaseWhenIdle.afterMs", value: describe(afterMs) });
	return { afterMs };
}

function describe(value: ReleaseWhenIdleOptions | number | string | boolean | null | undefined | object): string {
	return typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? "an array" : String(value);
}

/** What keeps the session from being released now, if anything. */
export function sessionActivity(session: AgentSession): AgentSessionActivity | undefined {
	if (session.isStreaming) return "streaming";
	if (session._activePromptCount > 0) return "prompt";
	if (session.isCompacting) return "compaction";
	if (session.isBashRunning || session.hasPendingBashMessages) return "shell";
	if (session.pendingMessageCount > 0) return "queued-messages";
	return undefined;
}

const releases = new WeakMap<AgentSession, Promise<ReleasedAgentSession>>();

/**
 * Let go of everything the session holds in memory (its agent loop, extension instances, tool registry, listeners,
 * timers, Intercom and MCP connections, provider caches) and keep only its stored history. Refused with a retryable
 * `session-busy` {@link AgentRehydrateError} while a run, compaction, shell command or queued message is pending.
 * Releasing again returns the same result. Rehydrate it with `AgentSessionRuntime.rehydrate(sessionId)`.
 */
export function release(this: AgentSession): Promise<ReleasedAgentSession> {
	const existing = releases.get(this);
	if (existing !== undefined) return existing;
	const sessionId = this.sessionManager.getSessionId();
	const activity = sessionActivity(this);
	if (activity !== undefined) return Promise.reject(new AgentRehydrateError("session-busy", { sessionId, activity }));
	const sessionFile = this.sessionManager.getSessionFile();
	const released: ReleasedAgentSession = {
		sessionId,
		cwd: this.sessionManager.getCwd(),
		...(sessionFile === undefined ? {} : { sessionFile }),
	};
	disarmIdleRelease(this);
	this._emit({ type: "session_released", released });
	const closing = this.dispose().then(() => released);
	releases.set(this, closing);
	return closing;
}

interface ArmedSession {
	readonly session: AgentSession;
	readonly policy: ReleaseWhenIdleOptions;
	readonly dispatcher: AgentWakeDispatcher;
	readonly unsubscribe: () => void;
}

/** Live sessions waiting to be released when idle, by wake key. A released or disposed session has no entry. */
const armedSessions = new Map<string, ArmedSession>();
const armedKeys = new WeakMap<AgentSession, string>();
const handledDispatchers = new WeakSet<AgentWakeDispatcher>();

function idleWakeKey(session: AgentSession): string {
	return `${IDLE_RELEASE_NAMESPACE}:${session.sessionManager.getSessionId()}`;
}

async function releaseIdleSession(wakeKey: string): Promise<void> {
	const armed = armedSessions.get(wakeKey);
	if (armed === undefined) return;
	if (sessionActivity(armed.session) !== undefined) {
		armed.dispatcher.schedule(wakeKey, { id: IDLE_RELEASE_WAKE_ID, kind: "timer" }, armed.policy.afterMs);
		return;
	}
	await armed.session.release();
}

/** Number of live sessions armed to release when idle; counted by tests. */
export function armedIdleSessionCount(): number {
	return armedSessions.size;
}

/**
 * Release `session` once it has been idle for `policy.afterMs`: it is armed whenever a run settles and disarmed
 * when one starts. The wait is a timed wake on the process's one dispatcher, not a timer of the session's own.
 */
export function enableReleaseWhenIdle(
	session: AgentSession,
	policy: ReleaseWhenIdleOptions,
	dispatcher: AgentWakeDispatcher = agentWakeDispatcher(),
): void {
	if (!handledDispatchers.has(dispatcher)) {
		dispatcher.handle(IDLE_RELEASE_NAMESPACE, (wakeKey) => releaseIdleSession(wakeKey));
		handledDispatchers.add(dispatcher);
	}
	disarmIdleRelease(session);
	const wakeKey = idleWakeKey(session);
	const arm = () => dispatcher.schedule(wakeKey, { id: IDLE_RELEASE_WAKE_ID, kind: "timer" }, policy.afterMs);
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_start") dispatcher.cancel(wakeKey, IDLE_RELEASE_WAKE_ID);
		else if (event.type === "agent_settled") arm();
	});
	armedSessions.set(wakeKey, { session, policy, dispatcher, unsubscribe });
	armedKeys.set(session, wakeKey);
	arm();
}

/** Stop releasing `session` when idle; called when it is released or closed. */
export function disarmIdleRelease(session: AgentSession): void {
	const wakeKey = armedKeys.get(session);
	if (wakeKey === undefined) return;
	armedKeys.delete(session);
	const armed = armedSessions.get(wakeKey);
	if (armed?.session !== session) return;
	armedSessions.delete(wakeKey);
	armed.unsubscribe();
	armed.dispatcher.cancel(wakeKey, IDLE_RELEASE_WAKE_ID);
}

const closeListeners = new WeakMap<AgentSession, Array<() => void>>();

/** Run `listener` once when `session` is released or closed, so whoever tracks it drops its entry. */
export function onSessionClose(session: AgentSession, listener: () => void): void {
	const listeners = closeListeners.get(session);
	if (listeners === undefined) closeListeners.set(session, [listener]);
	else listeners.push(listener);
}

/** Called once when a session starts closing: drop every per-session entry kept outside the session. */
export function sessionClosing(session: AgentSession): void {
	disarmIdleRelease(session);
	const listeners = closeListeners.get(session) ?? [];
	closeListeners.delete(session);
	for (const listener of listeners) listener();
}

export const agentSessionReleaseMethods = { release };
