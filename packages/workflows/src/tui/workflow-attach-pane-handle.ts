import type { PostMortemUnavailableReason } from "../runs/foreground/postmortem-stage-chat.js";
import type { StageControlHandle, StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { PooledStageLease } from "../workers/pooled-stage-sources.js";
import type { PostMortemHandleResolution } from "./workflow-attach-pane-types.js";

interface AttachedStageHandleResolution {
	readonly handle?: StageControlHandle;
	readonly postMortemUnavailableReason?: PostMortemUnavailableReason;
	/** Set for a live view of a pooled stage; the view stays open until it is called. */
	readonly release?: () => void;
}

/**
 * Resolves the chat handle of a stage: a handle registered in this process, then a live
 * view of a stage running on a local worker, then a post-mortem chat of a finished stage.
 */
export function resolveAttachedStageHandle(
	registry: StageControlRegistry | undefined,
	resolvePostMortemHandle: ((runId: string, stageId: string) => PostMortemHandleResolution) | undefined,
	runId: string,
	stageId: string,
	resolvePooledStage?: () => Promise<PooledStageLease | undefined> | undefined,
): AttachedStageHandleResolution | Promise<AttachedStageHandleResolution> {
	const liveHandle = registry?.claim(runId, stageId);
	if (liveHandle !== undefined) return { handle: liveHandle };
	const pooled = resolvePooledStage?.();
	if (pooled !== undefined)
		return pooled.then(
			(lease) =>
				lease === undefined
					? postMortemResolution(resolvePostMortemHandle, runId, stageId)
					: { handle: lease.handle, release: lease.release },
			() => postMortemResolution(resolvePostMortemHandle, runId, stageId),
		);
	return postMortemResolution(resolvePostMortemHandle, runId, stageId);
}

function postMortemResolution(
	resolvePostMortemHandle: ((runId: string, stageId: string) => PostMortemHandleResolution) | undefined,
	runId: string,
	stageId: string,
): AttachedStageHandleResolution | Promise<AttachedStageHandleResolution> {
	const postMortem = resolvePostMortemHandle?.(runId, stageId);
	return postMortem instanceof Promise
		? postMortem.then(attachedResolution, () => ({ postMortemUnavailableReason: "invalid_session" }))
		: attachedResolution(postMortem);
}

function attachedResolution(postMortem: Awaited<PostMortemHandleResolution>): AttachedStageHandleResolution {
	if (postMortem?.ok === true) return { handle: postMortem.handle };
	return postMortem?.ok === false ? { postMortemUnavailableReason: postMortem.reason } : {};
}
