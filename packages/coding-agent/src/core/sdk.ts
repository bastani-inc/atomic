import { basename, dirname, join, relative, sep } from "node:path";
import { getOpenCodeSessionHeaders } from "@bastani/pi-ai";
import { clampThinkingLevel, type Message, type ProviderHeaders, streamSimple } from "@bastani/pi-ai/compat";
import { getProviderEnvValue } from "@bastani/pi-ai/utils/provider-env";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../config.js";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.js";
import type { AgentSessionInternalSurface } from "./agent-session-methods.ts";
import { markRuntimeStreamFunction } from "./agent-session-models.ts";
import {
	enableReleaseWhenIdle,
	notReopenable,
	parseReleaseWhenIdle,
	type ReleaseWhenIdleOptions,
} from "./agent-session-release.ts";
import { childCommandTaskHost } from "./agent-session-tasks.js";
import { restoreAnthropicReplayThinkingBlocks } from "./anthropic-thinking-guard.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { getBuiltinPackageLocations, getBuiltinPackagePaths } from "./builtin-packages.ts";
import { withBuiltinResourceLoader } from "./builtin-resource-loader.ts";
import { getDefaultCacheRetention } from "./cache-retention.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { inheritChildSessionOptions } from "./child-session-options.ts";
import { getClientIdentity } from "./client-identity.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { startupCleanupFailureMessage } from "./extension-startup-failure.ts";
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
import { formatModelLabel } from "./model-label.ts";
import { findInitialModel, resolveRestoredModelReference, uncachedCopilotModelHint } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.js";
import { type ModelRuntimeSimpleStreamOptions, mergeHeaders } from "./model-runtime-streaming.ts";
import { sanitizeOpenAIResponsesPayload } from "./openai-responses-payload-sanitizer.ts";
import { scrubPreCompactionAssistantUsage } from "./provider-context-usage.ts";
import { currentResourceAdmission } from "./resource-admission-scope.ts";
import { canCloneDefaultResourceDiscovery, DefaultResourceLoader } from "./resource-loader.ts";
import { prepareSessionResume, savedProjectTrust, sessionResumeOptions } from "./resume/session-resume.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult, ResourceAdmission } from "./sdk-types.ts";
import { sessionLifecycleCreation, sessionLifecycleScopes } from "./session-lifecycle-scope.ts";
import {
	ownedSessionManagerStores,
	ownedSessionPermits,
	ownedSessionStores,
	sessionGenerationClosing,
	sessionLifetime,
	trackSessionWork,
} from "./session-lifecycle-work.ts";
import { SessionManager } from "./session-manager.ts";
import { registerStartupRollback, rollbackStartup } from "./session-startup-rollback.ts";
import { resolveSessionStore } from "./session-storage.js";
import { releaseSessionWorktrees } from "./session-worktree-snapshots.ts";
import { SettingsManager } from "./settings-manager.ts";
import { applyToolModifiers, getToolListError, isToolModifier } from "./settings-merge.js";
import { ownedSettingsManagers } from "./settings-write-ownership.ts";
import { validateProcessStorage } from "./storage/process-selection.js";
import { selectStorage } from "./storage/selection.js";
import type { SessionStore } from "./storage/session/types.js";
import { assertTeamAdapterInstalled } from "./storage/team.js";
import { createChildCommandTaskOwner } from "./tasks/child-command-owner.js";
import { time } from "./timings.ts";
import { createToolNameMatcher } from "./tool-selection.ts";
import type { ProjectHistory } from "./tools/history-protocol.ts";
import { allToolNames, getDefaultToolNames } from "./tools/index.js";
import {
	assertSessionManagerInWorktree,
	bindSessionWorkspace,
	recordSessionWorkspace,
	WORKSPACE_WRITE_TOOL_NAMES,
	workspaceSessionCwd,
} from "./workspace/session.ts";
import { resolveWorktreeSnapshotSettings } from "./worktree-snapshot/settings.ts";

