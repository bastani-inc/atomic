import { truncateToWidth } from "@earendil-works/pi-tui";
import { getEffectiveBehavior, getEffectiveModel } from "./chain-clarify-behavior.ts";
import { appendNotice, getFooterText, renderFooter, renderHeader, row } from "./chain-clarify-frame.ts";
import type { ChainClarifyState } from "./chain-clarify-state.ts";

export function renderSingleMode(state: ChainClarifyState): string[] {
	const innerW = state.width - 2;
	const th = state.theme;
	const lines: string[] = [];

	const agentName = state.agentConfigs[0]?.name ?? "unknown";
	const maxHeaderLen = innerW - 4;
	const headerText = ` Agent: ${truncateToWidth(agentName, maxHeaderLen - 9)} `;
	lines.push(renderHeader(state, headerText));
	lines.push(row(state, ""));

	const config = state.agentConfigs[0]!;
	const behavior = getEffectiveBehavior(state, 0);
	lines.push(row(state, ` ${th.fg("accent", "▶ " + config.name)}`));

	const template = (state.templates[0] ?? "").split("\n")[0] ?? "";
	lines.push(row(state, `     ${th.fg("dim", "task: ")}${truncateToWidth(template, innerW - 12)}`));
	lines.push(row(state, `     ${th.fg("dim", "model: ")}${truncateToWidth(formatModelValue(state, 0), innerW - 13)}`));

	const writesValue = behavior.output === false
		? th.fg("dim", "(disabled)")
		: (behavior.output || th.fg("dim", "(none)"));
	lines.push(row(state, `     ${th.fg("dim", "writes: ")}${truncateToWidth(writesValue, innerW - 14)}`));
	lines.push(row(state, `     ${th.fg("dim", "skills: ")}${truncateToWidth(formatSkillsValue(state, behavior.skills), innerW - 14)}`));
	lines.push(row(state, ""));

	appendNotice(state, lines);
	lines.push(renderFooter(state, getFooterText(state)));
	return lines;
}

export function renderParallelMode(state: ChainClarifyState): string[] {
	const innerW = state.width - 2;
	const th = state.theme;
	const lines: string[] = [];

	lines.push(renderHeader(state, ` Parallel Tasks (${state.agentConfigs.length}) `));
	lines.push(row(state, ""));

	for (let i = 0; i < state.agentConfigs.length; i++) {
		const config = state.agentConfigs[i]!;
		const isSelected = i === state.selectedStep;
		const color = isSelected ? "accent" : "dim";
		const prefix = isSelected ? "▶ " : "  ";
		const taskPrefix = `Task ${i + 1}: `;
		const maxNameLen = innerW - 4 - prefix.length - taskPrefix.length;
		const agentName = config.name.length > maxNameLen
			? config.name.slice(0, maxNameLen - 1) + "…"
			: config.name;
		lines.push(row(state, ` ${th.fg(color, prefix + taskPrefix + agentName)}`));

		const template = (state.templates[i] ?? "").split("\n")[0] ?? "";
		lines.push(row(state, `     ${th.fg("dim", "task: ")}${truncateToWidth(template, innerW - 12)}`));
		lines.push(row(state, `     ${th.fg("dim", "model: ")}${truncateToWidth(formatModelValue(state, i), innerW - 13)}`));

		const behavior = getEffectiveBehavior(state, i);
		lines.push(row(state, `     ${th.fg("dim", "skills: ")}${truncateToWidth(formatSkillsValue(state, behavior.skills), innerW - 14)}`));
		lines.push(row(state, ""));
	}

	appendNotice(state, lines);
	lines.push(renderFooter(state, getFooterText(state)));
	return lines;
}

