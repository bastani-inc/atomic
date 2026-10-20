import { availableStoreDurableBackend } from "../../durable/store-backend.js";
import type { PiEventContext } from "../../extension/public-types.js";
import type { Store } from "../../shared/store.js";

/**
 * Workflows → subagents: a run ended for good, so every subagent its stages launched ends with it (#3784). A run that
 * ends without a live stage generation, such as a run dormant after a restart, never closes a stage for good, so the
 * subagents extension reads the children from the stages' own sessions instead.
 */
const RUN_ENDED_STAGE_SUBAGENTS_EVENT = "atomic:workflow-run-ended-stage-subagents";

export interface RunEndedStageSubagentsEvents {
	emit(event: string, payload: Record<string, unknown>): void;
}

/** The sessions of every stage of the run and of the child runs it owns, as far as this process knows them. */
function stageSessionIds(store: Store, runId: string): string[] {
	const backend = availableStoreDurableBackend(store, runId);
	return store
		.runs()
		.filter((run) => run.id === runId || run.rootRunId === runId)
		.flatMap((run) =>
			run.stages.flatMap((stage) => {
				let sessionId = stage.sessionId;
				if (sessionId === undefined && stage.replayKey !== undefined) {
					try {
						sessionId = backend?.getStageSession(run.id, stage.replayKey)?.sessionId;
					} catch {
						// Its journal is unavailable: the stage's session is not known here.
					}
				}
				return sessionId === undefined ? [] : [sessionId];
			}),
		);
}

/** Ask the subagents extension to end the subagents of a run that ended for good; settles once they are recorded. */
export async function endRunStageSubagents(
	events: RunEndedStageSubagentsEvents | undefined,
	store: Store,
	runId: string,
	context?: PiEventContext,
): Promise<void> {
	if (events === undefined) return;
	const sessionIds = [...new Set(stageSessionIds(store, runId))];
	if (sessionIds.length === 0) return;
	const request: Record<string, unknown> & { completion?: Promise<void> } = {
		runId,
		stageSessionIds: sessionIds,
		...(context === undefined ? {} : { context }),
	};
	try {
		events.emit(RUN_ENDED_STAGE_SUBAGENTS_EVENT, request);
	} catch {
		return;
	}
	await request.completion?.catch(() => undefined);
}
