import { readFileSync } from "node:fs";
import type { ImageContent, TextContent } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { PromptOptions, QueuedInputDisposition } from "./agent-session-types.js";
import {
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatUnresolvedModelMessage,
} from "./auth-guidance.ts";
import { runCallback } from "./callback-activity.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
import {
	assertSessionOpen,
	sessionGenerationClosing,
	sessionLifetime,
	trackSessionWork,
} from "./session-lifecycle-work.ts";
import { getSkillCatalog } from "./skill-catalog.ts";

type UserMessageDeliveryAction = "prompt" | "steer" | "followUp" | "handled";

function assistantHasRecoverableOutput(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	return message.content.some((block) => {
		if (block.type === "text") return block.text.length > 0;
		if (block.type === "thinking") return block.thinking.length > 0;
		return true;
	});
}

type PromptOptionsWithWorkflowDelivery = PromptOptions & {
	readonly __workflowDelivery?: {
		readonly beforeDelivery?: () => void;
		/** Called only after an idle prompt has synchronously entered the agent turn. */
		readonly promptStarted?: () => void;
		readonly delivered?: (action: UserMessageDeliveryAction) => void;
	};
};

/** Dispatch registered extension slash commands without changing the raw queue pause gate. */
export async function tryExecuteSessionSlashCommand(
	session: Pick<AgentSession, "_tryExecuteExtensionCommand">,
	text: string,
): Promise<boolean> {
	if (!text.startsWith("/")) return false;
	return session._tryExecuteExtensionCommand(text);
}

async function _normalizePromptImages(
	this: AgentSession,
	images: ImageContent[] | undefined,
): Promise<{ images: ImageContent[]; hints: string[] }> {
	if (!images) return { images: [], hints: [] };

	const normalizedImages: ImageContent[] = [];
	const hints: string[] = [];
	for (const image of images) {
		const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			resizeOptions: this.model?.inputLimits?.images?.resize,
		});
		if (!processed.ok) {
			hints.push(processed.message);
			continue;
		}
		normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		hints.push(...processed.hints);
	}
	return { images: normalizedImages, hints };
}

export async function prompt(this: AgentSession, text: string, options?: PromptOptions): Promise<void> {
	if (this._disposed || sessionGenerationClosing.has(this))
		throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.prompt(text, options);
	if (this._isEmittingAgentSettled) {
		// A run started by an agent_settled handler waits until every settled handler completes.
		this._deferredSettledActions.push(async () => await this.prompt(text, options));
		return;
	}
	return trackSessionWork(this, () => admittedPrompt.call(this, text, options));
}

async function admittedPrompt(this: AgentSession, text: string, options?: PromptOptions): Promise<void> {
	if (this._activePromptCount === 0 && !this.isStreaming) this._agentRunAbortRequested = false;
	this._activePromptCount += 1;
	try {
		await promptInternal.call(this, text, options);
		const boundary = this._subagentMessageAdmission ?? this._workflowStageAdmission;
		if (
			!this._disposed &&
			!sessionGenerationClosing.has(this) &&
			this._activePromptCount === 1 &&
			!this.isStreaming &&
			!this._queuedMessagesPaused &&
			(this._priorityInterruptPending || boundary?.hasMessageDeliveries())
		) {
			// A command/input hook may consume the original prompt during preflight.
			// Its owner still owes independently admitted priority input a reply; drain
			// that input without replaying preflight or starting another task prompt.
			await this._continueQueuedAgentMessages();
			if (this._subagentMessageAdmission) await settleSubagentMessages(this);
		}
	} finally {
		this._activePromptCount -= 1;
	}
}

