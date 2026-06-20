import { SessionManager, type CreateAgentSessionOptions } from "@bastani/atomic";
import type { StageOptions } from "../../shared/types.js";
import type { AgentSessionConsumer } from "./stage-runner-types.js";

export function stripWorkflowOnlyOptions(
  options: StageOptions | undefined,
  defaultSessionDir?: string,
): CreateAgentSessionOptions {
  if (!options) {
    return defaultSessionDir === undefined
      ? {}
      : { sessionManager: SessionManager.create(process.cwd(), defaultSessionDir) };
  }
  const {
    schema: _schema,
    mcp: _mcp,
    fallbackModels: _fallbackModels,
    fallbackThinkingLevels: _fallbackThinkingLevels,
    context,
    forkFromSessionFile,
    sessionDir,
    gitWorktreeDir: _gitWorktreeDir,
    baseBranch: _baseBranch,
    ...sessionOptions
  } = options;
  if (sessionOptions.sessionManager === undefined) {
    const cwd = sessionOptions.cwd ?? process.cwd();
    const effectiveSessionDir = sessionDir ?? defaultSessionDir;
    if (context === "fork" && forkFromSessionFile !== undefined) {
      sessionOptions.sessionManager = SessionManager.forkFrom(forkFromSessionFile, cwd, effectiveSessionDir);
    } else if (effectiveSessionDir !== undefined) {
      sessionOptions.sessionManager = SessionManager.create(cwd, effectiveSessionDir);
    }
  }
  return sessionOptions as CreateAgentSessionOptions;
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
