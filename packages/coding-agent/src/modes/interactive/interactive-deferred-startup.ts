import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { type Api, type Model, modelsAreEqual } from "@bastani/atomic-ai/compat";
import { failureDebugFields, reportDebugAsync as reportDebug } from "../../core/debug.ts";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import { formatModelLabel } from "../../core/model-label.ts";
import { deduplicateDiagnostics } from "../../core/settings-diagnostics.ts";
import { recordStartupThinkingLevel } from "../../core/startup-thinking-level.ts";
import { loadAllHighlightLanguages } from "../../utils/syntax-highlight.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type Container,
	findInitialModel,
	formatNoModelsAvailableMessage,
	getChangelogPath,
	preloadChangelog,
	recordTimeSinceReset,
	resolveModelScopeWithDiagnostics,
	resolveRestoredModelReference,
	setRegisteredThemes,
	uncachedCopilotModelHint,
} from "./interactive-mode-deps.ts";
import { releaseStartupChatOutput } from "./interactive-startup-chat-container.ts";
import { reportUnavailableTools } from "./interactive-unavailable-tools.ts";
import { exitOnRefusedDecisionSetting } from "./refused-decision-setting.ts";
import { showSessionNotices } from "./session-notices.ts";

export interface DeferredStartupMode {
	deferredStartupPending: boolean;
	deferredStartupPromise: Promise<void> | undefined;
	completeDeferredStartup(): Promise<void>;
}

export async function ensureDeferredStartupComplete(mode: DeferredStartupMode): Promise<void> {
	if (!mode.deferredStartupPending && !mode.deferredStartupPromise) return;
	const startupPromise = mode.deferredStartupPromise ?? Promise.resolve().then(() => mode.completeDeferredStartup());
	mode.deferredStartupPromise = startupPromise;
	try {
		await startupPromise;
	} catch (error) {
		// Startup carries on with what it has: the prompt is released, and the reason goes to the debug log (#4660).
		mode.deferredStartupPending = false;
		reportDebug("storage", "deferred-startup-incomplete", failureDebugFields(error));
	} finally {
		if (mode.deferredStartupPromise === startupPromise && !mode.deferredStartupPending) {
			mode.deferredStartupPromise = undefined;
		}
	}
}

InteractiveModeBase.prototype.ensureDeferredStartupComplete = async function (
	this: InteractiveModeBase,
): Promise<void> {
	await ensureDeferredStartupComplete(this);
};

/**
 * Finishes a startup where extension loading was deferred so the TUI could
 * paint immediately. Loads extension code via session.reload(), then applies
 * the same post-load UI wiring as /reload and discloses loaded resources.
 */
