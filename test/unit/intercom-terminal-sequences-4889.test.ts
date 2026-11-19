import assert from "node:assert/strict";
import { type Component, stripTerminalSequences, type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { IntercomClient } from "../../packages/intercom/broker/client.ts";
import { renderContactSupervisorResult, renderIntercomResult } from "../../packages/intercom/result-renderers.ts";
import type { Message, SessionInfo } from "../../packages/intercom/types.ts";
import { ComposeOverlay } from "../../packages/intercom/ui/compose.ts";
import { InlineMessageComponent } from "../../packages/intercom/ui/inline-message.ts";
import { SessionListOverlay } from "../../packages/intercom/ui/session-list.ts";

// Neutral escape codes: a window-title OSC, a clipboard OSC carrying base64 "hello", and a clear-screen CSI.
const TITLE_OSC = "\x1b]0;harmless title\x07";
const CLIPBOARD_OSC = "\x1b]52;c;aGVsbG8=\x07";
const CLEAR_CSI = "\x1b[2J";
const PAYLOAD_SEQUENCES = [TITLE_OSC, CLIPBOARD_OSC, CLEAR_CSI, "\x1b]0;", "\x1b]52;"];

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

async function renderOnScreen(component: Component | ((tui: TuiMainScreen) => Component)): Promise<string> {
	const terminal = new CapturingTerminal();
	const tui = new TuiMainScreen(terminal);
	tui.addChild(typeof component === "function" ? component(tui) : component);
	tui.start();
	const deadline = Date.now() + 2_000;
	// A frame ends by closing synchronized output.
	while (!terminal.writes.some((write) => write.includes("\x1b[?2026l")) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	tui.stop();
	assert.ok(
		terminal.writes.some((write) => write.includes("\x1b[?2026l")),
		"the screen rendered no frame",
	);
	return terminal.writes.join("");
}

function assertNoPayloadSequences(output: string): void {
	for (const sequence of PAYLOAD_SEQUENCES) {
		assert.ok(!output.includes(sequence), `terminal output contains ${JSON.stringify(sequence)}`);
	}
}

function hostile(text: string): string {
	return `${TITLE_OSC}${text}${CLIPBOARD_OSC}${CLEAR_CSI}`;
}

const sender: SessionInfo = {
	id: "1a2b3c4d-1111-4222-8333-123456789abc",
	name: hostile("peer-name"),
	cwd: hostile("/peer/cwd"),
	model: hostile("peer-model"),
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

const message: Message = {
	id: "msg-4889",
	timestamp: 1,
	content: {
		text: hostile("message body\n\tindented line"),
		attachments: [{ type: "snippet", name: hostile("notes.txt"), content: hostile("attachment body") }],
	},
};

beforeAll(() => {
	initTheme("dark");
});

test("Intercom message card strips terminal sequences from the sender, cwd, text and attachments (#4889)", async () => {
	const output = await renderOnScreen(new InlineMessageComponent(sender, message, theme));
	assertNoPayloadSequences(output);
	for (const visible of ["peer-name", "peer/cwd", "message body", "indented line", "notes.txt"]) {
		assert.ok(output.includes(visible), `visible text ${visible} is missing`);
	}
	const lines = new InlineMessageComponent(sender, message, theme).render(100);
	assert.ok(
		lines.some((line) => line.includes("indented line")) && lines.some((line) => line.includes("message body")),
	);
	assert.ok(!lines.some((line) => line.includes("message body") && line.includes("indented line")), "newline kept");
});

test("Intercom message card strips terminal sequences from the heading and body text (#4889)", async () => {
	const component = new InlineMessageComponent(
		sender,
		message,
		theme,
		undefined,
		hostile("framed body\n\n📎 notes.txt\nattachment body"),
		hostile("Reply to your ask"),
	);
	const output = await renderOnScreen(component);
	assertNoPayloadSequences(output);
	for (const visible of ["Reply to your ask", "framed body", "attachment body"]) {
		assert.ok(output.includes(visible), `visible text ${visible} is missing`);
	}
});

test("Intercom session list strips terminal sequences from peer names, cwd and model (#4889)", async () => {
	const current: SessionInfo = {
		...sender,
		id: "f996d39d-5efd-41f7-8b01-22769b77873f",
		name: "self",
		cwd: hostile("/self/cwd"),
		model: hostile("self-model"),
	};
	const overlay = new SessionListOverlay(theme, new KeybindingsManager(), current, [sender], () => {});
	const output = await renderOnScreen(overlay);
	assertNoPayloadSequences(output);
	for (const visible of ["peer-name", "/peer/cwd", "peer-model", "/self/cwd", "self-model"]) {
		assert.ok(output.includes(visible), `visible text ${visible} is missing`);
	}
});

test("a narrow Intercom message card strips terminal sequences from the sender name (#4889)", () => {
	const narrow = { ...sender, name: `${TITLE_OSC}${CLEAR_CSI}` };
	const lines = new InlineMessageComponent(narrow, message, theme).render(2);
	assertNoPayloadSequences(lines.join(""));
	assert.equal(lines.length, 1);
	assert.equal(stripTerminalSequences(lines[0]), "..");
});

test("Intercom message card strips terminal sequences from the reply-to id (#4889)", async () => {
	const output = await renderOnScreen(
		new InlineMessageComponent(sender, { ...message, replyTo: hostile("reply-target") }, theme),
	);
	assertNoPayloadSequences(output);
	assert.ok(output.includes("Reply from"));
	assert.ok(!output.includes("reply-target"));
});

test("Intercom tool result strips terminal sequences from relayed reply text (#4889)", async () => {
	const rendered = renderIntercomResult(
		{ content: [{ type: "text", text: hostile("peer reply") }], details: { delivered: true } },
		{ isPartial: false, expanded: false },
		theme,
		{ isError: false, expanded: false } as Parameters<typeof renderIntercomResult>[3],
	);
	const output = await renderOnScreen(rendered);
	assertNoPayloadSequences(output);
	assert.ok(output.includes("peer reply"));
});

test("Intercom tool result strips terminal sequences from an expanded delivery reason (#4889)", async () => {
	const rendered = renderIntercomResult(
		{ content: [{ type: "text", text: "sent" }], details: { delivered: false, reason: hostile("peer reason") } },
		{ isPartial: false, expanded: true },
		theme,
		{ isError: false, expanded: true } as Parameters<typeof renderIntercomResult>[3],
	);
	const output = await renderOnScreen(rendered);
	assertNoPayloadSequences(output);
	const lines = rendered.render(100).map((line) => stripTerminalSequences(line).trim());
	assert.ok(
		lines.some((line) => line.includes("Refused · peer reason")),
		`reason line missing in ${JSON.stringify(lines)}`,
	);
});

test("contact_supervisor result strips terminal sequences from the reply and its parse issue (#4889)", async () => {
	const rendered = renderContactSupervisorResult(
		{
			content: [{ type: "text", text: hostile("supervisor reply") }],
			details: { delivered: true, structuredReplyParseError: hostile("parse issue") },
		},
		{ isPartial: false, expanded: false },
		theme,
		{ isError: false, expanded: false } as Parameters<typeof renderContactSupervisorResult>[3],
	);
	const output = await renderOnScreen(rendered);
	assertNoPayloadSequences(output);
	const lines = rendered.render(100).map((line) => stripTerminalSequences(line).trim());
	assert.ok(
		lines.some((line) => line.includes("supervisor reply")),
		`reply line missing in ${JSON.stringify(lines)}`,
	);
	assert.ok(
		lines.some((line) => line.includes("! Structured reply could not be parsed · parse issue")),
		`issue line missing in ${JSON.stringify(lines)}`,
	);
});

test("Intercom compose overlay strips terminal sequences from the target label, cwd and model (#4889)", async () => {
	const output = await renderOnScreen(
		(tui) =>
			new ComposeOverlay(
				tui,
				theme,
				new KeybindingsManager(),
				sender,
				hostile("peer-label"),
				{} as IntercomClient,
				() => {},
			),
	);
	assertNoPayloadSequences(output);
	for (const visible of ["peer-label", "/peer/cwd", "peer-model"]) {
		assert.ok(output.includes(visible), `visible text ${visible} is missing`);
	}
});

test("Intercom message card drops stray control characters but keeps the text around them (#4889)", async () => {
	const output = await renderOnScreen(
		new InlineMessageComponent(sender, { ...message, content: { text: "bell\x07ring\x1bend" } }, theme),
	);
	assert.ok(output.includes("bellringend"), "stray control characters are removed without replacement");
});

test("Intercom message card removes 8-bit control sequences and shows bidirectional overrides escaped", () => {
	const eightBit: Message = {
		id: "msg-c1",
		timestamp: 1,
		content: {
			text: "start \u009d52;c;aGVsbG8=\u009c \u0090q\u009c \u009b2J file \u202Etxt.exe\u202C end",
			attachments: [],
		},
	};
	const peer: SessionInfo = { ...sender, name: "peer \u009d0;title\u009c\u2066name\u2069", cwd: "/cwd" };
	const lines = new InlineMessageComponent(peer, eightBit, theme).render(120).join("\n");
	assert.ok(!/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/.test(lines), JSON.stringify(lines));
	assert.ok(!lines.includes("52;c;") && !lines.includes("0;title"), JSON.stringify(lines));
	assert.ok(lines.includes("file <U+202E>txt.exe<U+202C> end"), JSON.stringify(lines));
	assert.ok(lines.includes("peer <U+2066>name<U+2069>"), JSON.stringify(lines));
});
