import { getShellEnv } from "../utils/shell.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { BashResult } from "./bash-executor.ts";
import { executeBashWithOperations } from "./bash-executor.ts";
import type { BashExecutionMessage } from "./messages.ts";
import { sessionGenerationClosing, trackSessionWork } from "./session-lifecycle-work.ts";
import { type BashOperations, type BashOutputChannel, createLocalBashOperations } from "./tools/bash.js";
import { applyBashSessionEnvironment, snapshotBashSessionEnvironment } from "./tools/bash-session-environment.ts";
import { createLocalPowerShellOperations } from "./tools/powershell.ts";
import { resolveSessionTempDirPath } from "./tools/session-temp-dir.ts";

export function executeBash(this: AgentSession, ...args: Parameters<typeof executeBashOperation>): Promise<BashResult> {
	if (this._disposed || sessionGenerationClosing.has(this))
		return Promise.reject(Object.assign(new Error("Session is closed"), { code: "SessionClosed" }));
	return trackSessionWork(this, () => executeBashOperation.call(this, ...args));
}

async function executeBashOperation(
	this: AgentSession,
	command: string,
	onChunk?: (chunk: string, channel: BashOutputChannel) => void,
	options?: {
		excludeFromContext?: boolean;
		id?: string;
		operations?: BashOperations;
		pty?: boolean;
		emitEvent?: boolean;
		recordResult?: boolean;
	},
): Promise<BashResult> {
	const requestKey = options?.id ?? Symbol("bash-request");
	const abortController = new AbortController();
	const controllers = this._bashAbortControllers.get(requestKey) ?? new Set<AbortController>();
	controllers.add(abortController);
	this._bashAbortControllers.set(requestKey, controllers);
	// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
	const prefix = this.settingsManager.getShellCommandPrefix();
	const shellPath = this.settingsManager.getShellPath();
	const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
	const env = { ...getShellEnv() };
	applyBashSessionEnvironment(env, snapshotBashSessionEnvironment(this, true));

	try {
		const result = await executeBashWithOperations(
			resolvedCommand,
			this.sessionManager.getCwd(),
			options?.operations ??
				(process.platform === "win32"
					? createLocalPowerShellOperations()
					: createLocalBashOperations({ shellPath })),
			{
				onChunk: (delta, channel) => {
					onChunk?.(delta, channel);
					if (options?.emitEvent !== false) {
						this._emit({ type: "bash_execution_update", id: options?.id, channel, delta });
					}
				},
				signal: abortController.signal,
				env,
				pty: options?.pty,
				sessionTempDir: resolveSessionTempDirPath(this.sessionManager.getSessionId()),
			},
		);

		if (options?.recordResult !== false) await this.recordBashResult(command, result, options);
		return result;
	} finally {
		controllers.delete(abortController);
		if (controllers.size === 0) this._bashAbortControllers.delete(requestKey);
	}
}

/**
 * Record a bash execution result in session history.
 * Used by executeBash and by extensions that handle bash execution themselves.
 */

export async function recordBashResult(
	this: AgentSession,
	command: string,
	result: BashResult,
	options?: { excludeFromContext?: boolean; persist?: boolean; defer?: boolean },
): Promise<void> {
	const bashMessage: BashExecutionMessage = {
		role: "bashExecution",
		command,
		output: result.output,
		exitCode: result.exitCode,
		cancelled: result.cancelled,
		truncated: result.truncated,
		fullOutputPath: result.fullOutputPath,
		timestamp: Date.now(),
		excludeFromContext: options?.excludeFromContext,
	};

	// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
	if (this.isStreaming && options?.defer !== false) {
		// Queue for later - will be flushed on agent_end
		this._pendingBashMessages.push(bashMessage);
	} else if (options?.persist !== false) {
		// Persist first, then refresh the finalized context from the canonical projection.
		await this.sessionManager.appendMessage(bashMessage);
		this._refreshFinalizedContext();
	} else {
		// Avoid writing a source-owned result into a shared manager that an
		// in-memory fork changed while this execution was active. The result stays
		// visible to this run only, so it must be added to agent state directly.
		this.agent.state.messages.push(bashMessage);
	}
}

/** Cancel one correlated bash request, or all active requests for legacy callers. */
export function abortBash(this: AgentSession, id?: string): void {
	if (id !== undefined) {
		for (const controller of [...(this._bashAbortControllers.get(id) ?? [])]) controller.abort();
		return;
	}
	// Snapshot first: aborting settles owners, and a listener that removes its own
	// entry must not shorten the cancellation sweep.
	for (const controllers of [...this._bashAbortControllers.values()]) {
		for (const controller of [...controllers]) controller.abort();
	}
}

const pendingBashDrains = new WeakMap<AgentSession, Promise<void>>();

export function _flushPendingBashMessages(this: AgentSession): Promise<void> {
	const pending = pendingBashDrains.get(this);
	if (pending) return pending;
	if (this._pendingBashMessages.length === 0) return Promise.resolve();

	const drain = (async () => {
		while (this._pendingBashMessages.length > 0) {
			await this.sessionManager.appendMessage(this._pendingBashMessages[0]);
			this._pendingBashMessages.shift();
			this._refreshFinalizedContext();
		}
	})();
	pendingBashDrains.set(this, drain);
	void drain.then(
		() => pendingBashDrains.delete(this),
		() => pendingBashDrains.delete(this),
	);
	return drain;
}

// =========================================================================
// Session Management
// =========================================================================

/**
 * Set a display name for the current session.
 */

export const agentSessionBashMethods = {
	executeBash,
	recordBashResult,
	abortBash,
	_flushPendingBashMessages,
};
