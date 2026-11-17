import {
	type Component,
	getKeybindings,
	type Terminal,
	type TUI,
	TuiMainScreen,
	type TuiStopOptions,
} from "@bastani/atomic-tui";
import { type HeldPrompt, heldPrompts } from "../../../core/extensions/held-prompts.ts";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { PromptRoute } from "../../../core/tasks/contracts.js";
import { buildItemsForQuestion } from "../../../core/tools/ask-user-question/ask-user-question.js";
import { QuestionnaireSession } from "../../../core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionnaireResult } from "../../../core/tools/ask-user-question/tool/types.js";
import { theme } from "../theme/theme.js";
import { CountdownTimer } from "./countdown-timer.ts";
import { ExtensionEditorComponent } from "./extension-editor.ts";
import { ExtensionInputComponent } from "./extension-input.ts";
import { ExtensionSelectorComponent } from "./extension-selector.ts";

export type HeldPromptForm = Component & {
	handleInput(data: string): void;
	capturesBack?(): boolean;
	dispose?(): void;
};

export interface HeldPromptFormEnv {
	readonly tui?: TUI;
	readonly keybindings?: KeybindingsManager;
	readonly requestRender: () => void;
}

interface Kept {
	readonly route: PromptRoute;
	readonly form: HeldPromptForm;
	setEnv(env: HeldPromptFormEnv): void;
}

const fallbackTerminal: Terminal = {
	start: () => {},
	stop: () => {},
	drainInput: async () => {},
	write: () => {},
	columns: 80,
	rows: 24,
	kittyProtocolActive: false,
	moveBy: () => {},
	hideCursor: () => {},
	showCursor: () => {},
	clearLine: () => {},
	clearFromCursor: () => {},
	clearScreen: () => {},
	setTitle: () => {},
	setProgress: () => {},
	setProgramStatus: () => {},
};

class HeldPromptTui extends TuiMainScreen {
	private readonly getEnv: () => HeldPromptFormEnv;

	constructor(getEnv: () => HeldPromptFormEnv) {
		super({
			...fallbackTerminal,
			get columns() {
				return getEnv().tui?.terminal.columns ?? 80;
			},
			get rows() {
				return getEnv().tui?.terminal.rows ?? 24;
			},
		});
		this.getEnv = getEnv;
	}

	override start(): void {
		this.getEnv().tui?.start();
	}

	override stop(options?: TuiStopOptions): void {
		this.getEnv().tui?.stop(options);
	}

	override requestRender(force?: boolean): void {
		this.getEnv().tui?.requestRender(force);
		this.getEnv().requestRender();
	}
}

const forms = new Map<string, Kept>();
let watching = false;

function keyOf(route: PromptRoute): string {
	return `${route.sessionId}\0${route.promptId}`;
}

function watchSettlements(): void {
	if (watching) return;
	watching = true;
	heldPrompts().subscribe((sessionId) => {
		for (const [key, kept] of forms) {
			if (kept.route.sessionId !== sessionId) continue;
			if (heldPrompts().current(sessionId)?.promptId === kept.route.promptId) continue;
			forms.delete(key);
			kept.form.dispose?.();
		}
	});
}

export function heldPromptForm(prompt: HeldPrompt, env: HeldPromptFormEnv): HeldPromptForm {
	watchSettlements();
	const route: PromptRoute = { sessionId: prompt.sessionId, promptId: prompt.promptId };
	const key = keyOf(route);
	const kept = forms.get(key);
	if (kept !== undefined) {
		kept.setEnv(env);
		return kept.form;
	}
	let currentEnv = env;
	const tui = new HeldPromptTui(() => currentEnv);
	const live = heldPrompts().isCurrent(route);
	const timeout = live && prompt.expiresAt !== undefined ? Math.max(1, prompt.expiresAt - Date.now()) : undefined;
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
				{ tui, numbered: true, ...(timeout === undefined ? {} : { timeout }) },
			);
			break;
		case "select":
			form = new ExtensionSelectorComponent(prompt.title, [...(prompt.choices ?? [])], answer, cancel, {
				tui,
				...(timeout === undefined ? {} : { timeout }),
			});
			break;
		case "input": {
			const input = new ExtensionInputComponent(prompt.title, prompt.placeholder, answer, cancel, {
				tui,
				...(timeout === undefined ? {} : { timeout }),
			});
			input.focused = true;
			form = Object.assign(input, {
				capturesBack: () => input.getCursor() > 0,
			});
			break;
		}
		case "editor": {
			const keybindings = env.keybindings ?? new KeybindingsManager(getKeybindings().getResolvedBindings());
			const editor = new ExtensionEditorComponent(tui, keybindings, prompt.title, prompt.initial, answer, cancel);
			editor.focused = true;
			const countdown =
				timeout === undefined
					? undefined
					: new CountdownTimer(
							timeout,
							tui,
							(seconds) => editor.setTitle(`${prompt.title} (${seconds}s)`),
							cancel,
						);
			form = Object.assign(editor, {
				capturesBack: () => {
					const cursor = editor.getCursor();
					return cursor.line > 0 || cursor.col > 0;
				},
				dispose: () => countdown?.dispose(),
			});
			break;
		}
	}
	if (live) {
		forms.set(key, {
			route,
			form,
			setEnv: (next) => {
				currentEnv = next;
			},
		});
	}
	return form;
}
