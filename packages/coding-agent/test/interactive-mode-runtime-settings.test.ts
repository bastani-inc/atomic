import { describe, expect, it, vi } from "vitest";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-session-runtime.ts";

type SessionLike = { autoCompactionEnabled: boolean };
type Setter<T> = (value: T) => void;

interface RuntimeSettingsHarness {
	footer: { setSession: Setter<SessionLike> };
	usageMeter: { setSession: Setter<SessionLike>; setAutoCompactEnabled: Setter<boolean> };
	footerDataProvider: { setCwd: Setter<string> };
	session: SessionLike;
	sessionManager: { getCwd: () => string };
	hideThinkingBlock: boolean;
	outputPad: 0 | 1;
	settingsManager: {
		getHideThinkingBlock: () => boolean;
		getOutputPad: () => 0 | 1;
		getShowHardwareCursor: () => boolean;
		getClearOnShrink: () => boolean;
		getEditorPaddingX: () => number;
		getAutocompleteMaxVisible: () => number;
	};
	ui: { setShowHardwareCursor: Setter<boolean>; setClearOnShrink: Setter<boolean> };
	defaultEditor: { setPaddingX: Setter<number>; setAutocompleteMaxVisible: Setter<number> };
	editor: { setPaddingX?: Setter<number>; setAutocompleteMaxVisible?: Setter<number> };
}

const applyRuntimeSettings = InteractiveModeBase.prototype.applyRuntimeSettings as (this: RuntimeSettingsHarness) => void;

describe("InteractiveMode runtime settings", () => {
	it("reloads outputPad alongside other mutable runtime settings", () => {
		const secondaryEditor = {
			setPaddingX: vi.fn(),
			setAutocompleteMaxVisible: vi.fn(),
		};
		const harness: RuntimeSettingsHarness = {
			footer: { setSession: vi.fn() },
			usageMeter: { setSession: vi.fn(), setAutoCompactEnabled: vi.fn() },
			footerDataProvider: { setCwd: vi.fn() },
			session: { autoCompactionEnabled: true },
			sessionManager: { getCwd: () => "/repo" },
			hideThinkingBlock: false,
			outputPad: 1,
			settingsManager: {
				getHideThinkingBlock: () => true,
				getOutputPad: () => 0,
				getShowHardwareCursor: () => true,
				getClearOnShrink: () => true,
				getEditorPaddingX: () => 2,
				getAutocompleteMaxVisible: () => 7,
			},
			ui: { setShowHardwareCursor: vi.fn(), setClearOnShrink: vi.fn() },
			defaultEditor: { setPaddingX: vi.fn(), setAutocompleteMaxVisible: vi.fn() },
			editor: secondaryEditor,
		};

		applyRuntimeSettings.call(harness);

		expect(harness.hideThinkingBlock).toBe(true);
		expect(harness.outputPad).toBe(0);
		expect(harness.defaultEditor.setPaddingX).toHaveBeenCalledWith(2);
		expect(secondaryEditor.setPaddingX).toHaveBeenCalledWith(2);
		expect(secondaryEditor.setAutocompleteMaxVisible).toHaveBeenCalledWith(7);
	});
});
