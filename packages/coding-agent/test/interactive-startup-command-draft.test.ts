import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { InteractiveSubmission } from "../src/modes/interactive/interactive-submission.ts";

type InputContext = {
	pendingUserInputs: InteractiveSubmission[];
	startupReplayActiveInput?: string;
	inputHandlerReadyRecorded: boolean;
	onInputCallback?: (submission: InteractiveSubmission) => void;
	editor: { getText(): string; setText(text: string): void };
};

const getUserInput = InteractiveMode.prototype.getUserInput as (this: InputContext) => Promise<InteractiveSubmission>;

describe("interactive startup command drafts", () => {
	for (const draft of ["/", "!pwd", "/model\nunfinished", "!pwd\nunfinished"]) {
		it(`keeps ${JSON.stringify(draft)} in the editor until submission`, async () => {
			let text = draft;
			let editorChanges = 0;
			const context: InputContext = {
				pendingUserInputs: [],
				inputHandlerReadyRecorded: true,
				editor: {
					getText: () => text,
					setText: (next) => {
						text = next;
						editorChanges += 1;
					},
				},
			};
			const input = getUserInput.call(context);
			assert.equal(context.editor.getText(), draft);
			assert.equal(context.startupReplayActiveInput, undefined);
			assert.deepEqual(context.pendingUserInputs, []);
			assert.equal(editorChanges, 0);
			assert.ok(context.onInputCallback);
			context.onInputCallback({ text: "cleanup", draft: "cleanup" });
			await input;
		});
	}
});
