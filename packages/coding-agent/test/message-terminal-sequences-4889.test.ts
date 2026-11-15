import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { type Component, type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { createCustomMessage } from "../src/core/messages.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Neutral escape codes: a window-title OSC, a clipboard OSC carrying base64 "hello", and a clear-screen CSI.
const TITLE_OSC = "\x1b]0;harmless title\x07";
const CLIPBOARD_OSC = "\x1b]52;c;aGVsbG8=\x07";
const CLEAR_CSI = "\x1b[2J";
const PAYLOAD_SEQUENCES = [TITLE_OSC, CLIPBOARD_OSC, CLEAR_CSI, "\x1b]0;", "\x1b]52;"];
const FRAME_END = "\x1b[?2026l";

class CapturingTerminal implements Terminal {
	columns = 100;
	rows = 40;
	kittyProtocolActive = true;
	readonly writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

async function renderOnScreen(component: Component): Promise<string> {
	const terminal = new CapturingTerminal();
	const tui = new TuiMainScreen(terminal);
	tui.addChild(component);
	tui.start();
	const deadline = Date.now() + 2_000;
	while (!terminal.writes.some((write) => write.includes(FRAME_END)) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	tui.stop();
	assert.ok(
		terminal.writes.some((write) => write.includes(FRAME_END)),
		"the screen rendered no frame",
	);
	return terminal.writes.join("");
}

function assertInert(output: string, visible: readonly string[]): void {
	for (const sequence of PAYLOAD_SEQUENCES) {
		assert.ok(!output.includes(sequence), `terminal output contains ${JSON.stringify(sequence)}`);
	}
	for (const text of visible) {
		assert.ok(output.includes(text), `visible text ${text} is missing`);
	}
}

function hostile(text: string): string {
	return `${TITLE_OSC}${text}${CLIPBOARD_OSC}${CLEAR_CSI}`;
}

const MARKDOWN = `${hostile("**bold words**")}\n\n- ${hostile("list item")}\n\n${hostile("plain\ttabbed")}`;
const VISIBLE = ["bold words", "list item", "plain"];

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("message Markdown strips raw terminal sequences (#4889)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("assistant text and thinking blocks reach the terminal without their terminal sequences (#4889)", async () => {
		const component = new AssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: hostile("thinking words") },
				{ type: "text", text: MARKDOWN },
			]),
		);
		assertInert(await renderOnScreen(component), [...VISIBLE, "thinking words"]);
	});

	test("user messages reach the terminal without their terminal sequences (#4889)", async () => {
		assertInert(await renderOnScreen(new UserMessageComponent(MARKDOWN)), VISIBLE);
	});

	test("custom messages reach the terminal without their terminal sequences (#4889)", async () => {
		const message = createCustomMessage("peer-note", MARKDOWN, true, undefined, new Date(0).toISOString());
		assertInert(await renderOnScreen(new CustomMessageComponent(message)), VISIBLE);
	});
});

test("message text drops stray control characters but keeps the text around them (#4889)", async () => {
	initTheme("dark");
	const output = await renderOnScreen(new UserMessageComponent("bell\x07ring\x1bend"));
	assert.ok(output.includes("bellringend"), "stray control characters are removed without replacement");
});
