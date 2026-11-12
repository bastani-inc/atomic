import {
	bindSessionWorkspace,
	type CreateAgentSessionOptions,
	currentWorktreeRootMappings,
	getAgentDir,
	mapRestoredPath,
	recordRestoredWorktreeContext,
	resolveWorkspace,
	resumeStoreDir,
	SessionManager,
	type SessionStore,
	workspaceSessionCwd,
} from "@bastani/atomic";
import { resolveStageGroup, stageHasIntercomAccess } from "../../shared/intercom-group.js";
import { forkStageSession, migrateLegacyStageSession, stageSessionStore } from "../../shared/stage-session-store.js";
import type { StageExecutionMeta, StageOptions } from "../../shared/types.js";
import { agentSessionAdapterDefaultCwd } from "./stage-runner-session-options.js";
import type { AgentSessionConsumer, StageAdapters } from "./stage-runner-types.js";

function workflowSessionOptions(meta: StageExecutionMeta) {
	return {
		internal: true as const,
		workflow: { runId: meta.runId, stageId: meta.stageId, stageName: meta.stageName },
	};
}

function workflowOrchestrationContext(
	meta: StageExecutionMeta,
	stageOptions: StageOptions | undefined,
	pendingStageDelivery?: NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"],
): NonNullable<CreateAgentSessionOptions["orchestrationContext"]> {
	const base = {
		kind: "workflow-stage" as const,
		workflowRunId: meta.runId,
		workflowStageId: meta.stageId,
		workflowStageName: meta.stageName,
		constraints: { disableWorkflowTool: true as const },
	};
	const intercomGroup = stageHasIntercomAccess(stageOptions)
		? resolveStageGroup(stageOptions, meta.workflowIntercomGroup)
		: undefined;
	const context = intercomGroup ? { ...base, intercomGroup } : base;
	return pendingStageDelivery === undefined ? context : { ...context, pendingStageDelivery };
}

/** The session store a stage resumes from, with a legacy session file migrated into it. */
async function stageResumeStore(
	options: StageOptions,
	defaultSessionDir: string | undefined,
	sessionId: string,
	legacySessionFile: string | undefined,
): Promise<SessionStore> {
	const store = await stageSessionStore(options, defaultSessionDir);
	await migrateLegacyStageSession(store, sessionId, legacySessionFile);
	return store;
}

export async function stripWorkflowOnlyOptions(
	options: StageOptions | undefined,
	defaultSessionDir: string | undefined,
	meta: StageExecutionMeta,
	pendingStageDelivery?: NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"],
	signal?: AbortSignal,
): Promise<CreateAgentSessionOptions> {
	const classification = workflowSessionOptions(meta);
	const orchestrationContext = workflowOrchestrationContext(meta, options, pendingStageDelivery);
	if (!options) {
		return defaultSessionDir === undefined
			? { orchestrationContext }
			: {
					orchestrationContext,
					sessionManager: await SessionManager.create(process.cwd(), defaultSessionDir, classification),
				};
	}
	const {
		schema: _schema,
		schemaTimeoutMs: _schemaTimeoutMs,
		mcp: _mcp,
		fallbackModels,
		modelConstraints: _modelConstraints,
		taskNeeds: _taskNeeds,
		parallelSlot: _parallelSlot,
		inheritedModelConstraints: _inheritedModelConstraints,
		routerSelection: _routerSelection,
		context,
		forkFromSessionId,
		forkFromEntryId,
		resumeFromSessionId,
		resumeFromLegacySessionFile,
		resumeInsideCall: _resumeInsideCall,
		sessionStore,
		durableReplayKey: _durableReplayKey,
		durableAccumulatedDurationMs: _durableAccumulatedDurationMs,
		durableStageId: _durableStageId,
		durableIntercomGroup: _durableIntercomGroup,
		durableParentIds: _durableParentIds,
		sessionDir,
		gitWorktreeDir: _gitWorktreeDir,
		baseBranch: _baseBranch,
		group: _group,
		...sessionOptions
	} = options;
	// Bound here, before the session opens, so the session store, the session and its tools all use the bound worktree.
	// A resumed session restores the binding its session recorded instead of resolving the workspace again.
	const resumeStore =
		resumeFromSessionId === undefined
			? undefined
			: await stageResumeStore(options, defaultSessionDir, resumeFromSessionId, resumeFromLegacySessionFile);
	if (sessionOptions.workspace !== undefined) {
		const binding =
			resumeStore === undefined
				? await resolveWorkspace(sessionOptions.workspace, { signal })
				: await bindSessionWorkspace(
						sessionOptions.workspace,
						await SessionManager.open(resumeStore, resumeFromSessionId!),
						signal,
					);
		sessionOptions.workspace = binding;
		sessionOptions.cwd = workspaceSessionCwd(binding, sessionOptions.cwd);
	}
	const cwd = sessionOptions.cwd ?? process.cwd();
	if (resumeStore !== undefined) {
		sessionOptions.sessionManager = await SessionManager.open(resumeStore, resumeFromSessionId!, cwd);
	} else if (context === "fork" && forkFromSessionId !== undefined) {
		sessionOptions.sessionManager = await forkStageSession(
			await stageSessionStore(options, defaultSessionDir),
			forkFromSessionId,
			cwd,
			classification,
			undefined,
			forkFromEntryId,
		);
	} else if (sessionOptions.sessionManager === undefined) {
		if (sessionStore !== undefined) {
			sessionOptions.sessionManager = await SessionManager.create(sessionStore, cwd, classification);
		} else if ((sessionDir ?? defaultSessionDir) !== undefined) {
			sessionOptions.sessionManager = await SessionManager.create(
				cwd,
				sessionDir ?? defaultSessionDir,
				classification,
			);
		}
	}
	const manager = sessionOptions.sessionManager;
	if (manager !== undefined) {
		const mappings = [...manager.getWorktreeRootMappings(), ...currentWorktreeRootMappings()];
		const notKept = await recordRestoredWorktreeContext(
			manager,
			resumeStoreDir(sessionOptions.agentDir ?? getAgentDir()),
			mapRestoredPath(cwd, mappings),
		);
		if (notKept !== undefined) console.warn(`atomic-workflows: ${notKept.message}`);
	}
	return {
		...sessionOptions,
		...(fallbackModels?.length === 0 ? { fallbackModels: [] } : {}),
		orchestrationContext,
	} as CreateAgentSessionOptions;
}

