import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function makeMode(options: { showCacheMissNotices?: boolean } = {}) {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		chatContainer: new Container(),
		streamingComponent: undefined,
		streamingMessage: undefined,
		addMessageToChat: vi.fn(),
		pendingTools: new Map(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 0,
		compactionQueuedMessages: [],
		workingVisible: false,
		stopWorkingLoader: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getRegisteredToolDefinition: () => undefined,
		settingsManager: {
			getShowCacheMissNotices: () => options.showCacheMissNotices ?? false,
			getShowImages: () => false,
			getImageWidthCells: () => 80,
			getShowTerminalProgress: () => false,
		},
		session: { retryAttempt: 0, modelRegistry: { find: () => undefined } },
		sessionManager: { getEntries: () => [], getCwd: () => import.meta.dir },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
	};
}

async function handleEvent(mode: object, event: object): Promise<void> {
	const handle = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: object,
		event: object,
	) => Promise<void>;
	await handle.call(mode, event);
}

describe("InteractiveMode assistant event recovery", () => {
	it.each([
		["missing", undefined],
		["null", null],
	] as const)("ignores an update with a %s message", async (_label, message) => {
		const mode = makeMode();

		await expect(handleEvent(mode, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "bad" },
		})).resolves.toBeUndefined();
		expect(mode.streamingComponent).toBeUndefined();
	});

	it.each([
		["missing", undefined],
		["null", null],
	] as const)("ignores an end with a %s message", async (_label, message) => {
		const mode = makeMode();

		await expect(handleEvent(mode, { type: "message_end", message })).resolves.toBeUndefined();
		expect(mode.streamingComponent).toBeUndefined();
	});

	it.each([
		["absent", undefined],
		["non-array", "bad"],
		["malformed", [null]],
	] as const)("ignores an assistant update with %s content", async (_label, content) => {
		const mode = makeMode();
		const message = content === undefined ? { role: "assistant" } : { role: "assistant", content };

		await expect(handleEvent(mode, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "bad" },
		})).resolves.toBeUndefined();
		expect(mode.streamingComponent).toBeUndefined();
	});

	it.each([
		["absent", undefined],
		["non-array", "bad"],
		["malformed", [null]],
	] as const)("ignores an assistant end with %s content", async (_label, content) => {
		const mode = makeMode();
		const message = content === undefined
			? { role: "assistant", stopReason: "stop" }
			: { role: "assistant", stopReason: "stop", content };

		await expect(handleEvent(mode, { type: "message_end", message })).resolves.toBeUndefined();
		expect(mode.streamingComponent).toBeUndefined();
	});

	it("skips cache-miss detection when an assistant end lacks cache stats", async () => {
		const mode = makeMode({ showCacheMissNotices: true });

		await expect(handleEvent(mode, {
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "stop" },
		})).resolves.toBeUndefined();
		expect(mode.streamingComponent).toBeUndefined();
	});

	it("renders valid update and end events when message_start was dropped", async () => {
		const mode = makeMode();
		const partial = assistantMessage("Recovered");
		await handleEvent(mode, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Recovered" },
		});

		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n"))).toContain("Recovered");
		expect(mode.streamingComponent).toBeDefined();

		const complete = assistantMessage("Recovered automatic follow-up");
		await handleEvent(mode, { type: "message_end", message: complete });

		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n")))
			.toContain("Recovered automatic follow-up");
		expect(mode.streamingComponent).toBeUndefined();
	});
	it.each([
		["custom", {
			role: "custom",
			customType: "status",
			content: "Background status",
			display: false,
			timestamp: 2,
		}],
		["declaration-merged", {
			role: "extensionProgress",
			progress: 0.5,
			label: "Working",
			timestamp: 2,
		}],
	] as const)("keeps the active assistant component across a valid %s message pair", async (_label, message) => {
		const mode = makeMode();
		await handleEvent(mode, { type: "message_start", message: assistantMessage("First draft") });
		const assistantEntry = mode.chatContainer.children[0];

		await handleEvent(mode, { type: "message_start", message });
		await handleEvent(mode, { type: "message_end", message });
		await handleEvent(mode, {
			type: "message_update",
			message: assistantMessage("Complete response"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " response" },
		});

		expect(mode.chatContainer.children).toEqual([assistantEntry]);
		expect(mode.streamingComponent).toBe(assistantEntry);
		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n"))).toContain("Complete response");
	});

	it("renders a valid end when the dropped start has no updates", async () => {
		const mode = makeMode();
		await handleEvent(mode, {
			type: "message_end",
			message: assistantMessage("Recovered final response"),
		});

		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n")))
			.toContain("Recovered final response");
		expect(mode.streamingComponent).toBeUndefined();
	});

	it("normalizes an aborted end before its recovery render", async () => {
		const mode = makeMode();
		mode.session.retryAttempt = 2;
		const aborted = {
			...assistantMessage(""),
			content: [],
			stopReason: "aborted" as const,
			errorMessage: "Request was aborted",
		};
		await handleEvent(mode, { type: "message_end", message: aborted });

		const rendered = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
		expect(rendered).toContain("Aborted after 2 retry attempts");
		expect(rendered).not.toContain("Operation aborted");
		expect(aborted.errorMessage).toBe("Aborted after 2 retry attempts");
	});

	it("recovers an aborted end-only tool call and shows its retry error", async () => {
		const mode = makeMode();
		mode.session.retryAttempt = 2;
		const aborted = {
			...assistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-1", name: "customTool", arguments: {} }],
			stopReason: "aborted" as const,
			errorMessage: "Request was aborted",
		};

		await handleEvent(mode, { type: "message_end", message: aborted });

		const rendered = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
		expect(rendered).toContain("Aborted after 2 retry attempts");
		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.pendingTools).toHaveLength(0);
		expect(mode.streamingComponent).toBeUndefined();
		expect(mode.streamingMessage).toBeUndefined();
	});

	it("recovers an error end-only tool call and shows its error", async () => {
		const mode = makeMode();
		const failed = {
			...assistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-1", name: "customTool", arguments: {} }],
			stopReason: "error" as const,
			errorMessage: "Provider failed",
		};

		await handleEvent(mode, { type: "message_end", message: failed });

		const rendered = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
		expect(rendered).toContain("Provider failed");
		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.pendingTools).toHaveLength(0);
		expect(mode.streamingComponent).toBeUndefined();
		expect(mode.streamingMessage).toBeUndefined();
	});

	it.each([
		["missing", undefined],
		["null", null],
		["roleless", {}],
		["malformed", { role: "assistant", content: "malformed", stopReason: "stop" }],
	] as const)("fences only assistant-owned tools after an end with a %s message", async (_label, message) => {
		const mode = makeMode();
		await handleEvent(mode, { type: "message_start", message: assistantMessage("First response") });
		const firstEntry = mode.chatContainer.children[0];
		await handleEvent(mode, {
			type: "tool_execution_start",
			toolCallId: "unrelated-tool",
			toolName: "customTool",
			args: {},
		});
		const unrelatedTool = mode.pendingTools.get("unrelated-tool");
		await handleEvent(mode, {
			type: "message_update",
			message: {
				...assistantMessage(""),
				content: [{ type: "toolCall" as const, id: "owned-tool", name: "customTool", arguments: {} }],
			},
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
		});
		const ownedTool = mode.pendingTools.get("owned-tool");

		await handleEvent(mode, { type: "message_end", message });

		expect(mode.streamingComponent).toBeUndefined();
		expect(mode.streamingMessage).toBeUndefined();
		expect(mode.pendingTools.get("unrelated-tool")).toBe(unrelatedTool);
		expect(mode.pendingTools.has("owned-tool")).toBe(false);

		await handleEvent(mode, {
			type: "message_update",
			message: assistantMessage("Second response"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Second response" },
		});

		expect(mode.chatContainer.children[0]).toBe(firstEntry);
		expect(mode.pendingTools.get("unrelated-tool")).toBe(unrelatedTool);
		expect(Reflect.get(ownedTool!, "isPartial")).toBe(false);
		expect(Reflect.get(ownedTool!, "result")).toMatchObject({ content: [], isError: true });
		const rendered = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
		expect(rendered).toContain("Second response");
	});

	it("closes streaming after a malformed assistant end before the next message", async () => {
		const mode = makeMode();
		await handleEvent(mode, { type: "message_start", message: assistantMessage("First draft") });
		await handleEvent(mode, {
			type: "message_update",
			message: assistantMessage("First response"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " response" },
		});
		const firstEntry = mode.chatContainer.children[0];
		const firstRender = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));

		await handleEvent(mode, {
			type: "message_end",
			message: { role: "assistant", content: "malformed", stopReason: "stop" },
		});

		expect(mode.streamingComponent).toBeUndefined();
		expect(mode.streamingMessage).toBeUndefined();
		expect(mode.chatContainer.children).toEqual([firstEntry]);
		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n"))).toBe(firstRender);

		await handleEvent(mode, { type: "message_start", message: assistantMessage("Second response") });

		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.chatContainer.children[0]).toBe(firstEntry);
		expect(mode.chatContainer.children[1]).not.toBe(firstEntry);
		const finalRender = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
		expect(finalRender).toContain("First response");
		expect(finalRender).toContain("Second response");
	});

	it("reclaims the announced tool row when execution starts immediately after a malformed end", async () => {
		const mode = makeMode();
		const toolCall = {
			...assistantMessage(""),
			content: [{ type: "toolCall" as const, id: "reclaimed-tool", name: "customTool", arguments: {} }],
			stopReason: "toolUse" as const,
		};
		await handleEvent(mode, {
			type: "message_update",
			message: toolCall,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
		});
		const announcedTool = mode.chatContainer.children[1];

		await handleEvent(mode, { type: "message_end", message: undefined });
		expect(mode.pendingTools.has("reclaimed-tool")).toBe(false);
		await handleEvent(mode, {
			type: "tool_execution_start",
			toolCallId: "reclaimed-tool",
			toolName: "customTool",
			args: {},
		});

		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.chatContainer.children[1]).toBe(announcedTool);
		expect(mode.pendingTools.get("reclaimed-tool")).toBe(announcedTool);
		await handleEvent(mode, {
			type: "tool_execution_update",
			toolCallId: "reclaimed-tool",
			partialResult: { content: [{ type: "text", text: "partial output" }] },
		});
		await handleEvent(mode, {
			type: "tool_execution_end",
			toolCallId: "reclaimed-tool",
			result: { content: [{ type: "text", text: "final output" }] },
			isError: false,
		});
		expect(mode.pendingTools.has("reclaimed-tool")).toBe(false);
		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n"))).toContain("final output");
	});

	it("settles a reclaimed tool when a follow-up starts before execution ends", async () => {
		const mode = makeMode();
		const toolCall = {
			...assistantMessage(""),
			content: [{ type: "toolCall" as const, id: "unfinished-tool", name: "customTool", arguments: {} }],
			stopReason: "toolUse" as const,
		};
		await handleEvent(mode, {
			type: "message_update",
			message: toolCall,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
		});
		const unfinishedTool = mode.chatContainer.children[1];

		await handleEvent(mode, { type: "message_end", message: undefined });
		await handleEvent(mode, {
			type: "tool_execution_start",
			toolCallId: "unfinished-tool",
			toolName: "customTool",
			args: {},
		});
		await handleEvent(mode, { type: "message_start", message: assistantMessage("Follow-up response") });
		await handleEvent(mode, {
			type: "tool_execution_end",
			toolCallId: "unfinished-tool",
			result: { content: [{ type: "text", text: "LATE_UNFINISHED_OUTPUT" }] },
			isError: false,
		});

		expect(mode.pendingTools.has("unfinished-tool")).toBe(false);
		expect(Reflect.get(unfinishedTool!, "isPartial")).toBe(false);
		expect(Reflect.get(unfinishedTool!, "result")).toMatchObject({ content: [], isError: true });
		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n")))
			.not.toContain("LATE_UNFINISHED_OUTPUT");
	});

	it("preserves safe tool-use end routing into the announced component", async () => {
		const mode = makeMode();
		const toolCall = {
			...assistantMessage(""),
			content: [{ type: "toolCall" as const, id: "safe-tool", name: "customTool", arguments: {} }],
			stopReason: "toolUse" as const,
		};
		await handleEvent(mode, {
			type: "message_update",
			message: toolCall,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
		});
		const announcedTool = mode.pendingTools.get("safe-tool");

		await handleEvent(mode, { type: "message_end", message: toolCall });
		expect(mode.pendingTools.get("safe-tool")).toBe(announcedTool);
		await handleEvent(mode, {
			type: "tool_execution_start",
			toolCallId: "safe-tool",
			toolName: "customTool",
			args: {},
		});
		await handleEvent(mode, {
			type: "tool_execution_end",
			toolCallId: "safe-tool",
			result: { content: [{ type: "text", text: "safe final output" }] },
			isError: false,
		});

		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.chatContainer.children[1]).toBe(announcedTool);
		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n"))).toContain("safe final output");
	});

	it("settles an orphaned tool and fences its late execution traffic after a follow-up starts", async () => {
		const mode = makeMode();
		const toolCall = {
			...assistantMessage(""),
			content: [{ type: "toolCall" as const, id: "stale-tool", name: "customTool", arguments: {} }],
			stopReason: "toolUse" as const,
		};
		await handleEvent(mode, {
			type: "message_update",
			message: toolCall,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
		});
		const staleToolEntry = mode.chatContainer.children[1];

		await handleEvent(mode, { type: "message_end", message: undefined });
		await handleEvent(mode, { type: "agent_end", messages: [] });
		await handleEvent(mode, { type: "agent_start" });
		await handleEvent(mode, { type: "message_start", message: assistantMessage("Follow-up response") });
		expect(Reflect.get(staleToolEntry!, "isPartial")).toBe(false);
		expect(Reflect.get(staleToolEntry!, "result")).toMatchObject({ content: [], isError: true });
		await handleEvent(mode, {
			type: "tool_execution_start",
			toolCallId: "stale-tool",
			toolName: "customTool",
			args: {},
		});
		await handleEvent(mode, {
			type: "tool_execution_update",
			toolCallId: "stale-tool",
			partialResult: { content: [{ type: "text", text: "LATE_STALE_UPDATE" }] },
		});
		await handleEvent(mode, {
			type: "tool_execution_end",
			toolCallId: "stale-tool",
			result: { content: [{ type: "text", text: "LATE_STALE_END" }] },
			isError: false,
		});

		const rendered = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
		expect(mode.pendingTools.has("stale-tool")).toBe(false);
		expect(mode.chatContainer.children).toHaveLength(3);
		expect(mode.chatContainer.children[1]).toBe(staleToolEntry);
		expect(rendered).toContain("Follow-up response");
		expect(rendered).not.toContain("LATE_STALE_UPDATE");
		expect(rendered).not.toContain("LATE_STALE_END");
	});
});
