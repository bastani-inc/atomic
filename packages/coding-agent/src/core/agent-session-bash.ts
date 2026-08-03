import { getShellEnv } from "../utils/shell.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { BashResult } from "./bash-executor.ts";
import { executeBashWithOperations } from "./bash-executor.ts";
import type { BashExecutionMessage } from "./messages.ts";
import { type BashOperations, type BashOutputChannel, createLocalBashOperations } from "./tools/bash.ts";
import { applyBashSessionEnvironment, snapshotBashSessionEnvironment } from "./tools/bash-session-environment.ts";

export async function executeBash(
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
	this._bashAbortControllers.set(requestKey, abortController);
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
			options?.operations ?? createLocalBashOperations({ shellPath }),
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
			},
		);

		if (options?.recordResult !== false) this.recordBashResult(command, result, options);
		return result;
	} finally {
		if (this._bashAbortControllers.get(requestKey) === abortController) this._bashAbortControllers.delete(requestKey);
	}
}

/**
 * Record a bash execution result in session history.
 * Used by executeBash and by extensions that handle bash execution themselves.
 */

export function recordBashResult(
	this: AgentSession,
	command: string,
	result: BashResult,
	options?: { excludeFromContext?: boolean; persist?: boolean; defer?: boolean },
): void {
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
	} else {
		// Add to agent state immediately
		this.agent.state.messages.push(bashMessage);

		// Avoid writing a source-owned result into a shared manager that an
		// in-memory fork changed while this execution was active.
		if (options?.persist !== false) this.sessionManager.appendMessage(bashMessage);
	}
}

/** Cancel one correlated bash request, or all active requests for legacy callers. */
export function abortBash(this: AgentSession, id?: string): void {
	if (id !== undefined) {
		this._bashAbortControllers.get(id)?.abort();
		return;
	}
	// Snapshot first: aborting settles owners, and a listener that removes its own
	// entry must not shorten the cancellation sweep.
	for (const controller of [...this._bashAbortControllers.values()]) controller.abort();
}

/** Whether a bash command is currently running */

export function _flushPendingBashMessages(this: AgentSession): void {
	if (this._pendingBashMessages.length === 0) return;

	for (const bashMessage of this._pendingBashMessages) {
		// Add to agent state
		this.agent.state.messages.push(bashMessage);

		// Save to session
		this.sessionManager.appendMessage(bashMessage);
	}

	this._pendingBashMessages = [];
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
