import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

export function installAgentSessionAccessors(prototype: AgentSession): void {
	Object.defineProperties(prototype, {
		orchestrationContext: { get() { return this._orchestrationContext; } },
		modelRegistry: { get() { return this._modelRegistry; } },
		state: { get() { return this.agent.state; } },
		model: { get() { return this.agent.state.model; } },
		thinkingLevel: { get() { return this.agent.state.thinkingLevel; } },
		isStreaming: { get() { return this.agent.state.isStreaming; } },
		systemPrompt: { get() { return this.agent.state.systemPrompt; } },
		retryAttempt: { get() { return this._retryAttempt; } },
		isCompacting: {
			get() {
				return (
					this._autoCompactionAbortController !== undefined ||
					this._compactionAbortController !== undefined ||
					this._branchSummaryAbortController !== undefined
				);
			},
		},
		messages: { get() { return this.agent.state.messages; } },
		steeringMode: { get() { return this.agent.steeringMode; } },
		followUpMode: { get() { return this.agent.followUpMode; } },
		sessionFile: { get() { return this.sessionManager.getSessionFile(); } },
		sessionId: { get() { return this.sessionManager.getSessionId(); } },
		sessionName: { get() { return this.sessionManager.getSessionName(); } },
		scopedModels: { get() { return this._scopedModels; } },
		promptTemplates: { get() { return this._resourceLoader.getPrompts().prompts; } },
		pendingMessageCount: { get() { return this._steeringMessages.length + this._followUpMessages.length; } },
		resourceLoader: { get() { return this._resourceLoader; } },
		autoCompactionEnabled: { get() { return this.settingsManager.getCompactionEnabled(); } },
		isRetrying: { get() { return this._retryPromise !== undefined; } },
		autoRetryEnabled: { get() { return this.settingsManager.getRetryEnabled(); } },
		isBashRunning: { get() { return this._bashAbortController !== undefined; } },
		hasPendingBashMessages: { get() { return this._pendingBashMessages.length > 0; } },
		extensionRunner: { get() { return this._extensionRunner; } },
	});
}
