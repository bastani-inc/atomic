import assert from "node:assert/strict";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

// Kitty keyboard protocol encoding for Ctrl+R
const CTRL_R = "\x1b[114;5u";

describe("session selector rename", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	it("shows rename hint in interactive /resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: true, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).toContain("ctrl+r");
		expect(output).toContain("Rename");
	});

	it("does not show rename hint in --resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: false, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).not.toContain("ctrl+r");
		expect(output).not.toContain("Rename");
	});

	it.each(["a", ""])("renames selected session %j with Ctrl+R and Enter", async (id) => {
		const sessions = [makeSession({ id, name: "Old" })];
		const renameSession = vi.fn(async () => {});

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();

		// Rename mode layout
		const output = selector.render(120).join("\n");
		expect(output).toContain("Rename Session");
		expect(output).not.toContain("Resume Session");

		// Type and submit
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(renameSession).toHaveBeenCalledWith(sessions[0]!, "XOld");
	});

	it("keeps the renamed session selected when the reload starts with another session (#12106)", async () => {
		const sessions = [1, 2, 3, 4, 5].map((i) => makeSession({ id: `s${i}`, modified: new Date(10_000 - i * 1000) }));
		let loads = 0;
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async (onProgress) => {
				if (loads++ > 0) onProgress?.(1, sessions.length, [sessions[4]!]);
				return sessions;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession: async () => {}, showRenameHint: true, keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		assert.equal(list.getSelectedSessionPath(), sessions[2]!.path);

		list.handleInput(CTRL_R);
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		assert.equal(loads, 2);
		assert.equal(selector.getSessionList().getSelectedSessionPath(), sessions[2]!.path);
	});

	it("pins an untouched partial row while renaming as its parent arrives (#4694)", async () => {
		const parent = makeSession({ id: "parent" });
		const child = { ...makeSession({ id: "child", name: "Child" }), parentSessionPath: parent.path };
		let reportProgress!: (loaded: number, total: number, partial?: readonly SessionInfo[]) => void;
		let finishLoad!: (sessions: SessionInfo[]) => void;
		let loads = 0;
		const renameSession = vi.fn(async () => {});
		const onSelect = vi.fn();
		const selector = new SessionSelectorComponent(
			(onProgress) => {
				if (loads++ > 0) return Promise.resolve([parent, child]);
				reportProgress = onProgress!;
				return new Promise<SessionInfo[]>((resolve) => {
					finishLoad = resolve;
				});
			},
			async () => [],
			onSelect,
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings: new KeybindingsManager() },
		);

		reportProgress(1, 2, [child]);
		assert.equal(selector.getSessionList().getSelectedSessionPath(), child.path);
		selector.handleInput(CTRL_R);
		assert.match(selector.render(120).join("\n"), /Rename Session/);
		selector.handleInput("New ");
		reportProgress(2, 2, [parent, child]);
		assert.equal(selector.getSessionList().getSelectedSessionPath(), child.path);
		finishLoad([parent, child]);
		await flushPromises();
		assert.equal(selector.getSessionList().getSelectedSessionPath(), child.path);

		selector.handleInput("\r");
		await flushPromises();
		assert.deepEqual(renameSession.mock.calls, [[child, "New Child"]]);
		assert.equal(selector.getSessionList().getSelectedSessionPath(), child.path);
		selector.handleInput("\r");
		assert.equal(onSelect.mock.calls[0]?.[0], child);
		selector.dispose();
	});

	it("renames progressively rendered sessions before in-flight loads settle (#12106)", async () => {
		let currentName = "Old";
		let allName = "Foreign";
		let resolveInitialCurrent!: (value: SessionInfo[]) => void;
		let rejectInitialAll!: (reason?: unknown) => void;
		let reportInitialCurrentProgress!: (loaded: number, total: number, partial?: readonly SessionInfo[]) => void;
		let reportInitialAllProgress!: (loaded: number, total: number, partial?: readonly SessionInfo[]) => void;
		let currentLoads = 0;
		let allLoads = 0;
		const renameSession = vi.fn(async (session: SessionInfo, nextName: string | undefined) => {
			if (session.id === "a") currentName = nextName ?? currentName;
			if (session.id === "b") allName = nextName ?? allName;
		});
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			(onProgress) => {
				currentLoads += 1;
				if (currentLoads === 1) {
					reportInitialCurrentProgress = onProgress!;
					return new Promise<SessionInfo[]>((resolve) => {
						resolveInitialCurrent = resolve;
					});
				}
				return Promise.resolve([makeSession({ id: "a", name: currentName })]);
			},
			(onProgress) => {
				allLoads += 1;
				if (allLoads === 1) {
					reportInitialAllProgress = onProgress!;
					return new Promise<SessionInfo[]>((_resolve, reject) => {
						rejectInitialAll = reject;
					});
				}
				return Promise.resolve([makeSession({ id: "b", name: allName })]);
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);

		const staleCurrent = makeSession({ id: "a", name: "Old" });
		reportInitialCurrentProgress(1, 2, [staleCurrent]);
		assert.equal(selector.getSessionList().getSelectedSessionId(), "a");

		selector.handleInput(CTRL_R);
		assert.match(selector.render(120).join("\n"), /Rename Session/);

		selector.handleInput("New ");
		selector.handleInput("\r");
		await flushPromises();

		assert.equal(renameSession.mock.calls.length, 1);
		assert.deepEqual(renameSession.mock.calls[0], [staleCurrent, "New Old"]);
		assert.match(selector.render(120).join("\n"), /New Old/);

		reportInitialCurrentProgress(2, 2, [staleCurrent]);
		resolveInitialCurrent([staleCurrent]);
		await flushPromises();
		assert.match(selector.render(120).join("\n"), /New Old/);

		const staleAll = makeSession({ id: "b" });
		selector.handleInput("\t");
		reportInitialAllProgress(1, 2, [staleAll]);
		assert.equal(selector.getSessionList().getSelectedSessionId(), "b");

		selector.handleInput(CTRL_R);
		assert.match(selector.render(120).join("\n"), /Rename Session/);
		selector.handleInput("All Foreign");
		selector.handleInput("\r");
		await flushPromises();

		assert.equal(renameSession.mock.calls.length, 2);
		assert.deepEqual(renameSession.mock.calls[1], [staleAll, "All Foreign"]);
		assert.match(selector.render(120).join("\n"), /All Foreign/);

		rejectInitialAll(new Error("stale failure"));
		await flushPromises();
		const settledAllFrame = selector.render(120).join("\n");
		assert.doesNotMatch(settledAllFrame, /stale failure/);
		assert.match(settledAllFrame, /All Foreign/);
	});
});
