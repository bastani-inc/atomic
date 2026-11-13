import assert from "node:assert/strict";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SessionInfo, SessionListProgress } from "../src/core/session-manager.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { SessionList } from "../src/modes/interactive/components/session-selector-list.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

function session(id: string, path: string, modified: number): SessionInfo {
	return {
		id,
		path,
		cwd: "/project",
		created: new Date(0),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: id,
		allMessagesText: id,
	};
}

test("an empty resume list has no selected path (#12106)", () => {
	const list = new SessionList([], false, "threaded", "all", new KeybindingsManager());
	assert.equal(list.getSelectedSessionPath(), undefined);
});

test("a progress notification may omit its partial session list (#12106)", async () => {
	let progress: SessionListProgress | undefined;
	const selector = new SessionSelectorComponent(
		(onProgress) => {
			progress = onProgress;
			return Promise.resolve([session("first", "/project/first", 1)]);
		},
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager() },
	);
	assert.ok(progress);
	progress(1, 2);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(selector.getSessionList().getSelectedSessionPath(), "/project/first");
	selector.dispose();
});

test("a failed active reload reports the error and retains seeded sessions (#12106)", async () => {
	const initial = session("first", "/project/first", 1);
	const selector = new SessionSelectorComponent(
		async () => {
			throw new Error("loader failed");
		},
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ initialSessions: [initial], keybindings: new KeybindingsManager() },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.match(selector.render(120).join("\n"), /Failed to load sessions: loader failed/);
	assert.equal(selector.getSessionList().getSelectedSessionPath(), initial.path);
	selector.dispose();
});

test("an empty selected path follows index selection when a list is reordered (#12106)", () => {
	const emptyPath = session("empty", "", 3);
	const other = session("other", "/project/other", 2);
	const list = new SessionList([emptyPath, other], false, "threaded", "all", new KeybindingsManager());
	list.handleInput("\x1b[B");
	list.handleInput("\x1b[A");
	assert.equal(list.getSelectedSessionPath(), "");
	list.setSessions([emptyPath, { ...other, modified: new Date(4) }], false);
	assert.equal(list.getSelectedSessionPath(), other.path);
});
