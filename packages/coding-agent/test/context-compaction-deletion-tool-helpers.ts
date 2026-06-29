import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, StreamOptions } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { buildContextCompactionPrompt, CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT, contextCompact, createContextDeletionTool, DEFAULT_COMPACTION_SETTINGS, type CompactableTranscript } from "../src/core/compaction/index.ts";
export function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}
export function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
export function recentAssistantEntries(prefix: string, count = 2): CompactableTranscript["entries"] {
	return Array.from({ length: count }, (_unused, index) => {
		const message = assistantMessage(`Recent assistant context ${prefix} ${index}`);
		return {
			entryId: `${prefix}-${index}`,
			entryType: "message" as const,
			role: "assistant" as const,
			text: `Recent assistant context ${prefix} ${index}`,
			tokenEstimate: 4,
			protected: true,
			contentBlocks: [],
			message,
			toolCallIds: [],
		};
	});
}
export function createTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const oldOne = assistantMessage("Old search output that can be deleted.");
	const oldTwo = assistantMessage("Old file read that can be deleted.");
	const recentEntries = recentAssistantEntries("entry-recent");
	const entries: CompactableTranscript["entries"] = [
			{
				entryId: "entry-user",
				entryType: "message",
				role: "user",
				text: "Keep the user's task protected.",
				tokenEstimate: 8,
				protected: true,
				contentBlocks: [],
				message: task,
				toolCallIds: [],
			},
			{
				entryId: "entry-old-1",
				entryType: "message",
				role: "assistant",
				text: "Old search output that can be deleted.",
				tokenEstimate: 8,
				protected: false,
				contentBlocks: [],
				message: oldOne,
				toolCallIds: [],
			},
			{
				entryId: "entry-old-2",
				entryType: "message",
				role: "assistant",
				text: "Old file read that can be deleted.",
				tokenEstimate: 8,
				protected: false,
				contentBlocks: [],
				message: oldTwo,
				toolCallIds: [],
			},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}
export function createProtectedTranscript(): CompactableTranscript {
	const oldTask = userMessage("Old protected user message stays unavailable for deletion.");
	const recentTask = userMessage("Recent protected user message stays unavailable for deletion.");
	const entries = [
		{
			entryId: "entry-old-user",
			entryType: "message" as const,
			role: "user" as const,
			text: "Old protected user message stays unavailable for deletion.",
			tokenEstimate: 12,
			protected: true,
			contentBlocks: [],
			message: oldTask,
			toolCallIds: [],
		},
		...Array.from({ length: 5 }, (_, index) => {
			const message = assistantMessage(`assistant context ${index}`);
			return {
				entryId: `entry-assistant-${index}`,
				entryType: "message" as const,
				role: "assistant" as const,
				text: `assistant context ${index}`,
				tokenEstimate: 4,
				protected: index > 0,
				contentBlocks: [],
				message,
				toolCallIds: [],
			};
		}),
		{
			entryId: "entry-recent-user",
			entryType: "message" as const,
			role: "user" as const,
			text: "Recent protected user message stays unavailable for deletion.",
			tokenEstimate: 8,
			protected: true,
			contentBlocks: [],
			message: recentTask,
			toolCallIds: [],
		},
	];
	return {
		entries,
		protectedEntryIds: [
			"entry-old-user",
			"entry-assistant-1",
			"entry-assistant-2",
			"entry-assistant-3",
			"entry-assistant-4",
			"entry-recent-user",
		],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}
export function createContentBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const multi = assistantMessage("alpha stale block\nbeta active block");
	const single = assistantMessage("single stale block");
	const recentEntries = recentAssistantEntries("entry-content-recent");
	const entries: CompactableTranscript["entries"] = [
			{
				entryId: "entry-user",
				entryType: "message",
				role: "user",
				text: "Keep the user's task protected.",
				tokenEstimate: 8,
				protected: true,
				contentBlocks: [],
				message: task,
				toolCallIds: [],
			},
			{
				entryId: "entry-multi",
				entryType: "message",
				role: "assistant",
				text: "alpha stale block\nbeta active block",
				tokenEstimate: 12,
				protected: false,
				contentBlocks: [
					{
						entryId: "entry-multi",
						blockIndex: 0,
						type: "text",
						text: "alpha stale block",
						tokenEstimate: 6,
						protected: false,
					},
					{
						entryId: "entry-multi",
						blockIndex: 1,
						type: "text",
						text: "beta active block",
						tokenEstimate: 6,
						protected: false,
					},
				],
				message: multi,
				toolCallIds: [],
			},
			{
				entryId: "entry-single",
				entryType: "message",
				role: "assistant",
				text: "single stale block",
				tokenEstimate: 6,
				protected: false,
				contentBlocks: [
					{
						entryId: "entry-single",
						blockIndex: 0,
						type: "text",
						text: "single stale block",
						tokenEstimate: 6,
						protected: false,
					},
				],
				message: single,
				toolCallIds: [],
			},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}
export function createProtectedContentBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const safe = assistantMessage("alpha safe stale block\nbeta active block");
	const protectedBlock = assistantMessage("alpha protected stale block\nprotected sibling block");
	const recentEntries = recentAssistantEntries("entry-protected-block-recent");
	const entries: CompactableTranscript["entries"] = [
		{
			entryId: "entry-user",
			entryType: "message",
			role: "user",
			text: "Keep the user's task protected.",
			tokenEstimate: 8,
			protected: true,
			contentBlocks: [],
			message: task,
			toolCallIds: [],
		},
		{
			entryId: "entry-safe-block",
			entryType: "message",
			role: "assistant",
			text: "alpha safe stale block\nbeta active block",
			tokenEstimate: 12,
			protected: false,
			contentBlocks: [
				{
					entryId: "entry-safe-block",
					blockIndex: 0,
					type: "text",
					text: "alpha safe stale block",
					tokenEstimate: 6,
					protected: false,
				},
				{
					entryId: "entry-safe-block",
					blockIndex: 1,
					type: "text",
					text: "beta active block",
					tokenEstimate: 6,
					protected: false,
				},
			],
			message: safe,
			toolCallIds: [],
		},
		{
			entryId: "entry-protected-block",
			entryType: "message",
			role: "assistant",
			text: "alpha protected stale block\nprotected sibling block",
			tokenEstimate: 12,
			protected: false,
			contentBlocks: [
				{
					entryId: "entry-protected-block",
					blockIndex: 0,
					type: "text",
					text: "alpha protected stale block",
					tokenEstimate: 6,
					protected: true,
				},
				{
					entryId: "entry-protected-block",
					blockIndex: 1,
					type: "text",
					text: "protected sibling block",
					tokenEstimate: 6,
					protected: false,
				},
			],
			message: protectedBlock,
			toolCallIds: [],
		},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}
export function createProtectedToolBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const callId = "call-protected-tool";
	const toolCallMessage = {
		...assistantMessage(""),
		content: [
			{ type: "text", text: "assistant text beside protected tool call" },
			{ type: "toolCall", id: callId, name: "read", arguments: { path: "protected.ts" } },
		],
		stopReason: "toolUse",
	} as AgentMessage;
	const resultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: "old result paired with protected tool call" }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
	const recentEntries = recentAssistantEntries("entry-protected-tool-recent");
	const entries: CompactableTranscript["entries"] = [
		{
			entryId: "entry-user",
			entryType: "message",
			role: "user",
			text: "Keep the user's task protected.",
			tokenEstimate: 8,
			protected: true,
			contentBlocks: [],
			message: task,
			toolCallIds: [],
		},
		{
			entryId: "entry-tool-call",
			entryType: "message",
			role: "assistant",
			text: "assistant text beside protected tool call\nread({\"path\":\"protected.ts\"})",
			tokenEstimate: 12,
			protected: false,
			contentBlocks: [
				{
					entryId: "entry-tool-call",
					blockIndex: 0,
					type: "text",
					text: "assistant text beside protected tool call",
					tokenEstimate: 6,
					protected: false,
				},
				{
					entryId: "entry-tool-call",
					blockIndex: 1,
					type: "toolCall",
					text: "read({\"path\":\"protected.ts\"})",
					tokenEstimate: 6,
					protected: true,
					toolCallId: callId,
				},
			],
			message: toolCallMessage,
			toolCallIds: [callId],
		},
		{
			entryId: "entry-tool-result",
			entryType: "message",
			role: "toolResult",
			text: "old result paired with protected tool call",
			tokenEstimate: 8,
			protected: false,
			contentBlocks: [],
			message: resultMessage,
			toolCallIds: [],
			toolResultFor: callId,
		},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}