export type { ModelFallbackReason } from "./model-resolver-types.ts";
export { withResourceAdmission } from "./resource-admission-scope.ts";
export * from "./sdk-exports.ts";
export type {
	AtomicBuiltin,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ResourceAdmission,
	ResourceAdmissionRequest,
	ResourcePermit,
	ResourceProcessIdentity,
	SessionStorageOption,
} from "./sdk-types.ts";

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
export function createUnstartedAgentSession(
	options: CreateAgentSessionOptions,
	persistInitialState = true,
): Promise<CreateAgentSessionResult> {
	return createScopedSession(options, true, persistInitialState);
}

function createScopedSession(
	options: CreateAgentSessionOptions,
	deferStart: boolean,
	persistInitialState = true,
): Promise<CreateAgentSessionResult> {
	let releaseWhenIdle: ReleaseWhenIdleOptions | undefined;
	try {
		releaseWhenIdle = parseReleaseWhenIdle(options.releaseWhenIdle);
	} catch (error) {
		return Promise.reject(error);
	}
	if (releaseWhenIdle !== undefined && options.sessionManager !== undefined) {
		const unreopenable = notReopenable(
			options.sessionManager.getSessionId(),
			options.sessionManager.getSessionStore(),
		);
		if (unreopenable !== undefined) return Promise.reject(unreopenable);
	}
	const inherited = sessionLifecycleCreation.getStore();
	const context = inherited && !inherited.claimed ? inherited : { scope: {} };
	return sessionLifecycleCreation.run({ ...context, claimed: true }, async () => {
		const result = await factoryAcquisitions.run(
			{ pending: new Map(), replacement: context.replacement },
			async () => {
				const acquisition: SessionAcquisition = {
					store: options.sessionManager ? ownedSessionManagerStores.get(options.sessionManager) : undefined,
				};
				if (options.sessionManager) ownedSessionManagerStores.delete(options.sessionManager);
				const admission =
					options.resourceAdmission === null
						? undefined
						: (options.resourceAdmission ?? currentResourceAdmission());
				try {
					acquisition.release = await acquireSessionPermit(admission, options);
					return await constructAgentSession(
						{
							...options,
							extensionBindings: options.extensionBindings ?? context.bindings,
							resourceAdmission: admission,
						},
						deferStart,
						persistInitialState,
						acquisition,
					);
				} catch (error) {
					// The resumed session never opened: nothing else releases the pooled worktrees it holds (#4748).
					if (acquisition.resumed) await releaseSessionWorktrees(acquisition.resumed);
					const failures = await rollbackFactoryAcquisitions();
					if (acquisition.store) {
						try {
							await acquisition.store.close();
						} catch (cause) {
							failures.push(cause);
						}
					}
					if (!failures.length) await acquisition.release?.();
					throw factoryRollbackError(error, failures);
				}
			},
		);
		sessionLifecycleScopes.set(result.session, context.scope);
		if (releaseWhenIdle !== undefined)
			enableReleaseWhenIdle(result.session as unknown as AgentSessionInternalSurface, releaseWhenIdle);
		return result;
	});
}

/** The session's permit, telling `onResourceAdmissionWait` while the session waits for it. */
async function acquireSessionPermit(
	admission: ResourceAdmission | undefined,
	options: CreateAgentSessionOptions,
): Promise<Awaited<ReturnType<ResourceAdmission["acquire"]>> | undefined> {
	if (!admission) return undefined;
	options.onResourceAdmissionWait?.(true);
	try {
		return await admission.acquire(
			"session",
			options.resourceAdmissionSignal,
			options.resourceAdmissionDelegated ? { delegated: true } : undefined,
		);
	} finally {
		options.onResourceAdmissionWait?.(false);
	}
}

/**
 * A supplied session that recorded worktree snapshots, prepared the way `atomic --session` prepares it: continued in
 * its recorded checkout when that still matches, in a matching checkout, or in a worktree restored from its snapshot,
 * with its blueprints built. The checkout is compared under the `snapshots` the session itself records with. A session
 * without snapshots is returned unchanged, so creating it costs no Git call.
 */
