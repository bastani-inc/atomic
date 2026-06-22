import { matchesKey } from "@earendil-works/pi-tui";
import { findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import { getAvailableThinkingLevels, getEffectiveBehavior, getEffectiveModel, updateBehavior } from "./chain-clarify-behavior.ts";
import { showNotice } from "./chain-clarify-frame.ts";
import { exitEditMode, type ChainClarifyState } from "./chain-clarify-state.ts";

export function enterModelSelector(state: ChainClarifyState): void {
	state.editingStep = state.selectedStep;
	state.editMode = "model";
	state.modelSearchQuery = "";
	state.modelSelectedIndex = 0;
	state.filteredModels = [...state.availableModels];
	const currentModel = splitKnownThinkingSuffix(getEffectiveModel(state, state.selectedStep)).baseModel;
	const currentIndex = state.filteredModels.findIndex((m) => m.fullId === currentModel || m.id === currentModel);
	if (currentIndex >= 0) {
		state.modelSelectedIndex = currentIndex;
	}

	state.tui.requestRender();
}

function filterModels(state: ChainClarifyState): void {
	const query = state.modelSearchQuery.toLowerCase();
	if (!query) {
		state.filteredModels = [...state.availableModels];
	} else {
		state.filteredModels = state.availableModels.filter((m) =>
			m.fullId.toLowerCase().includes(query) ||
			m.id.toLowerCase().includes(query) ||
			m.provider.toLowerCase().includes(query)
		);
	}
	state.modelSelectedIndex = Math.min(state.modelSelectedIndex, Math.max(0, state.filteredModels.length - 1));
}

export function handleModelSelectorInput(state: ChainClarifyState, data: string): void {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		exitEditMode(state);
		return;
	}

	if (matchesKey(data, "return")) {
		const selected = state.filteredModels[state.modelSelectedIndex];
		if (selected) {
			const { thinkingSuffix } = splitKnownThinkingSuffix(getEffectiveModel(state, state.editingStep!));
			const requestedLevel = thinkingSuffix.slice(1);
			const selectedModel = findModelInfo(selected.fullId, state.availableModels, state.preferredProvider);
			const suffix = getSupportedThinkingLevels(selectedModel).some((level) => level === requestedLevel) ? thinkingSuffix : "";
			updateBehavior(state, state.editingStep!, "model", `${selected.fullId}${suffix}`);
		}
		exitEditMode(state);
		return;
	}

	if (matchesKey(data, "up")) {
		if (state.filteredModels.length > 0) {
			state.modelSelectedIndex = state.modelSelectedIndex === 0
				? state.filteredModels.length - 1
				: state.modelSelectedIndex - 1;
		}
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "down")) {
		if (state.filteredModels.length > 0) {
			state.modelSelectedIndex = state.modelSelectedIndex === state.filteredModels.length - 1
				? 0
				: state.modelSelectedIndex + 1;
		}
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "backspace")) {
		if (state.modelSearchQuery.length > 0) {
			state.modelSearchQuery = state.modelSearchQuery.slice(0, -1);
			filterModels(state);
		}
		state.tui.requestRender();
		return;
	}

	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		state.modelSearchQuery += data;
		filterModels(state);
		state.tui.requestRender();
	}
}

export function enterThinkingSelector(state: ChainClarifyState): void {
	if (!getEffectiveBehavior(state, state.selectedStep).model) {
		showNotice(state, "Select a model first", "error");
		return;
	}
	state.editingStep = state.selectedStep;
	state.editMode = "thinking";

	const levels = getAvailableThinkingLevels(state, state.selectedStep);
	const { thinkingSuffix } = splitKnownThinkingSuffix(getEffectiveModel(state, state.selectedStep));
	const suffix = thinkingSuffix.slice(1);
	const levelIdx = levels.findIndex((level) => level === suffix);
	state.thinkingSelectedIndex = levelIdx >= 0 ? levelIdx : Math.max(0, levels.indexOf("off"));

	state.tui.requestRender();
}

