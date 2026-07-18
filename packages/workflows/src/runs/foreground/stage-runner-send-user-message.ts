import type { StageSendUserMessageOptions, StageUserMessageContent } from "../../shared/types.js";
import type { StageSessionRuntime, StageUserMessageDeliveryAction } from "./stage-runner-types.js";

interface PromptOwnershipObserver {
  arm(): void;
  observe(): void;
  observeStreaming(): void;
  dispose(): void;
}

function createPromptOwnershipObserver(
  session: StageSessionRuntime,
  promptStarted: (() => void) | undefined,
): PromptOwnershipObserver {
  let armed = false;
  let observed = false;
  let unsubscribe: (() => void) | undefined;
  const observe = (): void => {
    if (observed) return;
    observed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    promptStarted?.();
  };
  unsubscribe = session.subscribe((event) => {
    if (armed && event.type === "agent_start") observe();
  });
  return {
    arm() { armed = true; },
    observe,
    observeStreaming() { if (session.isStreaming) observe(); },
    dispose() { unsubscribe?.(); },
  };
}

function unsupportedContentError(): Error {
  return new Error("atomic-workflows: this stage session adapter does not support non-string sendUserMessage content; provide a runtime sendUserMessage implementation for text/image blocks.");
}

export async function sendStageUserMessage(
  activeSession: StageSessionRuntime,
  content: StageUserMessageContent,
  options?: StageSendUserMessageOptions,
  beforeDelivery?: () => void,
  promptStarted?: () => void,
): Promise<StageUserMessageDeliveryAction> {
  const streaming = activeSession.isStreaming;
  const deliverAs = streaming ? options?.deliverAs ?? "followUp" : options?.deliverAs;
  if (activeSession.sendUserMessage !== undefined) {
    beforeDelivery?.();
    let reportedAction: StageUserMessageDeliveryAction | undefined;
    const ownership = streaming ? undefined : createPromptOwnershipObserver(activeSession, promptStarted);
    ownership?.arm();
    try {
      const delivery = activeSession.sendUserMessage(content, {
        ...(deliverAs === undefined ? {} : { deliverAs }),
        __workflowDelivery: {
          promptStarted: ownership?.observe ?? promptStarted,
          delivered(action) { reportedAction = action; },
        },
      });
      ownership?.observeStreaming();
      await delivery;
      return reportedAction ?? (streaming ? deliverAs ?? "followUp" : "prompt");
    } finally {
      ownership?.dispose();
    }
  }
  if (typeof content !== "string") throw unsupportedContentError();
  beforeDelivery?.();
  if (streaming) {
    if (deliverAs === "steer") await activeSession.steer(content);
    else await activeSession.followUp(content);
    return deliverAs ?? "followUp";
  }
  const ownership = createPromptOwnershipObserver(activeSession, promptStarted);
  ownership.arm();
  try {
    const turn = activeSession.prompt(content);
    ownership.observeStreaming();
    await turn;
    return "prompt";
  } finally {
    ownership.dispose();
  }
}
