import type { StageSendUserMessageOptions, StageUserMessageContent } from "../../shared/types.js";
import type { StageMessageAdmission, StageMessageTurn } from "./stage-runner-message-admission.js";
import type { StageSessionRuntime, StageUserMessageDeliveryAction } from "./stage-runner-types.js";

interface PromptOwnershipObserver {
  arm(): void;
  observe(): void;
  observeStreaming(): void;
  settle(action?: StageUserMessageDeliveryAction): void;
  dispose(): void;
  invoke<T>(operation: () => T): T;
}

function createLocalPromptOwnershipObserver(
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
    settle() {},
    dispose() { unsubscribe?.(); },
    invoke: (operation) => operation(),
  };
}

function coordinatedPromptOwnershipObserver(
  turn: StageMessageTurn,
): PromptOwnershipObserver {
  return {
    arm: () => turn.arm(),
    observe: () => turn.observe(),
    observeStreaming: () => turn.observeStreaming(),
    settle: (action) => turn.settle(action),
    dispose() {},
    invoke: (operation) => turn.invoke(operation),
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
  admission?: StageMessageAdmission,
): Promise<StageUserMessageDeliveryAction> {
  const streaming = activeSession.isStreaming || admission?.isOwned(activeSession) === true;
  const deliverAs = streaming ? options?.deliverAs ?? "followUp" : options?.deliverAs;
  if (activeSession.sendUserMessage !== undefined) {
    beforeDelivery?.();
    let reportedAction: StageUserMessageDeliveryAction | undefined;
    const ownership = streaming
      ? undefined
      : admission === undefined
        ? createLocalPromptOwnershipObserver(activeSession, promptStarted)
        : coordinatedPromptOwnershipObserver(admission.startTurn(activeSession, promptStarted ?? (() => {})));
    ownership?.arm();
    try {
      const invokeDelivery = () => activeSession.sendUserMessage!(content, {
        ...(deliverAs === undefined ? {} : { deliverAs }),
        __workflowDelivery: {
          promptStarted: ownership?.observe ?? promptStarted,
          delivered(action) { reportedAction = action; },
        },
      });
      const delivery = ownership === undefined ? invokeDelivery() : ownership.invoke(invokeDelivery);
      ownership?.observeStreaming();
      await delivery;
      const action = reportedAction ?? (streaming ? deliverAs ?? "followUp" : "prompt");
      ownership?.settle(action);
      return action;
    } catch (error) {
      ownership?.settle();
      throw error;
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
  const ownership = admission === undefined
    ? createLocalPromptOwnershipObserver(activeSession, promptStarted)
    : coordinatedPromptOwnershipObserver(admission.startTurn(activeSession, promptStarted ?? (() => {})));
  ownership.arm();
  try {
    const turn = ownership.invoke(() => activeSession.prompt(content));
    ownership.observeStreaming();
    await turn;
    ownership.settle("prompt");
    return "prompt";
  } catch (error) {
    ownership.settle();
    throw error;
  } finally {
    ownership.dispose();
  }
}
