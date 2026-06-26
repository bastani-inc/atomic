import type { StageSendUserMessageOptions, StageUserMessageContent } from "../../shared/types.js";
import type { StageSessionRuntime } from "./stage-runner-types.js";

function unsupportedContentError(): Error {
  return new Error("atomic-workflows: this stage session adapter does not support non-string sendUserMessage content; provide a runtime sendUserMessage implementation for text/image blocks.");
}

export async function sendStageUserMessage(
  activeSession: StageSessionRuntime,
  content: StageUserMessageContent,
  options?: StageSendUserMessageOptions,
): Promise<void> {
  const deliverAs = activeSession.isStreaming ? options?.deliverAs ?? "followUp" : options?.deliverAs;
  if (activeSession.sendUserMessage !== undefined) {
    await activeSession.sendUserMessage(content, deliverAs === undefined ? undefined : { deliverAs });
    return;
  }
  if (typeof content !== "string") throw unsupportedContentError();
  if (activeSession.isStreaming) {
    if (deliverAs === "steer") await activeSession.steer(content);
    else await activeSession.followUp(content);
    return;
  }
  await activeSession.prompt(content);
}