async function promptInternal(this: AgentSession, text: string, options?: PromptOptions): Promise<void> {
	const lifetime = sessionLifetime(this);
	const assertCurrent = () => {
		if (this._disposed || lifetime.aborted || sessionGenerationClosing.has(this))
			throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	};
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.prompt(text, options);
	const expandPromptTemplates = options?.expandPromptTemplates ?? true;
	const preflightResult = options?.preflightResult;
	const workflowDelivery = (options as PromptOptionsWithWorkflowDelivery | undefined)?.__workflowDelivery;
	let messages: AgentMessage[] | undefined;

	try {
		// Authorize workflow delivery before commands or input extensions can perform side effects.
		// A later terminal transition cannot retroactively reject input accepted at this boundary.
		workflowDelivery?.beforeDelivery?.();
		// Registered slash commands execute without releasing ordinary queued work.
		// Unknown slash input continues through the normal paused admission path.
		if (expandPromptTemplates && (await tryExecuteSessionSlashCommand(this, text))) {
			workflowDelivery?.delivered?.("handled");
			preflightResult?.(true, "handled");
			return;
		}
		assertCurrent();
		// Real user input is on its way in, so a summary describing the previous turn is about
		// to be stale; stop paying for it. Deliberately after the authorization boundary and
		// the slash-command path, both of which must observe an untouched session. The
		// generation discards itself via its token/anchor checks either way.
		this.abortSessionSummary();
		// A controlled pause is an admission gate, including the idle gap after
		// abort settles. Preserve the raw user payload without running input hooks,
		// compaction, or a provider turn; explicit resume makes it eligible again.
		if (this._queuedMessagesPaused) {
			const delivery = options?.streamingBehavior === "followUp" ? "followUp" : "steer";
			if (delivery === "followUp") await this._queueFollowUp(text, options?.images);
			else await this._queueSteer(text, options?.images);
			workflowDelivery?.delivered?.(delivery);
			preflightResult?.(true, "queued");
			return;
		}

		// Emit input event for extension interception (before skill/template expansion)
		let currentText = text;
		let currentImages = options?.images;
		if (this._extensionRunner.hasHandlers("input")) {
			const inputResult = await this._extensionRunner.emitInput(
				currentText,
				currentImages,
				options?.source ?? "interactive",
				this.isStreaming ? options?.streamingBehavior : undefined,
			);
			assertCurrent();
			if (inputResult.action === "handled") {
				workflowDelivery?.delivered?.("handled");
				preflightResult?.(true, "handled");
				return;
			}
			if (inputResult.action === "transform") {
				currentText = inputResult.text;
				currentImages = inputResult.images ?? currentImages;
			}
		}

		// Expand skill commands (/skill:name args) and prompt templates (/template args)
		let expandedText = currentText;
		if (expandPromptTemplates) {
			expandedText = this._expandSkillCommand(expandedText);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}

		// If streaming, queue via steer() or followUp() based on option. The run is still
		// open while agent_before_settle handlers decide on its continuation, so input sent
		// from that boundary queues for the continuation instead of starting a second run.
		if (this.isStreaming || this._isBeforeSettle) {
			if (!options?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			if (options.streamingBehavior === "followUp") {
				await this._queueFollowUp(expandedText, currentImages);
			} else {
				await this._queueSteer(expandedText, currentImages);
			}
			workflowDelivery?.delivered?.(options.streamingBehavior);
			preflightResult?.(true, "queued");
			return;
		}

		// Close the completed fallback lifecycle before validating credentials for
		// the next idle prompt. The selected fallback remains the session model.
		if (typeof this._settleFallbackModelScope === "function") await this._settleFallbackModelScope();
		assertCurrent();
		// Flush context-only messages deferred until the previous turn's tool results were appended.
		this._flushPendingBashMessages();
		this._flushPendingCustomMessages();

		// Validate model
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		// Defensive guard: a model that never resolved to a real provider
		// (for example an unknown/unresolved model id that reached this path
		// as a bare string) has no `provider`, which would otherwise fail deep
		// in auth resolution as the confusing "No API key found for undefined".
		// Surface a clear, accurate "unknown model" error instead.
		const resolvedProvider = (this.model as { provider?: unknown }).provider;
		if (typeof resolvedProvider !== "string" || resolvedProvider.length === 0) {
			throw new Error(formatUnresolvedModelMessage(this.model));
		}

		if (!this._modelRuntime.hasConfiguredAuth(this.model.provider)) {
			// A failed credential-store load (for example auth.json briefly locked
			// by a concurrent process, or invalid JSON) leaves an empty in-memory
			// credential set. That would otherwise be misreported here as
			// "No API key found" even though the credentials exist on disk. Surface
			// the real load failure instead so configured providers are not falsely
			// reported as unauthenticated (issue #1431).
			const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
			if (isOAuth) {
				throw new Error(
					`Authentication failed for "${this.model.provider}". ` +
						`Credentials may have expired or network is unavailable. ` +
						`Run '/login ${this.model.provider}' to re-authenticate.`,
				);
			}
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}

		// Check if we need to compact before sending (catches aborted responses)
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) {
			await this._checkCompaction(lastAssistant, false);
			assertCurrent();
		}

		// Emit before_agent_start before normalizing images so extension-driven model
		// selection determines the resize profile used for the request and history.
		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools ?? [];
		const emitted = await this._extensionRunner.emitBeforeAgentStart(
			expandedText,
			currentImages,
			this._baseSystemPromptOptions,
		);
		const result = emitted ?? { systemPromptOptions: this._baseSystemPromptOptions };
		assertCurrent();
		const nextTools = result.systemPromptOptions.selectedTools ?? selectedToolsBefore;
		const handlerEditedTools =
			nextTools.length !== selectedToolsBefore.length ||
			nextTools.some((name, index) => name !== selectedToolsBefore[index]);
		if (!handlerEditedTools && typeof this.getActiveToolNames === "function") {
			result.systemPromptOptions.selectedTools = this.getActiveToolNames();
		}

		const normalized = await _normalizePromptImages.call(this, currentImages);
		assertCurrent();
		const userText = normalized.hints.length > 0 ? `${expandedText}\n\n${normalized.hints.join("\n")}` : expandedText;

		// Build messages only after hooks and image normalization have completed.
		messages = [];
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
		userContent.push(...normalized.images);
		messages.push({
			role: "user",
			content: userContent,
			timestamp: Date.now(),
		});

		// Inject any pending "nextTurn" messages as context alongside the user message
		for (const msg of this._pendingNextTurnMessages) {
			messages.push(msg);
		}
		this._pendingNextTurnMessages = [];

		// Add all custom messages from extensions
		if (result?.messages) {
			for (const msg of result.messages) {
				messages.push({
					role: "custom",
					customType: msg.customType,
					content: msg.content ?? [],
					display: msg.display,
					details: msg.details,
					timestamp: Date.now(),
				});
			}
		}
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);
	} catch (error) {
		preflightResult?.(false);
		throw error;
	}

	preflightResult?.(true, "started");
	assertCurrent();
	const turn = this._runAgentPrompt(messages, workflowDelivery?.promptStarted);
	workflowDelivery?.delivered?.("prompt");
	await turn;
}