export function createAssistantThinkingBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const thinkingMessage = {
		...assistantMessage(""),
		content: [{ type: "thinking", thinking: "single thinking sentinel", thinkingSignature: "sig-thinking" }],
	} as AgentMessage;
	const recentEntries = recentAssistantEntries("entry-thinking-recent");
	const entries: CompactableTranscript["entries"] = [
			{
				entryId: "entry-user",
				entryType: "message",
				role: "user",
				text: "Keep the user's task protected.",
				tokenEstimate: 8,
				protected: true,
				contentBlocks: [],
				message: task,
				toolCallIds: [],
			},
			{
				entryId: "entry-thinking",
				entryType: "message",
				role: "assistant",
				text: "single thinking sentinel",
				tokenEstimate: 6,
				protected: false,
				contentBlocks: [
					{
						entryId: "entry-thinking",
						blockIndex: 0,
						type: "thinking",
						text: "single thinking sentinel",
						tokenEstimate: 6,
						protected: false,
					},
				],
				message: thinkingMessage,
				toolCallIds: [],
			},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}
export function createAssistantThinkingSiblingTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const thinkingMessage = {
		...assistantMessage(""),
		content: [
			{ type: "text", text: "visible sibling sentinel" },
			{ type: "thinking", thinking: "paired thinking sentinel", thinkingSignature: "sig-thinking" },
		],
	} as AgentMessage;
	const recentEntries = recentAssistantEntries("entry-thinking-sibling-recent");
	const entries: CompactableTranscript["entries"] = [
			{
				entryId: "entry-user",
				entryType: "message",
				role: "user",
				text: "Keep the user's task protected.",
				tokenEstimate: 8,
				protected: true,
				contentBlocks: [],
				message: task,
				toolCallIds: [],
			},
			{
				entryId: "entry-thinking-sibling",
				entryType: "message",
				role: "assistant",
				text: "visible sibling sentinel\npaired thinking sentinel",
				tokenEstimate: 10,
				protected: false,
				contentBlocks: [
					{
						entryId: "entry-thinking-sibling",
						blockIndex: 0,
						type: "text",
						text: "visible sibling sentinel",
						tokenEstimate: 4,
						protected: false,
					},
					{
						entryId: "entry-thinking-sibling",
						blockIndex: 1,
						type: "thinking",
						text: "paired thinking sentinel",
						tokenEstimate: 6,
						protected: false,
					},
				],
				message: thinkingMessage,
				toolCallIds: [],
			},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}
export { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Context, type StreamOptions, buildContextCompactionPrompt, CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT, contextCompact, createContextDeletionTool, DEFAULT_COMPACTION_SETTINGS, type CompactableTranscript };
