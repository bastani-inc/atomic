import type {
	CursorModelParameter,
	CursorParameterizedVariant,
	CursorParameterDefinitionMetadata,
	CursorUsableModel,
} from "../../packages/cursor/src/model-mapper.js";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const GPT_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

interface ClaudeMode {
	readonly thinking: boolean;
	readonly context: "300k" | "1m";
	readonly fast?: boolean;
	readonly maxMode: boolean;
}

function parameter(id: string, value: string): CursorModelParameter {
	return { id, value };
}

function claudeDefinitions(includeFast: boolean): readonly CursorParameterDefinitionMetadata[] {
	return [
		{
			id: "thinking",
			displayName: "Thinking",
			description: "Does the model use thinking to generate its response?",
			type: "boolean",
			options: [{ value: "false" }, { value: "true" }],
		},
		{
			id: "context",
			displayName: "Context",
			description: "Context size the model has available.",
			type: "enum",
			options: [{ value: "300k", label: "300K" }, { value: "1m", label: "1M", wireField3: true }],
		},
		{
			id: "effort",
			displayName: "Effort",
			description: "Effort the model uses to generate its response.",
			type: "enum",
			options: CLAUDE_EFFORTS.map((value) => ({
				value,
				label: value === "xhigh" ? "Extra High" : value[0].toUpperCase() + value.slice(1),
			})),
			wireField5: true,
		},
		...(includeFast ? [{
			id: "fast",
			displayName: "Fast",
			description: "2x more expensive, but significantly faster speeds.",
			type: "boolean" as const,
			options: [{ value: "false" }, { value: "true", label: "Fast", wireField3: true }],
		}] : []),
	];
}

function claudeModel(
	id: string,
	displayName: string,
	modes: readonly ClaudeMode[],
): CursorUsableModel {
	const includeFast = modes.some((mode) => mode.fast !== undefined);
	const variants = modes.flatMap((mode) => CLAUDE_EFFORTS.map((effort): CursorParameterizedVariant => {
		const parameters = [
			parameter("thinking", String(mode.thinking)),
			parameter("context", mode.context),
			parameter("effort", effort),
			...(mode.fast === undefined ? [] : [parameter("fast", String(mode.fast))]),
		];
		const isDefault = mode.thinking && mode.context === (mode.maxMode ? "1m" : "300k")
			&& mode.fast !== true && effort === "high";
		return {
			parameters,
			isMaxMode: mode.maxMode,
			...(isDefault && mode.maxMode ? { isDefaultMaxConfig: true } : {}),
			...(isDefault && !mode.maxMode ? { isDefaultNonMaxConfig: true } : {}),
			displayName,
			displayNameOutsidePicker: displayName,
			variantStringRepresentation: `${id}[${parameters.map(({ id: parameterId, value }) => `${parameterId}=${value}`).join(",")}]`,
		};
	}));
	return {
		id,
		displayName,
		serverModelName: id,
		supportsImages: true,
		supportsMaxMode: true,
		supportsNonMaxMode: true,
		metadataProvenance: "available-models-reverse-engineered",
		parameterDefinitions: claudeDefinitions(includeFast),
		variants,
	};
}

function gpt56SolModel(): CursorUsableModel {
	const modes = [
		{ context: "272k", fast: false, maxMode: false },
		{ context: "272k", fast: true, maxMode: false },
		{ context: "1m", fast: false, maxMode: true },
	] as const;
	const variants = modes.flatMap((mode) => GPT_EFFORTS.map((effort): CursorParameterizedVariant => {
		const parameters = [parameter("context", mode.context), parameter("reasoning", effort), parameter("fast", String(mode.fast))];
		const isDefault = !mode.fast && effort === "medium";
		return {
			parameters,
			isMaxMode: mode.maxMode,
			...(isDefault && mode.maxMode ? { isDefaultMaxConfig: true } : {}),
			...(isDefault && !mode.maxMode ? { isDefaultNonMaxConfig: true } : {}),
			displayName: "GPT-5.6 Sol",
			displayNameOutsidePicker: "GPT-5.6 Sol",
			variantStringRepresentation: `gpt-5.6-sol[${parameters.map(({ id, value }) => `${id}=${value}`).join(",")}]`,
		};
	}));
	return {
		id: "gpt-5.6-sol",
		displayName: "GPT-5.6 Sol",
		serverModelName: "gpt-5.6-sol",
		supportsImages: true,
		supportsMaxMode: true,
		supportsNonMaxMode: true,
		metadataProvenance: "available-models-reverse-engineered",
		parameterDefinitions: [
			{ id: "context", displayName: "Context", type: "enum", options: [{ value: "272k", label: "272K" }, { value: "1m", label: "1M", wireField3: true }] },
			{ id: "reasoning", displayName: "Reasoning", type: "enum", options: GPT_EFFORTS.map((value) => ({ value, label: value === "xhigh" ? "Extra High" : value[0].toUpperCase() + value.slice(1) })), wireField5: true },
			{ id: "fast", displayName: "Fast", type: "boolean", options: [{ value: "false" }, { value: "true", label: "Fast", wireField3: true }] },
		],
		variants,
	};
}