export async function _runAgentPrompt(
	this: AgentSession,
	messages: AgentMessage | AgentMessage[],
	promptStarted?: () => void,
): Promise<void> {
	const lifetime = sessionLifetime(this);
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) {
		if (owner._queuedMessagesPaused) {
			const items = Array.isArray(messages) ? messages : [messages];
			for (const message of items) owner._queueAgentMessage(message, "steer");
			return;
		}
		return owner._runAgentPrompt(messages, promptStarted);
	}
	if (this._isEmittingAgentSettled) {
		this._deferredSettledActions.push(async () => await this._runAgentPrompt(messages, promptStarted));
		return;
	}
	if (this._activePromptCount === 0 && !this.isStreaming) this._agentRunAbortRequested = false;
	this._activePromptCount += 1;
	try {
		if (this._subagentMessageAdmission) {
			await this._subagentMessageAdmission.waitForPendingDeliveries();
			if (!this._subagentMessageAdmission.isOpen()) return;
		}
		const pendingPriority = preparePriorityContinuation(this);
		if (pendingPriority) await pendingPriority;
		if (this._agentRunAbortRequested) {
			if (this.isStreaming || this._queuedMessagesPaused) return;
			this._agentRunAbortRequested = false;
		}
		// An explicit stop may win during input preflight or priority preparation.
		// Preserve the prepared input without opening a native turn past that gate.
		if (this._queuedMessagesPaused) {
			const items = Array.isArray(messages) ? messages : [messages];
			for (const message of items) this._queueAgentMessage(message, "steer");
			return;
		}
		if (this._disposed || lifetime.aborted || sessionGenerationClosing.has(this))
			throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
		const turn = this.agent.prompt(messages);
		if (this.isStreaming) promptStarted?.();
		await turn;
		await this.waitForRetry();
		if (
			this._agentRunAbortRequested &&
			!this._queuedMessagesPaused &&
			this._protectedStreamingCustomMessages?.some((entry) => entry.phase === "queued")
		) {
			this._agentRunAbortRequested = false;
		}
		// Abort still has to answer a queued message already in the transcript.
		// `_continueQueuedAgentMessages` skips remaining queue drains while abort
		// is requested; skipping it entirely reintroduces issue #2362.
		await this._continueQueuedAgentMessages();
		if (this._agentRunAbortRequested) return;
		await this._awaitPendingPostCompactionContinuation();
		await runBeforeSettleContinuations(this);
	} finally {
		this._runSystemPromptOptions = undefined;
		this._cacheWarmer?.onAgentSettled();
		await this._agentEventQueue;
		this._flushPendingCustomMessages();
		this._isEmittingAgentSettled = true;
		try {
			if (typeof this._extensionRunner?.emit === "function") {
				await this._extensionRunner.emit({ type: "agent_settled" });
			}
			this._emit?.({ type: "agent_settled" });
		} finally {
			this._isEmittingAgentSettled = false;
		}
		if (this._subagentMessageAdmission) await settleSubagentMessages(this);
		this._activePromptCount -= 1;
		// Runs deferred by agent_settled handlers start only after every settled handler completed.
		// Guarded because prompt-handshake suites drive this function on a synthetic session.
		const deferred = this._deferredSettledActions?.splice(0) ?? [];
		for (const action of deferred) await action();
	}
}

