import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { PromptOptions } from "./agent-session-types.ts";
import {
	ATOMIC_GUIDE_COMMAND_NAME,
	ATOMIC_GUIDE_HELP_CHOICES,
	atomicGuideModeForChoice,
	getAtomicGuideMessage,
	isAtomicGuideHelpChoice,
	normalizeAtomicGuideMode,
} from "./atomic-guide-command.ts";
import {
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatUnresolvedModelMessage,
} from "./auth-guidance.ts";
import { runCallback } from "./callback-activity.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
import { getSkillCatalog } from "./skill-catalog.ts";

type UserMessageDeliveryAction = "prompt" | "steer" | "followUp" | "handled";

type PromptOptionsWithWorkflowDelivery = PromptOptions & {
	readonly __workflowDelivery?: {
		readonly beforeDelivery?: () => void;
		/** Called only after an idle prompt has synchronously entered the agent turn. */
		readonly promptStarted?: () => void;
		readonly delivered?: (action: UserMessageDeliveryAction) => void;
	};
};

/** Dispatch registered slash commands without changing the raw queue pause gate. */
export async function tryExecuteSessionSlashCommand(
	session: Pick<AgentSession, "_tryExecuteBuiltinSlashCommand" | "_tryExecuteExtensionCommand">,
	text: string,
): Promise<boolean> {
	if (!text.startsWith("/")) return false;
	if (await session._tryExecuteBuiltinSlashCommand(text)) return true;
	return session._tryExecuteExtensionCommand(text);
}

export async function prompt(this: AgentSession, text: string, options?: PromptOptions): Promise<void> {
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
			preflightResult?.(true);
			return;
		}
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
			preflightResult?.(true);
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
			if (inputResult.action === "handled") {
				workflowDelivery?.delivered?.("handled");
				preflightResult?.(true);
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

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
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
			preflightResult?.(true);
			return;
		}

		// A fallback model is scoped to the failing turn. Restore the user-selected
		// model before validating credentials for the next idle prompt.
		if (typeof this._restoreFallbackModel === "function") await this._restoreFallbackModel();
		// Flush any pending bash messages before the new prompt
		this._flushPendingBashMessages();

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
		}

		// Build messages array (custom message if any, then user message)
		messages = [];

		// Add user message
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (currentImages) {
			userContent.push(...currentImages);
		}
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

		// Emit before_agent_start extension event
		const result = await this._extensionRunner.emitBeforeAgentStart(
			expandedText,
			currentImages,
			this._baseSystemPrompt,
			this._baseSystemPromptOptions,
		);
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
		// Apply extension-modified system prompt, or reset to base
		if (result?.systemPrompt !== undefined) {
			this._systemPromptOverride = result.systemPrompt;
			this.agent.state.systemPrompt = result.systemPrompt;
		} else {
			// Ensure we're using the base prompt (in case previous turn had modifications)
			this._systemPromptOverride = undefined;
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
	} catch (error) {
		preflightResult?.(false);
		throw error;
	}

	preflightResult?.(true);
	const turn = this._runAgentPrompt(messages, workflowDelivery?.promptStarted);
	workflowDelivery?.delivered?.("prompt");
	await turn;
}

export async function _runAgentPrompt(
	this: AgentSession,
	messages: AgentMessage | AgentMessage[],
	promptStarted?: () => void,
): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) {
		if (owner._queuedMessagesPaused) {
			const items = Array.isArray(messages) ? messages : [messages];
			for (const message of items) owner._queueAgentMessage(message, "steer");
			return;
		}
		return owner._runAgentPrompt(messages, promptStarted);
	}
	try {
		const turn = this.agent.prompt(messages);
		if (this.isStreaming) promptStarted?.();
		await turn;
		await this.waitForRetry();
		await this._continueQueuedAgentMessages();
		await this._awaitPendingPostCompactionContinuation();
	} finally {
		this._systemPromptOverride = undefined;
		await this._agentEventQueue;
		if (typeof this._extensionRunner?.emit === "function") {
			await this._extensionRunner.emit({ type: "agent_settled" });
		}
		this._emit?.({ type: "agent_settled" });
	}
}

