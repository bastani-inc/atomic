import { basename, join, relative, sep } from "node:path";
import { clampThinkingLevel, type Message, type ProviderHeaders, streamSimple } from "@bastani/pi-ai/compat";
import { getProviderEnvValue } from "@bastani/pi-ai/utils/provider-env";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../config.js";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.js";
import type { AgentSessionInternalSurface } from "./agent-session-methods.ts";
import { restoreAnthropicReplayThinkingBlocks } from "./anthropic-thinking-guard.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { getBuiltinPackageLocations, getBuiltinPackagePaths } from "./builtin-packages.ts";
import { withBuiltinResourceLoader } from "./builtin-resource-loader.ts";
import { getDefaultCacheRetention } from "./cache-retention.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { inheritChildSessionOptions } from "./child-session-options.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner } from "./extensions/index.js";
import {
	factoryAcquisitions,
	factoryRollbackError,
	rollbackFactoryAcquisitions,
} from "./extensions/loader-rollback.ts";
import { getModelFastRoute, streamWithFastRoute, withFastRouteStreamOptions } from "./fast-model-routing.ts";
import { markLifecycleTiming } from "./lifecycle-timings.ts";
import {
	isMandatoryResourceLoader,
	isolateMandatoryResourceLoader,
	withMandatoryResourceLoader,
} from "./mandatory-resource-loader.ts";
import { convertToLlm, repairOrphanToolResults } from "./messages.ts";
import { findInitialModel, resolveRestoredModelReference } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.js";
import { type ModelRuntimeSimpleStreamOptions, mergeHeaders } from "./model-runtime-streaming.ts";
import { sanitizeOpenAIResponsesPayload } from "./openai-responses-payload-sanitizer.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { scrubPreCompactionAssistantUsage } from "./provider-context-usage.ts";
import { canCloneDefaultResourceDiscovery, DefaultResourceLoader } from "./resource-loader.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "./sdk-types.ts";
import { sessionLifecycleCreation, sessionLifecycleScopes } from "./session-lifecycle-scope.ts";
import { sessionGenerationClosing, sessionLifetime, trackSessionWork } from "./session-lifecycle-work.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { registerStartupRollback, rollbackStartup } from "./session-startup-rollback.ts";
import { SettingsManager } from "./settings-manager.ts";
import { ownedSettingsManagers } from "./settings-write-ownership.ts";
import { createChildCommandTaskOwner } from "./tasks/child-command-owner.js";
import { time } from "./timings.ts";
import { allToolNames, getDefaultToolNames } from "./tools/index.ts";

export type { ModelFallbackReason } from "./model-resolver-types.ts";
export * from "./sdk-exports.ts";
export type { AtomicBuiltin, CreateAgentSessionOptions, CreateAgentSessionResult } from "./sdk-types.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn.
setDefaultStreamFn(streamSimple);

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/** Keep static model headers visible to hooks without promoting unchanged defaults to request overrides. */
function removeUnownedModelHeaders(
	headers: ProviderHeaders | undefined,
	modelHeaders: ProviderHeaders | undefined,
	requestHeaders: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!headers || !modelHeaders) return headers;
	const requestOwned = new Set(Object.keys(requestHeaders ?? {}).map((name) => name.toLowerCase()));
	const filtered = { ...headers };
	for (const [modelName, modelValue] of Object.entries(modelHeaders)) {
		const lowerName = modelName.toLowerCase();
		if (requestOwned.has(lowerName)) continue;
		for (const [name, value] of Object.entries(filtered)) {
			if (name.toLowerCase() === lowerName && value === modelValue) delete filtered[name];
		}
	}
	return Object.keys(filtered).length > 0 ? filtered : undefined;
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
 * import { getModel } from '@bastani/pi-ai/compat';
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
	return createScopedSession(options, false);
}

/** Internal CLI assembly seam. Not exported from the package entrypoint. */
export function createUnstartedAgentSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	return createScopedSession(options, true);
}

