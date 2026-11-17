import {
	PromptHistorySelectorComponent,
	promptHistoryEntries,
	type SessionPrompt,
} from "./components/prompt-history-selector.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";

function promptText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
}

/** The current session's prompts from the history already in memory, with when each was sent. */
function sessionPrompts(mode: InteractiveModeBase): SessionPrompt[] {
	const prompts: SessionPrompt[] = [];
	for (const entry of mode.session.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = promptText(entry.message.content);
		if (!text.trim()) continue;
		const sentAt = Date.parse(entry.timestamp);
		prompts.push(Number.isFinite(sentAt) ? { text, sentAt } : { text });
	}
	return prompts;
}

InteractiveModeBase.prototype.showPromptHistorySearch = function (this: InteractiveModeBase): void {
	const entries = promptHistoryEntries(this.editor.getHistory?.() ?? [], sessionPrompts(this));
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
