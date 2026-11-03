import type { Api, Model } from "@bastani/pi-ai/compat";
import type { Args } from "./cli/args.ts";
import { findInitialModel, resolveRestoredModelReference, uncachedCopilotModelHint } from "./core/model-resolver.ts";
import type { ScopedModel } from "./core/model-resolver-types.ts";
import type { ModelRuntime } from "./core/model-runtime.js";
import type { DefaultProjectTrust, SettingsManager } from "./core/settings-manager.ts";
import type { ProjectTrustStore } from "./core/trust-manager.ts";
import { hasProjectTrustInputs } from "./core/trust-manager.ts";
import type { AppMode } from "./main-app-mode.ts";

export interface ComputeDeferExtensionsInput {
	appMode: AppMode;
	stdinIsTTY: boolean;
	hasSessionStartEvent: boolean;
	help?: boolean;
	listModels?: Args["listModels"];
	shouldResolveProjectTrust: boolean;
	storedProjectTrust: boolean | null;
	resolvedExtensionPathCount: number;
	resolvedResourcePathCount: number;
	hasSystemPromptInput: boolean;
	unknownFlagCount: number;
	provider?: string;
	model?: string;
}

export interface ComputeInteractiveEngineResourceDeferralInput {
	interactiveEngineChild: boolean;
	hasSessionStartEvent: boolean;
	shouldResolveProjectTrust: boolean;
	storedProjectTrust: boolean | null;
	resolvedExtensionPathCount: number;
	resolvedResourcePathCount: number;
	hasSystemPromptInput: boolean;
	unknownFlagCount: number;
}

export interface ComputeStartupInputCaptureInput {
	appMode: AppMode;
	stdinIsTTY: boolean;
	parsed: Pick<
		Args,
		| "help"
		| "listModels"
		| "projectTrustOverride"
		| "systemPrompt"
		| "appendSystemPrompt"
		| "unknownFlags"
		| "provider"
		| "model"
		| "resume"
		| "session"
	>;
	sessionCwd: string;
	projectTrustStore: Pick<ProjectTrustStore, "get">;
	resolvedExtensionPathCount: number;
	resolvedResourcePathCount: number;
	deprecationWarningCount: number;
	sessionSelectionComplete?: boolean;
}

export function computeStartupInputCaptureEnabled(input: ComputeStartupInputCaptureInput): boolean {
	if (!input.sessionSelectionComplete && (input.parsed.resume || input.parsed.session !== undefined)) return false;
	const hasTrustInputs = hasProjectTrustInputs(input.sessionCwd);
	return (
		input.appMode === "interactive" &&
		input.stdinIsTTY &&
		!input.parsed.help &&
		input.parsed.listModels === undefined &&
		input.deprecationWarningCount === 0 &&
		(input.parsed.projectTrustOverride !== undefined ||
			!hasTrustInputs ||
			input.projectTrustStore.get(input.sessionCwd) !== null)
	);
}

export interface ComputeStartupTrustPromptPossibleInput {
	projectTrustOverride: boolean | undefined;
	hasTrustInputs: boolean;
	storedProjectTrust: boolean | null;
	defaultProjectTrust: DefaultProjectTrust;
}

export function computeStartupTrustPromptPossible(input: ComputeStartupTrustPromptPossibleInput): boolean {
	return (
		input.projectTrustOverride === undefined &&
		input.hasTrustInputs &&
		input.storedProjectTrust === null &&
		input.defaultProjectTrust === "ask"
	);
}

export function computeDeferExtensions(input: ComputeDeferExtensionsInput): boolean {
	return (
		input.appMode === "interactive" &&
		input.stdinIsTTY &&
		!input.hasSessionStartEvent &&
		!input.help &&
		input.listModels === undefined &&
		(!input.shouldResolveProjectTrust || input.storedProjectTrust !== null) &&
		input.resolvedExtensionPathCount === 0 &&
		input.resolvedResourcePathCount === 0 &&
		!input.hasSystemPromptInput &&
		input.provider === undefined &&
		input.model === undefined &&
		input.unknownFlagCount === 0
	);
}

/**
 * The isolated engine may bind its minimal RPC session before loading optional
 * bundled resources. User-selected paths and trust-sensitive startup stay
 * synchronous because they can affect the first visible or interactive state.
 */
export function computeInteractiveEngineResourceDeferral(
	input: ComputeInteractiveEngineResourceDeferralInput,
): boolean {
	return (
		input.interactiveEngineChild &&
		!input.hasSessionStartEvent &&
		(!input.shouldResolveProjectTrust || input.storedProjectTrust !== null) &&
		input.resolvedExtensionPathCount === 0 &&
		input.resolvedResourcePathCount === 0 &&
		!input.hasSystemPromptInput &&
		input.unknownFlagCount === 0
	);
}

export function formatScopedModelList(scopedModels: ScopedModel[]): string {
	return scopedModels
		.map((scoped) => {
			const thinkingSuffix = scoped.thinkingLevel ? `:${scoped.thinkingLevel}` : "";
			return `${scoped.model.id}${thinkingSuffix}`;
		})
		.join(", ");
}

export interface ResolveDeferredStartupModelInput {
	/** The model the command line or the model scope selected. */
	selected: Model<Api> | undefined;
	/** Whether the session already has messages. */
	isContinuing: boolean;
	/** The model a continued session last used. */
	savedModel: { provider: string; modelId: string } | null | undefined;
	settingsManager: Pick<
		SettingsManager,
		"getDefaultProvider" | "getDefaultModel" | "getDefaultThinkingLevel" | "getAllModelThinkingLevels"
	>;
	modelRuntime: ModelRuntime;
}

/**
 * The model the deferred startup pass applies once project trust and extensions are resolved: the
 * selected model, else the continued session's saved model, else the initial model. A saved GitHub
 * Copilot model that is only missing from the cached account list selects nothing, as session
 * creation does, so the session keeps its refresh message instead of switching to another model.
 */
export async function resolveDeferredStartupModel(
	input: ResolveDeferredStartupModelInput,
): Promise<Model<Api> | undefined> {
	if (input.selected) return input.selected;
	const { isContinuing, savedModel, settingsManager, modelRuntime } = input;
	if (isContinuing && savedModel) {
		const restored = await resolveRestoredModelReference(savedModel.provider, savedModel.modelId, modelRuntime);
		if (restored) return restored;
		if (uncachedCopilotModelHint(savedModel.provider, savedModel.modelId, modelRuntime)) return undefined;
	}
	return (
		await findInitialModel({
			scopedModels: [],
			isContinuing,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		})
	).model;
}
