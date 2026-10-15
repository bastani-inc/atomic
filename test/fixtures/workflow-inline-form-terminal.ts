import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.js";
import { InlineFormEditor } from "../../packages/workflows/src/tui/inline-form-editor.js";
import { createForm, finalizeForm } from "../../packages/workflows/src/tui/inline-form-store.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";

const theme = deriveGraphTheme({});
const state = createForm({
	formId: "current-terminal-form",
	workflowName: "Current form",
	fields: [{ name: "message", type: "string", required: true }],
	rawText: { message: "" },
	focusedIdx: 0,
	caret: 0,
	status: "editing",
});
const tui = new TuiMainScreen(new ProcessTerminal());
const closed = Promise.withResolvers<void>();
const editor = new InlineFormEditor(tui, {
	formId: state.formId,
	theme,
	keybindings: makeFakeKeybindings({ "tui.editor.deleteCharBackward": ["!"] }),
	onExit: (outcome) => {
		finalizeForm(state.formId, outcome);
		closed.resolve();
	},
});
const component = {
	render: (width: number) => renderInlineCard({ width, state, theme }),
	invalidate: () => editor.invalidate(),
	handleInput: (data: string) => editor.handleInput(data),
};
tui.addChild(component);
tui.setFocus(component);
tui.start();
try {
	await closed.promise;
} finally {
	editor.dispose?.();
	tui.stop();
}
console.log(`FORM_RESULT=${JSON.stringify({ status: state.status, message: state.rawText.message })}`);
