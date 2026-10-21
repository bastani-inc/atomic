import { type CreateAgentSessionOptions, SessionManager } from "@bastani/atomic";
import { resolveStageGroup, stageHasIntercomAccess } from "../../shared/intercom-group.js";
import { forkStageSession, migrateLegacyStageSession, stageSessionStore } from "../../shared/stage-session-store.js";
import type { StageExecutionMeta, StageOptions } from "../../shared/types.js";
import type { AgentSessionConsumer } from "./stage-runner-types.js";

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

export async function stripWorkflowOnlyOptions(
	options: StageOptions | undefined,
	defaultSessionDir: string | undefined,
	meta: StageExecutionMeta,
	pendingStageDelivery?: NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"],
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
		inheritedModelConstraints: _inheritedModelConstraints,
		routerSelection: _routerSelection,
		context,
		forkFromSessionId,
		resumeFromSessionId,
		resumeFromLegacySessionFile,
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
	const cwd = sessionOptions.cwd ?? process.cwd();
	if (resumeFromSessionId !== undefined) {
		const store = await stageSessionStore(options, defaultSessionDir);
		await migrateLegacyStageSession(store, resumeFromSessionId, resumeFromLegacySessionFile);
		sessionOptions.sessionManager = await SessionManager.open(store, resumeFromSessionId, cwd);
	} else if (context === "fork" && forkFromSessionId !== undefined) {
		sessionOptions.sessionManager = await forkStageSession(
			await stageSessionStore(options, defaultSessionDir),
			forkFromSessionId,
			cwd,
			classification,
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
	return {
		...sessionOptions,
		...(fallbackModels?.length === 0 ? { fallbackModels: [] } : {}),
		orchestrationContext,
	} as CreateAgentSessionOptions;
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
