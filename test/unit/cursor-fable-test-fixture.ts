import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";

const parameter = (id: string, value: string) => ({ id, value });

export function authenticatedFable5Model(): CursorUsableModel {
	const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
	const variants = ([
		{ thinking: "false", context: "300k", isMaxMode: false },
		{ thinking: "false", context: "1m", isMaxMode: true },
		{ thinking: "true", context: "300k", isMaxMode: false },
		{ thinking: "true", context: "1m", isMaxMode: true },
	] as const).flatMap((mode) => efforts.map((effort) => ({
		parameters: [parameter("thinking", mode.thinking), parameter("context", mode.context), parameter("effort", effort)],
		isMaxMode: mode.isMaxMode,
		...(mode.thinking === "true" && effort === "high"
			? mode.isMaxMode ? { isDefaultMaxConfig: true } : { isDefaultNonMaxConfig: true }
			: {}),
		displayName: "Fable 5",
		displayNameOutsidePicker: "Fable 5",
		variantStringRepresentation: `claude-fable-5[thinking=${mode.thinking},context=${mode.context},effort=${effort}]`,
	})));
	return {
		id: "claude-fable-5",
		displayName: "Fable 5",
		serverModelName: "claude-fable-5",
		supportsImages: true,
		supportsMaxMode: true,
		supportsNonMaxMode: true,
		metadataProvenance: "available-models-reverse-engineered",
		variants,
		parameterDefinitions: [
			{ id: "thinking", displayName: "Thinking", description: "Does the model use thinking to generate its response?", type: "boolean", options: [{ value: "false" }, { value: "true" }] },
			{ id: "context", displayName: "Context", description: "Context size the model has available.", type: "enum", options: [{ value: "300k", label: "300K" }, { value: "1m", label: "1M" }] },
			{ id: "effort", displayName: "Effort", description: "Effort the model uses to generate its response.", type: "enum", options: efforts.map((value) => ({ value, label: value === "xhigh" ? "Extra High" : value[0]!.toUpperCase() + value.slice(1) })) },
		],
	};
}
