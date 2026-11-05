import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionList } from "../src/modes/interactive/components/session-selector-list.ts";
import { truncatePathStart } from "../src/modes/interactive/components/session-selector-utils.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

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

function rows(list: SessionList, width: number): string[] {
	return list
		.render(width)
		.slice(2)
		.map((line) => stripTerminalSequences(line));
}

describe("session selector rows with long paths", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("keeps a session name whole beside a project path longer than the row (#4406)", () => {
		assert.equal(projectPath.length, 106);
		const list = allScopeList([session({ name: "foreign target" })]);
		assert.deepEqual(rows(list, 120), [`› foreign target  …${projectPath.slice(-95)} 0 now`]);
	});

	test("shows the whole project path when it fits beside the name", () => {
		const fitting = projectPath.slice(-96);
		const list = allScopeList([session({ name: "foreign target", cwd: fitting })]);
		assert.deepEqual(rows(list, 120), [`› foreign target  ${fitting} 0 now`]);
	});

	test("starts shortening the project path one cell past the space the name leaves", () => {
		const overflowing = projectPath.slice(-97);
		const list = allScopeList([session({ name: "foreign target", cwd: overflowing })]);
		assert.deepEqual(rows(list, 120), [`› foreign target  …${overflowing.slice(-95)} 0 now`]);
	});

	test("reserves the ten-cell name column for a short name", () => {
		const list = allScopeList([session({ name: "fix" })]);
		assert.deepEqual(rows(list, 120), [`› fix${" ".repeat(9)}…${projectPath.slice(-99)} 0 now`]);
	});

	test("counts the tree prefix of a forked session against the shared width", () => {
		const parent = session({ name: "parent chat", path: "/sessions/parent.jsonl" });
		const child = session({
			name: "forked target",
			path: "/sessions/child.jsonl",
			parentSessionPath: parent.path,
		});
		const list = allScopeList([parent, child]);
		assert.deepEqual(rows(list, 120), [
			`› parent chat  …${projectPath.slice(-98)} 0 now`,
			`     └─ forked target  …${projectPath.slice(-90)} 0 now`,
		]);
	});

	test("splits the row in half between a long first message and a long project path", () => {
		const message = "fix the login bug ".repeat(12).trim();
		const list = allScopeList([session({ firstMessage: message })]);
		assert.deepEqual(rows(list, 121), [`› ${message.slice(0, 55)}…  …${projectPath.slice(-54)} 0 now`]);
	});

	test("keeps the name whole beside a summary column", () => {
		const summary = "Renamed the foreign session";
		const list = allScopeList([session({ name: "foreign target", summary })]);
		assert.deepEqual(rows(list, 120), [
			`› foreign target${" ".repeat(7)}${summary.slice(0, 21)}…  …${projectPath.slice(-66)} 0 now`,
		]);
	});

	test("keeps the session file name and project path visible with path display on", () => {
		const sessionPath = `/sessions/--${"p".repeat(90)}--/2026-11-05T22-40-03-123Z_shared-id.jsonl`;
		const list = allScopeList([session({ name: "foreign target", path: sessionPath, cwd: "/work/foreign" })]);
		list.handleInput(TOGGLE_PATH);
		assert.deepEqual(rows(list, 120), [`› foreign target  …${`${sessionPath} /work/foreign`.slice(-95)} 0 now`]);
	});

	test("shows only the message count and age in the current-folder scope", () => {
		const message = "m".repeat(60);
		const list = allScopeList([session({ firstMessage: message })], false);
		assert.deepEqual(rows(list, 40), [`› ${"m".repeat(30)}…  0 now`]);
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
