import type { HostInput } from "../../../packages/coding-agent/src/index.js";
import { InteractiveModeBase } from "../../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import { ProgramStatusReporter } from "../../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
import { initTheme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import "../../../packages/coding-agent/src/modes/interactive/interactive-extension-context.js";
import "../../../packages/coding-agent/src/modes/interactive/interactive-extension-dialogs.js";
import "../../../packages/coding-agent/src/modes/interactive/interactive-selectors.js";
import { ExtensionInputComponent } from "../../../packages/coding-agent/src/modes/interactive/components/extension-input.js";
import { ExtensionSelectorComponent } from "../../../packages/coding-agent/src/modes/interactive/components/extension-selector.js";

// Controlled presentation only: these are real CLI components and dialog methods.
export function attachedCliPresentation(text: string, reply: "true" | "false" | "cancelled" | "invalid" | "late") {
	const dialogs: string[] = [];
	const editor = {};
	let selector: ExtensionSelectorComponent | undefined;
	initTheme("dark");
	const mode = Object.assign(Object.create(InteractiveModeBase.prototype), {
		editor,
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		editorContainer: { clear() {}, addChild() {} },
		ui: {
			requestRender() {},
			setFocus(component: { handleInput(data: string): void }) {
				if (component === editor) return;
				queueMicrotask(() => {
					if (component instanceof ExtensionInputComponent) {
						dialogs.push("input");
						component.handleInput(`\x1b[200~${text}\x1b[201~`);
						component.handleInput("\r");
					} else if (component instanceof ExtensionSelectorComponent) {
						dialogs.push("confirm");
						selector = component;
						if (reply === "late" || reply === "cancelled") return;
						if (reply === "false") component.handleInput("\x1b[B");
						component.handleInput("\r");
					}
				});
			},
		},
	}) as InteractiveModeBase;
	const uiContext = mode.createExtensionUIContext();
	if (reply === "invalid") {
		const confirm = uiContext.confirm;
		// Fault injection at the presentation boundary, after the real dialog ran.
		// The unmodified runner bridge must reject this malformed renderer result.
		uiContext.confirm = async (...args) => {
			await confirm(...args);
			return "true" as unknown as boolean;
		};
	}
	return {
		uiContext,
		dialogs,
		lateTrue: () => selector?.handleInput("\r"),
		get activeDialog() {
			return mode.extensionSelector !== undefined;
		},
	};
}

// The supplied UI is the presentation session runner's validated context,
// not the raw presentation functions. Workflow request signal travels through both runners.
export function forwardCliDialogs(ui: ReturnType<InteractiveModeBase["createExtensionUIContext"]>): HostInput {
	return {
		input: (title, placeholder, options) => ui.input(title, placeholder, options),
		confirm: (title, message, options) => ui.confirm(title, message, options),
		select: (title, choices, options) => ui.select(title, choices, options),
		editor: (title, initial, options) => ui.editor(title, initial, options),
		questionnaire: async () => {
			throw new Error("primitive fixture does not request questionnaires");
		},
	};
}
