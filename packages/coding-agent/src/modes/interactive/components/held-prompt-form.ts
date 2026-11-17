import { type Component, getKeybindings, type TUI } from "@bastani/atomic-tui";
import { type HeldPrompt, heldPrompts } from "../../../core/extensions/held-prompts.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { PromptRoute } from "../../../core/tasks/contracts.js";
import { buildItemsForQuestion } from "../../../core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../../core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionnaireResult } from "../../../core/tools/ask-user-question/tool/types.js";
import { theme } from "../theme/theme.js";
import { ExtensionEditorComponent } from "./extension-editor.ts";
import { ExtensionInputComponent } from "./extension-input.ts";
import { ExtensionSelectorComponent } from "./extension-selector.ts";

/** A held prompt's form, as its session's view shows it. */
export type HeldPromptForm = Component & {
	handleInput(data: string): unknown;
	/** Whether ← belongs to the form now (a cursor, a question tab), so it does not leave the view. */
	capturesBack?(): boolean;
	dispose?(): void;
};

/** What a view that shows a session's held prompt renders with. */
export interface HeldPromptFormEnv {
	readonly tui?: TUI;
	readonly keybindings?: unknown;
	readonly requestRender: () => void;
}

interface Kept {
	readonly form: HeldPromptForm;
	/** The view the form renders through now: the one that showed it last. */
	env: HeldPromptFormEnv;
}

const forms = new Map<string, Kept>();
let watching = false;

function keyOf(route: PromptRoute): string {
	return `${route.sessionId}\0${route.promptId}`;
}

/** Forms of prompts no longer held are dropped as their prompts settle. */
function watchSettlements(): void {
	if (watching) return;
	watching = true;
	heldPrompts().subscribe((sessionId) => {
		for (const [key, kept] of forms) {
			const [owner, promptId] = key.split("\0") as [string, string];
			if (owner !== sessionId) continue;
			if (heldPrompts().current(owner)?.promptId === promptId) continue;
			forms.delete(key);
			kept.form.dispose?.();
		}
	});
}

/**
 * The form `prompt` shows in its own session's view. It is built once and kept while the prompt waits, so a view that
 * is left and opened again shows it exactly as it was left: the selected option, the question tab, notes and choices.
 * Its answer and its Esc reach only this prompt, by its route.
 */
export function heldPromptForm(prompt: HeldPrompt, env: HeldPromptFormEnv): HeldPromptForm {
	watchSettlements();
	const route: PromptRoute = { sessionId: prompt.sessionId, promptId: prompt.promptId };
	const key = keyOf(route);
	const kept = forms.get(key);
	if (kept !== undefined) {
		kept.env = env;
		return kept.form;
	}
	const entry = { env } as Kept;
	// The form renders through whichever view shows it now.
	const tui = {
		get terminal() {
			return entry.env.tui?.terminal ?? { columns: 80, rows: 24 };
		},
		start: () => entry.env.tui?.start?.(),
		stop: () => entry.env.tui?.stop?.(),
		requestRender: (force?: boolean) => {
			entry.env.tui?.requestRender?.(force);
			entry.env.requestRender();
		},
	} as unknown as TUI;
	const answer = (value: boolean | string | QuestionnaireResult): void => {
		heldPrompts().answer(route, { value });
	};
	const cancel = (): void => {
		heldPrompts().cancel(route);
	};
	let form: HeldPromptForm;
	switch (prompt.kind) {
		case "questionnaire": {
			const params = prompt.params ?? { questions: [] };
			const session = new QuestionnaireSession({
				tui,
				theme,
				params,
				itemsByTab: params.questions.map(buildItemsForQuestion),
				done: (result) => (result.cancelled ? cancel() : answer(result)),
			});
			form = Object.assign(session.component, { capturesBack: () => session.capturesBack() });
			break;
		}
		case "confirm":
			form = new ExtensionSelectorComponent(
				prompt.message === undefined ? prompt.title : `${prompt.title}\n${prompt.message}`,
				["Yes", "No"],
				(option) => answer(option === "Yes"),
				cancel,
				{ tui, numbered: true },
			);
			break;
		case "select":
			form = new ExtensionSelectorComponent(prompt.title, [...(prompt.choices ?? [])], answer, cancel, { tui });
			break;
		case "input": {
			const input = new ExtensionInputComponent(prompt.title, prompt.placeholder, answer, cancel, { tui });
			input.focused = true;
			form = Object.assign(input, {
				capturesBack: () => input.getCursor() > 0,
			});
			break;
		}
		case "editor": {
			const editor = new ExtensionEditorComponent(
				tui,
				(env.keybindings ?? getKeybindings()) as KeybindingsManager,
				prompt.title,
				prompt.initial,
				answer,
				cancel,
			);
			editor.focused = true;
			form = Object.assign(editor, {
				capturesBack: () => {
					const cursor = editor.getCursor();
					return cursor.line > 0 || cursor.col > 0;
				},
			});
			break;
		}
	}
	Object.assign(entry, { form });
	if (heldPrompts().isCurrent(route)) forms.set(key, entry);
	return form;
}
