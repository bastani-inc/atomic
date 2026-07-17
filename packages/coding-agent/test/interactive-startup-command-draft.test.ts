import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RecoverContext = {
	startupCookedInputRecovered: boolean;
	pendingUserInputs: string[];
	editor: { getText(): string; setText(text: string): void };
	options: { startupInputCapture: { consume(): { text: string; submissions: string[] } } };
	startupReplayInputs: string[];
	startupReplayActiveInput?: string;
	startupDraftText?: string;
};

type RecoverStartupInput = (this: RecoverContext) => boolean;
const recoverCookedStartupInput = InteractiveMode.prototype.recoverCookedStartupInput as RecoverStartupInput;

describe("interactive startup command drafts", () => {
	for (const draft of ["/", "!pwd"]) {
		it(`keeps raw-captured ${JSON.stringify(draft)} in the editor until Enter`, () => {
			const setText = vi.fn();
			const context: RecoverContext = {
				startupCookedInputRecovered: false,
				pendingUserInputs: [],
				editor: { getText: () => draft, setText },
				options: { startupInputCapture: { consume: () => ({ text: draft, submissions: [] }) } },
				startupReplayInputs: [],
			};

			expect(recoverCookedStartupInput.call(context)).toBe(false);
			expect(context.startupReplayActiveInput).toBeUndefined();
			expect(context.pendingUserInputs).toEqual([]);
			expect(setText).not.toHaveBeenCalled();
		});
	}
});
