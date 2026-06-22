import { truncateToWidth } from "@earendil-works/pi-tui";
import { getCursorDisplayPos, ensureCursorVisible, renderEditor, wrapText } from "./chain-clarify-editor.ts";
import { getAvailableThinkingLevels, getEffectiveModel } from "./chain-clarify-behavior.ts";
import { getStepLabel, renderFooter, renderHeader, row } from "./chain-clarify-frame.ts";
import { EDIT_VIEWPORT_HEIGHT, MODEL_SELECTOR_HEIGHT, type ChainClarifyState } from "./chain-clarify-state.ts";
import { splitKnownThinkingSuffix, type ThinkingLevel } from "../../shared/model-info.ts";

export function renderFullEditMode(state: ChainClarifyState): string[] {
	const innerW = state.width - 2;
	const textWidth = innerW - 2;
	const lines: string[] = [];

	const { lines: wrapped, starts } = wrapText(state.editState.buffer, textWidth);
	const cursorPos = getCursorDisplayPos(state.editState.cursor, starts);
	state.editState = {
		...state.editState,
		viewportOffset: ensureCursorVisible(cursorPos.line, EDIT_VIEWPORT_HEIGHT, state.editState.viewportOffset),
	};

	const fieldName = state.editMode === "template" ? "task" : state.editMode;
	const rawAgentName = state.agentConfigs[state.editingStep!]?.name ?? "unknown";
	const maxAgentLen = innerW - 30;
	const agentName = rawAgentName.length > maxAgentLen
		? rawAgentName.slice(0, maxAgentLen - 1) + "…"
		: rawAgentName;
	const stepLabel = state.mode === "single"
		? agentName
		: state.mode === "parallel"
			? `Task ${state.editingStep! + 1}: ${agentName}`
			: `Step ${state.editingStep! + 1}: ${agentName}`;
	lines.push(renderHeader(state, ` Editing ${fieldName} (${stepLabel}) `));
	lines.push(row(state, ""));

	const editorLines = renderEditor(state.editState, textWidth, EDIT_VIEWPORT_HEIGHT);
	for (const line of editorLines) {
		lines.push(row(state, ` ${line}`));
	}

	const linesBelow = wrapped.length - state.editState.viewportOffset - EDIT_VIEWPORT_HEIGHT;
	const hasMore = linesBelow > 0;
	const hasLess = state.editState.viewportOffset > 0;
	let scrollInfo = "";
	if (hasLess) scrollInfo += "↑";
	if (hasMore) scrollInfo += `↓ ${linesBelow}+`;

	lines.push(row(state, ""));
	const footerText = scrollInfo
		? ` [Esc] Done • [Ctrl+C] Discard • ${scrollInfo} `
		: " [Esc] Done • [Ctrl+C] Discard ";
	lines.push(renderFooter(state, footerText));

	return lines;
}