export function renderChainMode(state: ChainClarifyState): string[] {
	const innerW = state.width - 2;
	const th = state.theme;
	const lines: string[] = [];

	const chainLabel = state.agentConfigs.map((c) => c.name).join(" → ");
	const maxHeaderLen = innerW - 4;
	lines.push(renderHeader(state, ` Chain: ${truncateToWidth(chainLabel, maxHeaderLen - 9)} `));
	lines.push(row(state, ""));
	lines.push(row(state, ` Original Task: ${truncateToWidth(state.originalTask, innerW - 16)}`));
	const chainDirPreview = truncateToWidth(state.chainDir ?? "", innerW - 12);
	lines.push(row(state, ` Chain Dir: ${th.fg("dim", chainDirPreview)}`));

	const progressEnabled = state.agentConfigs.some((_, i) => getEffectiveBehavior(state, i).progress);
	const progressValue = progressEnabled ? th.fg("success", "enabled") : th.fg("dim", "disabled");
	lines.push(row(state, ` Progress: ${progressValue} ${th.fg("dim", "(press [p] to toggle)")}`));
	lines.push(row(state, ""));

	for (let i = 0; i < state.agentConfigs.length; i++) {
		renderChainStep(state, lines, i, progressEnabled);
	}

	appendNotice(state, lines);
	lines.push(renderFooter(state, getFooterText(state)));
	return lines;
}

function renderChainStep(state: ChainClarifyState, lines: string[], index: number, progressEnabled: boolean): void {
	const innerW = state.width - 2;
	const th = state.theme;
	const config = state.agentConfigs[index]!;
	const isSelected = index === state.selectedStep;
	const behavior = getEffectiveBehavior(state, index);
	const color = isSelected ? "accent" : "dim";
	const prefix = isSelected ? "▶ " : "  ";
	const stepPrefix = `Step ${index + 1}: `;
	const maxNameLen = innerW - 4 - prefix.length - stepPrefix.length;
	const agentName = config.name.length > maxNameLen
		? config.name.slice(0, maxNameLen - 1) + "…"
		: config.name;
	lines.push(row(state, ` ${th.fg(color, prefix + stepPrefix + agentName)}`));

	const template = (state.templates[index] ?? "").split("\n")[0] ?? "";
	const highlighted = template
		.replace(/\{task\}/g, th.fg("success", "{task}"))
		.replace(/\{previous\}/g, th.fg("warning", "{previous}"))
		.replace(/\{chain_dir\}/g, th.fg("accent", "{chain_dir}"));
	lines.push(row(state, `     ${th.fg("dim", "task: ")}${truncateToWidth(highlighted, innerW - 12)}`));
	lines.push(row(state, `     ${th.fg("dim", "model: ")}${truncateToWidth(formatModelValue(state, index), innerW - 13)}`));

	const writesValue = behavior.output === false
		? th.fg("dim", "(disabled)")
		: (behavior.output || th.fg("dim", "(none)"));
	lines.push(row(state, `     ${th.fg("dim", "writes: ")}${truncateToWidth(writesValue, innerW - 14)}`));

	const readsValue = behavior.reads === false
		? th.fg("dim", "(disabled)")
		: (behavior.reads && behavior.reads.length > 0 ? behavior.reads.join(", ") : th.fg("dim", "(none)"));
	lines.push(row(state, `     ${th.fg("dim", "reads: ")}${truncateToWidth(readsValue, innerW - 13)}`));
	lines.push(row(state, `     ${th.fg("dim", "skills: ")}${truncateToWidth(formatSkillsValue(state, behavior.skills), innerW - 14)}`));

	if (progressEnabled) {
		const progressAction = index === 0
			? th.fg("success", "writes progress.md")
			: th.fg("accent", "reads progress.md");
		lines.push(row(state, `     ${th.fg("dim", "progress: ")}${progressAction}`));
	}

	if (index < state.agentConfigs.length - 1) {
		const nextStepUsePrevious = (state.templates[index + 1] ?? "").includes("{previous}");
		if (nextStepUsePrevious) {
			const indicator = th.fg("dim", "     ↳ response → ") + th.fg("warning", "{previous}");
			lines.push(row(state, indicator));
		}
	}
	lines.push(row(state, ""));
}

function formatModelValue(state: ChainClarifyState, stepIndex: number): string {
	const effectiveModel = getEffectiveModel(state, stepIndex);
	const override = state.behaviorOverrides.get(stepIndex);
	return override?.model !== undefined
		? state.theme.fg("warning", effectiveModel) + state.theme.fg("dim", " ✎")
		: effectiveModel;
}

function formatSkillsValue(state: ChainClarifyState, skills: string[] | false): string {
	return skills === false
		? state.theme.fg("dim", "(disabled)")
		: (skills.length ? skills.join(", ") : state.theme.fg("dim", "(none)"));
}
