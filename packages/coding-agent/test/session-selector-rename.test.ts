import assert from "node:assert/strict";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

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
});
