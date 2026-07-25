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

function makeMode() {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		chatContainer: new Container(),
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 0,
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		settingsManager: {
			getShowCacheMissNotices: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 80,
		},
		session: { retryAttempt: 0 },
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
});
