import type { AgentMessage } from "@bastani/atomic-agent-core";
import { finalizeProjectedMessages, repairUniquifiedMessages } from "./agent-session-boundaries.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { uniquifyToolCallIds } from "./context-tool-pairing.js";
import { getLatestSessionSummary } from "./session-manager-entries.ts";
import type { SessionProjection } from "./session-manager-types.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

function finalizeTranscript(session: AgentSession, { entries, messages }: SessionProjection): AgentMessage[] {
	const runOnly = session._runOnlyBashMessages;
	const resident = session.messages;
	const first = runOnly ? resident.findIndex((message) => runOnly.has(message)) : -1;
	if (!runOnly || first < 0) return finalizeProjectedMessages(session, messages);

	// Repair the whole history, so a call before a run-only shell still pairs with its result after the shell.
	const unique = uniquifyToolCallIds(messages);
	const repaired = repairUniquifiedMessages(session, unique);
	const positions = new Map(repaired.map((message, index) => [message, index]));
	const anchors = new Map<string | AgentMessage, number>();
	let row = 0;
	for (const { sourceEntry, messages: contribution } of entries) {
		const end = row + contribution.length;
		while (row < end) {
			const position = positions.get(unique[row++]);
			if (position !== undefined && !anchors.has(sourceEntry.id)) anchors.set(sourceEntry.id, position);
		}
	}
	// Rows joined after the saved entries are still the resident objects (including a prompt whose save is pending).
	for (; row < messages.length; row++) {
		const position = positions.get(unique[row]);
		if (position !== undefined) anchors.set(messages[row], position);
	}

	const before = new Map<number, AgentMessage[]>();
	let position = repaired.length;
	for (let index = resident.length - 1; index >= first; index--) {
		const message = resident[index];
		if (runOnly.has(message)) {
			const group = before.get(position) ?? [];
			group.push(message);
			before.set(position, group);
		} else {
			const anchor = anchors.get(message) ?? anchors.get(session._entryIdsByMessage.get(message) ?? message);
			if (anchor !== undefined) position = Math.min(position, anchor);
		}
	}
	// The shell and everything appended after it are already live rows. A context refresh would have removed the
	// shell. Apply the SDK filter only to the prefix, before adding those rows, just as recordBashResult did.
	const prefix = repaired.slice(0, position);
	const result = [...(session._contextProjectionTransform?.(prefix) ?? prefix)];
	for (; position <= repaired.length; position++) {
		for (const shell of before.get(position)?.reverse() ?? []) result.push(shell);
		if (position < repaired.length) result.push(repaired[position]);
	}
	return result;
}

export function installAgentSessionAccessors(prototype: AgentSession): void {
	Object.defineProperties(prototype, {
		sessionSummary: {
			get() {
				return getLatestSessionSummary(this.sessionManager.getBranch());
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
		turnStartedAt: {
			get() {
				return this._turnStartedAt;
			},
		},
		retryStatus: {
			get() {
				return this._retryStatus;
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
				// Only a context edit or a save in flight sets the transcript apart from the context, which is read as it is.
				if (saving === undefined && !this.sessionManager.hasContextEdits()) return this.messages;
				const beforeSave =
					saving && this._messagesAwaitingPersistence.has(saving.message) ? saving.previousLeaf : undefined;
				const projection = this.sessionManager.buildSessionProjection("transcript", beforeSave);
				const { entries, messages } = projection;
				// The context also shows rows the store does not have: admitted ones still saving and ones whose save failed.
				const pending = this.messages.filter(
					(message) =>
						this._messagesAwaitingPersistence.has(message) || this._messagesWithFailedPersistence.has(message),
				);
				if (pending.length === 0 && beforeSave === undefined) return finalizeTranscript(this, projection);
				const saved = new Set(entries.map(({ sourceEntry }) => sourceEntry.id));
				// An independent delivery can save a notice after the pinned leaf and publish it while the input's
				// write is still outstanding. Its source ID distinguishes it from both the prefix and the pending input.
				const tail = new Set(pending);
				if (beforeSave !== undefined) {
					for (const message of this.messages) {
						const id = this._entryIdsByMessage.get(message);
						if (id !== undefined && !saved.has(id)) tail.add(message);
					}
				}
				for (const message of tail) {
					const id = this._entryIdsByMessage.get(message);
					if (id !== undefined && saved.has(id)) continue;
					if (id !== undefined) saved.add(id);
					messages.push(message);
				}
				// Paired and repaired as the context is: a call whose result was never saved shows it was interrupted.
				return finalizeTranscript(this, projection);
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
				return this._retryPromise !== undefined || this._fallbackOriginGeneration !== undefined;
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
	});
}
