import { matchesKey } from "@earendil-works/pi-tui";
import { getCursorDisplayPos, handleEditorInput, wrapText } from "./chain-clarify-editor.ts";
import { getEffectiveBehavior, propagateOutputChange, updateBehavior } from "./chain-clarify-behavior.ts";
import { EDIT_VIEWPORT_HEIGHT, exitEditMode, type ChainClarifyState } from "./chain-clarify-state.ts";
import type { EditMode } from "./chain-clarify-types.ts";

export function enterEditMode(state: ChainClarifyState, mode: EditMode): void {
	state.editingStep = state.selectedStep;
	state.editMode = mode;
	let buffer = "";

	if (mode === "template") {
		const template = state.templates[state.selectedStep] ?? "";
		buffer = template.split("\n")[0] ?? "";
	} else if (mode === "output") {
		const behavior = getEffectiveBehavior(state, state.selectedStep);
		buffer = behavior.output === false ? "" : (behavior.output || "");
	} else if (mode === "reads") {
		const behavior = getEffectiveBehavior(state, state.selectedStep);
		buffer = behavior.reads === false ? "" : (behavior.reads?.join(", ") || "");
	}

	state.editState = { buffer, cursor: 0, viewportOffset: 0 };
	state.tui.requestRender();
}

export function handleEditInput(state: ChainClarifyState, data: string): void {
	const textWidth = state.width - 4;
	if (matchesKey(data, "shift+up") || matchesKey(data, "pageUp")) {
		const { lines: wrapped, starts } = wrapText(state.editState.buffer, textWidth);
		const cursorPos = getCursorDisplayPos(state.editState.cursor, starts);
		const targetLine = Math.max(0, cursorPos.line - EDIT_VIEWPORT_HEIGHT);
		const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
		state.editState = { ...state.editState, cursor: starts[targetLine]! + targetCol };
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "shift+down") || matchesKey(data, "pageDown")) {
		const { lines: wrapped, starts } = wrapText(state.editState.buffer, textWidth);
		const cursorPos = getCursorDisplayPos(state.editState.cursor, starts);
		const targetLine = Math.min(wrapped.length - 1, cursorPos.line + EDIT_VIEWPORT_HEIGHT);
		const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
		state.editState = { ...state.editState, cursor: starts[targetLine]! + targetCol };
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "tab")) return;

	const nextState = handleEditorInput(state.editState, data, textWidth);
	if (nextState) {
		state.editState = nextState;
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "escape")) {
		saveEdit(state);
		exitEditMode(state);
		return;
	}

	if (matchesKey(data, "ctrl+c")) {
		exitEditMode(state);
		return;
	}
}

function saveEdit(state: ChainClarifyState): void {
	const stepIndex = state.editingStep!;

	if (state.editMode === "template") {
		const original = state.templates[stepIndex] ?? "";
		const originalLines = original.split("\n");
		originalLines[0] = state.editState.buffer;
		state.templates[stepIndex] = originalLines.join("\n");
	} else if (state.editMode === "output") {
		const oldBehavior = getEffectiveBehavior(state, stepIndex);
		const oldOutput = typeof oldBehavior.output === "string" ? oldBehavior.output : null;
		const trimmed = state.editState.buffer.trim();
		const newOutput = trimmed === "" ? false : trimmed;
		updateBehavior(state, stepIndex, "output", newOutput);

		if (oldOutput && typeof newOutput === "string" && oldOutput !== newOutput) {
			propagateOutputChange(state, stepIndex, oldOutput, newOutput);
		}
	} else if (state.editMode === "reads") {
		const trimmed = state.editState.buffer.trim();
		if (trimmed === "") {
			updateBehavior(state, stepIndex, "reads", false);
		} else {
			const files = trimmed.split(",").map((f) => f.trim()).filter((f) => f !== "");
			updateBehavior(state, stepIndex, "reads", files.length > 0 ? files : false);
		}
	}
}
