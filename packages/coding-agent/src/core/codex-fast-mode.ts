import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { OrchestrationContext } from "./extensions/index.ts";

export const CODEX_FAST_MODE_SERVICE_TIER = "priority" as const;

export interface CodexFastModeResolvedSettings {
	chat: boolean;
	workflow: boolean;
}

export type CodexFastModeScope = "chat" | "workflow";

export interface CodexFastModeStreamOptions extends SimpleStreamOptions {
	serviceTier?: typeof CODEX_FAST_MODE_SERVICE_TIER;
}

export function isCodexFastModeSupportedProvider(provider: string): boolean {
	return provider === "openai" || provider === "openai-codex";
}

export function isCodexFastModeSupportedModel(model: Pick<Model<Api>, "provider">): boolean {
	return isCodexFastModeSupportedProvider(model.provider);
}

export function hasSupportedCodexFastModeModel(models: readonly Pick<Model<Api>, "provider">[]): boolean {
	return models.some(isCodexFastModeSupportedModel);
}

export function isWorkflowStageOrchestrationContext(context: OrchestrationContext | undefined): boolean {
	return context?.kind === "workflow-stage";
}

export function getCodexFastModeScope(context: OrchestrationContext | undefined): CodexFastModeScope {
	return isWorkflowStageOrchestrationContext(context) ? "workflow" : "chat";
}

export function isCodexFastModeEnabledForScope(
	settings: CodexFastModeResolvedSettings,
	scope: CodexFastModeScope,
): boolean {
	return settings[scope];
}

export function isCodexFastModeEnabledForSession(
	settings: CodexFastModeResolvedSettings,
	context: OrchestrationContext | undefined,
): boolean {
	return isCodexFastModeEnabledForScope(settings, getCodexFastModeScope(context));
}

export function shouldApplyCodexFastModeForScope(
	model: Pick<Model<Api>, "provider">,
	settings: CodexFastModeResolvedSettings,
	scope: CodexFastModeScope,
): boolean {
	return isCodexFastModeSupportedModel(model) && isCodexFastModeEnabledForScope(settings, scope);
}

export function shouldApplyCodexFastMode(
	model: Pick<Model<Api>, "provider">,
	settings: CodexFastModeResolvedSettings,
	context: OrchestrationContext | undefined,
): boolean {
	return shouldApplyCodexFastModeForScope(model, settings, getCodexFastModeScope(context));
}

export function withCodexFastModeStreamOptions(
	options: SimpleStreamOptions | undefined,
	enabled: boolean,
): CodexFastModeStreamOptions | undefined {
	if (!enabled) {
		return options;
	}

	return {
		...(options ?? {}),
		serviceTier: CODEX_FAST_MODE_SERVICE_TIER,
	};
}

function isObjectPayload(payload: unknown): payload is Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

export function withCodexFastModePayload(payload: unknown, enabled: boolean): unknown {
	if (!enabled || !isObjectPayload(payload) || payload.service_tier !== undefined) {
		return payload;
	}

	return {
		...payload,
		service_tier: CODEX_FAST_MODE_SERVICE_TIER,
	};
}

export function formatCodexFastModeModelLabel(modelName: string, enabled: boolean): string {
	return enabled ? `${modelName} fast` : modelName;
}