/**
 * Give `agent_before_settle` handlers a chance to append entries and request one explicit
 * continuation before the run settles. Each continuation is followed by the same queued
 * and post-compaction drains as the initial run, then the boundary is offered again.
 */
async function runBeforeSettleContinuations(session: AgentSession): Promise<void> {
	// Guarded because prompt-handshake suites drive this function on a synthetic session.
	if (typeof session._extensionRunner?.hasHandlers !== "function") return;
	if (typeof session._runBeforeSettleBoundary !== "function") return;
	while (!session._agentRunAbortRequested) {
		await session._agentEventQueue?.catch(() => {});
		if (!(await session._runBeforeSettleBoundary())) return;
		// An explicit stop or a paused queue keeps the requested continuation pending.
		if (session._agentRunAbortRequested || session._queuedMessagesPaused || session._stopAfterTurnBlockedContinuation)
			return;
		await session._runAgentContinue();
		if (session._agentRunAbortRequested) return;
		await session._awaitPendingPostCompactionContinuation();
	}
}

async function settleSubagentMessages(session: AgentSession): Promise<void> {
	const admission = session._subagentMessageAdmission!;
	// A host-requested stop is terminal for a child, like cancellation. Retain
	// protected input for persistence without restarting work or spinning on it.
	if (session._stopAfterTurnBlockedContinuation) session.pauseQueuedMessages();
	// Keep receiving while admitted input is answered. Seal synchronously only
	// after both producer commits and native continuations have drained.
	do {
		await admission.waitForPendingDeliveries();
		await session._continueQueuedAgentMessages();
		if (session._stopAfterTurnBlockedContinuation) session.pauseQueuedMessages();
	} while (admission.hasPendingDeliveries() || (!session._queuedMessagesPaused && session.agent.hasQueuedMessages()));
	admission.seal();
}

