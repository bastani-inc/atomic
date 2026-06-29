import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import {
	buildContextCompactionPrompt,
	type CompactableTranscript,
	contextCompact,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	prepareContextCompaction,
	validateContextDeletionRequest,
} from "../src/core/compaction/index.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type ContextCompactionEntry,
	type CustomMessageEntry,
	getLatestCompactionBoundaryEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";

let counter = 0;
let lastId: string | null = null;

export function resetIds(): void {
	counter = 0;
	lastId = null;
}

export function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

export function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function assistantTextWithoutUsage(text: string): AssistantMessage {
	const { usage: _usage, ...message } = assistantText(text);
	void _usage;
	return message as AssistantMessage;
}

export function assistantTextWithTotalUsage(text: string, totalTokens: number): AssistantMessage {
	const message = assistantText(text);
	return {
		...message,
		usage: {
			...message.usage!,
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
		},
	};
}

export function bashExecution(command: string, output: string, exitCode: number, excludeFromContext = false): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
		...(excludeFromContext ? { excludeFromContext: true } : {}),
	};
}

export function excludedBashExecution(command: string, output: string): AgentMessage {
	return bashExecution(command, output, 0, true);
}

export function excludedCustomAgentMessage(content: string): AgentMessage {
	return {
		role: "custom",
		customType: "test-custom",
		content,
		display: true,
		timestamp: Date.now(),
		excludeFromContext: true,
	} as AgentMessage;
}

export function assistantToolCall(toolCallId: string): AssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } }],
		stopReason: "toolUse",
	};
}

export function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

export function toolResultWithImage(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			{ type: "text", text },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		],
		isError: false,
		timestamp: Date.now(),
	};
}

export function entry(message: AgentMessage): SessionMessageEntry {
	const id = `entry-${counter++}`;
	const result: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return result;
}

export function customMessageEntry(content: string, excludeFromContext = false): CustomMessageEntry {
	const id = `entry-${counter++}`;
	const result: CustomMessageEntry = {
		type: "custom_message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		customType: "test-custom-entry",
		content,
		display: true,
		...(excludeFromContext ? { excludeFromContext: true } : {}),
	};
	lastId = id;
	return result;
}

export function contextEntry(targets: ContextCompactionEntry["deletedTargets"]): ContextCompactionEntry {
	const id = `entry-${counter++}`;
	const result: ContextCompactionEntry = {
		type: "context_compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		promptVersion: 1,
		deletedTargets: targets,
		protectedEntryIds: [],
		stats: {
			objectsBefore: 0,
			objectsAfter: 0,
			objectsDeleted: targets.length,
			tokensBefore: 0,
			tokensAfter: 0,
			percentReduction: 0,
		},
	};
	lastId = id;
	return result;
}

export function compactionEntry(summary: string, firstKeptEntryId: string, tokensBefore = 1234): CompactionEntry {
	const id = `entry-${counter++}`;
	const result: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore,
	};
	lastId = id;
	return result;
}


export {
	fauxAssistantMessage,
	registerFauxProvider,
	type AssistantMessage,
	type ToolResultMessage,
	buildContextCompactionPrompt,
	type CompactableTranscript,
	contextCompact,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	prepareContextCompaction,
	validateContextDeletionRequest,
	buildSessionContext,
	type CompactionEntry,
	type ContextCompactionEntry,
	type CustomMessageEntry,
	getLatestCompactionBoundaryEntry,
	type SessionEntry,
	type SessionMessageEntry,
};
