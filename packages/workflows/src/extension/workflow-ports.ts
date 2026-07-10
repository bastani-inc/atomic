import type { WorkflowMcpPort, WorkflowPersistencePort, WorkflowUsageRollupPort } from "../shared/types.js";
import { clearMcpScope, setMcpScope, type PiEventBus, type PiMcpExtensionAPI } from "./mcp.js";
import type { ExtensionAPI } from "./public-types.js";

export function makePersistencePort(
  pi: ExtensionAPI,
  persistRuns: boolean,
): WorkflowPersistencePort | undefined {
  if (!persistRuns) return undefined;
  if (typeof pi.appendEntry !== "function") return undefined;
  const port: WorkflowPersistencePort = {
    appendEntry: (type, payload) => pi.appendEntry!(type, payload),
  };
  if (typeof pi.setLabel === "function") {
    port.setLabel = (entryId, label) => pi.setLabel!(entryId, label);
  }
  if (typeof pi.appendCustomMessageEntry === "function") {
    port.appendCustomMessageEntry = (content, meta) =>
      pi.appendCustomMessageEntry!(content, meta);
  }
  return port;
}

export function makeMcpPort(pi: ExtensionAPI): WorkflowMcpPort | undefined {
  if (typeof pi.events?.emit !== "function") return undefined;
  const piForMcp: PiMcpExtensionAPI = {
    events: { emit: pi.events.emit as PiEventBus["emit"] },
  };
  return {
    setScope(stageId: string, allow: string[] | null, deny: string[] | null) {
      setMcpScope(piForMcp, {
        stageId,
        allow: allow ?? undefined,
        deny: deny ?? undefined,
      });
    },
    clearScope(stageId: string) {
      clearMcpScope(piForMcp, stageId);
    },
  };
}

export function makeUsageRollupPort(pi: ExtensionAPI): WorkflowUsageRollupPort | undefined {
  if (typeof pi.events?.emit !== "function") return undefined;
  return {
    emitStageRollup(_stageId, usage, meta): void {
      const sessionManager = pi.sessionManager as ({ getSessionId?: () => string } | undefined);
      const rootSessionId = pi.getSessionId?.() ?? sessionManager?.getSessionId?.();
      if (!rootSessionId || !meta.sessionId) return;
      pi.events!.emit!("usage:descendant-rollup", {
        rootSessionId,
        childRunId: meta.sessionId,
        kind: "workflow-stage",
        usage,
        settled: meta.settled !== false,
        label: meta.label,
        sessionFile: meta.sessionFile,
      });
    },
  };
}
