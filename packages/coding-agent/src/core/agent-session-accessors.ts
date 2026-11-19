import { unsavedHostNotices } from "./agent-session-host-notices.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { SessionWorkflowsHandle } from "./extensions/workflow-run-control-hub.js";
import { getLatestSessionSummary } from "./session-manager-entries.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

export function installAgentSessionAccessors(prototype: AgentSession): void {
	Object.defineProperties(prototype, {
		sessionSummary: {
			get() {
				return getLatestSessionSummary(this.sessionManager.getBranch());
			},
		},
		orchestrationContext: {
			get() {
				return this._orchestrationContext;
			},
		},
		modelRuntime: {
			get() {
				return this._modelRuntime;
			},
		},
		state: {
			get() {
				return this.agent.state;
			},
		},
		model: {
			get() {
				return this.agent.state.model;
			},
		},
		thinkingLevel: {
			get() {
				return this.agent.state.thinkingLevel;
			},
		},
		isStreaming: {
			get() {
				return this._isPreparingRun === "custom" || this.agent.state.isStreaming;
			},
		},
		systemPrompt: {
			get() {
				return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
			},
		},
		retryAttempt: {
			get() {
				return this._retryAttempt;
			},
		},
		isCompacting: {
			get() {
				return (
					this._autoCompactionAbortController !== undefined ||
					this._compactionAbortController !== undefined ||
					this._branchSummaryAbortController !== undefined
				);
			},
		},
		compactionReason: {
			get() {
				return this._compactionReason;
			},
		},
		compactionStartedAt: {
			get() {
				return this._compactionStartedAt;
			},
		},
		messages: {
			get() {
				return this.agent.state.messages;
			},
		},
		transcriptMessages: {
			get(this: AgentSession) {
				const saving = this._transcriptAppend;
				const beforeSave =
					saving && this._messagesAwaitingPersistence.has(saving.message) ? saving.previousLeaf : undefined;
				const { entries, messages } = this.sessionManager.buildSessionProjection("transcript", beforeSave);
				const pending = this.messages.filter((message) => this._messagesAwaitingPersistence.has(message));
				// A line about how a turn ended that is still being saved is part of the transcript already (#5649).
				const notices = unsavedHostNotices(
					this,
					entries.map(({ sourceEntry }) => sourceEntry),
				);
				if (pending.length === 0 && notices.length === 0) return messages;
				const saved = new Set(entries.map(({ sourceEntry }) => sourceEntry.id));
				return [
					...messages,
					...pending.filter((message) => {
						const id = this._entryIdsByMessage.get(message);
						return id === undefined || !saved.has(id);
					}),
					...notices,
				];
			},
		},
		steeringMode: {
			get() {
				return this.agent.steeringMode;
			},
		},
		followUpMode: {
			get() {
				return this.agent.followUpMode;
			},
		},
		sessionFile: {
			get() {
				return this.sessionManager.getSessionFile();
			},
		},
		sessionId: {
			get() {
				return this.sessionManager.getSessionId();
			},
		},
		sessionName: {
			get() {
				return this.sessionManager.getSessionName();
			},
		},
		scopedModels: {
			get() {
				return this._scopedModels;
			},
		},
		promptTemplates: {
			get() {
				return this._resourceLoader.getPrompts().prompts;
			},
		},
		pendingMessageCount: {
			get() {
				return this._steeringMessages.length + this._followUpMessages.length;
			},
		},
		queuedMessagesPaused: {
			get() {
				return this._queuedMessagesPaused;
			},
		},
		resourceLoader: {
			get() {
				return this._resourceLoader;
			},
		},
		autoCompactionEnabled: {
			get() {
				return this.settingsManager.getCompactionEnabled();
			},
		},
		isRetrying: {
			get() {
				return this._retryPromise !== undefined;
			},
		},
		isWaitingToRetry: {
			get() {
				return this._retryAbortController !== undefined;
			},
		},
		autoRetryEnabled: {
			get() {
				return this.settingsManager.getRetryEnabled();
			},
		},
		isBashRunning: {
			get() {
				return this._bashAbortControllers.size > 0;
			},
		},
		hasPendingBashMessages: {
			get() {
				return this._pendingBashMessages.length > 0;
			},
		},
		extensionRunner: {
			get() {
				return this._extensionRunner;
			},
		},
		workflows: {
			get() {
				this._workflows ??= new SessionWorkflowsHandle(
					() => this._extensionRunner?.getWorkflowRunControl(),
					() => {
						const runner = this._extensionRunner;
						if (this._disposed || runner === undefined) return undefined;
						return (observer) => runner.observeWorkflowActivity(observer);
					},
				);
				return this._workflows;
			},
		},
	});
}
