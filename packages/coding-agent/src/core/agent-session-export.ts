import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AssistantMessage, Usage } from "@bastani/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.js";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { SessionStats } from "./agent-session-types.js";
import { calculateContextTokens, estimateProjectedContextTokens } from "./compaction/index.ts";
import type { ToolHtmlRenderer } from "./export-html/index.ts";
import type { ContextUsage, ReplacedSessionContext } from "./extensions/index.js";
import { CURRENT_SESSION_VERSION, getLatestCompactionBoundaryEntry, type SessionHeader } from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

export function getSessionStats(this: AgentSession): SessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	const totals = createUsageTotals();
	let latestAssistantUsage: Usage | undefined;
	for (const entry of this.sessionManager.getEntries()) {
		if (
			(entry.type === "usage" ||
				entry.type === "branch_summary" ||
				entry.type === "session_summary" ||
				entry.type === "compaction") &&
			entry.usage
		) {
			addUsageToTotals(totals, entry.usage);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") userMessages++;
		else if (message.role === "toolResult") {
			toolResults++;
			if ("usage" in message && message.usage) addUsageToTotals(totals, message.usage);
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistant = message as AssistantMessage;
			toolCalls += assistant.content.filter((content) => content.type === "toolCall").length;
			addUsageToTotals(totals, assistant.usage);
			latestAssistantUsage = assistant.usage;
		}
	}

	return {
		sessionFile: this.sessionFile,
		sessionId: this.sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: totals.input,
			output: totals.output,
			cacheRead: totals.cacheRead,
			cacheWrite: totals.cacheWrite,
			total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		},
		cost: totals.cost,
		contextUsage: this.getContextUsage(),
		latestAssistantUsage,
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
	const projection = this.sessionManager.buildSessionProjection();
	const branchEntries = this.sessionManager.getBranch();
	const latestCompactionBoundary = getLatestCompactionBoundaryEntry(branchEntries);

	if (latestCompactionBoundary) {
		// Only a projected (not omitted) assistant that responded after the boundary
		// carries trustworthy usage.
		const projectedAssistants = new Set(
			projection.entries.flatMap((entry) =>
				entry.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason !== "aborted" &&
						message.stopReason !== "error" &&
						calculateContextTokens(message.usage, message.api) > 0,
				)
					? [entry.sourceEntry.id]
					: [],
			),
		);
		const compactionIndex = branchEntries.findIndex((entry) => entry.id === latestCompactionBoundary.id);
		const hasPostCompactionUsage = branchEntries
			.slice(compactionIndex + 1)
			.some((entry) => projectedAssistants.has(entry.id));
		if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
	}

	const estimate = estimateProjectedContextTokens(projection, branchEntries);
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
 * @param options Optional export presentation settings; `themeName` overrides the
 * saved theme setting (e.g. with this run's --use-theme selection) when it names a
 * registered theme.
 * @returns Path to exported file
 */

export async function exportToHtml(
	this: AgentSession,
	outputPath?: string,
	options: { themeName?: string } = {},
): Promise<string> {
	const themeName = [options.themeName, this.settingsManager.getTheme()].find(
		(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
	);
	const [{ exportSessionToHtml }, { createToolHtmlRenderer }] = await Promise.all([
		import("./export-html/index.ts"),
		import("./export-html/tool-renderer.ts"),
	]);

	// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
	const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
		getToolRenderers: (name) => this.extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
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

export function exportToJsonl(
	this: AgentSession,
	outputPath?: string,
	options: { includeShareContext?: boolean } = {},
): string {
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
	if (options.includeShareContext) {
		const shareEntry = {
			type: "custom",
			id: randomUUID(),
			parentId: prevId,
			timestamp: new Date().toISOString(),
			customType: "atomic.share",
			data: {
				systemPrompt: this.systemPrompt,
				tools: this.agent.state.tools.map(({ name, description, parameters }) => ({
					name,
					description,
					parameters,
				})),
			},
		};
		lines.push(JSON.stringify(shareEntry));
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
	for (const message of this.messages.slice().reverse()) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		// Skip aborted messages with no content
		if (assistant.stopReason === "aborted" && assistant.content.length === 0) continue;
		let text = "";
		for (const content of assistant.content) {
			if (content.type === "text") text += content.text;
		}
		const trimmed = text.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
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
