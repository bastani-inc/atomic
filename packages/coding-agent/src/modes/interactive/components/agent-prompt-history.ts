/** What the history of a retargeted prompt needs of its editor. */
export interface PromptHistoryEditor {
	addToHistory?(text: string): void;
	getHistory?(): readonly string[];
	setHistory?(newestFirst: readonly string[]): void;
	appendOlderHistory?(newestFirst: readonly string[]): void;
}

/** As many prompts as the editor's own history keeps. */
const HISTORY_LIMIT = 100;

const histories = new WeakMap<PromptHistoryEditor, AgentPromptHistory>();

/**
 * The Up/Down history of the one prompt that writes to the main chat or to the agent the screen views. While an agent
 * is viewed, Up recalls that agent's own delivered user messages as they were when the view started, oldest at the
 * end, then what was submitted while viewing it; back on the main chat, main's history is as it was left. Submissions
 * keep going through the editor's `addToHistory`, as the main chat's do, so they join the history of the agent viewed.
 * An editor that cannot replace its history keeps one history for every agent.
 */
export class AgentPromptHistory {
	private readonly editor: PromptHistoryEditor;
	/** Main's history, newest first, while an agent is viewed. */
	private main: string[] | undefined;
	private viewing: string | undefined;
	/** Which view a read of an agent's prompts belongs to: a read for an earlier view is dropped. */
	private generation = 0;

	constructor(editor: PromptHistoryEditor) {
		this.editor = editor;
	}

	/** The key of the agent whose history Up recalls, or undefined on the main chat. */
	get viewedAgent(): string | undefined {
		return this.viewing;
	}

	/**
	 * The prompt now writes to the agent `key`, whose own delivered user messages are `prompts`, oldest first. Viewing
	 * the agent already viewed changes nothing. The text and cursor stay; history browsing ends.
	 */
	viewAgent(key: string, prompts: readonly string[] | PromiseLike<readonly string[]>): void {
		const { editor } = this;
		if (editor.getHistory === undefined || editor.setHistory === undefined || key === this.viewing) return;
		this.main ??= [...editor.getHistory()];
		this.viewing = key;
		const generation = ++this.generation;
		if (!isPromiseLike(prompts)) {
			editor.setHistory([...prompts].reverse());
			return;
		}
		editor.setHistory([]);
		prompts.then(
			(loaded) => {
				if (generation !== this.generation) return;
				// What was submitted while the prompts were read stays newest, and browsing it goes on undisturbed.
				const older = [...loaded].reverse();
				if (editor.appendOlderHistory !== undefined) editor.appendOlderHistory(older);
				else editor.setHistory?.([...(editor.getHistory?.() ?? []), ...older]);
			},
			() => {},
		);
	}

	/** The prompt writes to the main chat again: Up recalls main's history. */
	viewMain(): void {
		this.generation++;
		this.viewing = undefined;
		const main = this.main;
		if (main === undefined) return;
		this.main = undefined;
		this.editor.setHistory?.(main);
	}

	/** Main's history gains `text`, also while an agent is viewed: it waits for main, as addToHistory keeps it. */
	addMain(text: string): void {
		const main = this.main;
		if (main === undefined) {
			this.editor.addToHistory?.(text);
			return;
		}
		const trimmed = text.trim();
		if (!trimmed || main[0] === trimmed) return;
		main.unshift(trimmed);
		if (main.length > HISTORY_LIMIT) main.pop();
	}
}

/** The history of the prompt `editor`, made on first use: one per editor, which the screen retargets. */
export function promptHistoryFor(editor: PromptHistoryEditor): AgentPromptHistory {
	let history = histories.get(editor);
	if (history === undefined) {
		history = new AgentPromptHistory(editor);
		histories.set(editor, history);
	}
	return history;
}

/** What Up recalls in `editor` while it writes to a viewed agent, newest first; undefined on the main chat. */
export function viewedAgentPromptHistory(editor: PromptHistoryEditor): readonly string[] | undefined {
	return histories.get(editor)?.viewedAgent === undefined ? undefined : (editor.getHistory?.() ?? []);
}

/**
 * Add `text` to the main chat's Up history, as the main chat does when it shows its session: through the prompt's
 * {@link AgentPromptHistory} when it has one, so an agent viewed meanwhile never recalls it.
 */
export function addMainPromptHistory(editor: PromptHistoryEditor, text: string): void {
	const history = histories.get(editor);
	if (history !== undefined) history.addMain(text);
	else editor.addToHistory?.(text);
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
	return typeof (value as { then?: unknown } | null)?.then === "function";
}