export async function _runAgentContinue(this: AgentSession): Promise<void> {
	await this.agent.continue();
	await this.waitForRetry();
	await this._continueQueuedAgentMessages();
}

export async function _continueQueuedAgentMessages(this: AgentSession): Promise<void> {
	await this._agentEventQueue;

	while (!this._queuedMessagesPaused && this.agent.hasQueuedMessages()) {
		await this.agent.continue();
		await this.waitForRetry();
		await this._agentEventQueue;
	}

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
	const reply = messages[messages.length - 1];
	// Only an interrupt that produced nothing is recoverable. A partially streamed
	// reply already answered the message; restarting it would duplicate output.
	if (reply?.role !== "assistant" || reply.stopReason !== "aborted" || reply.content.length > 0) return;
	const message = messages[messages.length - 2];
	if (message?.role !== "user" || session._getUserMessageText(message) !== admitted) return;

	// Drop the empty aborted reply from agent state so `continue()` resumes from the
	// admitted user message. The session history keeps it, as the retry paths do.
	session.agent.state.messages = messages.slice(0, -1);
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
 * Try to execute a built-in slash command. Returns true if command was found and executed.
 */

export async function _tryExecuteBuiltinSlashCommand(this: AgentSession, text: string): Promise<boolean> {
	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	if (commandName !== ATOMIC_GUIDE_COMMAND_NAME) return false;

	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
	const mode = normalizeAtomicGuideMode(args);
	if (mode === "help" && this._extensionUIContext) {
		const choice = await this._extensionUIContext.select("Atomic. Select where to start:", [
			...ATOMIC_GUIDE_HELP_CHOICES,
		]);
		if (!choice || !isAtomicGuideHelpChoice(choice)) return true;
		await this.sendCustomMessage(
			{
				customType: "atomic",
				content: getAtomicGuideMessage(atomicGuideModeForChoice(choice), this._cwd),
				display: true,
			},
			{ triggerTurn: false },
		);
		return true;
	}

	await this.sendCustomMessage(
		{
			customType: "atomic",
			content: getAtomicGuideMessage(mode, this._cwd),
			display: true,
		},
		{ triggerTurn: false },
	);
	return true;
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

/**
 * Queue a steering message while the agent is running.
 * Delivered after the current assistant turn finishes executing its tool calls,
 * before the next LLM call.
 * Expands skill commands and prompt templates. Errors on extension commands.
 * @param images Optional image attachments to include with the message
 * @throws Error if text is an extension command
 */

export async function steer(this: AgentSession, text: string, images?: ImageContent[]): Promise<void> {
	// Check for extension commands (cannot be queued)
	if (text.startsWith("/")) {
		this._throwIfExtensionCommand(text);
	}

	// Expand skill commands and prompt templates
	let expandedText = this._expandSkillCommand(text);
	expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

	await this._queueSteer(expandedText, images);
}

/**
 * Queue a follow-up message to be processed after the agent finishes.
 * Delivered only when agent has no more tool calls or steering messages.
 * Expands skill commands and prompt templates. Errors on extension commands.
 * @param images Optional image attachments to include with the message
 * @throws Error if text is an extension command
 */

export async function followUp(this: AgentSession, text: string, images?: ImageContent[]): Promise<void> {
	// Check for extension commands (cannot be queued)
	if (text.startsWith("/")) {
		this._throwIfExtensionCommand(text);
	}

	// Expand skill commands and prompt templates
	let expandedText = this._expandSkillCommand(text);
	expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

	await this._queueFollowUp(expandedText, images);
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
	_tryExecuteBuiltinSlashCommand,
	_tryExecuteExtensionCommand,
	_expandSkillCommand,
	steer,
	followUp,
	sendUserMessage,
};