export function renderModelSelector(state: ChainClarifyState): string[] {
	const th = state.theme;
	const lines: string[] = [];

	lines.push(renderHeader(state, ` Select Model (${getStepLabel(state, state.editingStep!)}) `));
	lines.push(row(state, ""));
	const searchPrefix = th.fg("dim", "Search: ");
	const cursor = "\x1b[7m \x1b[27m";
	lines.push(row(state, ` ${searchPrefix}${state.modelSearchQuery}${cursor}`));
	lines.push(row(state, ""));

	const currentModel = getEffectiveModel(state, state.editingStep!);
	const currentModelBase = splitKnownThinkingSuffix(currentModel).baseModel;
	const currentLabel = th.fg("dim", "Current: ");
	lines.push(row(state, ` ${currentLabel}${th.fg("warning", currentModel)}`));
	lines.push(row(state, ""));

	if (state.filteredModels.length === 0) {
		lines.push(row(state, ` ${th.fg("dim", "No matching models")}`));
	} else {
		const maxVisible = MODEL_SELECTOR_HEIGHT;
		let startIdx = 0;
		if (state.filteredModels.length > maxVisible) {
			startIdx = Math.max(0, state.modelSelectedIndex - Math.floor(maxVisible / 2));
			startIdx = Math.min(startIdx, state.filteredModels.length - maxVisible);
		}

		const endIdx = Math.min(startIdx + maxVisible, state.filteredModels.length);
		if (startIdx > 0) {
			lines.push(row(state, ` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));
		}

		for (let i = startIdx; i < endIdx; i++) {
			const model = state.filteredModels[i]!;
			const isSelected = i === state.modelSelectedIndex;
			const isCurrent = model.fullId === currentModelBase || model.id === currentModelBase;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const modelText = isSelected ? th.fg("accent", model.id) : model.id;
			const providerBadge = th.fg("dim", ` [${model.provider}]`);
			const currentBadge = isCurrent ? th.fg("success", " current") : "";
			lines.push(row(state, ` ${prefix}${modelText}${providerBadge}${currentBadge}`));
		}

		const remaining = state.filteredModels.length - endIdx;
		if (remaining > 0) {
			lines.push(row(state, ` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
		}
	}

	for (let i = lines.length; i < 18; i++) {
		lines.push(row(state, ""));
	}
	lines.push(renderFooter(state, " [Enter] Select • [Esc] Cancel • Type to search "));
	return lines;
}

export function renderThinkingSelector(state: ChainClarifyState): string[] {
	const th = state.theme;
	const lines: string[] = [];

	lines.push(renderHeader(state, ` Thinking Level (${getStepLabel(state, state.editingStep!)}) `));
	lines.push(row(state, ""));
	const currentModel = getEffectiveModel(state, state.editingStep!);
	lines.push(row(state, ` ${th.fg("dim", "Model: ")}${th.fg("accent", currentModel)}`));
	lines.push(row(state, ""));
	lines.push(row(state, ` ${th.fg("dim", "Select thinking level (extended thinking budget):")}`));
	lines.push(row(state, ""));

	const levelDescriptions: Record<ThinkingLevel, string> = {
		off: "No extended thinking",
		minimal: "Brief reasoning",
		low: "Light reasoning",
		medium: "Moderate reasoning",
		high: "Deep reasoning",
		xhigh: "Maximum reasoning (ultrathink)",
	};
	const levels = getAvailableThinkingLevels(state, state.editingStep!);
	if (levels.length === 0) {
		lines.push(row(state, ` ${th.fg("dim", "No supported thinking levels")}`));
	} else {
		for (let i = 0; i < levels.length; i++) {
			const level = levels[i]!;
			const isSelected = i === state.thinkingSelectedIndex;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const levelText = isSelected ? th.fg("accent", level) : level;
			const desc = th.fg("dim", ` - ${levelDescriptions[level]}`);
			lines.push(row(state, ` ${prefix}${levelText}${desc}`));
		}
	}

	for (let i = lines.length; i < 16; i++) {
		lines.push(row(state, ""));
	}
	const footerText = levels.length === 0
		? " [Esc] Cancel "
		: " [Enter] Select • [Esc] Cancel • ↑↓ Navigate ";
	lines.push(renderFooter(state, footerText));
	return lines;
}

export function renderSkillSelector(state: ChainClarifyState): string[] {
	const innerW = state.width - 2;
	const th = state.theme;
	const lines: string[] = [];

	lines.push(renderHeader(state, ` Select Skills (${getStepLabel(state, state.editingStep!)}) `));
	lines.push(row(state, ""));
	const cursor = "\x1b[7m \x1b[27m";
	lines.push(row(state, ` ${th.fg("dim", "Search: ")}${state.skillSearchQuery}${cursor}`));
	lines.push(row(state, ""));

	const selected = [...state.skillSelectedNames].join(", ") || th.fg("dim", "(none)");
	lines.push(row(state, ` ${th.fg("dim", "Selected: ")}${truncateToWidth(selected, innerW - 12)}`));
	lines.push(row(state, ""));

	const selectorHeight = 10;
	if (state.filteredSkills.length === 0) {
		lines.push(row(state, ` ${th.fg("dim", "No matching skills")}`));
	} else {
		let startIdx = 0;
		if (state.filteredSkills.length > selectorHeight) {
			startIdx = Math.max(0, state.skillCursorIndex - Math.floor(selectorHeight / 2));
			startIdx = Math.min(startIdx, state.filteredSkills.length - selectorHeight);
		}
		const endIdx = Math.min(startIdx + selectorHeight, state.filteredSkills.length);
		if (startIdx > 0) lines.push(row(state, ` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));

		for (let i = startIdx; i < endIdx; i++) {
			const skill = state.filteredSkills[i]!;
			const isCursor = i === state.skillCursorIndex;
			const isSelected = state.skillSelectedNames.has(skill.name);
			const prefix = isCursor ? th.fg("accent", "→ ") : "  ";
			const checkbox = isSelected ? th.fg("success", "[x]") : "[ ]";
			const nameText = isCursor ? th.fg("accent", skill.name) : skill.name;
			const sourceBadge = th.fg("dim", ` [${skill.source}]`);
			const desc = skill.description ? th.fg("dim", ` - ${truncateToWidth(skill.description, 25)}`) : "";
			lines.push(row(state, ` ${prefix}${checkbox} ${nameText}${sourceBadge}${desc}`));
		}

		const remaining = state.filteredSkills.length - endIdx;
		if (remaining > 0) lines.push(row(state, ` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
	}

	for (let i = lines.length; i < 18; i++) {
		lines.push(row(state, ""));
	}
	lines.push(renderFooter(state, " [Enter] Confirm • [Space] Toggle • [Esc] Cancel "));
	return lines;
}