function gpt51Model(): CursorUsableModel {
	const variants = (["low", "medium", "high"] as const).map((effort): CursorParameterizedVariant => ({
		parameters: [parameter("reasoning", effort)],
		isMaxMode: false,
		...(effort === "medium" ? { isDefaultMaxConfig: true, isDefaultNonMaxConfig: true } : {}),
		displayName: "GPT-5.1",
		displayNameOutsidePicker: "GPT-5.1",
		variantStringRepresentation: `gpt-5.1[reasoning=${effort}]`,
	}));
	return {
		id: "gpt-5.1",
		displayName: "GPT-5.1",
		serverModelName: "gpt-5.1",
		supportsImages: true,
		supportsMaxMode: true,
		supportsNonMaxMode: true,
		metadataProvenance: "available-models-reverse-engineered",
		parameterDefinitions: [{ id: "reasoning", displayName: "Reasoning", type: "enum", options: ["low", "medium", "high"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })), wireField5: true }],
		variants,
	};
}

function composerModel(): CursorUsableModel {
	return {
		id: "composer-2.5",
		displayName: "Composer 2.5",
		serverModelName: "composer-2.5",
		supportsMaxMode: true,
		supportsNonMaxMode: true,
		metadataProvenance: "available-models-reverse-engineered",
		parameterDefinitions: [{ id: "fast", displayName: "Fast", type: "boolean", options: [{ value: "false" }, { value: "true", label: "Fast", wireField3: true }], wireField5: true }],
		variants: [false, true].map((fast): CursorParameterizedVariant => ({
			parameters: [parameter("fast", String(fast))],
			isMaxMode: false,
			...(fast ? { isDefaultMaxConfig: true, isDefaultNonMaxConfig: true } : {}),
			displayName: "Composer 2.5",
			displayNameOutsidePicker: "Composer 2.5",
			variantStringRepresentation: `composer-2.5[fast=${fast}]`,
		})),
	};
}

export function authenticatedVariantCorrectionModels(): readonly CursorUsableModel[] {
	const standardClaudeModes: readonly ClaudeMode[] = [
		{ thinking: false, context: "300k", maxMode: false },
		{ thinking: false, context: "1m", maxMode: true },
		{ thinking: true, context: "300k", maxMode: false },
		{ thinking: true, context: "1m", maxMode: true },
	];
	const opusModes: readonly ClaudeMode[] = [
		{ thinking: false, context: "300k", fast: false, maxMode: false },
		{ thinking: false, context: "300k", fast: true, maxMode: true },
		{ thinking: false, context: "1m", fast: false, maxMode: true },
		{ thinking: false, context: "1m", fast: true, maxMode: true },
		{ thinking: true, context: "300k", fast: false, maxMode: false },
		{ thinking: true, context: "300k", fast: true, maxMode: true },
		{ thinking: true, context: "1m", fast: false, maxMode: true },
		{ thinking: true, context: "1m", fast: true, maxMode: true },
	];
	return [
		composerModel(),
		claudeModel("claude-opus-4-8", "Opus 4.8", opusModes),
		gpt56SolModel(),
		claudeModel("claude-fable-5", "Fable 5", standardClaudeModes),
		claudeModel("claude-sonnet-5", "Sonnet 5", standardClaudeModes),
		gpt51Model(),
	];
}
