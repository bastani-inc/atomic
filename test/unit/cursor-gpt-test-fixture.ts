import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";

const parameter = (id: string, value: string) => ({ id, value });

export function authenticatedGpt56SolModel(): CursorUsableModel {
	const efforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
	const modes = [
		{ context: "272k", fast: "false", isMaxMode: false },
		{ context: "272k", fast: "true", isMaxMode: false },
		{ context: "1m", fast: "false", isMaxMode: true },
	] as const;
	return {
		id: "gpt-5.6-sol",
		displayName: "GPT-5.6 Sol",
		serverModelName: "gpt-5.6-sol",
		supportsImages: true,
		supportsMaxMode: true,
		supportsNonMaxMode: true,
		metadataProvenance: "available-models-reverse-engineered",
		variants: modes.flatMap((mode) => efforts.map((effort) => ({
			parameters: [parameter("context", mode.context), parameter("reasoning", effort), parameter("fast", mode.fast)],
			isMaxMode: mode.isMaxMode,
			...(effort === "medium" && mode.fast === "false"
				? mode.isMaxMode ? { isDefaultMaxConfig: true } : { isDefaultNonMaxConfig: true }
				: {}),
			displayName: "GPT-5.6 Sol",
			displayNameOutsidePicker: "GPT-5.6 Sol",
			variantStringRepresentation: `gpt-5.6-sol[context=${mode.context},reasoning=${effort},fast=${mode.fast}]`,
		}))),
		parameterDefinitions: [
			{ id: "context", displayName: "Context", type: "enum", options: [{ value: "272k", label: "272K" }, { value: "1m", label: "1M" }] },
			{ id: "reasoning", displayName: "Reasoning", type: "enum", options: efforts.map((value) => ({ value, label: value === "xhigh" ? "Extra High" : value[0]!.toUpperCase() + value.slice(1) })) },
			{ id: "fast", displayName: "Fast", type: "boolean", options: [{ value: "false" }, { value: "true", label: "Fast" }] },
		],
	};
}
