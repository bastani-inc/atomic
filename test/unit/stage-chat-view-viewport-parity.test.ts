import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { StageChatViewOpts } from "../../packages/workflows/src/tui/stage-chat-view-types.js";
import {
	assert,
	createStore,
	deriveGraphTheme,
	flush,
	makeHandle,
	makeTestTui,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";

const WHEEL_UP = "\x1b[<64;10;10M";
const ALT_WHEEL_UP = "\x1b[<72;10;10M";

/** A running stage chat with enough exchanged messages to scroll, inheriting `settings` from its host. */
async function scrollableStageChat(settings: ReturnType<NonNullable<StageChatViewOpts["getChatRenderSettings"]>>) {
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "pending");
	const { handle } = makeHandle();
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(20),
		piKeybindings: keys,
		getChatRenderSettings: () => settings,
	});
	for (let i = 0; i < 18; i++) {
		for (const ch of `parity-msg-${i}`) view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
	}
	return {
		view,
		text: () => view.render(80).map((line) => stripVTControlCharacters(line)),
		dispose() {
			view.dispose();
			setKeybindings(previous);
		},
	};
}

test("a stage chat's wheel honours fullscreenWheelScrollLines and Alt multiplies it (#4521)", async () => {
	const chat = await scrollableStageChat({ fullscreenWheelScrollLines: 2 });
	try {
		chat.text();
		assert.equal(chat.view.handleInput(WHEEL_UP), true);
		assert.equal(chat.view._bodyScrollFromBottom, 2);
		chat.view.handleInput(ALT_WHEEL_UP);
		assert.equal(chat.view._bodyScrollFromBottom, 12);
	} finally {
		chat.dispose();
	}
});

test("a stage chat paints the scrollbar fullscreenScrollbar asks for (#4521)", async () => {
	const always = await scrollableStageChat({ fullscreenScrollbar: "always" });
	try {
		const bodyRows = always.text().filter((line) => /parity-msg-/.test(line));
		assert.ok(bodyRows.length > 0);
		assert.ok(
			bodyRows.every((line) => /[│┃]\s*$/.test(line)),
			"every transcript row ends in the scrollbar column",
		);
	} finally {
		always.dispose();
	}
	const hidden = await scrollableStageChat({ fullscreenScrollbar: "hidden" });
	try {
		assert.ok(hidden.text().every((line) => !/parity-msg-.*[│┃]\s*$/.test(line)));
	} finally {
		hidden.dispose();
	}
});

test("a stage chat scrolled up shows the shared jump-to-latest row and still reaches its first row (#4521)", async () => {
	const chat = await scrollableStageChat({ fullscreenWheelScrollLines: 3 });
	try {
		assert.ok(chat.text().every((line) => !line.includes("Jump to latest message")));
		chat.view.handleInput(WHEEL_UP);
		assert.ok(chat.text().some((line) => line.includes("↓ Jump to latest message · ctrl+end")));
		chat.view.handleInput("\x1b[1;5H");
		const top = chat.text();
		assert.ok(
			top.some((line) => line.includes("parity-msg-0")),
			"the first message is reachable",
		);
		assert.ok(top.some((line) => line.includes("Jump to latest message")));
		chat.view.handleInput("\x1b[1;5F");
		assert.ok(chat.text().every((line) => !line.includes("Jump to latest message")));
	} finally {
		chat.dispose();
	}
});

test("a stage chat jumps between its prompts with ctrl+up and ctrl+down (#4521)", async () => {
	const chat = await scrollableStageChat({});
	try {
		const firstVisible = () => {
			const match = chat
				.text()
				.join("\n")
				.match(/parity-msg-(\d+)/);
			return Number(match?.[1]);
		};
		const latest = firstVisible();
		assert.equal(chat.view.handleInput("\x1b[1;5A"), true);
		assert.equal(firstVisible(), latest, "the prompt whose text is the top row starts one row higher");
		assert.equal(chat.text()[2]?.trim(), "", "its prompt mark row is now the first body row");
		chat.view.handleInput("\x1b[1;5A");
		assert.equal(firstVisible(), latest - 1, "each further ctrl+up parks the previous prompt at the top");
		chat.view.handleInput("\x1b[1;5B");
		assert.equal(firstVisible(), latest);
	} finally {
		chat.dispose();
	}
});
