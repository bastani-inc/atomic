import assert from "node:assert/strict";
import { setKeybindings, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { StorageUnavailableError } from "../src/core/storage/session/errors.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import type { SessionWriteOptions } from "../src/core/storage/session/types.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import type { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-input-handling.ts";
import "../src/modes/interactive/interactive-editor-actions.ts";
import "../src/modes/interactive/interactive-model-routing.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

class FailingStore extends MemorySessionStore {
	failure: StorageUnavailableError | undefined;
	override async append(id: string, entries: readonly SessionEntry[], options: SessionWriteOptions) {
		if (this.failure) throw this.failure;
		return super.append(id, entries, options);
	}
}

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

beforeAll(() => initTheme("dark"));

for (const boundary of ["shortcut", "picker"] as const) {
	test(`thinking ${boundary} displays persistence failures and remains available for retry`, async () => {
		const store = new FailingStore();
		const manager = await SessionManager.create(store, "/thinking-test");
		const harness = await createHarness({ sessionManager: manager, models: [{ id: "reasoning", reasoning: true }] });
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const ui = new TuiMainScreen(new FakeTerminal());
		const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
		let picker: ThinkingSelectorComponent | undefined;
		let pickerClosed = false;
		const mode = {
			session: harness.session,
			settingsManager: harness.settingsManager,
			defaultEditor: editor,
			ui,
			keybindings,
			addTuiInputListener: () => {},
			footer: { invalidate: () => {} },
			updateEditorBorderColor: () => {},
			showStatus: () => {},
			showError: vi.fn<(message: string) => void>(),
			cycleThinkingLevel: InteractiveModeBase.prototype.cycleThinkingLevel,
			selectThinkingLevel: InteractiveModeBase.prototype.selectThinkingLevel,
			showSelector: (factory: (done: () => void) => { component: ThinkingSelectorComponent }) => {
				picker = factory(() => {
					pickerClosed = true;
				}).component;
			},
		};
		const failure = new StorageUnavailableError(store.descriptor, new Error("thinking write failed"));
		store.failure = failure;
		try {
			if (boundary === "shortcut") {
				await InteractiveModeBase.prototype.setupKeyHandlers.call(mode as never);
				editor.handleInput("\x1b[Z");
			} else {
				InteractiveModeBase.prototype.showThinkingSelector.call(mode as never);
				assert.ok(picker);
				picker.handleInput("\x1b[B");
				picker.handleInput("\r");
			}
			await vi.waitFor(() => assert.equal(mode.showError.mock.calls.length, 1));
			assert.ok(mode.showError.mock.calls[0][0].includes(failure.message));
			assert.equal(pickerClosed, false);
			assert.equal(
				manager.getEntries().some((entry) => entry.type === "thinking_level_change"),
				false,
			);
			store.failure = undefined;
			if (boundary === "shortcut") editor.handleInput("\x1b[Z");
			else picker!.handleInput("\r");
			await vi.waitFor(() =>
				assert.equal(manager.getEntries().filter((entry) => entry.type === "thinking_level_change").length, 1),
			);
			if (boundary === "picker") await vi.waitFor(() => assert.equal(pickerClosed, true));
			assert.equal(mode.showError.mock.calls.length, 1);
		} finally {
			await harness.cleanup();
		}
	});
}
