import {
	SettingsManager,
	isCodexFastModeCandidateModelId,
	shouldApplyCodexFastModeForScope,
	type CodexFastModeResolvedSettings,
} from "@bastani/atomic";
import { splitKnownThinkingSuffix } from "./model-info.ts";

export interface ResolveSubagentModelFastModeInput {
	model?: string;
	cwd: string;
	settings?: CodexFastModeResolvedSettings;
}

export interface ResolveSubagentModelFastModeMapInput {
	models: readonly (string | undefined)[];
	cwd: string;
	settings?: CodexFastModeResolvedSettings;
}

export interface ResolveSubagentModelFastModeMetadataInput {
	model?: string;
	modelCandidates: readonly (string | undefined)[];
	cwd: string;
	settings?: CodexFastModeResolvedSettings;
}

export interface SubagentModelFastModeMetadata {
	fastMode?: true;
	modelFastModes: Record<string, boolean>;
}

export function getSubagentCodexFastModeSettings(cwd: string): CodexFastModeResolvedSettings {
	try {
		return SettingsManager.create(cwd).getCodexFastModeSettings();
	} catch {
		return { chat: false, workflow: false };
	}
}

function providerFromModelId(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const { baseModel } = splitKnownThinkingSuffix(model);
	if (!isCodexFastModeCandidateModelId(baseModel)) return undefined;
	return baseModel.split("/", 1)[0];
}

export function resolveSubagentModelFastMode(input: ResolveSubagentModelFastModeInput): boolean {
	const provider = providerFromModelId(input.model);
	if (!provider) return false;
	const settings = input.settings ?? getSubagentCodexFastModeSettings(input.cwd);
	return shouldApplyCodexFastModeForScope({ provider }, settings, "chat");
}

export function resolveSubagentModelFastModeMap(input: ResolveSubagentModelFastModeMapInput): Record<string, boolean> {
	const settings = input.settings ?? getSubagentCodexFastModeSettings(input.cwd);
	const fastModes: Record<string, boolean> = {};
	for (const model of input.models) {
		if (!model || Object.prototype.hasOwnProperty.call(fastModes, model)) continue;
		fastModes[model] = resolveSubagentModelFastMode({ model, cwd: input.cwd, settings });
	}
	return fastModes;
}

export function resolveSubagentModelFastModeMetadata(input: ResolveSubagentModelFastModeMetadataInput): SubagentModelFastModeMetadata {
	const settings = input.settings ?? getSubagentCodexFastModeSettings(input.cwd);
	const fastMode = resolveSubagentModelFastMode({ model: input.model, cwd: input.cwd, settings });
	return {
		...(fastMode ? { fastMode: true as const } : {}),
		modelFastModes: resolveSubagentModelFastModeMap({ models: input.modelCandidates, cwd: input.cwd, settings }),
	};
}