export async function _runAgentContinue(this: AgentSession): Promise<void> {
	if (this._agentRunAbortRequested) return;
	await this.agent.continue();
	await this.waitForRetry();
	await this._continueQueuedAgentMessages();
}

/** Restore priority input the moment the native loop can poll it again. */
function preparePriorityContinuation(session: AgentSession): Promise<void> | undefined {
	const boundary = session._subagentMessageAdmission ?? session._workflowStageAdmission;
	// Explicit SDK interrupts own a native turn and the shared hold. An admitted
	// receiver's task must join that owner before checking its priority input;
	// otherwise it can settle before the interrupt finalizer restores the queue.
	if (boundary && session._pendingInterruptDeliveries > 0) {
		return session._interruptDeliveryQueue.then(() => preparePriorityContinuation(session));
	}
	const restore = (): void => {
		if (!session._priorityInterruptPending) return;
		session._priorityInterruptPending = false;
		session._restoreAndClearActiveInterruptQueueHold();
	};
	// Keep the idle prompt start synchronous unless a producer commit is still in flight.
	if (!boundary?.hasMessageDeliveries()) {
		restore();
		return undefined;
	}
	// A producer can enqueue an explicit SDK interrupt while this await yields.
	// Recheck its ownership before restoring the shared hold.
	return boundary.waitForMessageDeliveries().then(() => preparePriorityContinuation(session));
}

export async function _continueQueuedAgentMessages(this: AgentSession): Promise<void> {
	await this._agentEventQueue;
	await preparePriorityContinuation(this);

	if (
		!this._agentRunAbortRequested &&
		!this._stopAfterTurnBlockedContinuation &&
		!this._queuedMessagesPaused &&
		this.agent.hasQueuedMessages()
	) {
		while (
			!this._agentRunAbortRequested &&
			!this._stopAfterTurnBlockedContinuation &&
			!this._queuedMessagesPaused &&
			this.agent.hasQueuedMessages()
		) {
			await this.agent.continue();
			await this.waitForRetry();
			await this._agentEventQueue;
			await preparePriorityContinuation(this);
		}
	}
	if (this._stopAfterTurnBlockedContinuation) return;

	await answerAdmittedQueuedMessage(this);
}

/**
 * Answer a queued message the agent loop already admitted into the transcript but
 * never replied to.
 *
 * `pauseQueuedMessages()` can only hold entries still sitting in the agent's own
 * steering/follow-up queues. Once the loop has polled a message it lives inside the
 * loop, is pushed into the transcript on the next iteration, and an interrupt at that
 * moment leaves it with a contentless aborted assistant reply. The message is no
 * longer queued and no longer held, so neither the pause release nor the queued
 * continuation above schedules the turn it is waiting for (issue #2362).
 *
 * This is deliberately disjoint from the paused-hold contract: a *held* message is
 * still released without starting a turn, while an *admitted* one gets its reply.
 */
