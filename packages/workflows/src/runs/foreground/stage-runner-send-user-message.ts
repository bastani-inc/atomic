import type { StageSendUserMessageOptions, StageUserMessageContent } from "../../shared/types.js";
import type { StageSessionRuntime, StageUserMessageDeliveryAction } from "./stage-runner-types.js";

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
    let unsubscribe: (() => void) | undefined;
    let ownershipObserved = false;
    let deliveryArmed = false;
    const observePromptOwnership = (): void => {
      if (ownershipObserved) return;
      ownershipObserved = true;
      unsubscribe?.();
      unsubscribe = undefined;
      promptStarted?.();
    };
    if (!streaming) {
      unsubscribe = activeSession.subscribe((event) => {
        if (deliveryArmed && event.type === "agent_start") observePromptOwnership();
      });
    }
    deliveryArmed = true;
    try {
      const delivery = activeSession.sendUserMessage(content, {
        ...(deliverAs === undefined ? {} : { deliverAs }),
        __workflowDelivery: {
          promptStarted: observePromptOwnership,
          delivered(action) { reportedAction = action; },
        },
      });
      if (!streaming && activeSession.isStreaming) observePromptOwnership();
      await delivery;
      return reportedAction ?? (streaming ? deliverAs ?? "followUp" : "prompt");
    } finally {
      unsubscribe?.();
    }
  }
  if (typeof content !== "string") throw unsupportedContentError();
  beforeDelivery?.();
  if (streaming) {
    if (deliverAs === "steer") await activeSession.steer(content);
    else await activeSession.followUp(content);
    return deliverAs ?? "followUp";
  }
  const turn = activeSession.prompt(content);
  if (activeSession.isStreaming) promptStarted?.();
  await turn;
  return "prompt";
}
