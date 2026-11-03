import assert from "node:assert/strict";
import { setKeybindings } from "@earendil-works/pi-tui";
import { describe, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import "../src/modes/interactive/interactive-session-routing.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("session tree navigation while a turn runs", () => {
	test.each([
		[
			"fails",
			() => Promise.reject(new Error("engine unavailable")),
			["Failed to restore queued messages: engine unavailable"],
		],
		["never answers", () => new Promise<number>(() => {}), []],
	])("aborts the turn when the queue clear %s (#4257)", async (_case, restoreQueuedMessagesToEditor, reported) => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager());
		const manager = await SessionManager.create(new MemorySessionStore(), "/project");
		const first = await manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		await manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		let selector!: TreeSelectorComponent;
		const errors: string[] = [];
		const abort = vi.fn(async () => {});
		const restore = vi.fn(restoreQueuedMessagesToEditor);
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		const mode = {
			ensureDeferredStartupComplete: async () => {},
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ branchSummary: { skipPrompt: true } }),
			// Compaction running ends navigation right after the abort, which is all this test needs of it.
			session: { isStreaming: true, isCompacting: true, abort },
			restoreQueuedMessagesToEditor: restore,
			ui: { terminal: { rows: 24 }, requestRender() {} },
			showSelector(create: Parameters<InteractiveModeBase["showSelector"]>[0]) {
				const mounted = create(() => {});
				assert.ok(mounted.component instanceof TreeSelectorComponent);
				selector = mounted.component;
			},
			showError: (message: string) => {
				errors.push(message);
			},
			showStatus() {},
		} as unknown as InteractiveModeBase;
		process.on("unhandledRejection", onUnhandled);
		try {
			await InteractiveModeBase.prototype.showTreeSelector.call(mode);
			const choose = selector.getTreeList().onSelect as (entryId: string) => Promise<void>;
			const navigation = choose(first);
			await nextTurn();
			await nextTurn();

			assert.equal(abort.mock.calls.length, 1, "the abort must not wait for the queue clear");
			assert.equal(restore.mock.calls.length, 1);
			await navigation;
			assert.deepEqual(unhandled, []);
			const clearFailure = errors.filter((message) => message.startsWith("Failed to restore queued messages"));
			assert.deepEqual(clearFailure, reported);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