async function answerAdmittedQueuedMessage(session: AgentSession): Promise<void> {
	const admitted = session._admittedQueuedMessageAwaitingReply;
	// One attempt per admission: clear before continuing so an interrupt of the
	// recovery turn ends the sequence instead of restarting it.
	session._admittedQueuedMessageAwaitingReply = undefined;
	if (admitted === undefined || session._disposed) return;
	// An interrupt delivery already in flight aborts this reply and then starts its
	// own turn, so continuing concurrently would reject the caller's prompt() with
	// "Agent is already processing." Wait for it on the same boundary the resume
	// path uses, then let the checks below re-read the transcript: a delivery that
	// started its own turn changes the tail so they decline, while one that only
	// joined a paused hold leaves the admitted message still waiting for its reply.
	if (session._pendingInterruptDeliveries > 0) {
		await session._interruptDeliveryQueue;
		if (session._disposed) return;
	}

	const messages = session.agent.state.messages;
	let replyIndex = messages.length - 1;
	while (replyIndex >= 0 && messages[replyIndex]?.role === "system") replyIndex--;
	const reply = messages[replyIndex];
	// Only an interrupt that produced nothing is recoverable. A partially streamed
	// reply already answered the message; restarting it would duplicate output.
	if (reply?.role !== "assistant" || reply.stopReason !== "aborted" || assistantHasRecoverableOutput(reply)) return;
	const message = messages[replyIndex - 1];
	if (message?.role !== "user" || session._getUserMessageText(message) !== admitted) return;

	// Omit the empty aborted reply from the model projection so `continue()` resumes
	// from the admitted user message. Raw session history keeps it, as the retry paths do.
	session._omitRecoveryAttempt(reply);
	// Publish this turn before it starts. It begins after the pause abort boundary
	// resolves, so a submission that only waited for that boundary would race it
	// and be rejected by the streaming guard while the queue is still paused.
	const recovery = (async () => {
		await session.agent.continue();
		await session.waitForRetry();
		await session._agentEventQueue;
	})();
	const settled = recovery.catch(() => undefined);
	session._admittedRecoveryTurn = settled;
	try {
		await recovery;
	} finally {
		if (session._admittedRecoveryTurn === settled) session._admittedRecoveryTurn = undefined;
	}
}

/**
 * Try to execute an extension command. Returns true if command was found and executed.
 */

export async function _tryExecuteExtensionCommand(this: AgentSession, text: string): Promise<boolean> {
	// Parse command name and args
	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const command = this._extensionRunner.getCommand(commandName);
	if (!command) return false;

	// Get command context from extension runner (includes session control methods)
	const ctx = this._extensionRunner.createCommandContext();

	try {
		await runCallback(
			{ kind: "extension.hook", name: `command:${commandName}`, sourcePath: command.sourceInfo.path },
			() => command.handler(args, ctx),
		);
		return true;
	} catch (err) {
		// Emit error via extension runner
		this._extensionRunner.emitError({
			extensionPath: `command:${commandName}`,
			event: "command",
			error: err instanceof Error ? err.message : String(err),
		});
		return true;
	}
}

/**
 * Expand skill commands (/skill:name args) to their full content.
 * Returns the expanded text, or the original text if not a skill command or skill not found.
 * Emits errors via extension runner if file read fails.
 */

