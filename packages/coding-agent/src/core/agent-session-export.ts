import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { theme } from "../modes/interactive/theme/theme.ts";
import { resolvePath } from "../utils/paths.ts";
import { calculateContextTokens, estimateContextTokens } from "./compaction/index.ts";
import type { ContextUsage, ReplacedSessionContext } from "./extensions/index.ts";
import type { ToolHtmlRenderer } from "./export-html/index.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionBoundaryEntry, type SessionHeader } from "./session-manager.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { SessionStats } from "./agent-session-types.ts";

export function getSessionStats(this: AgentSession): SessionStats {
	const state = this.state;
	const userMessages = state.messages.filter((m) => m.role === "user").length;
	const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
	const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const message of state.messages) {
		if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			totalInput += assistantMsg.usage.input;
			totalOutput += assistantMsg.usage.output;
			totalCacheRead += assistantMsg.usage.cacheRead;
			totalCacheWrite += assistantMsg.usage.cacheWrite;
			totalCost += assistantMsg.usage.cost.total;
		}
	}

	return {
		sessionFile: this.sessionFile,
		sessionId: this.sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: state.messages.length,
		tokens: {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
		},
		cost: totalCost,
		contextUsage: this.getContextUsage(),
	};
}


export function getContextUsage(this: AgentSession): ContextUsage | undefined {
	const model = this.model;
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// We can only trust usage from an assistant that responded after the latest compaction.
	// If no such assistant exists, context token count is unknown until the next LLM response.
	const branchEntries = this.sessionManager.getBranch();
	const latestCompactionBoundary = getLatestCompactionBoundaryEntry(branchEntries);

	if (latestCompactionBoundary) {
		// Check if there's a valid assistant usage after the compaction boundary
		const compactionIndex = branchEntries.lastIndexOf(latestCompactionBoundary);
		let hasPostCompactionUsage = false;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
					const contextTokens = calculateContextTokens(assistant.usage, assistant.api);
					if (contextTokens > 0) {
						hasPostCompactionUsage = true;
					}
					break;
				}
			}
		}

		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const estimate = estimateContextTokens(this.messages);
	const percent = (estimate.tokens / contextWindow) * 100;

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent,
	};
}

/**
 * Export session to HTML.
 * @param outputPath Optional output path (defaults to session directory)
 * @returns Path to exported file
 */

export async function exportToHtml(this: AgentSession, outputPath?: string): Promise<string> {
	const themeName = this.settingsManager.getTheme();
	const [{ exportSessionToHtml }, { createToolHtmlRenderer }] = await Promise.all([
		import("./export-html/index.ts"),
		import("./export-html/tool-renderer.ts"),
	]);

	// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
	const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
		getToolDefinition: (name) => this.getToolDefinition(name),
		theme,
		cwd: this.sessionManager.getCwd(),
	});

	return await exportSessionToHtml(this.sessionManager, this.state, {
		outputPath,
		themeName,
		toolRenderer,
	});
}

/**
 * Export the current session branch to a JSONL file.
 * Writes the session header followed by all entries on the current branch path.
 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
 * @returns The resolved output file path.
 */

export function exportToJsonl(this: AgentSession, outputPath?: string): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: this.sessionManager.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: this.sessionManager.getCwd(),
	};

	const branchEntries = this.sessionManager.getBranch();
	const lines = [JSON.stringify(header)];

	// Re-chain parentIds to form a linear sequence
	let prevId: string | null = null;
	for (const entry of branchEntries) {
		const linear = { ...entry, parentId: prevId };
		lines.push(JSON.stringify(linear));
		prevId = entry.id;
	}

	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}

// =========================================================================
// Utilities
// =========================================================================

/**
 * Get text content of last assistant message.
 * Useful for /copy command.
 * @returns Text content, or undefined if no assistant message exists
 */

export function getLastAssistantText(this: AgentSession): string | undefined {
	const lastAssistant = this.messages
		.slice()
		.reverse()
		.find((m) => {
			if (m.role !== "assistant") return false;
			const msg = m as AssistantMessage;
			// Skip aborted messages with no content
			if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
			return true;
		});

	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of (lastAssistant as AssistantMessage).content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}

// =========================================================================
// Extension System
// =========================================================================


export function createReplacedSessionContext(this: AgentSession): ReplacedSessionContext {
	const context = Object.defineProperties(
		{},
		Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
	) as ReplacedSessionContext;
	context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
	context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
	return context;
}

/**
 * Check if extensions have handlers for a specific event type.
 */

export function hasExtensionHandlers(this: AgentSession, eventType: string): boolean {
	return this._extensionRunner.hasHandlers(eventType);
}

/**
 * Get the extension runner (for setting UI context and error handlers).
 */

export const agentSessionExportMethods = {
	getSessionStats,
	getContextUsage,
	exportToHtml,
	exportToJsonl,
	getLastAssistantText,
	createReplacedSessionContext,
	hasExtensionHandlers,
};