/**
 * The messages of the stage session `sessionId`, read from the store the stage would reopen it from, as the session
 * starts with them. Opens no session, and closes the store when this read opened it: a caller's `sessionStore` or
 * `sessionManager` stays open (#4309).
 */
export async function readStoredStageMessages(
	options: StageOptions,
	defaultSessionDir: string | undefined,
	sessionId: string,
): Promise<ReturnType<SessionManager["buildSessionContext"]>["messages"]> {
	const store = await stageSessionStore(options, defaultSessionDir);
	const owned = options.sessionStore === undefined && options.sessionManager === undefined;
	let messages: ReturnType<SessionManager["buildSessionContext"]>["messages"];
	try {
		messages = (await SessionManager.open(store, sessionId, options.cwd)).buildSessionContext().messages;
	} catch (error) {
		if (owned) await closeAfterFailure(store, error);
		throw error;
	}
	if (owned) await store.close();
	return messages;
}

/**
 * The stored messages of session `sessionId` of a stage a resumed run replays, from the store the stage would open with
 * `options`: its own `sessionStore`, `sessionManager` or `sessionDir`, else the run's `adapters.sessionStore`, else
 * `defaultSessionDir` or the default store. A store this read opens is closed; the caller's stores stay open (#4309).
 */
export function readReplayedStageMessages(
	options: StageOptions,
	run: {
		readonly adapters?: Partial<Pick<StageAdapters, "sessionStore" | "agentSession">>;
		readonly defaultSessionDir?: string;
		readonly defaultCwd: string;
	},
	sessionId: string,
): Promise<ReturnType<SessionManager["buildSessionContext"]>["messages"]> {
	const ownStore =
		options.sessionStore !== undefined || options.sessionDir !== undefined || options.sessionManager !== undefined;
	const runStore = run.adapters?.sessionStore;
	return readStoredStageMessages(
		{
			...(ownStore || runStore === undefined ? options : { ...options, sessionStore: runStore }),
			cwd:
				options.cwd ??
				options.sessionManager?.getCwd() ??
				agentSessionAdapterDefaultCwd(run.adapters?.agentSession) ??
				run.defaultCwd,
		},
		run.defaultSessionDir,
		sessionId,
	);
}

/** Close `store` after `primary` failed: a failure to close is attached to `primary` as `cleanupCause`, never thrown. */
async function closeAfterFailure(store: SessionStore, primary: unknown): Promise<void> {
	try {
		await store.close();
	} catch (cleanupCause) {
		if (primary instanceof Error)
			Object.defineProperty(primary, "cleanupCause", { value: cleanupCause, configurable: true });
	}
}

export function missingAdapter(consumer: AgentSessionConsumer): never {
	if (consumer === "complete") {
		throw new Error(
			"atomic-workflows: ctx.complete requires either RunOpts.adapters.complete or RunOpts.adapters.agentSession",
		);
	}
	throw new Error(
		"atomic-workflows: prompt adapter not configured — provide an AgentSessionAdapter via RunOpts.adapters.agentSession",
	);
}

export function unavailableSync(property: string): never {
	throw new Error(
		`atomic-workflows: stage AgentSession property "${property}" is unavailable until the SDK session has been created`,
	);
}
