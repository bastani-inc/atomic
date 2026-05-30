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

export function isCodexFastModeEnabledForSession(
	settings: CodexFastModeResolvedSettings,
	context: OrchestrationContext | undefined,
): boolean {
	return settings[getCodexFastModeScope(context)];
}

export function shouldApplyCodexFastMode(
	model: Pick<Model<Api>, "provider">,
	settings: CodexFastModeResolvedSettings,
	context: OrchestrationContext | undefined,
): boolean {
	return isCodexFastModeSupportedModel(model) && isCodexFastModeEnabledForSession(settings, context);
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

export function withCodexFastModePayload(payload: unknown, enabled = true): unknown {
	if (!enabled || !isObjectPayload(payload) || "service_tier" in payload) {
		return payload;
	}

	return {
		...payload,
		service_tier: CODEX_FAST_MODE_SERVICE_TIER,
	};
}
