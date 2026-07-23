/**
 * Extension-side wiring for the shared post-mortem stage-chat resolver.
 *
 * Builds `PostMortemStageChatDeps` from live extension runtime surfaces
 * (stage adapters, durable per-run cwd, and the default stage session dir after
 * a host restart) so both the TUI attach pane and `workflow send` revive an
 * eligible terminal agent stage through the same detached, single-flight
 * resolver instead of process-local handle presence alone.
 *
 * cross-ref:
 *   - src/runs/foreground/postmortem-stage-chat.ts (resolver)
 *   - src/tui/overlay-adapter.ts (attach pane wiring)
 *   - src/extension/workflow-tool-send.ts (send parity)
 */
import { store } from "../shared/store.js";
import { getDurableBackend } from "../durable/factory.js";
import {
  ensurePostMortemStageHandle,
  type EnsurePostMortemStageHandleResult,
  type PostMortemStageChatDeps,
} from "../runs/foreground/postmortem-stage-chat.js";
import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";

export interface PostMortemResolverDeps {
  readonly adapters: StageAdapters;
  readonly resolveDefaultStageSessionDir: () => string | undefined;
}

/** Persisted original/resolved cwd for a durable run tree, when still available. */
function resolveStageCwd(runId: string): string | undefined {
  try {
    const backend = getDurableBackend();
    const owningHandle = backend.getWorkflow(runId);
    const run = store.snapshot().runs.find((candidate) => candidate.id === runId);
    const rootRunId = run?.rootRunId ?? owningHandle?.rootWorkflowId;
    const cwdHandle = rootRunId === undefined
      ? owningHandle
      : backend.getWorkflow(rootRunId) ?? owningHandle;
    return cwdHandle?.workflowCwd ?? cwdHandle?.invocationCwd ?? undefined;
  } catch {
    return undefined;
  }
}

/** Resolver deps for a specific run, keyed so revived handles use the real run cwd. */
export function postMortemDepsForRun(
  runId: string,
  deps: PostMortemResolverDeps,
): PostMortemStageChatDeps {
  return {
    registry: stageControlRegistry,
    adapters: deps.adapters,
    cwd: resolveStageCwd(runId),
    defaultSessionDir: deps.resolveDefaultStageSessionDir(),
  };
}

/**
 * Build a `(runId, stageId) => result | undefined` resolver for the attach pane.
 * Unknown stages return `undefined`; known but non-revivable stages retain the
 * resolver's explicit reason so the pane can explain why chat is unavailable.
 */
export function createPostMortemHandleResolver(
  deps: PostMortemResolverDeps,
): (runId: string, stageId: string) => EnsurePostMortemStageHandleResult | undefined {
  return (runId, stageId) => {
    const run = store.snapshot().runs.find((candidate) => candidate.id === runId);
    const stage = run?.stages.find((candidate) => candidate.id === stageId);
    if (stage === undefined) return undefined;
    return ensurePostMortemStageHandle(runId, stage, postMortemDepsForRun(runId, deps));
  };
}
