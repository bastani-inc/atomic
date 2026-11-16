import {
	type Component,
	Container,
	decodePrintableKey,
	getKeybindings,
	normalizePastedText,
	Text,
} from "@bastani/atomic-tui";
import { PROJECT_TRUST_DISTRUST_LABEL, PROJECT_TRUST_SESSION_DISTRUST_LABEL } from "../../../core/trust-manager.ts";
import { theme } from "../theme/theme.js";

export type GuardedDecision = Component & { handleInput(data: string): void; dispose?(): void };

export const TRUST_DECISION_TYPED_TEXT_NOTICE =
	"Answer the trust question with ↑↓ and Enter; your text is kept as a draft.";
export const STARTUP_DECISION_TYPED_TEXT_NOTICE = "Answer with ↑↓ and Enter; your text is kept as a draft.";

export function isTrustDecision(labels: readonly string[]): boolean {
	return labels.includes(PROJECT_TRUST_SESSION_DISTRUST_LABEL) || labels.includes(PROJECT_TRUST_DISTRUST_LABEL);
}

export function safeTrustChoiceIndex(labels: readonly string[]): number {
	for (const safe of [PROJECT_TRUST_SESSION_DISTRUST_LABEL, PROJECT_TRUST_DISTRUST_LABEL, "No"]) {
		const index = labels.indexOf(safe);
		if (index >= 0) return index;
	}
	return 0;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function typedText(data: string): string | undefined {
	const pasted = data.startsWith(BRACKETED_PASTE_START)
		? normalizePastedText(data.slice(BRACKETED_PASTE_START.length).replace(BRACKETED_PASTE_END, ""))
		: undefined;
	const text = pasted ?? decodePrintableKey(data) ?? data;
	if (pasted === undefined && /[\x00-\x1f\x7f]/.test(text)) {
		return undefined;
	}
	return text.length > 0 ? text : undefined;
}

export class TrustDecisionSelector extends Container {
	private draft = "";
	private enterArmed: boolean;
	private readonly notice = new Text("", 1, 0);
	private selector: GuardedDecision;
	private readonly keepDraft: (text: string) => void;
	private readonly noticeText: string;

	constructor(
		selector: GuardedDecision,
		keepDraft: (text: string) => void,
		noticeText: string = TRUST_DECISION_TYPED_TEXT_NOTICE,
		options: { enterArmed?: boolean } = {},
	) {
		super();
		this.selector = selector;
		this.keepDraft = keepDraft;
		this.noticeText = noticeText;
		this.enterArmed = options.enterArmed ?? true;
		if (!this.enterArmed) this.showNotice();
		this.addChild(selector);
		this.addChild(this.notice);
	}

	setDecision(selector: GuardedDecision): void {
		this.selector = selector;
		this.clear();
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
			const last = this.draft.charCodeAt(this.draft.length - 1);
			const previous = this.draft.charCodeAt(this.draft.length - 2);
			const codeUnits = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 2 : 1;
			this.draft = this.draft.slice(0, -codeUnits);
			return true;
		}
		if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
			this.enterArmed = true;
			this.notice.setText("");
		} else if (!this.enterArmed && (keybindings.matches(data, "tui.select.confirm") || data === "\n")) {
			if (this.draft.length > 0 && !this.draft.endsWith("\n")) this.draft += "\n";
			this.showNotice();
			return true;
		}
		this.selector.handleInput(data);
		return true;
	}

	dispose(): void {
		const draft = this.draft.replace(/\n+$/, "");
		this.draft = "";
		if (draft.length > 0) this.keepDraft(draft);
		this.selector.dispose?.();
	}

	private showNotice(): void {
		this.notice.setText(theme.fg("warning", this.noticeText));
	}
}
