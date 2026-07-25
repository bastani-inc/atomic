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
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getRegisteredToolDefinition: () => undefined,
		settingsManager: {
			getShowCacheMissNotices: () => options.showCacheMissNotices ?? false,
			getShowImages: () => false,
			getImageWidthCells: () => 80,
		},
		session: { retryAttempt: 0, modelRegistry: { find: () => undefined } },
		sessionManager: { getEntries: () => [], getCwd: () => import.meta.dir },
		ui: { requestRender: vi.fn() },
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
	] as const)("closes active streaming after an end with a %s message", async (_label, message) => {
		const mode = makeMode();
		await handleEvent(mode, { type: "message_start", message: assistantMessage("First response") });
		const firstEntry = mode.chatContainer.children[0];
		const firstRender = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
		const pendingTool = {};
		mode.pendingTools.set("pending-1", pendingTool);

		await handleEvent(mode, { type: "message_end", message });

		expect(mode.streamingComponent).toBeUndefined();
		expect(mode.streamingMessage).toBeUndefined();
		expect(mode.pendingTools.get("pending-1")).toBe(pendingTool);
		expect(stripVTControlCharacters(mode.chatContainer.render(100).join("\n"))).toBe(firstRender);

		await handleEvent(mode, {
			type: "message_update",
			message: assistantMessage("Second response"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Second response" },
		});

		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.chatContainer.children[0]).toBe(firstEntry);
		expect(mode.chatContainer.children[1]).not.toBe(firstEntry);
		const rendered = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
		expect(rendered).toContain("First response");
		expect(rendered).toContain("Second response");
		expect(mode.pendingTools.get("pending-1")).toBe(pendingTool);
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
});