async function sessionResumedOnThisNode(
	sessionManager: SessionManager | undefined,
	agentDir: string,
	settingsManager: SettingsManager | undefined,
	snapshots: CreateAgentSessionOptions["snapshots"],
): Promise<SessionManager | undefined> {
	if (sessionManager === undefined || !sessionManager.isPersisted()) return sessionManager;
	if (sessionManager.getLatestWorktreeSnapshots().size === 0) return sessionManager;
	const settings = settingsManager ?? SettingsManager.create(process.cwd(), agentDir);
	const prepared = await prepareSessionResume(sessionManager, {
		...sessionResumeOptions(
			"create-agent-session",
			process.cwd(),
			agentDir,
			settings,
			savedProjectTrust(agentDir, settings),
		),
		settings: resolveWorktreeSnapshotSettings(snapshots, "sdk", "snapshots", settings.getWorktreeSnapshotSettings()),
	});
	return prepared.status === "ready" ? prepared.sessionManager : sessionManager;
}

/** What creating a session acquired, released when creation fails. */
interface SessionAcquisition {
	store?: SessionStore;
	release?: () => Promise<void>;
	/** The supplied session as its resume opened it, holding the pooled worktrees it continues in (#4748). */
	resumed?: SessionManager;
}

async function constructAgentSession(
	options: CreateAgentSessionOptions,
	deferStart: boolean,
	persistInitialState: boolean,
	acquisition: SessionAcquisition,
): Promise<CreateAgentSessionResult> {
	resolveWorktreeSnapshotSettings(options.snapshots, "sdk", "snapshots");
	const workspace =
		options.workspace === undefined
			? undefined
			: await bindSessionWorkspace(options.workspace, options.sessionManager, options.resourceAdmissionSignal);
	if (workspace !== undefined) assertSessionManagerInWorktree(workspace, options.sessionManager);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	validateProcessStorage(agentDir);
	// `storage` backs the sessions only without `sessionManager` and `sessionStore`, and the journal only without
	// `journal`; an unused selection needs no adapter, while the process's own profile is still checked.
	const storageUsed =
		(options.sessionManager === undefined && options.sessionStore === undefined) || options.journal === undefined;
	await assertTeamAdapterInstalled(agentDir, storageUsed ? options.storage : undefined);
	const suppliedSession =
		options.cwd === undefined && workspace === undefined
			? await sessionResumedOnThisNode(options.sessionManager, agentDir, options.settingsManager, options.snapshots)
			: options.sessionManager;
	acquisition.resumed = suppliedSession;
	const cwd =
		workspace === undefined
			? resolvePath(options.cwd ?? suppliedSession?.getCwd() ?? process.cwd())
			: workspaceSessionCwd(workspace, options.cwd);
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
	let sessionManager = suppliedSession;
	if (!sessionManager) {
		const sessionStore =
			options.sessionStore ??
			(options.storage === undefined
				? undefined
				: selectStorage(options.storage, "sdk", "storage", join(dirname(agentDir), "workflows", "journal.sqlite")));
		const store = await resolveSessionStore(cwd, {
			agentDir,
			settings: settingsManager.getSettings(),
			sessionStore,
		});
		if (store !== options.sessionStore) acquisition.store = store;
		sessionManager = await SessionManager.create(store, cwd);
	}

	if (workspace !== undefined && persistInitialState) await recordSessionWorkspace(sessionManager, workspace);

	// Mark workflow-created sessions as internal so they are excluded from the
	// standard `/resume` history while remaining resumable via `/workflow resume`.
	// Only stamped when the orchestration context identifies a workflow stage;
	// reattaching to an already-marked session preserves its existing marker.
	if (options.orchestrationContext?.kind === "workflow-stage") {
		const ctx = options.orchestrationContext;
		await sessionManager.markSessionInternal({
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
		resourceLoader = await withMandatoryResourceLoader(resourceLoader, cwd, agentDir);
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
			const { provider, modelId } = existingSession.model;
			const uncachedHint = uncachedCopilotModelHint(provider, modelId, modelRuntime);
			const label = formatModelLabel({ provider, id: modelId });
			modelFallbackMessage = uncachedHint
				? `Could not restore model ${label}: ${uncachedHint}, or choose another model with /model.`
				: `Could not restore model ${label}`;
			// A saved Copilot model that is only missing from the cache must not be replaced silently.
			modelFallbackReason = uncachedHint ? "configured-provider-unsupported" : "session-restore";
		}
	}
	if (!model && modelFallbackReason !== "configured-provider-unsupported") {
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
	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools() ?? getDefaultToolNames());
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
	const allowedToolNames =
		options.noTools === "all"
			? []
			: toolModifiers
				? undefined
				: options.tools === undefined
					? undefined
					: [...options.tools];
	const subagentPolicy =
		options.subagentPolicy && (options.subagentPolicy.depth ?? 0) >= 1
			? {
					...options.subagentPolicy,
					tools: allowedToolNames,
					mcpDirectTools:
						options.noTools === "all"
							? []
							: (options.subagentPolicy.mcpDirectTools ?? (allowedToolNames === undefined ? undefined : [])),
				}
			: options.subagentPolicy;
	// A read-only workspace excludes the file-writing tools, which wins over any tool selection, also after a reload.
	const excludedTools =
		workspace?.sandbox === "read-only"
			? [...(options.excludedTools ?? []), ...WORKSPACE_WRITE_TOOL_NAMES]
			: options.excludedTools;
	const isExcludedTool = excludedTools ? createToolNameMatcher(excludedTools) : undefined;
	const initialActiveToolNames = (options.noTools === "all" ? [] : (selectedToolNames ?? defaultToolNames)).filter(
		(name) => !isExcludedTool?.(name),
	);
	const childBuiltins = { ...options.builtins };
	const childExcludedTools = [
		...(excludedTools ?? []),
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
					extension?.aliasOf === undefined &&
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

	const handleProviderStreamEvent: NonNullable<ModelRuntimeSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
			data,
		});
	};

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
			const onProviderStreamEvent = streamOptions?.onProviderStreamEvent ?? handleProviderStreamEvent;
			const prepare = async () => {
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
					auth.baseUrl !== undefined && auth.baseUrl !== model.baseUrl
						? { ...model, baseUrl: auth.baseUrl }
						: model;
				const providerRetrySettings = settingsManager.getProviderRetrySettings();
				const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
				// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
				// Use max int32 to effectively disable the timeout.
				const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
				const timeoutMs = streamOptions?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
				const websocketConnectTimeoutMs =
					streamOptions?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
				const streamDeadlineMs = streamOptions?.streamDeadlineMs ?? settingsManager.getStreamDeadlineMs();
				// The OpenCode session header joins here, not in `ModelRuntimeStreaming`, so `before_provider_headers`
				// handlers see it and can change or remove it.
				const requestHeaders = mergeHeaders(
					mergeHeaders(getOpenCodeSessionHeaders(requestModel, streamOptions?.sessionId), auth.headers),
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
					// Replaces the agent loop's default identity; read per request so telemetry changes apply at once.
					identity: getClientIdentity(settingsManager),
					maxRetries: streamOptions?.maxRetries ?? providerRetrySettings.maxRetries,
					maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
					headers: transportHeaders,
				});
				const nativeFastRoute =
					fastRoute?.serviceTier !== undefined && !usesExtensionStream && extensionProvider?.aliasOf === undefined;
				const requestOptions: ModelRuntimeSimpleStreamOptions = {
					...fastRouteStreamOptions,
					onProviderStreamEvent,
					preparedRequestAuth: {
						resolution: authResult,
						reprepare: async () => {
							const next = await prepare();
							return { model: next.requestModel, options: next.requestOptions };
						},
						streamSimple: nativeFastRoute
							? (routeModel, routeContext, routeOptions) =>
									streamWithFastRoute(routeModel, routeContext, routeOptions)
							: undefined,
					},
				};
				return { authResult, requestModel, fastRouteStreamOptions, requestOptions };
			};
			const { authResult, requestModel, fastRouteStreamOptions, requestOptions } = await prepare();
			if (streamOptions?.sessionId === sessionManager.getSessionId()) {
				const prefix = [...agent.state.messages];
				const warmOptions: ModelRuntimeSimpleStreamOptions = {
					...fastRouteStreamOptions,
					preparedRequestAuth: {
						resolution: authResult,
						reprepare: requestOptions.preparedRequestAuth?.reprepare,
					},
				};
				cacheWarmer.start({ model: requestModel, context, options: warmOptions }, () => {
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
			// The Codex routing identity is attached by ModelRuntimeStreaming, after auth headers are
			// merged. Applying it here would be inert: `mergeHeaders` copies the header object the
			// wrapper mutates.
			return modelRuntime.streamSimple(requestModel, context, requestOptions);
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
	// This stream resolves auth through modelRuntime, so summaries must not pre-resolve it (upstream #11520).
	markRuntimeStreamFunction(agent.streamFunction, modelRuntime);

	// The isolated host mirrors child-owned storage without writing startup metadata.
	if (persistInitialState) {
		if (hasExistingSession) {
			if (!hasThinkingEntry) {
				await sessionManager.appendThinkingLevelChange(thinkingLevel);
			}
		} else {
			await sessionManager.appendStartState(
				model ? { provider: model.provider, modelId: model.id } : undefined,
				thinkingLevel,
			);
		}
	}

	const providerRollback = modelRuntime.createExtensionProviderTransaction();
	let session: AgentSession;
	const childCommandTaskOwner = createChildCommandTaskOwner(() =>
		childCommandTaskHost(session as unknown as AgentSessionInternalSurface),
	);
	const childHistory: ProjectHistory = {
		sessionStore: () => session.extensionRunner.getProjectHistory().sessionStore(),
		workflows: () => session.extensionRunner.getProjectHistory().workflows(),
	};
	try {
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd,
			workflowJournal: options.journal ?? options.storage,
			storageAgentDir: agentDir,
			worktreeSnapshots:
				options.snapshots === undefined
					? undefined
					: resolveWorktreeSnapshotSettings(
							options.snapshots,
							"sdk",
							"snapshots",
							settingsManager.getWorktreeSnapshotSettings(),
						),
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
						inheritedHistory: childHistory,
						resourceAdmission: options.resourceAdmission,
						workspace,
					},
					child,
					session.getAllTools().map((tool) => tool.name),
				),
			scopedModels: options.scopedModels,
			// Undefined follows the settings' current `fallbackModels`, also once a project is trusted later.
			fallbackModels: options.fallbackModels,
			isFallbackModelAllowed: options.isFallbackModelAllowed,
			resourceLoader,
			customTools: options.customTools,
			modelRuntime,
			cacheWarmer,
			...(options.compactionWake ? { compactionWake: options.compactionWake } : {}),
			initialActiveToolNames,
			usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
			defaultToolModifiers: toolModifiers,
			allowedToolNames,
			excludedToolNames: excludedTools,
			extensionRunnerRef,
			sessionStartEvent: options.sessionStartEvent,
			orchestrationContext: options.orchestrationContext,
			subagentPolicy,
			parentCommandTaskOwner: options.parentCommandTaskOwner,
			inheritedHistory: options.inheritedHistory,
			resourceAdmission: options.resourceAdmission ?? undefined,
			systemPromptTransform: options.systemPromptTransform,
			contextProjectionTransform: options.initialContextTransform,
			workspace,
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
		if (cleanupErrors.length) {
			const errors = [error, ...cleanupErrors];
			throw new AggregateError(
				errors,
				startupCleanupFailureMessage("Extension startup failed and rollback reported errors", errors),
			);
		}
		throw error;
	});
	if (acquisition.store) {
		ownedSessionStores.set(session, acquisition.store);
		acquisition.store = undefined;
	}
	if (acquisition.release) {
		ownedSessionPermits.set(session, acquisition.release);
		acquisition.release = undefined;
	}
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
		return {
			session,
			extensionsResult,
			modelFallbackMessage,
			modelFallbackReason,
			...(workspace !== undefined ? { workspace } : {}),
		};
	} catch (error) {
		return rollbackStartup(session.extensionRunner, error instanceof Error ? error : new Error(String(error)));
	}
}
