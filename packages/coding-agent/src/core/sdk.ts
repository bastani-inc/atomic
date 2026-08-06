import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { restoreAnthropicReplayThinkingBlocks } from "./anthropic-thinking-guard.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import {
	shouldApplyCodexFastMode,
	streamWithCodexFastMode,
	withCodexFastModePayload,
	withCodexFastModeStreamOptions,
} from "./codex-fast-mode.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { convertToLlm, repairOrphanToolResults } from "./messages.ts";
import { findInitialModel, resolveRestoredModelReference } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { sanitizeOpenAIResponsesPayload } from "./openai-responses-payload-sanitizer.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { scrubPreCompactionAssistantUsage } from "./provider-context-usage.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "./sdk-types.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import { defaultToolNames } from "./tools/index.ts";

export type { ModelFallbackReason } from "./model-resolver-types.ts";
export * from "./sdk-exports.ts";
export type { CreateAgentSessionOptions, CreateAgentSessionResult } from "./sdk-types.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn.
setDefaultStreamFn(streamSimple);

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai/compat';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));
	await modelRuntime.refresh({ allowNetwork: false });

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	// Mark workflow-created sessions as internal so they are excluded from the
	// standard `/resume` history while remaining resumable via `/workflow resume`.
	// Only stamped when the orchestration context identifies a workflow stage;
	// reattaching to an already-marked session preserves its existing marker.
	if (options.orchestrationContext?.kind === "workflow-stage") {
		const ctx = options.orchestrationContext;
		sessionManager.markSessionInternal({
			runId: ctx.workflowRunId,
			stageId: ctx.workflowStageId,
			stageName: ctx.workflowStageName,
		});
	}

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const repairedMessages = repairOrphanToolResults(existingSession.messages, { repairTrailing: true });
	const existingMessages = options.initialContextTransform
		? options.initialContextTransform(repairedMessages)
		: repairedMessages;
	const hasExistingSession = existingMessages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;
	let modelFallbackReason: import("./model-resolver-types.ts").ModelFallbackReason | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		model = await resolveRestoredModelReference(
			existingSession.model.provider,
			existingSession.model.modelId,
			modelRuntime,
		);
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
			modelFallbackReason = "session-restore";
		}
	}
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			if (result.fallbackReason === "configured-provider-unsupported") {
				modelFallbackMessage = result.fallbackMessage;
				modelFallbackReason = result.fallbackReason;
			} else if (!modelFallbackMessage) {
				modelFallbackMessage = result.fallbackMessage ?? formatNoModelsAvailableMessage();
				modelFallbackReason = result.fallbackReason ?? "no-models-available";
			}
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const initialActiveToolNames: string[] = options.tools
		? [...options.tools]
		: options.noTools
			? []
			: [...defaultToolNames];

	let agent: Agent;

	let lastConvertedLlmMessages: Message[] | undefined;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			lastConvertedLlmMessages = converted;
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		const filtered = converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image"
									? {
											type: "text" as const,
											text: "Image reading is disabled.",
										}
									: c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
		lastConvertedLlmMessages = filtered;
		return filtered;
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const isCodexFastModeEnabled = (requestModel: Model<Api>): boolean =>
		shouldApplyCodexFastMode(requestModel, settingsManager.getCodexFastModeSettings(), options.orchestrationContext);

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, streamOptions) => {
			const authResult = await modelRuntime.getAuth(model);
			const compatibility = authResult ? undefined : modelRuntime.getCompatibilityRequestConfig(model);
			if (!authResult && compatibility?.authHeader) {
				throw new Error(`No API key found for "${model.provider}"`);
			}
			const auth = {
				apiKey: authResult?.auth.apiKey,
				headers: authResult?.auth.headers ?? compatibility?.headers,
				baseUrl: authResult?.auth.baseUrl,
			};
			const requestModel =
				auth.baseUrl !== undefined && auth.baseUrl !== model.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = streamOptions?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				streamOptions?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const mergedHeaders = mergeProviderAttributionHeaders(
				model,
				settingsManager,
				streamOptions?.sessionId,
				auth.headers,
				streamOptions?.headers,
			);
			const headerRunner = extensionRunnerRef.current;
			const attributionHeaders = headerRunner?.hasHandlers("before_provider_headers")
				? await headerRunner.emitBeforeProviderHeaders(mergedHeaders ?? {})
				: mergedHeaders;
			const fastModeEnabled = isCodexFastModeEnabled(model);
			const extensionProvider = modelRuntime.getRegisteredProviderConfig(requestModel.provider);
			const usesExtensionStream =
				extensionProvider?.streamSimple !== undefined && requestModel.api === extensionProvider.api;
			if (fastModeEnabled && !usesExtensionStream && !authResult) {
				throw new Error(`No API key found for "${model.provider}"`);
			}
			const codexFastModeStreamOptions = withCodexFastModeStreamOptions(
				{
					...streamOptions,
					apiKey: auth.apiKey,
					timeoutMs,
					websocketConnectTimeoutMs,
					maxRetries: streamOptions?.maxRetries ?? providerRetrySettings.maxRetries,
					maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
					headers: attributionHeaders,
				},
				fastModeEnabled,
			);
			if (usesExtensionStream) {
				return modelRuntime.streamSimple(requestModel, context, codexFastModeStreamOptions);
			}
			return fastModeEnabled
				? streamWithCodexFastMode(requestModel, context, codexFastModeStreamOptions)
				: modelRuntime.streamSimple(requestModel, context, codexFastModeStreamOptions);
		},
		onPayload: async (payload, model) => {
			const fastModeEnabled = isCodexFastModeEnabled(model);
			const guardedPayload = withCodexFastModePayload(payload, fastModeEnabled);
			const sourceMessages = lastConvertedLlmMessages;
			const replayGuardedPayload = sourceMessages
				? restoreAnthropicReplayThinkingBlocks(guardedPayload, sourceMessages, model)
				: guardedPayload;
			const runner = extensionRunnerRef.current;
			let finalPayload: unknown;
			if (!runner?.hasHandlers("before_provider_request")) {
				finalPayload = replayGuardedPayload;
			} else {
				const extensionPayload = await runner.emitBeforeProviderRequest(replayGuardedPayload);
				finalPayload = sourceMessages
					? restoreAnthropicReplayThinkingBlocks(extensionPayload, sourceMessages, model)
					: extensionPayload;
			}
			return sanitizeOpenAIResponsesPayload(finalPayload, model);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			const transformed = runner ? await runner.emitContext(messages) : messages;
			return scrubPreCompactionAssistantUsage(transformed, sessionManager.getBranch());
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingMessages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		fallbackModels: options.fallbackModels ?? settingsManager.getFallbackModels(),
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames: options.excludedTools,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		orchestrationContext: options.orchestrationContext,
		subagentPolicy: options.subagentPolicy,
		systemPromptTransform: options.systemPromptTransform,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
		modelFallbackReason,
	};
}
