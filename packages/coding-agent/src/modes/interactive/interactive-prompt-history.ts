import { viewedAgentPromptHistory } from "./components/agent-prompt-history.ts";
import {
	PromptHistorySelectorComponent,
	promptHistoryEntries,
	sessionPromptsFromEntries,
} from "./components/prompt-history-selector.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";

InteractiveModeBase.prototype.showPromptHistorySearch = function (this: InteractiveModeBase): void {
	// While the prompt writes to a viewed agent, the search is over what Up recalls for it, never main's prompts.
	const viewed = viewedAgentPromptHistory(this.defaultEditor);
	const entries = promptHistoryEntries(
		viewed === undefined
			? sessionPromptsFromEntries(this.session.sessionManager.getEntries())
			: [...viewed].reverse().map((text) => ({ text })),
	);
	this.showSelector((done) => {
		let settled = false;
		const selector = new PromptHistorySelectorComponent(entries, {
			onSelect: (text) => {
				if (settled) return;
				settled = true;
				done();
				this.editor.setText(text);
				this.ui.requestRender();
			},
			onCancel: () => {
				if (settled) return;
				settled = true;
				done();
				this.ui.requestRender();
			},
		});
		return { component: selector, focus: selector };
	});
};
