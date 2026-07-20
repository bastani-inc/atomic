import { SessionManager, type CreateAgentSessionOptions } from "@bastani/atomic";
import type { StageExecutionMeta, StageOptions } from "../../shared/types.js";
import type { AgentSessionConsumer } from "./stage-runner-types.js";
import { resolveStageGroup, stageHasIntercomAccess } from "../../shared/intercom-group.js";

function workflowSessionOptions(meta: StageExecutionMeta) {
  return {
    internal: true as const,
    workflow: { runId: meta.runId, stageId: meta.stageId, stageName: meta.stageName },
  };
}

function workflowOrchestrationContext(
  meta: StageExecutionMeta,
  stageOptions: StageOptions | undefined,
): NonNullable<CreateAgentSessionOptions["orchestrationContext"]> {
  const base = {
    kind: "workflow-stage" as const,
    workflowRunId: meta.runId,
    workflowStageId: meta.stageId,
    workflowStageName: meta.stageName,
    constraints: { disableWorkflowTool: true as const, maxSubagentDepth: 5 },
  };
  const intercomGroup = stageHasIntercomAccess(stageOptions) ? resolveStageGroup(stageOptions) : undefined;
  return intercomGroup ? { ...base, intercomGroup } : base;
}

export function stripWorkflowOnlyOptions(
  options: StageOptions | undefined,
  defaultSessionDir: string | undefined,
  meta: StageExecutionMeta,
): CreateAgentSessionOptions {
  const classification = workflowSessionOptions(meta);
  const orchestrationContext = workflowOrchestrationContext(meta, options);
  if (!options) {
    return defaultSessionDir === undefined
      ? { orchestrationContext }
      : {
          orchestrationContext,
          sessionManager: SessionManager.create(process.cwd(), defaultSessionDir, classification),
        };
  }
  const {
    schema: _schema,
    mcp: _mcp,
    fallbackModels: _fallbackModels,
    fallbackThinkingLevels: _fallbackThinkingLevels,
    context,
    forkFromSessionFile,
    resumeFromSessionFile,
    durableReplayKey: _durableReplayKey,
    durableAccumulatedDurationMs: _durableAccumulatedDurationMs,
    sessionDir,
    gitWorktreeDir: _gitWorktreeDir,
    baseBranch: _baseBranch,
    group: _group,
    ...sessionOptions
  } = options;
  if (sessionOptions.sessionManager === undefined) {
    const cwd = sessionOptions.cwd ?? process.cwd();
    const effectiveSessionDir = sessionDir ?? defaultSessionDir;
    if (resumeFromSessionFile !== undefined) {
      sessionOptions.sessionManager = SessionManager.open(resumeFromSessionFile, effectiveSessionDir, cwd);
    } else if (context === "fork" && forkFromSessionFile !== undefined) {
      sessionOptions.sessionManager = SessionManager.forkFrom(
        forkFromSessionFile,
        cwd,
        effectiveSessionDir,
        classification,
      );
    } else if (effectiveSessionDir !== undefined) {
      sessionOptions.sessionManager = SessionManager.create(cwd, effectiveSessionDir, classification);
    }
  }
  return { ...sessionOptions, orchestrationContext } as CreateAgentSessionOptions;
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
