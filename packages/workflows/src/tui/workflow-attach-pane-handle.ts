import type { PostMortemUnavailableReason } from "../runs/foreground/postmortem-stage-chat.js";
import type { StageControlHandle, StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
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
): AttachedStageHandleResolution | Promise<AttachedStageHandleResolution> {
	const liveHandle = registry?.claim(runId, stageId);
	if (liveHandle !== undefined) return { handle: liveHandle };
	const postMortem = resolvePostMortemHandle?.(runId, stageId);
	return postMortem instanceof Promise
		? postMortem.then(attachedResolution, () => ({ postMortemUnavailableReason: "invalid_session" }))
		: attachedResolution(postMortem);
}

function attachedResolution(postMortem: Awaited<PostMortemHandleResolution>): AttachedStageHandleResolution {
	if (postMortem?.ok === true) return { handle: postMortem.handle };
	return postMortem?.ok === false ? { postMortemUnavailableReason: postMortem.reason } : {};
}