function createScopedSession(
	options: CreateAgentSessionOptions,
	deferStart: boolean,
): Promise<CreateAgentSessionResult> {
	const inherited = sessionLifecycleCreation.getStore();
	const context = inherited && !inherited.claimed ? inherited : { scope: {} };
	return sessionLifecycleCreation.run({ ...context, claimed: true }, async () => {
		const result = await factoryAcquisitions.run(
			{ pending: new Map(), replacement: context.replacement },
			async () => {
				try {
					return await constructAgentSession(
						{ ...options, extensionBindings: options.extensionBindings ?? context.bindings },
						deferStart,
					);
				} catch (error) {
					throw factoryRollbackError(error, await rollbackFactoryAcquisitions());
				}
			},
		);
		sessionLifecycleScopes.set(result.session, context.scope);
		return result;
	});
}

async function constructAgentSession(
	options: CreateAgentSessionOptions,
	deferStart: boolean,
): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;
	// The concrete default can rediscover into private storage (including deferred
	// CLI configuration). Custom discovery stays delegated; composition instantiates
	// its extensions independently without replacing overridden resource policy.
	if (canCloneDefaultResourceDiscovery(resourceLoader)) {
		resourceLoader = await resourceLoader.createSessionLoader(sessionLifecycleCreation.getStore()!.scope);
	}
	if (resourceLoader) resourceLoader = await isolateMandatoryResourceLoader(resourceLoader);

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

	const disableWorkflowExtension =
		options.orchestrationContext?.kind === "workflow-stage" || options.subagentPolicy !== undefined;
	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			builtinPackagePaths: getBuiltinPackagePaths(options.builtins).map((source) =>
				disableWorkflowExtension && basename(source) === "workflows" ? { source, extensions: [] } : source,
			),
		});
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}
	if (
		(options.resourceLoader || options.builtins || disableWorkflowExtension) &&
		(!isMandatoryResourceLoader(resourceLoader) || options.builtins || disableWorkflowExtension)
	) {
		resourceLoader = await withBuiltinResourceLoader(
			resourceLoader,
			cwd,
			agentDir,
			options.builtins,
			disableWorkflowExtension,
		);
	}
	if (options.builtins?.intercom !== false) {
		resourceLoader = await withMandatoryResourceLoader(resourceLoader, cwd);
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
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
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

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		thinkingLevel = settingsManager.getModelThinkingLevel(model.provider, model.id);
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	// `defaultTools` narrows only the initial BUILT-IN selection. It must not
	// narrow `allowedToolNames`: a narrow allowlist would drop every extension
	// and SDK custom tool (workflow, subagent, intercom, mcp, web_search, ...)
	// for any user who configures it (upstream 4d9aa837 + companion fix 541045ae).
	const configuredDefaultToolNames = settingsManager.getDefaultTools();
	const allowedToolNames =
		options.noTools === "all" ? [] : options.tools === undefined ? undefined : [...options.tools];
	const initialActiveToolNames: string[] = allowedToolNames
		? [...allowedToolNames]
		: options.noTools
			? []
			: [...(configuredDefaultToolNames ?? getDefaultToolNames())];
	const childBuiltins = { ...options.builtins };
	const childExcludedTools = [
		...(options.excludedTools ?? []),
		...(allowedToolNames === undefined
			? [...allToolNames].filter((name) => !initialActiveToolNames.includes(name))
			: []),
	];

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
		const filtered = converted.map((msg): Message => {
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
						// `user` and `toolResult` carry different content unions, and mapping them in one
						// branch widens both to their union. Only image blocks are rewritten here, so each
						// message keeps its own shape at runtime.
						return { ...msg, content: filteredContent } as Message;
					}
				}
			}
			return msg;
		});
		lastConvertedLlmMessages = filtered;
		return filtered;
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
		{
			streamSimple: (model, context, requestOptions) => {
				const extension = modelRuntime.getRegisteredProviderConfig(model.provider);
				return getModelFastRoute(model)?.serviceTier !== undefined &&
					!(extension?.streamSimple && extension.api === model.api)
					? streamWithFastRoute(model, context, requestOptions)
					: modelRuntime.streamSimple(model, context, requestOptions);
			},
		},
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => {
			const runner = extensionRunnerRef.current;
			if (!runner) {
				return event.action;
			}
			return (await runner.emitCacheWarmingDecision(event)) ?? event.action;
		},
		(refresh) => trackSessionWork(session, refresh),
	);

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
			messages: existingMessages,
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, streamOptions) => {
			const authResult = await modelRuntime.getRequestAuth(model, {
				apiKey: streamOptions?.apiKey,
				env: streamOptions?.env,
				signal: streamOptions?.signal,
			});
			const compatibility = authResult ? undefined : modelRuntime.getCompatibilityRequestConfig(model);
			if (!authResult && compatibility?.authHeader) {
				throw new Error(`No API key found for "${model.provider}"`);
			}
			const auth = {
				apiKey: authResult?.auth.apiKey,
				headers: authResult?.auth.headers ?? compatibility?.headers,
				baseUrl: authResult?.auth.baseUrl,
				env: authResult?.env,
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
			const streamDeadlineMs = streamOptions?.streamDeadlineMs ?? settingsManager.getStreamDeadlineMs();
			const requestHeaders = mergeProviderAttributionHeaders(
				model,
				settingsManager,
				streamOptions?.sessionId,
				auth.headers,
				streamOptions?.headers,
			);
			const mergedHeaders = mergeHeaders(model.headers, requestHeaders);
			const headerRunner = extensionRunnerRef.current;
			const assembledHeaders = headerRunner?.hasHandlers("before_provider_headers")
				? await headerRunner.emitBeforeProviderHeaders(mergedHeaders ?? {})
				: mergedHeaders;
			const extensionProvider = modelRuntime.getRegisteredProviderConfig(requestModel.provider);
			const usesExtensionStream =
				extensionProvider?.streamSimple !== undefined && requestModel.api === extensionProvider.api;
			const transportHeaders = usesExtensionStream
				? assembledHeaders
				: removeUnownedModelHeaders(assembledHeaders, model.headers, requestHeaders);
			// Fast-vs-normal is the selected model's own identity, so the canonical `-fast` model is what
			// dispatch, the recorded assistant message, session state, and usage all see. The provider
			// adapter reads `fastRoute.upstreamModelId` when it serializes the outbound request.
			const fastRoute = getModelFastRoute(requestModel);
			if (fastRoute?.serviceTier !== undefined && !usesExtensionStream && !authResult) {
				throw new Error(`No API key found for "${model.provider}"`);
			}
			const env = auth.env || streamOptions?.env ? { ...auth.env, ...streamOptions?.env } : undefined;
			const cacheRetentionEnv = getProviderEnvValue("PI_CACHE_RETENTION", env);
			// Shared by main chat, workflow stages and subagents; provider capability gates still apply.
			const cacheRetention =
				streamOptions?.cacheRetention ??
				(cacheRetentionEnv === "none"
					? "none"
					: !cacheRetentionEnv
						? getDefaultCacheRetention(requestModel)
						: cacheRetentionEnv === "long"
							? "long"
							: "short");
			const fastRouteStreamOptions = withFastRouteStreamOptions(fastRoute, {
				...streamOptions,
				apiKey: auth.apiKey,
				env,
				cacheRetention,
				timeoutMs,
				websocketConnectTimeoutMs,
				streamDeadlineMs,
				maxRetries: streamOptions?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers: transportHeaders,
			});
			const preparedStreamOptions: ModelRuntimeSimpleStreamOptions = {
				...fastRouteStreamOptions,
				preparedRequestAuth: { resolution: authResult },
			};
			if (streamOptions?.sessionId === sessionManager.getSessionId()) {
				const prefix = [...agent.state.messages];
				cacheWarmer.start({ model: requestModel, context, options: preparedStreamOptions }, () => {
					const current = agent.state.model;
					return (
						!sessionLifetime(session).aborted &&
						!sessionGenerationClosing.has(session) &&
						!(session as unknown as AgentSessionInternalSurface)._agentRunAbortRequested &&
						current?.provider === model.provider &&
						current.id === model.id &&
						prefix.every((message, index) => agent.state.messages[index] === message)
					);
				});
			}
			if (usesExtensionStream) {
				return modelRuntime.streamSimple(requestModel, context, preparedStreamOptions);
			}
			if (fastRoute?.serviceTier !== undefined) {
				return streamWithFastRoute(requestModel, context, fastRouteStreamOptions);
			}
			// The Codex routing identity is attached by ModelRuntimeStreaming, after auth headers are
			// merged. Applying it here would be inert: `mergeHeaders` copies the header object the
			// wrapper mutates.
			return modelRuntime.streamSimple(requestModel, context, preparedStreamOptions);
		},
		onPayload: async (payload, model) => {
			const sourceMessages = lastConvertedLlmMessages;
			const replayGuardedPayload = sourceMessages
				? restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, model)
				: payload;
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
			const sanitizedPayload = sanitizeOpenAIResponsesPayload(finalPayload, model);
			markLifecycleTiming("before-provider-request");
			return sanitizedPayload;
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

	// Restore missing settings metadata for older sessions.
	if (hasExistingSession) {
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

	const providerRollback = modelRuntime.createExtensionProviderTransaction();
	let session: AgentSession;
	const childCommandTaskOwner = createChildCommandTaskOwner(() => session.getAgentTaskHost());
	try {
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd,
			childSessionOptions: (child) =>
				inheritChildSessionOptions(
					{
						cwd,
						agentDir,
						modelRuntime,
						settingsManager,
						model: session.model,
						thinkingLevel: session.thinkingLevel,
						fallbackModels: options.fallbackModels ?? settingsManager.getFallbackModels(),
						isFallbackModelAllowed: options.isFallbackModelAllowed,
						builtins: childBuiltins,
						tools: allowedToolNames,
						noTools: options.noTools,
						excludedTools: childExcludedTools,
						customTools: options.customTools,
						extensionBindings: session.extensionRunner.getChildHostBindings(),
						parentCommandTaskOwner: childCommandTaskOwner,
					},
					child,
				),
			scopedModels: options.scopedModels,
			fallbackModels: options.fallbackModels ?? settingsManager.getFallbackModels(),
			isFallbackModelAllowed: options.isFallbackModelAllowed,
			resourceLoader,
			customTools: options.customTools,
			modelRuntime,
			cacheWarmer,
			initialActiveToolNames,
			allowedToolNames,
			excludedToolNames: options.excludedTools,
			extensionRunnerRef,
			sessionStartEvent: options.sessionStartEvent,
			orchestrationContext: options.orchestrationContext,
			subagentPolicy: options.subagentPolicy,
			parentCommandTaskOwner: options.parentCommandTaskOwner,
			systemPromptTransform: options.systemPromptTransform,
			contextProjectionTransform: options.initialContextTransform,
		});
	} catch (error) {
		// The constructor releases its own leases/subscriptions; restore borrowed provider state here.
		const cleanup = await Promise.allSettled([providerRollback.commit(), settingsManager.flush()]);
		const failures = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length)
			throw new AggregateError([error, ...failures], "Session construction failed and rollback reported errors");
		throw error;
	}
	// Only the selected factories transfer. Discovery may have acquired omitted factories.
	const acquisitions = factoryAcquisitions.getStore();
	const selected = resourceLoader.getExtensions();
	for (const extension of selected.extensions) acquisitions?.pending?.delete(extension);
	if (!options.settingsManager) ownedSettingsManagers.set(settingsManager, session);
	const rollbackReason = sessionLifecycleCreation.getStore()?.replacement ? "new" : "quit";
	registerStartupRollback(session.extensionRunner, async (error) => {
		const results = await Promise.allSettled([
			(session as unknown as AgentSessionInternalSurface)._close({
				type: "session_shutdown",
				reason: rollbackReason,
			}),
			providerRollback.commit(),
		]);
		const cleanupErrors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupErrors.length)
			throw new AggregateError([error, ...cleanupErrors], "Extension startup failed and rollback reported errors");
		throw error;
	});
	try {
		// Omitted factories may share the selected runtime: release their acquisitions,
		// but leave that runtime and its selected subscriptions owned by the runner.
		const failures = await rollbackFactoryAcquisitions(new Set([selected.runtime]));
		if (failures.length)
			throw Object.assign(new AggregateError(failures, "Unselected extension cleanup failed"), {
				code: "ShutdownFailed",
			});
		const extensionsResult = resourceLoader.getExtensions();
		for (const failure of extensionsResult.errors) {
			const builtin = getBuiltinPackageLocations().find(({ packageDir }) => {
				const path = relative(packageDir, failure.path);
				return path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
			});
			if (builtin)
				throw Object.assign(new Error(`Builtin unavailable: ${builtin.packageName}: ${failure.error}`), {
					code: "BuiltinUnavailable",
				});
		}
		if (!deferStart) await session.bindExtensions(options.extensionBindings ?? {});
		return { session, extensionsResult, modelFallbackMessage, modelFallbackReason };
	} catch (error) {
		return rollbackStartup(session.extensionRunner, error instanceof Error ? error : new Error(String(error)));
	}
}
