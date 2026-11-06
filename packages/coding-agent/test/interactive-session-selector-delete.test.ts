/**
 * Deleting a session from the interactive session selector (#4309) goes through the open session manager, whose store
 * deletes the oversized tool results a released workflow stage kept as blobs of the session (#4379). A session
 * directory's sessions have no delete action there: their files are deleted as files.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SessionManager } from "../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type SelectorBuilder = (done: () => void) => { component: SessionSelectorComponent; focus: SessionSelectorComponent };

describe("the interactive session selector's delete action (#4309)", () => {
	let root: string;
	const closers: (() => Promise<void>)[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-selector-delete-"));
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		while (closers.length > 0) await closers.pop()?.();
		rmSync(root, { recursive: true, force: true });
	});

	test("deletes through the open session manager, so the session's released-stage tool results go with it (#4309, #4379)", async () => {
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
		const { hash } = await store.putBlob(doomed.getSessionId(), new TextEncoder().encode("spilled"));
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
		await vi.waitFor(async () => assert.equal(await store.getBlob(doomed.getSessionId(), hash), undefined), {
			timeout: 5_000,
		});
		assert.ok(await store.readHeader(active.getSessionId()), "the open session is still there");
		assert.equal(await store.readHeader(doomed.getSessionId()), undefined);
	});
});