InteractiveModeBase.prototype.completeDeferredStartup = async function (this: InteractiveModeBase): Promise<void> {
	let fallbackModelsChecked = false;
	const checkFallbackModels = () => {
		if (fallbackModelsChecked) return;
		fallbackModelsChecked = true;
		for (const diagnostic of this.options.deferredFallbackModelCheck?.(this.session) ?? []) {
			this.showWarning(diagnostic.message);
		}
	};
	try {
		const heldProject =
			this.runtimeHost?.isProjectTrustPending?.() && !this.runtimeHost.pendingProjectResourcesTrusted?.();
		await this.bindCurrentSessionExtensions();
		const completedStartupTrust = Boolean(await this.runtimeHost?.completeStartup?.());
		if (!completedStartupTrust) await this.session.reload({ reason: "startup" });
		this.applyRuntimeSettings();
		// Initial transcript rows precede deferred extension loading, so rebuild them
		// against the new extension registry before releasing startup output. The transcript was offscreen;
		// a press held in the editor through trust does not belong to these rows.
		this.rebuildChatFromMessages(heldProject ? { preserveViewportInput: true } : undefined);

		// A prompt turn keeps its own working loader mounted from submit until
		// `agent_start` or `compaction_start` takes over; tearing it down here
		// would leave the rest of startup and prompt preflight with no indicator.
		if (!this.promptTurnWorkingLoaderActive) {
			this.stopWorkingLoader();
		}
		this.deferredStartupPending = false;
		recordTimeSinceReset("deferred-extension-load");

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		await this.themeController.applyFromSettings(heldProject ? { keepPreview: true } : undefined);
		this.setupAutocompleteProvider(heldProject ? { preserveSelection: true } : undefined);
		this.setupExtensionShortcuts(this.session.extensionRunner);
		try {
			if (completedStartupTrust) {
				showSessionNotices(this, this.runtimeHost?.services.diagnostics);
			} else {
				await applyDeferredModelScope(this);
			}
			await this.retryDeferredModelRestore(this.startupNoticesContainer);
		} finally {
			checkFallbackModels();
		}
		this.showLoadedResources({
			force: true,
			showDiagnosticsWhenQuiet: true,
			targetContainer: this.resourceDisclosureContainer,
		});
		// Keep the subscription warning after the RESOURCES disclosure.
		void this.maybeWarnAboutAnthropicSubscriptionAuth(undefined, this.startupNoticesContainer);
		await preloadChangelog(getChangelogPath());
		this.showStartupNoticesIfNeeded(this.startupNoticesContainer);
		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}
		// Extension providers can introduce a `-fast` collision that did not exist at eager startup, so
		// re-read; `reportModelCatalogWarning` suppresses a repeat of what startup already showed.
		this.reportModelCatalogWarning(this.startupNoticesContainer);
		void this.updateAvailableProviderCount().catch(() => {});
		this.updateEditorBorderColor();
		this.ui.requestRender();
		void loadAllHighlightLanguages().then(() => this.ui.requestRender());
	} catch (error) {
		exitOnRefusedDecisionSetting(this, error);
		// Same ownership rule as the success path: this catch swallows the error,
		// so prompt preflight continues and must keep its indicator.
		if (!this.promptTurnWorkingLoaderActive) {
			this.stopWorkingLoader();
		}
		this.deferredStartupPending = false;
		this.showError(`Extension loading failed: ${error instanceof Error ? error.message : String(error)}`);
		// Startup ended before or while deciding project trust, and the chat is not redrawn: a session left untrusted
		// shows the warning now.
		this.runtimeHost?.abandonStartupTrust?.();
		this.refreshProjectTrustWarning();
		checkFallbackModels();
		// The RESOURCES disclosure will not render; surface the held warning.
		void this.maybeWarnAboutAnthropicSubscriptionAuth(undefined, this.startupNoticesContainer);
	} finally {
		// Extension loading has either produced the disclosure or definitively
		// failed, so startup ordering is resolved before any prompt can run.
		releaseStartupChatOutput(this);
	}
	await reportUnavailableTools(this);
	// Interrupted work is recovered whatever extension loading did: what could not load only means less to restore.
	this.startSessionRecovery("startup");
};

export async function applyDeferredModelScope(mode: InteractiveModeBase): Promise<void> {
	const patterns = mode.options.deferredModelScopePatterns;
	if (!patterns || patterns.length === 0) return;

	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, mode.session.modelRuntime);
	for (const diagnostic of deduplicateDiagnostics(diagnostics)) {
		mode.showWarning(diagnostic.message);
	}
	mode.session.setScopedModels(scopedModels);

	if (mode.sessionManager.buildSessionContext().messages.length > 0 || scopedModels.length === 0) {
		return;
	}

	const savedProvider = mode.settingsManager.getDefaultProvider();
	const savedModelId = mode.settingsManager.getDefaultModel();
	const savedModel =
		savedProvider && savedModelId ? mode.session.modelRuntime.getModel(savedProvider, savedModelId) : undefined;
	const preferred = savedModel ? scopedModels.find((scoped) => modelsAreEqual(scoped.model, savedModel)) : undefined;
	const nextScopedModel = preferred ?? scopedModels[0];
	const currentModel = mode.session.model;
	if (currentModel && modelsAreEqual(currentModel, nextScopedModel.model)) {
		return;
	}
	if (mode.session.modelRuntime.hasConfiguredAuth(nextScopedModel.model.provider)) {
		await mode.session.setModel(nextScopedModel.model);
		await mode.session.setThinkingLevel(
			startupThinkingLevel(mode, nextScopedModel.model, false, nextScopedModel.thinkingLevel),
		);
	}
}

