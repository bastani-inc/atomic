/**
 * A selector for a trust decision, or another startup question or screen, that keys meant for the prompt cannot answer.
 *
 * Startup can show the "Trust project folder?" question while the user is already typing a prompt (#5227 review): a
 * slow first start paints it after the keys were sent. A plain selector drops the typed text and takes the Enter as a
 * choice, so the prompt is lost and the project is trusted by accident. This selector opens on the choice that trusts
 * and saves nothing, keeps typed text as a draft for the prompt, and ignores Enter after typed text until ↑ or ↓ shows
 * the user is answering the question.
 */

import { type Component, Container, getKeybindings, Text } from "@bastani/atomic-tui";
import { PROJECT_TRUST_DISTRUST_LABEL, PROJECT_TRUST_SESSION_DISTRUST_LABEL } from "../../../core/trust-manager.ts";
import { theme } from "../theme/theme.js";

/** A startup screen or decision the guard wraps: it gets every key the guard does not keep as typed text. */
export type GuardedDecision = Component & { handleInput(data: string): unknown; dispose?(): void };

export const TRUST_DECISION_TYPED_TEXT_NOTICE =
	"Answer the trust question with ↑↓ and Enter; your text is kept as a draft.";
/** The same notice for a startup question or screen that is not about trust. */
export const STARTUP_DECISION_TYPED_TEXT_NOTICE = "Answer with ↑↓ and Enter; your text is kept as a draft.";

/** Whether a selector's choices are a project trust decision. */
export function isTrustDecision(labels: readonly string[]): boolean {
	return labels.includes(PROJECT_TRUST_SESSION_DISTRUST_LABEL) || labels.includes(PROJECT_TRUST_DISTRUST_LABEL);
}

/** The choice a trust decision opens on: the one that trusts and saves nothing, else any refusal. */
export function safeTrustChoiceIndex(labels: readonly string[]): number {
	for (const safe of [PROJECT_TRUST_SESSION_DISTRUST_LABEL, PROJECT_TRUST_DISTRUST_LABEL, "No"]) {
		const index = labels.indexOf(safe);
		if (index >= 0) return index;
	}
	return 0;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** The text a key press or paste types, or undefined for a key that types nothing (arrows, Enter, Esc, Ctrl+…). */
function typedText(data: string): string | undefined {
	const pasted = data.startsWith(BRACKETED_PASTE_START)
		? data.slice(BRACKETED_PASTE_START.length).replace(BRACKETED_PASTE_END, "")
		: undefined;
	const text = pasted ?? data;
	if (pasted === undefined && Array.from(text).some((char) => char.charCodeAt(0) < 0x20 || char === "\x7f")) {
		return undefined;
	}
	return text.length > 0 ? text : undefined;
}

export class TrustDecisionSelector extends Container {
	private draft = "";
	private enterArmed = true;
	private readonly notice = new Text("", 1, 0);
	private readonly selector: GuardedDecision;
	private readonly keepDraft: (text: string) => void;
	private readonly noticeText: string;

	/** `keepDraft` receives the typed text once, when the selector is disposed. */
	constructor(
		selector: GuardedDecision,
		keepDraft: (text: string) => void,
		noticeText: string = TRUST_DECISION_TYPED_TEXT_NOTICE,
	) {
		super();
		this.selector = selector;
		this.keepDraft = keepDraft;
		this.noticeText = noticeText;
		this.addChild(selector);
		this.addChild(this.notice);
	}

	handleInput(data: string): boolean {
		const keybindings = getKeybindings();
		const text = typedText(data);
		if (text !== undefined) {
			this.draft += text;
			this.enterArmed = false;
			this.showNotice();
			return true;
		}
		if ((data === "\x7f" || data === "\b") && this.draft.length > 0) {
			this.draft = Array.from(this.draft).slice(0, -1).join("");
			return true;
		}
		if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
			this.enterArmed = true;
			this.notice.setText("");
		} else if (!this.enterArmed && (keybindings.matches(data, "tui.select.confirm") || data === "\n")) {
			this.showNotice();
			return true;
		}
		this.selector.handleInput(data);
		return true;
	}

	dispose(): void {
		const draft = this.draft;
		this.draft = "";
		if (draft.length > 0) this.keepDraft(draft);
		this.selector.dispose?.();
	}

	private showNotice(): void {
		this.notice.setText(theme.fg("warning", this.noticeText));
	}
}
