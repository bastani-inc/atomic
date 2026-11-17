import {
	PromptHistorySelectorComponent,
	promptHistoryEntries,
	sessionPromptsFromEntries,
} from "./components/prompt-history-selector.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";

InteractiveModeBase.prototype.showPromptHistorySearch = function (this: InteractiveModeBase): void {
	const entries = promptHistoryEntries(
		this.editor.getHistory?.() ?? [],
		sessionPromptsFromEntries(this.session.sessionManager.getEntries()),
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
