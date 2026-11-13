import { subagentChildRecordsOf } from "./subagent-child-card-state.js";
import {
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	subagentChildRecordsAppended,
} from "./subagent-child-records.js";

/**
 * Intercom asks which children this session launched can still take a message, for a `subagents:` send (#4752).
 * `completion` resolves to them, each addressed by its Intercom name.
 */
export const SUBAGENT_LIST_INTERCOM_CHILDREN_EVENT = "subagent:list-intercom-children";

export interface SubagentIntercomChild {
	readonly childName: string;
	readonly childId: string;
	readonly runId: string;
}

export interface SubagentListIntercomChildrenRequest {
	readonly ownerSessionId: string;
	/** Only children of this run; every run when absent. */
	readonly runId?: string;
	completion?: Promise<readonly SubagentIntercomChild[]>;
}

/** Stopped children a send to still reaches: a released one is woken for it, a paused one gets it on resume. */
const ADDRESSABLE_STOPPED_STATUSES: ReadonlySet<string | undefined> = new Set([
	SUBAGENT_CHILD_RELEASED_STATUS,
	"paused",
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
]);

function addressable(record: SubagentChildRecord): boolean {
	return record.state === "running" || ADDRESSABLE_STOPPED_STATUSES.has(record.terminalStatus);
}

/**
 * The children of `ownerSessionId` that are running, released or paused, in launch order: foreground and background
 * alike, since both keep a child record.
 */
export async function listSubagentIntercomChildren(
	ownerSessionId: string,
	runId?: string,
): Promise<SubagentIntercomChild[]> {
	await subagentChildRecordsAppended(ownerSessionId);
	return subagentChildRecordsOf(ownerSessionId)
		.filter((record) => (runId === undefined || record.runId === runId) && addressable(record))
		.flatMap((record) =>
			record.intercomTarget === undefined
				? []
				: [{ childName: record.intercomTarget, childId: record.childId, runId: record.runId }],
		);
}

/** Answer Intercom's requests for this process's children while `isCurrent` holds; returns the unsubscribe. */
export function answerIntercomChildrenRequests(
	events: { on(eventName: string, handler: (payload: unknown) => void): () => void },
	isCurrent: () => boolean,
): () => void {
	return events.on(SUBAGENT_LIST_INTERCOM_CHILDREN_EVENT, (payload) => {
		const request = payload as Partial<SubagentListIntercomChildrenRequest> | null;
		if (!isCurrent() || !request || request.completion || typeof request.ownerSessionId !== "string") return;
		const runId = typeof request.runId === "string" ? request.runId : undefined;
		request.completion = listSubagentIntercomChildren(request.ownerSessionId, runId);
	});
}
