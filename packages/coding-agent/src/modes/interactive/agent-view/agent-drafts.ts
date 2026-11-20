import { type EditorComponent, type EditorDraft, editorDraftText, emptyEditorDraft } from "@bastani/atomic-tui";
import { addMainPromptHistory } from "../components/agent-prompt-history.ts";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";

/**
 * The one prompt writes to the agent the screen shows. Each agent keeps its own prompt while another is shown (D1):
 * leaving an agent takes its whole prompt state (text, cursor, paste registry, undo, kill ring, Up-history browsing)
 * and arriving puts the arriving agent's back, so main's prompt is exactly as origin's main editor, which the separate
 * subagent page never touched, would be. Late writes (a refused send, a restore answered after a switch, an engine
 * restart) reach the prompt of the agent they belong to through a {@link PromptHandle} captured when they began.
 */

/** Whose prompt: the main chat's, or a subagent's by its `agentKey`. */
export type PromptOwner = { readonly kind: "main" } | { readonly kind: "agent"; readonly agentKey: string };

const MAIN_KEY = "main";

function ownerKey(owner: PromptOwner): string {
	return owner.kind === "main" ? MAIN_KEY : `agent:${owner.agentKey}`;
}

/** One target's prompt, wherever it is now: in the editor while that target is shown, else kept aside. */
export interface PromptHandle {
	/** Whether this prompt is the one in the editor now. */
	isShown(): boolean;
	getText(): string;
	getExpandedText(): string;
	setText(text: string): void;
	addToHistory(text: string): void;
}

/** A prompt kept aside: the state it was left in, then every `setText` it received since, replayed on return. */
interface KeptPrompt {
	readonly draft: EditorDraft | undefined;
	/** What it showed: its text, and its text with pastes expanded (a history entry while it browsed Up history). */
	readonly text: string;
	readonly expanded: string;
	/** What the reader typed into it, expanded: while it browsed Up history, the draft Up parked. */
	readonly own: string;
	readonly writes: readonly string[];
}

class PromptDrafts {
	private readonly mode: InteractiveModeBase;
	/** The prompt in the editor now. */
	private live = MAIN_KEY;
	private readonly kept = new Map<string, KeptPrompt>();

	constructor(mode: InteractiveModeBase) {
		this.mode = mode;
	}

	private get editor(): EditorComponent {
		return this.mode.editor;
	}

	/** The key of the prompt the editor holds now. */
	get liveKey(): string {
		return this.live;
	}

	/**
	 * Put `owner`'s prompt in the editor and keep the one there aside. `between` runs once the leaving prompt is
	 * kept and before the arriving one is in: replacing the Up history ends history browsing, so it goes there.
	 */
	switchTo(owner: PromptOwner, between?: () => void): void {
		const arriving = ownerKey(owner);
		if (arriving === this.live) {
			between?.();
			return;
		}
		this.kept.set(this.live, this.keepLive());
		between?.();
		const prompt = this.kept.get(arriving);
		this.kept.delete(arriving);
		this.live = arriving;
		const editor = this.editor;
		if (editor.restoreDraft !== undefined) editor.restoreDraft(prompt?.draft ?? emptyEditorDraft());
		else editor.setText(prompt?.expanded ?? "");
		for (const text of prompt?.writes ?? []) editor.setText(text);
	}

	/** The prompt in the editor, as kept aside. */
	private keepLive(): KeptPrompt {
		const editor = this.editor;
		const draft = editor.snapshotDraft?.();
		const expanded = editor.getExpandedText?.() ?? editor.getText();
		return {
			draft,
			text: editor.getText(),
			expanded,
			own: draft === undefined ? expanded : editorDraftText(draft),
			writes: [],
		};
	}

	/** What the reader typed into `owner`'s prompt, expanded: while it browses Up history, the draft Up parked. */
	private ownText(key: string): string {
		if (key === this.live) return this.keepLive().own;
		const prompt = this.kept.get(key);
		return prompt === undefined ? "" : (prompt.writes.at(-1) ?? prompt.own);
	}

	/**
	 * Take `owner`'s prompt out of the store (an agent gone for good): what the reader typed into it, expanded, with
	 * every write since. Its prompt is left empty. An empty string when it has none.
	 */
	takeText(owner: PromptOwner): string {
		const key = ownerKey(owner);
		const text = this.ownText(key);
		if (key === this.live) this.editor.setText("");
		else this.kept.delete(key);
		return text;
	}

	/**
	 * Add `text` after what the reader typed into `owner`'s prompt (text typed for an agent while it was being
	 * opened). A history entry shown while browsing is not part of it: the draft Up parked is.
	 */
	appendText(owner: PromptOwner, text: string): void {
		this.rewriteOwnText(owner, (own) => `${own}${text}`);
	}

	/**
	 * Replace `owner`'s prompt with `combine` of what the reader typed into it: while it browses Up history, the draft
	 * Up parked, never the entry shown. Answers the prompt's text after.
	 */
	rewriteOwnText(owner: PromptOwner, combine: (own: string) => string): string {
		const key = ownerKey(owner);
		const merged = combine(this.ownText(key));
		if (key === this.live) {
			this.editor.setText(merged);
			return this.editor.getExpandedText?.() ?? this.editor.getText();
		}
		const prompt = this.kept.get(key);
		this.kept.set(key, {
			draft: prompt?.draft,
			text: prompt?.text ?? "",
			expanded: prompt?.expanded ?? "",
			own: prompt?.own ?? "",
			writes: [...(prompt?.writes ?? []), merged],
		});
		return merged;
	}

