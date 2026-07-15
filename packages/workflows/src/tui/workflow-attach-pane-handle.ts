import type { PostMortemUnavailableReason } from "../runs/foreground/postmortem-stage-chat.js";
import type {
  StageControlHandle,
  StageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";
import type { PostMortemHandleResolution } from "./workflow-attach-pane-types.js";

interface AttachedStageHandleResolution {
  readonly handle?: StageControlHandle;
  readonly postMortemUnavailableReason?: PostMortemUnavailableReason;
}

export function resolveAttachedStageHandle(
  registry: StageControlRegistry | undefined,
  resolvePostMortemHandle: ((runId: string, stageId: string) => PostMortemHandleResolution) | undefined,
  runId: string,
  stageId: string,
): AttachedStageHandleResolution {
  const liveHandle = registry?.get(runId, stageId);
  if (liveHandle !== undefined) return { handle: liveHandle };
  const postMortem = resolvePostMortemHandle?.(runId, stageId);
  if (postMortem?.ok === true) return { handle: postMortem.handle };
  return postMortem?.ok === false
    ? { postMortemUnavailableReason: postMortem.reason }
    : {};
}
