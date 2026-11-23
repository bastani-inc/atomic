import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionList } from "../src/modes/interactive/components/session-selector-list.js";
import { truncatePathStart } from "../src/modes/interactive/components/session-selector-utils.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const projectPath = `/tmp/${"t".repeat(62)}/atomic-session-identity-sGgz6v/foreign`;
const TOGGLE_PATH = "\x10";

function session(overrides: Partial<SessionInfo>): SessionInfo {
	return {
		path: "/sessions/foreign.jsonl",
		id: "shared-id",
		cwd: projectPath,
		created: new Date(),
		modified: new Date(),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
		...overrides,
	};
}

function allScopeList(sessions: SessionInfo[], showCwd = true): SessionList {
	return new SessionList(sessions, showCwd, "threaded", "all", new KeybindingsManager());
}

/** The rendered rows only: two lines each (title, then the dim detail line), without the search box and hint. */
function rows(list: SessionList, width: number): string[] {
	const lines = list.render(width).map((line) => stripTerminalSequences(line).replace(/\s+$/, ""));
	return lines.slice(4, lines.length - 2);
}

describe("session selector rows with long paths", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("keeps a session name whole on its own line beside a project path longer than the row (#4406)", () => {
		assert.equal(projectPath.length, 106);
		const list = allScopeList([session({ name: "foreign target" })]);
		assert.deepEqual(rows(list, 80), [" ∀ foreign target", `   just now · 0 messages · …${projectPath.slice(-51)}`]);
	});

	test("shows the whole project path when it fits", () => {
		const fitting = projectPath.slice(-96);
		const list = allScopeList([session({ name: "foreign target", cwd: fitting })]);
		assert.deepEqual(rows(list, 130), [" ∀ foreign target", `   just now · 0 messages · ${fitting}`]);
	});

	test("shortens a project path from its start, one cell past the room it has", () => {
		const overflowing = projectPath.slice(-97);
		const list = allScopeList([session({ name: "foreign target", cwd: overflowing })]);
		assert.deepEqual(rows(list, 124), [" ∀ foreign target", `   just now · 0 messages · …${overflowing.slice(-95)}`]);
	});

	test("keeps the tree prefix of a forked session on both of its lines", () => {
		const parent = session({ name: "parent chat", path: "/sessions/parent.jsonl" });
		const child = session({
			name: "forked target",
			path: "/sessions/child.jsonl",
			parentSessionPath: parent.path,
		});
		const list = allScopeList([parent, child]);
		assert.deepEqual(rows(list, 80), [
			" ∀ parent chat",
			`   just now · 0 messages · …${projectPath.slice(-51)}`,
			"      └─ forked target",
			`         just now · 0 messages · …${projectPath.slice(-45)}`,
		]);
	});

	test("gives a long first message its own line and the project path the line under it", () => {
		const message = "fix the login bug ".repeat(12).trim();
		const list = allScopeList([session({ firstMessage: message })]);
		const [title, detail] = rows(list, 80);
		assert.equal(title, ` ∀ ${message.slice(0, 75)}…`);
		assert.equal(detail, `   just now · 0 messages · …${projectPath.slice(-51)}`);
	});

	test("puts a summary after the path when the line has room for it", () => {
		const summary = "Renamed the foreign session";
		const list = allScopeList([session({ name: "foreign target", summary, cwd: "/work/foreign" })]);
		assert.deepEqual(rows(list, 120), [" ∀ foreign target", `   just now · 0 messages · /work/foreign · ${summary}`]);
	});

	test("keeps the session file name and project path visible with path display on", () => {
		const sessionPath = `/sessions/--${"p".repeat(90)}--/2026-11-05T22-40-03-123Z_shared-id.jsonl`;
		const list = allScopeList([session({ name: "foreign target", path: sessionPath, cwd: "/work/foreign" })]);
		list.handleInput(TOGGLE_PATH);
		const [, detail] = rows(list, 120);
		assert.match(detail!, /\/work\/foreign · ….*2026-11-05T22-40-03-123Z_shared-id\.jsonl$/);
	});

	test("shows only the age and message count in the current-folder scope", () => {
		const message = "m".repeat(60);
		const list = allScopeList([session({ firstMessage: message })], false);
		assert.deepEqual(rows(list, 40), [` ∀ ${"m".repeat(35)}…`, "   just now · 0 messages"]);
	});
});

describe("truncatePathStart", () => {
	test("returns a path that fits unchanged", () => {
		assert.equal(truncatePathStart("/a/b", 4), "/a/b");
	});

	test("drops the start of a path one cell too long", () => {
		assert.equal(truncatePathStart("/a/bc", 4), "…/bc");
	});

	test("leaves only the ellipsis in a single cell", () => {
		assert.equal(truncatePathStart("/a/bc", 1), "…");
	});

	test.each([0, -3])("returns an empty string for a width of %i", (width) => {
		assert.equal(truncatePathStart("/a/bc", width), "");
	});

	test("never splits a wide character at the cut", () => {
		assert.equal(truncatePathStart("/a/項目", 4), "…目");
	});
});