	handle(owner: PromptOwner): PromptHandle {
		const key = ownerKey(owner);
		const isLive = () => key === this.live;
		const kept = () => this.kept.get(key);
		// A kept prompt reads as the editor would show it on return. Main's reads as origin's main editor, which the
		// subagent page never touched: the history entry it showed while browsing. A subagent's reads as what the
		// reader typed into it, so text coming back to it joins that and not a history entry.
		const keptText = (prompt: KeptPrompt | undefined, expanded: boolean) =>
			prompt === undefined
				? ""
				: (prompt.writes.at(-1) ??
					(owner.kind === "main" ? (expanded ? prompt.expanded : prompt.text) : prompt.own));
		return {
			isShown: isLive,
			getText: () => (isLive() ? this.editor.getText() : keptText(kept(), false)),
			getExpandedText: () =>
				isLive() ? (this.editor.getExpandedText?.() ?? this.editor.getText()) : keptText(kept(), true),
			setText: (text) => {
				if (isLive()) {
					this.editor.setText(text);
					return;
				}
				const prompt = kept();
				this.kept.set(key, {
					draft: prompt?.draft,
					text: prompt?.text ?? "",
					expanded: prompt?.expanded ?? "",
					own: prompt?.own ?? "",
					writes: [...(prompt?.writes ?? []), text],
				});
			},
			addToHistory: (text) => {
				if (isLive()) this.editor.addToHistory?.(text);
				// Main's history waits for main; a subagent's is read from what it was delivered when it is shown again.
				else if (owner.kind === "main") addMainPromptHistory(this.editor, text);
			},
		};
	}
}

const drafts = new WeakMap<InteractiveModeBase, PromptDrafts>();

function promptDrafts(mode: InteractiveModeBase): PromptDrafts {
	let store = drafts.get(mode);
	if (store === undefined) {
		store = new PromptDrafts(mode);
		drafts.set(mode, store);
	}
	return store;
}

/** The prompt owner the screen shows now. */
export function viewedPromptOwner(mode: InteractiveModeBase): PromptOwner {
	const viewed = mode.agentView?.viewed;
	return viewed?.kind === "agent" ? { kind: "agent", agentKey: viewed.port.agentKey } : { kind: "main" };
}

/**
 * The prompt of the target shown now (`"viewed"`) or of the main chat (`"main"`), bound to that target for good:
 * while it is shown it is the editor itself, and once the screen shows another it is that target's kept prompt.
 * Capture it before any await whose late write must reach the prompt the input came from.
 */
export function promptHandle(mode: InteractiveModeBase, which: "viewed" | "main"): PromptHandle {
	return promptDrafts(mode).handle(which === "main" ? { kind: "main" } : viewedPromptOwner(mode));
}

/** Show `owner`'s prompt in the editor, keeping the one there aside; `between` runs in between (history). */
export function switchPrompt(mode: InteractiveModeBase, owner: PromptOwner, between?: () => void): void {
	promptDrafts(mode).switchTo(owner, between);
}

/** Take `owner`'s prompt text out (an agent gone for good): what it held, expanded; it is left empty. */
export function takePromptText(mode: InteractiveModeBase, owner: PromptOwner): string {
	return promptDrafts(mode).takeText(owner);
}

/**
 * Replace `owner`'s prompt with `combine` of what the reader typed into it, never a history entry it shows (text for a
 * subagent that is gone joins main's own draft). Answers the prompt's text after.
 */
export function rewritePromptOwnText(
	mode: InteractiveModeBase,
	owner: PromptOwner,
	combine: (own: string) => string,
): string {
	return promptDrafts(mode).rewriteOwnText(owner, combine);
}

/** Add `text` after what the reader typed into `owner`'s prompt, not after a history entry it shows. */
export function appendPromptText(mode: InteractiveModeBase, owner: PromptOwner, text: string): void {
	promptDrafts(mode).appendText(owner, text);
}

/**
 * Text typed for a subagent that is gone, which D6 moved into main's prompt, while main's prompt still holds exactly
 * what the move left: one Enter must not run a command that rewrites main from it without asking (supervisor ruling).
 */
export interface MovedDraftMark {
	/** The subagent it was typed for. */
	readonly agentName: string;
	/** Main's whole prompt as the move left it, as one Enter would submit it. */
	readonly text: string;
}

const movedMarks = new WeakMap<InteractiveModeBase, MovedDraftMark>();

/** Mark main's prompt `text` as moved from `agentName`'s, until the next submission. */
export function markMovedDraft(mode: InteractiveModeBase, agentName: string, text: string): void {
	movedMarks.set(mode, { agentName, text });
}

/**
 * The mark of main's prompt when `submitted` is exactly what the move left there; undefined otherwise. Every submission
 * takes the mark, so the next unrelated submission clears it. An edit counts by what it leaves: text that differs from
 * the moved text no longer matches, while browsing history and coming back to it, or typing it again exactly, still
 * asks.
 */
export function takeMovedDraftMark(mode: InteractiveModeBase, submitted: string): MovedDraftMark | undefined {
	const mark = movedMarks.get(mode);
	movedMarks.delete(mode);
	return mark !== undefined && mark.text.trim() === submitted.trim() ? mark : undefined;
}
