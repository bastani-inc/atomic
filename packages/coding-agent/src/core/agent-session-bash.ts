import type { BashResult } from "./bash-executor.ts";
import { executeBashWithOperations } from "./bash-executor.ts";
import type { BashExecutionMessage } from "./messages.ts";
import type { BashOperations } from "./tools/bash.ts";
import { createLocalBashOperations } from "./tools/bash.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

export async function executeBash(this: AgentSession, 
	command: string,
	onChunk?: (chunk: string) => void,
	options?: { excludeFromContext?: boolean; operations?: BashOperations; pty?: boolean },
): Promise<BashResult> {
	this._bashAbortController = new AbortController();

	// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
	const prefix = this.settingsManager.getShellCommandPrefix();
	const shellPath = this.settingsManager.getShellPath();
	const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

	try {
		const result = await executeBashWithOperations(
			resolvedCommand,
			this.sessionManager.getCwd(),
			options?.operations ?? createLocalBashOperations({ shellPath }),
			{
				onChunk,
				signal: this._bashAbortController.signal,
				pty: options?.pty,
			},
		);

		this.recordBashResult(command, result, options);
		return result;
	} finally {
		this._bashAbortController = undefined;
	}
}

/**
 * Record a bash execution result in session history.
 * Used by executeBash and by extensions that handle bash execution themselves.
 */

export function recordBashResult(this: AgentSession, command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
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
	if (this.isStreaming) {
		// Queue for later - will be flushed on agent_end
		this._pendingBashMessages.push(bashMessage);
	} else {
		// Add to agent state immediately
		this.agent.state.messages.push(bashMessage);

		// Save to session
		this.sessionManager.appendMessage(bashMessage);
	}
}

/**
 * Cancel running bash command.
 */

export function abortBash(this: AgentSession): void {
	this._bashAbortController?.abort();
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
