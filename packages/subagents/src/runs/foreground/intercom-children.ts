import { SUBAGENT_OWNER_GENERATION } from "./owner-generation.js";
import { SUBAGENT_QUESTION_TOOLS } from "./released-child-questions.js";
import {
	type SubagentChildStanding,
	subagentChildRecordsOf,
	subagentChildStandingsOf,
} from "./subagent-child-card-state.js";
import {
	SUBAGENT_CHILD_RELEASED_STATUS,
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

/**
 * #6168: Intercom asks which of the asks this session holds unanswered came from an attempt of one of its children that
 * is over, so no reply can reach it. `completion` resolves to their message ids.
 */
export const SUBAGENT_FINISHED_ASKS_EVENT = "subagent:finished-asks";

/** One ask a session holds unanswered, as Intercom saw it arrive. */
export interface SubagentHeldAsk {
	readonly messageId: string;
	readonly from: { readonly id: string; readonly name?: string };
	readonly source?: { readonly subagentRunId: string; readonly subagentIndex?: number };
	/** When this session received it, by its own clock. */
	readonly receivedAt: number;
}

export interface SubagentFinishedAsksRequest {
	readonly ownerSessionId: string;
	readonly asks: readonly SubagentHeldAsk[];
	completion?: Promise<readonly string[]>;
}

/** Stopped children whose messages are kept for them until they continue: an answer can still reach them. */
const HELD_FOR_STATUSES: ReadonlySet<string | undefined> = new Set([SUBAGENT_CHILD_RELEASED_STATUS, "paused", "quit"]);

/**
 * The child of this session that sent `ask`: the Intercom name it registered, and the run and index its subagent
 * messages carry. A name alone is no witness (a later session can take a finished child's name), so an ask without
 * them is never a child's.
 */
function askingChild(
	children: readonly (SubagentChildRecord | SubagentChildStanding)[],
	ask: SubagentHeldAsk,
): SubagentChildRecord | SubagentChildStanding | undefined {
	const name = ask.from.name?.trim().toLowerCase();
	const source = ask.source;
	if (!name || source?.subagentIndex === undefined) return undefined;
	return children.find(
		(child) =>
			child.intercomTarget?.trim().toLowerCase() === name &&
			source.subagentRunId === child.runId &&
			source.subagentIndex === child.index,
	);
}

/**
 * Whether the attempt of `child` that asked `ask` is over, so no reply can reach it: the child ended, or it was
 * released waiting on other calls, or it ran in an earlier owner process, whose attempts ended with it. A child released
 * waiting on that question, one paused or quit (its messages are kept for it), one this process still runs a question
 * for, and one running in this process keep the ask: a running attempt is not told apart from the one that asked.
 */
function askOutlivedItsAttempt(child: SubagentChildRecord | SubagentChildStanding, ask: SubagentHeldAsk): boolean {
	const record: Partial<SubagentChildRecord> = child;
	const runningHere = (record.stillRunning ?? []).some(
		(call) => call.ownerGeneration === SUBAGENT_OWNER_GENERATION && SUBAGENT_QUESTION_TOOLS.has(call.toolName),
	);
	if (runningHere) return false;
	if (child.state === "running")
		return record.ownerGeneration !== undefined && record.ownerGeneration !== SUBAGENT_OWNER_GENERATION;
	if (child.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS) {
		if (record.waitingOn === undefined) return false;
		return !record.waitingOn.some(
			(call) =>
				call.replyWait?.questionId === ask.messageId ||
				(call.replyWait === undefined && SUBAGENT_QUESTION_TOOLS.has(call.toolName)),
		);
	}
	return !HELD_FOR_STATUSES.has(child.terminalStatus);
}

/** The ids of `asks` that came from an attempt of a child of `ownerSessionId` that is over. */
export async function finishedSubagentAsks(
	ownerSessionId: string,
	asks: readonly SubagentHeldAsk[],
): Promise<string[]> {
	if (asks.length === 0) return [];
	await subagentChildRecordsAppended(ownerSessionId);
	const children = subagentChildStandingsOf(ownerSessionId);
	return asks.flatMap((ask) => {
		const child = askingChild(children, ask);
		return child !== undefined && askOutlivedItsAttempt(child, ask) ? [ask.messageId] : [];
	});
}

function isHeldAsk(value: unknown): value is SubagentHeldAsk {
	const ask = value as Partial<SubagentHeldAsk> | null | undefined;
	return (
		typeof ask?.messageId === "string" &&
		typeof ask.receivedAt === "number" &&
		typeof ask.from?.id === "string" &&
		(ask.from.name === undefined || typeof ask.from.name === "string") &&
		(ask.source === undefined || typeof ask.source.subagentRunId === "string")
	);
}

/** Answer Intercom's finished-ask requests while `isCurrent` holds; returns the unsubscribe. */
export function answerFinishedAskRequests(
	events: { on(eventName: string, handler: (payload: unknown) => void): () => void },
	isCurrent: () => boolean,
): () => void {
	return events.on(SUBAGENT_FINISHED_ASKS_EVENT, (payload) => {
		const request = payload as Partial<SubagentFinishedAsksRequest> | null;
		if (!isCurrent() || !request || request.completion || typeof request.ownerSessionId !== "string") return;
		if (!Array.isArray(request.asks) || !request.asks.every(isHeldAsk)) return;
		request.completion = finishedSubagentAsks(request.ownerSessionId, request.asks);
	});
}
