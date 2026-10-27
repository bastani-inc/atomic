import type { PostMortemUnavailableReason } from "../runs/foreground/postmortem-stage-chat.js";
import type { StageControlHandle, StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { PooledStageLease } from "../workers/pooled-stage-sources.js";
import type { PostMortemHandleResolution } from "./workflow-attach-pane-types.js";

interface AttachedStageHandleResolution {
	readonly handle?: StageControlHandle;
	readonly postMortemUnavailableReason?: PostMortemUnavailableReason;
	/** Set for a live view of a pooled stage; the view stays open until it is called. */
	readonly release?: () => void;
	/** Set for a live view of a pooled stage: observes it reconnecting to a replacement attempt. */
	readonly onReconnected?: (listener: (redelivered: number) => void) => () => void;
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
	// A registered handle of a stage on a local worker (an SDK caller's registry) proxies a watch
	// it opens only while used, so it has no transcript to mount a chat from. The pooled view
	// opens with the stage's snapshot: the transcript, the reply in flight and running tools.
	if (liveHandle !== undefined && liveHandle.placement?.kind !== "local-worker") return { handle: liveHandle };
	const fallback = () =>
		liveHandle === undefined ? postMortemResolution(resolvePostMortemHandle, runId, stageId) : { handle: liveHandle };
	const pooled = resolvePooledStage?.();
	if (pooled !== undefined)
		return pooled.then(
			(lease) =>
				lease === undefined
					? fallback()
					: {
							handle: lease.handle,
							release: lease.release,
							...(lease.onReconnected === undefined
								? {}
								: {
										onReconnected: (listener: (redelivered: number) => void) =>
											lease.onReconnected!(listener),
									}),
						},
			fallback,
		);
	return fallback();
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