export function handleThinkingSelectorInput(state: ChainClarifyState, data: string): void {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		exitEditMode(state);
		return;
	}

	const levels = getAvailableThinkingLevels(state, state.editingStep!);
	if (levels.length === 0) return;

	if (matchesKey(data, "return")) {
		const selectedLevel = levels[state.thinkingSelectedIndex] ?? "off";
		const currentModel = getEffectiveBehavior(state, state.editingStep!).model;
		if (currentModel) {
			const { baseModel } = splitKnownThinkingSuffix(currentModel);
			const newModel = selectedLevel === "off" ? baseModel : `${baseModel}:${selectedLevel}`;
			updateBehavior(state, state.editingStep!, "model", newModel);
		}
		exitEditMode(state);
		return;
	}

	if (matchesKey(data, "up")) {
		state.thinkingSelectedIndex = state.thinkingSelectedIndex === 0
			? levels.length - 1
			: state.thinkingSelectedIndex - 1;
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "down")) {
		state.thinkingSelectedIndex = state.thinkingSelectedIndex === levels.length - 1
			? 0
			: state.thinkingSelectedIndex + 1;
		state.tui.requestRender();
	}
}

export function enterSkillSelector(state: ChainClarifyState): void {
	state.editingStep = state.selectedStep;
	state.editMode = "skills";
	state.skillSearchQuery = "";
	state.skillCursorIndex = 0;
	state.filteredSkills = [...state.availableSkills];
	const current = getEffectiveBehavior(state, state.selectedStep).skills;
	state.skillSelectedNames.clear();
	if (current !== false && current.length > 0) {
		current.forEach((skillName) => state.skillSelectedNames.add(skillName));
	}
	state.tui.requestRender();
}

function filterSkills(state: ChainClarifyState): void {
	const query = state.skillSearchQuery.toLowerCase();
	if (!query) {
		state.filteredSkills = [...state.availableSkills];
	} else {
		state.filteredSkills = state.availableSkills.filter((s) =>
			s.name.toLowerCase().includes(query) ||
			(s.description?.toLowerCase().includes(query) ?? false),
		);
	}
	state.skillCursorIndex = Math.min(state.skillCursorIndex, Math.max(0, state.filteredSkills.length - 1));
}

export function handleSkillSelectorInput(state: ChainClarifyState, data: string): void {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		exitEditMode(state);
		return;
	}

	if (matchesKey(data, "return")) {
		const selected = [...state.skillSelectedNames];
		updateBehavior(state, state.editingStep!, "skills", selected);
		exitEditMode(state);
		return;
	}

	if (data === " ") {
		if (state.filteredSkills.length > 0) {
			const skill = state.filteredSkills[state.skillCursorIndex];
			if (skill) {
				if (state.skillSelectedNames.has(skill.name)) {
					state.skillSelectedNames.delete(skill.name);
				} else {
					state.skillSelectedNames.add(skill.name);
				}
			}
		}
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "up")) {
		if (state.filteredSkills.length > 0) {
			state.skillCursorIndex = state.skillCursorIndex === 0
				? state.filteredSkills.length - 1
				: state.skillCursorIndex - 1;
		}
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "down")) {
		if (state.filteredSkills.length > 0) {
			state.skillCursorIndex = state.skillCursorIndex === state.filteredSkills.length - 1
				? 0
				: state.skillCursorIndex + 1;
		}
		state.tui.requestRender();
		return;
	}

	if (matchesKey(data, "backspace")) {
		if (state.skillSearchQuery.length > 0) {
			state.skillSearchQuery = state.skillSearchQuery.slice(0, -1);
			filterSkills(state);
		}
		state.tui.requestRender();
		return;
	}

	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		state.skillSearchQuery += data;
		filterSkills(state);
		state.tui.requestRender();
	}
}
