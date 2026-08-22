import { isStaleExtensionContextError, type ExtensionAPI } from "@bastani/atomic";
import type {
  ChildOrchestratorMetadata,
  SupervisorInterviewRequest,
} from "./intercom-utils.js";
import type { Attachment } from "./types.js";

export const PARENT_ASK_PAUSE_REQUEST_EVENT = "subagent:parent-ask-pause-request";

const PROCESS_PARENT_ASK_CLAIMS = Symbol.for("atomic/subagents/parent-ask-claims@1");

type ProcessParentAskClaimHandler = (payload: unknown) => void;

interface ProcessParentAskClaimRegistry {
  handlers: Set<ProcessParentAskClaimHandler>;
}

function processClaimRegistry(): ProcessParentAskClaimRegistry | undefined {
  const slots = globalThis as typeof globalThis & Record<symbol, ProcessParentAskClaimRegistry | undefined>;
  return slots[PROCESS_PARENT_ASK_CLAIMS];
}

export type ParentAskKind = "decision" | "interview" | "intercom";

export interface ParentAskPauseRequest {
  runId: string;
  index: number;
  agent: string;
  childIntercomTarget: string;
  orchestratorTarget: string;
  kind: ParentAskKind;
  question: string;
  attachments?: Attachment[];
  interview?: SupervisorInterviewRequest;
  resolvedTargetId?: string;
  claimed: boolean;
}

export function requestParentAskPause(
  events: ExtensionAPI["events"] | undefined,
  metadata: ChildOrchestratorMetadata,
  input: Pick<ParentAskPauseRequest, "kind" | "question" | "attachments" | "interview" | "resolvedTargetId">,
): boolean {
  const index = Number(metadata.index);
  if (!events || !Number.isInteger(index) || index < 0 || !metadata.sessionName) return false;
  const request: ParentAskPauseRequest = {
    runId: metadata.runId,
    index,
    agent: metadata.agent,
    childIntercomTarget: metadata.sessionName,
    orchestratorTarget: metadata.orchestratorTarget,
    kind: input.kind,
    question: input.question,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.interview ? { interview: input.interview } : {}),
    ...(input.resolvedTargetId ? { resolvedTargetId: input.resolvedTargetId } : {}),
    claimed: false,
  };
  try {
    events.emit(PARENT_ASK_PAUSE_REQUEST_EVENT, request);
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
  }
  if (!request.claimed) {
    for (const handler of [...(processClaimRegistry()?.handlers ?? [])]) {
      handler(request);
      if (request.claimed) break;
    }
  }
  return request.claimed;
}
