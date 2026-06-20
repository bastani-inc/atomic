import type { AgentSession } from "@bastani/atomic";
import type {
  StageSessionCreateResult,
  StageSessionRuntime,
} from "./stage-runner-types.js";

type StageSessionExtensionRunner = {
  hasHandlers(eventType: string): boolean;
  emit(event: { readonly type: "session_shutdown"; readonly reason: "quit" }): Promise<unknown>;
};

function stageSessionExtensionRunner(
  current: StageSessionRuntime,
): StageSessionExtensionRunner | undefined {
  const runner = (current as StageSessionRuntime & { extensionRunner?: StageSessionExtensionRunner })
    .extensionRunner;
  if (runner && typeof runner.hasHandlers === "function" && typeof runner.emit === "function") {
    return runner;
  }
  return undefined;
}

export async function disposeStageSession(current: StageSessionRuntime | undefined): Promise<void> {
  if (!current) return;
  const runner = stageSessionExtensionRunner(current);
  if (runner?.hasHandlers("session_shutdown")) {
    try {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
    } catch (error) {
      console.error("atomic-workflows: stage session_shutdown handler failed", error);
    }
  }
  await current.dispose();
}

export function asAgentSession(activeSession: StageSessionRuntime | undefined): AgentSession | undefined {
  if (!activeSession) return undefined;
  const candidate = activeSession as StageSessionRuntime & Partial<Pick<AgentSession, "state" | "sessionManager" | "modelRegistry" | "getContextUsage">>;
  if (
    candidate.state !== undefined &&
    candidate.sessionManager !== undefined &&
    candidate.modelRegistry !== undefined &&
    typeof candidate.getContextUsage === "function"
  ) {
    return candidate as AgentSession;
  }
  return undefined;
}

export function normalizeSessionCreateResult(
  created: StageSessionRuntime | StageSessionCreateResult,
): StageSessionCreateResult {
  if ("session" in created) return created;
  return { session: created };
}
