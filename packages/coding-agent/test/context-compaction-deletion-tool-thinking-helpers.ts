import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, type CompactableTranscript } from "../src/core/compaction/index.ts";
import {
	assistantMessage,
	recentAssistantEntries,
	userMessage,
} from "./context-compaction-deletion-tool-helpers.js";

function protectedUserEntry(entryId: string): CompactableTranscript["entries"][number] {
	const text = "Current task starts a new turn.";
	return {
		entryId,
		entryType: "message",
		role: "user",
		text,
		tokenEstimate: 4,
		protected: true,
		contentBlocks: [],
		message: userMessage(text),
		toolCallIds: [],
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
		protectedUserEntry("entry-thinking-current-user"),
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", "entry-thinking-current-user", ...recentEntries.map((entry) => entry.entryId)],
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
		protectedUserEntry("entry-thinking-sibling-current-user"),
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", "entry-thinking-sibling-current-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}
