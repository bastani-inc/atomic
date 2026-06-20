import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ATOMIC_GUIDE_COMMAND_NAME, ATOMIC_GUIDE_HELP_CHOICES, atomicGuideModeForChoice, getAtomicGuideMessage, isAtomicGuideHelpChoice, normalizeAtomicGuideMode } from "./atomic-guide-command.ts";
import { formatAuthStorageLoadFailedMessage, formatNoApiKeyFoundMessage, formatNoModelSelectedMessage, formatUnresolvedModelMessage } from "./auth-guidance.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { PromptOptions } from "./agent-session-types.ts";

export async function prompt(this: AgentSession, text: string, options?: PromptOptions): Promise<void> {
	const expandPromptTemplates = options?.expandPromptTemplates ?? true;
	const preflightResult = options?.preflightResult;
	let messages: AgentMessage[] | undefined;

	try {
		// Handle slash commands first (execute immediately, even during streaming).
		// Builtin and extension commands manage their own LLM interaction via custom messages.
		if (expandPromptTemplates && text.startsWith("/")) {
			const handledBuiltin = await this._tryExecuteBuiltinSlashCommand(text);
			if (handledBuiltin) {
				preflightResult?.(true);
				return;
			}

			const handledExtension = await this._tryExecuteExtensionCommand(text);
			if (handledExtension) {
				preflightResult?.(true);
				return;
			}
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
			preflightResult?.(true);
			return;
		}

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

		if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
			// A failed credential-store load (for example auth.json briefly locked
			// by a concurrent process, or invalid JSON) leaves an empty in-memory
			// credential set. That would otherwise be misreported here as
			// "No API key found" even though the credentials exist on disk. Surface
			// the real load failure instead so configured providers are not falsely
			// reported as unauthenticated (issue #1431).
			const authLoadError = this._modelRegistry.authStorage.getLoadError();
			if (authLoadError) {
				throw new Error(
					formatAuthStorageLoadFailedMessage(this.model.provider, authLoadError),
					{ cause: authLoadError },
				);
			}
			const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
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
					content: msg.content,
					display: msg.display,
					details: msg.details,
					timestamp: Date.now(),
				});
			}
		}
		// Apply extension-modified system prompt, or reset to base
		if (result?.systemPrompt) {
			this.agent.state.systemPrompt = result.systemPrompt;
		} else {
			// Ensure we're using the base prompt (in case previous turn had modifications)
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
	} catch (error) {
		preflightResult?.(false);
		throw error;
	}

	if (!messages) {
		return;
	}

	preflightResult?.(true);
	await this._runAgentPrompt(messages);
}


export async function _runAgentPrompt(this: AgentSession, messages: AgentMessage | AgentMessage[]): Promise<void> {
	await this.agent.prompt(messages);
	await this.waitForRetry();
	await this._continueQueuedAgentMessages();
}


export async function _continueQueuedAgentMessages(this: AgentSession): Promise<void> {
	await this._agentEventQueue;

	while (this.agent.hasQueuedMessages()) {
		await this.agent.continue();
		await this.waitForRetry();
		await this._agentEventQueue;
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
		await command.handler(args, ctx);
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
	const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

	const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
	if (!skill) return text; // Unknown skill, pass through

	try {
		const content = readFileSync(skill.filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
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
 * Internal: Queue a steering message (already expanded, no extension command check).
 */

export async function sendUserMessage(this: AgentSession, 
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp" },
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

	// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
	await this.prompt(text, {
		expandPromptTemplates: false,
		streamingBehavior: options?.deliverAs,
		images,
		source: "extension",
	});
}

/**
 * Clear all queued messages and return them.
 * Useful for restoring to editor when user aborts.
 * @returns Object with steering and followUp arrays
 */

export const agentSessionPromptMethods = {
	prompt,
	_runAgentPrompt,
	_continueQueuedAgentMessages,
	_tryExecuteBuiltinSlashCommand,
	_tryExecuteExtensionCommand,
	_expandSkillCommand,
	steer,
	followUp,
	sendUserMessage,
};