function startupThinkingLevel(
	mode: InteractiveModeBase,
	model: Model<Api>,
	continued: boolean,
	scopedThinkingLevel?: ThinkingLevel,
): ThinkingLevel {
	return (
		mode.options.deferredStartupThinkingLevel ??
		scopedThinkingLevel ??
		(continued ? undefined : mode.settingsManager.getModelThinkingLevel(model.provider, model.id)) ??
		mode.settingsManager.getDefaultThinkingLevel() ??
		DEFAULT_THINKING_LEVEL
	);
}

async function selectStartupModel(mode: InteractiveModeBase, model: Model<Api>, continued: boolean): Promise<void> {
	await mode.session.setModel(model);
	await mode.session.setThinkingLevel(startupThinkingLevel(mode, model, continued));
	const savedThinkingLevel = mode.options.deferredSavedThinkingLevel;
	if (savedThinkingLevel !== undefined) {
		await recordStartupThinkingLevel(mode.sessionManager, savedThinkingLevel, mode.session.thinkingLevel);
	}
}

InteractiveModeBase.prototype.retryDeferredModelRestore = async function (
	this: InteractiveModeBase,
	targetContainer?: Container,
): Promise<void> {
	const preliminaryFallbackMessage = this.options.modelFallbackMessage;
	if (!preliminaryFallbackMessage) return;

	const sessionContext = this.sessionManager.buildSessionContext();
	const savedModel = sessionContext.model;
	const continued = sessionContext.messages.length > 0;
	let restoreFailure: string | undefined;
	if (savedModel) {
		const restoredModel = await resolveRestoredModelReference(
			savedModel.provider,
			savedModel.modelId,
			this.session.modelRuntime,
		);
		if (restoredModel && this.session.modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			const selectedModel = this.session.model;
			if (!selectedModel || !modelsAreEqual(selectedModel, restoredModel)) {
				await selectStartupModel(this, restoredModel, continued);
			}
			return;
		}
		if (continued) {
			if (uncachedCopilotModelHint(savedModel.provider, savedModel.modelId, this.session.modelRuntime)) {
				this.showWarning(preliminaryFallbackMessage, targetContainer);
				return;
			}
			restoreFailure = `Could not restore model ${formatModelLabel({ provider: savedModel.provider, id: savedModel.modelId })}`;
		}
	}
	const currentModel = this.session.model;
	if (currentModel && this.session.modelRuntime.hasConfiguredAuth(currentModel.provider)) {
		if (restoreFailure) {
			this.showWarning(`${restoreFailure}. Using ${currentModel.provider}/${currentModel.id}`, targetContainer);
		}
		return;
	}

	const result = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: this.settingsManager.getDefaultProvider(),
		defaultModelId: this.settingsManager.getDefaultModel(),
		defaultThinkingLevel: this.settingsManager.getDefaultThinkingLevel(),
		modelThinkingLevels: this.settingsManager.getAllModelThinkingLevels(),
		modelRuntime: this.session.modelRuntime,
	});
	if (result.model) {
		await selectStartupModel(this, result.model, continued);
		if (restoreFailure) {
			this.showWarning(`${restoreFailure}. Using ${result.model.provider}/${result.model.id}`, targetContainer);
		}
		return;
	}
	const unavailableMessage =
		result.fallbackReason === "configured-provider-unsupported"
			? result.fallbackMessage
			: (restoreFailure ?? result.fallbackMessage);
	this.showWarning(unavailableMessage ?? formatNoModelsAvailableMessage(), targetContainer);
};