export function _expandSkillCommand(this: AgentSession, text: string): string {
	if (!text.startsWith("/skill:")) return text;

	const spaceIndex = text.indexOf(" ");
	const selector = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	const resolution = getSkillCatalog(this.resourceLoader).resolve(selector);
	if (!resolution.ok) {
		if (selector.includes("@")) {
			this._extensionRunner.emitError({
				extensionPath: `skill:${selector}`,
				event: "skill_expansion",
				error: resolution.message,
			});
		}
		return text;
	}
	const { skill, id } = resolution.candidate;

	try {
		const content = readFileSync(skill.filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		const skillBlock = `<skill name="${selector}" location="${skill.filePath}" candidate="${id}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return args ? `${skillBlock}\n\n${args}` : skillBlock;
	} catch (err) {
		// Emit error like extension commands do
		this._extensionRunner.emitError({
			extensionPath: skill.filePath,
			event: "skill_expansion",
			error: err instanceof Error ? err.message : String(err),
		});
		return text; // Return original on error
	}
}

async function queueUserInput(
	session: AgentSession,
	text: string,
	images: ImageContent[] | undefined,
	behavior: "steer" | "followUp",
	source: NonNullable<PromptOptions["source"]>,
): Promise<QueuedInputDisposition> {
	assertSessionOpen(session);
	const owner = resolveWorkflowStageDeliveryTarget(session);
	if (owner !== session) return queueUserInput(owner, text, images, behavior, source);
	return trackSessionWork(session, () => admittedQueueUserInput(session, text, images, behavior, source));
}

async function admittedQueueUserInput(
	session: AgentSession,
	text: string,
	images: ImageContent[] | undefined,
	behavior: "steer" | "followUp",
	source: NonNullable<PromptOptions["source"]>,
): Promise<QueuedInputDisposition> {
	const lifetime = sessionLifetime(session);
	if (text.startsWith("/")) session._throwIfExtensionCommand(text);
	if (session._extensionRunner?.hasHandlers("input")) {
		const result = await session._extensionRunner.emitInput(
			text,
			images,
			source,
			session.isStreaming ? behavior : undefined,
		);
		assertSessionOpen(session);
		if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
		if (result.action === "handled") return "handled";
		if (result.action === "transform") {
			text = result.text;
			images = result.images ?? images;
		}
	}
	const expandedText = expandPromptTemplate(session._expandSkillCommand(text), [...session.promptTemplates]);
	if (behavior === "steer") await session._queueSteer(expandedText, images);
	else await session._queueFollowUp(expandedText, images);
	return "queued";
}

/**
 * Queue a steering message while the agent is running.
 * Delivered after the current assistant turn finishes executing its tool calls,
 * before the next LLM call.
 * Expands skill commands and prompt templates. Errors on extension commands.
 * @param images Optional image attachments to include with the message
 * @throws Error if text is an extension command
 */

export async function steer(
	this: AgentSession,
	text: string,
	images?: ImageContent[],
	options?: Pick<PromptOptions, "source">,
): Promise<QueuedInputDisposition> {
	return queueUserInput(this, text, images, "steer", options?.source ?? "interactive");
}

/**
 * Queue a follow-up message to be processed after the agent finishes.
 * Delivered only when agent has no more tool calls or steering messages.
 * Expands skill commands and prompt templates. Errors on extension commands.
 * @param images Optional image attachments to include with the message
 * @throws Error if text is an extension command
 */

export async function followUp(
	this: AgentSession,
	text: string,
	images?: ImageContent[],
	options?: Pick<PromptOptions, "source">,
): Promise<QueuedInputDisposition> {
	return queueUserInput(this, text, images, "followUp", options?.source ?? "interactive");
}

/**
 * Send a user message and trigger a turn.
 *
 * By default the text is delivered literally: extension commands are not
 * dispatched and skill commands / prompt templates are not expanded. Set
 * `expandPromptTemplates: true` to dispatch a registered extension or skill
 * command (or expand a prompt template) instead of sending the raw text —
 * with that option the message may DISPATCH a command rather than be sent.
 *
 * @param content User message content (string or content array)
 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
 */
export async function sendUserMessage(
	this: AgentSession,
	content: string | (TextContent | ImageContent)[],
	options?: {
		deliverAs?: "steer" | "followUp";
		expandPromptTemplates?: boolean;
		__workflowDelivery?: PromptOptionsWithWorkflowDelivery["__workflowDelivery"];
	},
): Promise<void> {
	// Normalize content to text string + optional images
	let text: string;
	let images: ImageContent[] | undefined;

	if (typeof content === "string") {
		text = content;
	} else {
		const textParts: string[] = [];
		images = [];
		for (const part of content) {
			if (part.type === "text") {
				textParts.push(part.text);
			} else {
				images.push(part);
			}
		}
		text = textParts.join("\n");
		if (images.length === 0) images = undefined;
	}

	// prompt() owns command dispatch and template expansion; the default (false)
	// keeps every pre-existing caller sending literally. The private delivery hook
	// lets workflow routing report and gate the branch selected after asynchronous
	// input/compaction extension preflight.
	await this.prompt(text, {
		expandPromptTemplates: options?.expandPromptTemplates ?? false,
		streamingBehavior: options?.deliverAs,
		images,
		source: "extension",
		__workflowDelivery: options?.__workflowDelivery,
	} as PromptOptionsWithWorkflowDelivery);
}

/**
 * Clear all queued messages and return them.
 * Useful for restoring to editor when user aborts.
 * @returns Object with steering and followUp arrays
 */

export const agentSessionPromptMethods = {
	prompt,
	_runAgentPrompt,
	_runAgentContinue,
	_continueQueuedAgentMessages,
	_tryExecuteExtensionCommand,
	_expandSkillCommand,
	steer,
	followUp,
	sendUserMessage,
};
