import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SessionConflictError } from "../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-session-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class LabelStore extends MemorySessionStore {
	entered = Promise.withResolvers<void>();
	release = Promise.withResolvers<void>();
	failure: SessionConflictError | undefined;
	blocked = false;
	attempts = 0;

	override async append(...args: Parameters<MemorySessionStore["append"]>) {
		if (this.blocked) {
			this.attempts++;
			this.entered.resolve();
			await this.release.promise;
		}
		if (this.failure) throw this.failure;
		return super.append(...args);
	}
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("tree label keys await persistence, present the identical rejection and allow retry without ghost labels", async () => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
	const store = new LabelStore();
	const manager = await SessionManager.create(store, "/project");
	const id = await manager.appendMessage({ role: "user", content: "label target", timestamp: 1 });
	let selector!: TreeSelectorComponent;
	let renders = 0;
	const errors: string[] = [];
	const observed: Error[] = [];
	const unhandled: Error[] = [];
	const onUnhandled = (error: Error) => unhandled.push(error);
	const mode = {
		ensureDeferredStartupComplete: async () => {},
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory(),
		ui: {
			terminal: { rows: 24 },
			requestRender: () => {
				renders++;
			},
		},
		showSelector(create: Parameters<InteractiveModeBase["showSelector"]>[0]) {
			const mounted = create(() => {});
			assert.ok(mounted.component instanceof TreeSelectorComponent);
			selector = mounted.component;
		},
		showError: (message: string) => {
			errors.push(message);
		},
	} as InteractiveModeBase;
	process.on("unhandledRejection", onUnhandled);
	try {
		await InteractiveModeBase.prototype.showTreeSelector.call(mode);
		const onLabelError = selector.onLabelError;
		selector.onLabelError = (error) => {
			observed.push(error);
			onLabelError?.(error);
		};
		const screen = () => selector.render(100).map(stripVTControlCharacters).join("\n");
		const failure = new SessionConflictError(manager.getSessionId(), 1, 2);
		store.failure = failure;
		store.blocked = true;
		selector.handleInput("L");
		assert.ok(screen().includes("Label (empty to remove):"));
		selector.handleInput("saved-label");
		selector.handleInput("\r");
		await store.entered.promise;
		selector.handleInput("\r");
		selector.handleInput("\x1b");
		assert.equal(store.attempts, 1);
		assert.equal(manager.getLabel(id), undefined);
		assert.equal(selector.getTreeList().getSelectedNode()?.label, undefined);
		assert.ok(screen().includes("Label (empty to remove):"));
		assert.equal(renders, 0);
		store.release.resolve();
		await nextTurn();
		assert.deepEqual(observed, [failure]);
		assert.equal(observed[0], failure);
		assert.ok(observed[0] instanceof SessionConflictError);
		assert.deepEqual(errors, [failure.message]);
		assert.equal(manager.getLabel(id), undefined);
		assert.equal(selector.getTreeList().getSelectedNode()?.label, undefined);
		assert.ok(screen().includes("Label (empty to remove):"));
		assert.ok(screen().includes("saved-label"));
		assert.deepEqual(unhandled, []);
		assert.ok(renders > 0);

		store.failure = undefined;
		store.entered = Promise.withResolvers<void>();
		store.release = Promise.withResolvers<void>();
		selector.handleInput("\r");
		await store.entered.promise;
		assert.equal(manager.getLabel(id), undefined);
		assert.equal(selector.getTreeList().getSelectedNode()?.label, undefined);
		assert.ok(screen().includes("Label (empty to remove):"));
		store.release.resolve();
		await nextTurn();
		assert.equal(store.attempts, 2);
		assert.equal(manager.getLabel(id), "saved-label");
		assert.equal(selector.getTreeList().getSelectedNode()?.label, "saved-label");
		assert.equal(screen().includes("Label (empty to remove):"), false);
		assert.ok(screen().includes("[saved-label]"));
		assert.equal((await SessionManager.open(store, manager.getSessionId())).getLabel(id), "saved-label");
		assert.equal(manager.getEntries().filter((entry) => entry.type === "label").length, 1);
		assert.deepEqual(errors, [failure.message]);
		assert.deepEqual(unhandled, []);
	} finally {
		store.release.resolve();
		await nextTurn();
		process.off("unhandledRejection", onUnhandled);
		await store.close();
	}
});
