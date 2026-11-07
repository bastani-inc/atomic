import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.ts";
import { SCROLLBAR_HIDE_DELAY_MS } from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";

const identity = (text: string): string => text;
const PAGE_UP = "\x1b[5~";

function hostOptions(overrides: Partial<ChatSessionHostOpts> = {}): ChatSessionHostOpts {
	return {
		style: {
			dim: identity,
			text: identity,
			textMuted: identity,
			accent: identity,
			accentBold: identity,
			rule: (_hex, text) => text,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: identity,
			selectList: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		},
		...overrides,
	};
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const text = (rows: readonly string[]) => stripVTControlCharacters(rows.join("\n"));

const longConversation = Array.from({ length: 60 }, (_, i) => ({
	role: "user" as const,
	content: `LINE-${i}`,
	timestamp: i,
}));

afterEach(() => {
	vi.useRealTimers();
});

test("a chat host opens a task's transcript as a chat of its own and hands back only what the inspector declines (#4521)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const transcript = SessionManager.inMemory();
	await transcript.appendMessage({ role: "user", content: "HOST-WIRED-MESSAGE", timestamp: 0 });
	const source = ownerTaskViewSource(fixture.store);
	const host = new ChatSessionHost(hostOptions({ getTaskSource: () => source }));
	try {
		await fixture.start("Wired transcript");
		fixture.runners[0]!.context.bindTranscript(transcript);
		assert.equal(host.handleTaskInput("\r"), false, "without an open inspector nothing takes the key");
		assert.equal(host.openTasks(), true);
		assert.equal(host.hasTaskInspector, true);
		assert.equal(host.handleTaskInput("\x14"), false, "Ctrl+T goes back to the chat");
		assert.equal(host.handleTaskInput("q"), true, "other keys stay with the inspector");
		host.handleTaskInput("\r");
		await flush();
		host.handleTaskInput("\r");
		await flush();
		const page = text(host.renderBody(80, 24));
		assert.match(page, /HOST-WIRED-MESSAGE/, "the transcript is a chat the host built");
		assert.doesNotMatch(page, /unavailable/);
		host.closeTasks();
		assert.equal(host.hasTaskInspector, false);
		assert.equal(host.handleTaskInput("\r"), false);
	} finally {
		host.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("a chat host without a repaint hook takes earlier and replaced history (#4521)", () => {
	initTheme("dark");
	const host = new ChatSessionHost(hostOptions());
	try {
		host.replaceMessages([{ role: "user", content: "LATEST", timestamp: 2 }]);
		host.prependMessages([{ role: "user", content: "EARLIER", timestamp: 1 }]);
		const body = text(host.renderBody(80, 20));
		assert.ok(body.indexOf("EARLIER") >= 0 && body.indexOf("EARLIER") < body.indexOf("LATEST"));
	} finally {
		host.dispose();
	}
});

test("prepending or replacing history repaints the host (#4521)", () => {
	initTheme("dark");
	let renders = 0;
	const host = new ChatSessionHost(hostOptions({ requestRender: () => renders++ }));
	try {
		const before = renders;
		host.prependMessages([{ role: "user", content: "EARLIER", timestamp: 1 }]);
		assert.equal(renders, before + 1);
		host.replaceMessages([{ role: "user", content: "LATEST", timestamp: 2 }]);
		assert.equal(renders, before + 2);
	} finally {
		host.dispose();
	}
});

test("the jump-to-latest row names the host's own bottom key, or the global one (#4521)", () => {
	initTheme("dark");
	for (const [keybindings, label] of [
		[new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+g" }), /Jump to latest message · ctrl\+g/],
		[undefined, /Jump to latest message · ctrl\+end/],
	] as const) {
		const host = new ChatSessionHost(hostOptions(keybindings === undefined ? {} : { keybindings }));
		try {
			host.replaceMessages(longConversation);
			host.renderBody(80, 10);
			host.handleInput(PAGE_UP);
			const rows = host.renderBody(80, 10);
			assert.match(text(rows.slice(-1)), label);
		} finally {
			host.dispose();
		}
	}
});

test("an auto scrollbar hides again through the host's repaint hook (#4521)", () => {
	vi.useFakeTimers();
	initTheme("dark");
	let renders = 0;
	const host = new ChatSessionHost(
		hostOptions({
			requestRender: () => renders++,
			getChatRenderSettings: () => ({ hideThinkingBlock: false, fullscreenScrollbar: "auto" }),
		}),
	);
	try {
		host.replaceMessages(longConversation);
		host.renderBody(80, 10);
		host.handleInput(PAGE_UP);
		host.renderBody(80, 10);
		const before = renders;
		vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
		assert.equal(renders, before + 1, "the hide timer asks the host to repaint");
	} finally {
		host.dispose();
	}
});
