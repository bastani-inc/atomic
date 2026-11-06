/**
 * Deleting a session from the interactive session selector (#4309) goes through the open session manager, which also
 * removes the oversized tool results a released workflow stage kept for it in the agent directory. A session
 * directory's sessions have no delete action there: their files are deleted as files.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SessionManager } from "../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { getReleasedStageBlobDir } from "../src/core/tools/tool-output-blobs.js";
import type { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type SelectorBuilder = (done: () => void) => { component: SessionSelectorComponent; focus: SessionSelectorComponent };

describe("the interactive session selector's delete action (#4309)", () => {
	let root: string;
	let agentDir: string;
	const closers: (() => Promise<void>)[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-selector-delete-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		while (closers.length > 0) await closers.pop()?.();
		rmSync(root, { recursive: true, force: true });
	});

	test("deletes through the open session manager, so the session's released-stage tool results go with it (#4309)", async () => {
		const database = await openNodeSqliteDatabase(join(root, "sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		closers.push(async () => {
			await store.close();
			await database.close();
		});
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const doomed = await SessionManager.create(store, cwd);
		await doomed.appendMessage({ role: "user", content: "delete me", timestamp: Date.now() });
		const active = await SessionManager.create(store, cwd);
		await active.appendMessage({ role: "user", content: "stay open", timestamp: Date.now() });
		active.bindAgentDir(agentDir);
		const blobs = getReleasedStageBlobDir(agentDir, doomed.getSessionId());
		mkdirSync(blobs, { recursive: true });
		writeFileSync(join(blobs, "result.txt"), "spilled");
		const deletes = vi.spyOn(active, "deleteSession");
		let selector: SessionSelectorComponent | undefined;
		const mode = {
			sessionManager: active,
			keybindings: new KeybindingsManager(),
			ui: { requestRender: () => {} },
			handleResumeSession: async () => {},
			shutdown: async () => {},
			showSelector: (build: SelectorBuilder) => {
				selector = build(() => {}).component;
			},
		};

		await import("../src/modes/interactive/interactive-session-routing.js");
		InteractiveModeBase.prototype.showSessionSelector.call(mode as unknown as InteractiveModeBase);
		assert.ok(selector !== undefined);
		await vi.waitFor(() => assert.match(selector!.render(120).join("\n"), /delete me/), { timeout: 5_000 });
		selector.handleInput("\x1b[B");
		selector.handleInput("\x04");
		selector.handleInput("\r");

		await vi.waitFor(() => assert.deepEqual(deletes.mock.calls, [[doomed.getSessionId()]]), { timeout: 5_000 });
		await vi.waitFor(() => assert.equal(existsSync(blobs), false), { timeout: 5_000 });
		assert.ok(await store.readHeader(active.getSessionId()), "the open session is still there");
		assert.equal(await store.readHeader(doomed.getSessionId()), undefined);
	});
});
