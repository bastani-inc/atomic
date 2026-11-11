import { isStaleExtensionContextError } from "@bastani/atomic";
import type { IntercomEventBus, RunSyncOptions } from "../../shared/types.js";
import { subagentChildRecordsOf } from "./subagent-child-card-state.js";
import {
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
} from "./subagent-child-records.js";

/** Subagents asks Intercom to reserve released children by name, in bulk, or to park them (#4326). */
export const SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT = "subagent:reserve-released-children";
/** Subagents tells Intercom that released children ended or were taken over (#4326). */
export const SUBAGENT_DROP_RELEASED_CHILDREN_EVENT = "subagent:drop-released-children";
/** Subagents tells Intercom it is waking a released child, so the sends held for it may wait longer (#4326). */
export const SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT = "subagent:acknowledge-released-child-wake";
/** Intercom tells every extension it is connected to the broker, at start and after each reconnect (#4326). */
export const INTERCOM_CONNECTED_EVENT = "intercom:connected";
/** Subagents tells Intercom how children it launched ended, so a send to one names why it is gone (#4639). */
export const SUBAGENT_MARK_ENDED_CHILDREN_EVENT = "subagent:mark-ended-children";

/** How a child's last run ended, as a send to it with no live session is told (#4639). */
export type EndedChildOutcome = "completed" | "failed" | "stopped" | "cancelled";

/** What the broker answers for one child that ended: its name, its other ids, why, and the id `resume` takes. */
export interface EndedChildMark {
	readonly childName: string;
	readonly group?: string;
	readonly aliases: readonly string[];
	readonly outcome: EndedChildOutcome;
	readonly childId: string;
}

/** What the broker holds for one released child: its name, its other ids, and whether a send wakes its owner. */
export interface ReleasedChildReservation {
	readonly childName: string;
	readonly group?: string;
	readonly aliases: readonly string[];
	/** True: the first send held for it asks the owner to wake it. False: parked (paused or quit), never woken. */
	readonly wake: boolean;
}

/** Deliver a reservation failure to the launching session, without retaining a registry per child. */
export const SUBAGENT_HOLD_FAILURE_EVENT = "subagent:released-child-hold-failure";
export const SUBAGENT_HOLD_RECOVERED_EVENT = "subagent:released-child-hold-recovered";

export interface ReleasedChildHoldFailure {
	readonly childNames: readonly string[];
	readonly error: Error;
	handled?: boolean;
}

function closedOwnerSession(error: Error): boolean {
	return (error as Error & { code?: string }).code === "SessionClosed" || isStaleExtensionContextError(error);
}

/** Tell the launching session; false when it has closed, so there is nobody left to tell. */
function emitToOwner(events: IntercomEventBus, eventName: string, payload: object): boolean {
	try {
		events.emit(eventName, payload);
		return true;
	} catch (error) {
		if (closedOwnerSession(error as Error)) return false;
		throw error;
	}
}

function recordHoldFailure(events: IntercomEventBus, childNames: readonly string[], error: Error): void {
	if (closedOwnerSession(error)) return;
	const failure: ReleasedChildHoldFailure = { childNames, error };
	if (!emitToOwner(events, SUBAGENT_HOLD_FAILURE_EVENT, failure)) return;
	if (!failure.handled) console.error("Released subagent reservation failed (hold-failed); no owner is listening");
}

const PARKED_STATUSES: ReadonlySet<string> = new Set(["paused", "quit", SUBAGENT_CHILD_STAGE_PAUSED_STATUS]);

/** The parts of a child record that decide what the broker holds or answers for it. */
type ChildReservationFacts = Pick<
	SubagentChildRecord,
	| "intercomTarget"
	| "intercomGroup"
	| "state"
	| "terminalStatus"
	| "waitingOn"
	| "childSessionId"
	| "releasedIntercomId"
>;

/**
 * What the broker should hold for this child, if it is released or was stopped while it waited: a released child wakes
 * its owner when a send is held for it, a stopped one only holds the send. Undefined for every other child.
 */
export function releasedChildReservation(record: ChildReservationFacts): ReleasedChildReservation | undefined {
	if (record.intercomTarget === undefined || record.state !== "terminal") return undefined;
	const released = record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS;
	const parked = (record.waitingOn?.length ?? 0) > 0 && PARKED_STATUSES.has(record.terminalStatus ?? "");
	if (!released && !parked) return undefined;
	return {
		childName: record.intercomTarget,
		...(record.intercomGroup === undefined ? {} : { group: record.intercomGroup }),
		aliases: [record.childSessionId, record.releasedIntercomId].filter((id): id is string => id !== undefined),
		wake: released,
	};
}

const ENDED_OUTCOMES = new Map<string | undefined, EndedChildOutcome>([
	["ok", "completed"],
	["error", "failed"],
	["interrupted", "stopped"],
	["paused", "stopped"],
	["quit", "stopped"],
	[SUBAGENT_CHILD_STAGE_PAUSED_STATUS, "stopped"],
	["killed", "cancelled"],
	[SUBAGENT_CHILD_STAGE_CLOSED_STATUS, "cancelled"],
]);

/**
 * What the broker should answer for this child once its session is gone, if its last run ended: why, and the id to
 * resume it by. Undefined for a running child, one the broker holds sends for (released or parked) and one that did
 * not survive a restart, which the broker already answers for.
 */
export function endedChildMark(
	record: ChildReservationFacts & Pick<SubagentChildRecord, "childId">,
): EndedChildMark | undefined {
	if (record.intercomTarget === undefined || record.state !== "terminal") return undefined;
	const outcome = ENDED_OUTCOMES.get(record.terminalStatus);
	if (outcome === undefined || releasedChildReservation(record) !== undefined) return undefined;
	return {
		childName: record.intercomTarget,
		...(record.intercomGroup === undefined ? {} : { group: record.intercomGroup }),
		aliases: [record.childSessionId, record.releasedIntercomId].filter((id): id is string => id !== undefined),
		outcome,
		childId: record.childId,
	};
}

async function emitIntercomRequest(events: IntercomEventBus, eventName: string, request: object): Promise<void> {
	events.emit(eventName, request);
	await ((request as { completion?: Promise<void> }).completion ?? Promise.resolve());
}

/** Reserve released children at the broker, or park them; one call whatever their number. Idempotent per child. */
export function reserveReleasedChildren(
	events: IntercomEventBus,
	children: readonly ReleasedChildReservation[],
): Promise<void> {
	if (children.length === 0) return Promise.resolve();
	return emitIntercomRequest(events, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children }).then(
		() => {
			emitToOwner(events, SUBAGENT_HOLD_RECOVERED_EVENT, {});
		},
		(error: Error) =>
			recordHoldFailure(
				events,
				children.map((child) => child.childName),
				error,
			),
	);
}

/** End the broker's reservation of children that ended or were taken over. */
export function dropReleasedChildren(
	events: IntercomEventBus,
	childNames: readonly string[],
	outcome: { readonly gone?: string; readonly refusal?: string } = {},
): Promise<void> {
	if (childNames.length === 0) return Promise.resolve();
	return emitIntercomRequest(events, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames, ...outcome }).catch(
		(error: Error) => recordHoldFailure(events, childNames, error),
	);
}

/** Tell the broker this owner is waking the child, so the sends held for it may wait longer. */
export function acknowledgeReleasedChildWake(events: IntercomEventBus, childName: string): Promise<void> {
	return emitIntercomRequest(events, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName }).catch(
		(error: Error) => recordHoldFailure(events, [childName], error),
	);
}

/**
 * Tell the broker how these children ended. A report that fails leaves sends to them answered as not found; the
 * failure is logged once, unless the launching session has closed and nobody is left to send to them.
 */
export function markEndedChildren(events: IntercomEventBus, children: readonly EndedChildMark[]): Promise<void> {
	if (children.length === 0) return Promise.resolve();
	return emitIntercomRequest(events, SUBAGENT_MARK_ENDED_CHILDREN_EVENT, { children }).catch((error: Error) => {
		if (closedOwnerSession(error)) return;
		console.error(
			`Subagent end report failed (${children.map((child) => child.childName).join(", ")}); sends to them answer Session not found: ${error.message}`,
		);
	});
}

/** Report every ended child of `ownerSessionId` at once, as after a restart or a reconnect. */
export function markEndedChildrenOf(events: IntercomEventBus, ownerSessionId: string): Promise<void> {
	const marks: EndedChildMark[] = [];
	for (const record of subagentChildRecordsOf(ownerSessionId)) {
		const mark = endedChildMark(record);
		if (mark !== undefined) marks.push(mark);
	}
	return markEndedChildren(events, marks);
}

/** Reserve every released or parked child of `ownerSessionId` at once, as after a restart or a reconnect. */
export function reserveReleasedChildrenOf(events: IntercomEventBus, ownerSessionId: string): Promise<void> {
	const reservations: ReleasedChildReservation[] = [];
	for (const record of subagentChildRecordsOf(ownerSessionId)) {
		const reservation = releasedChildReservation(record);
		if (reservation !== undefined) reservations.push(reservation);
	}
	return reserveReleasedChildren(events, reservations);
}

/**
 * Keep a released child addressable while it holds no session: the broker holds sends and asks to its name and ids,
 * and tells this owner to wake it. The reservation lives in the broker; nothing for it stays in this process.
 */
export function reserveReleasedChildTargets(
	options: Pick<RunSyncOptions, "intercomEvents" | "intercomSessionName" | "intercomGroup">,
	childSessionId: string | undefined,
	intercomId: string | undefined,
	wake = true,
): Promise<void> {
	const events = options.intercomEvents;
	const childName = options.intercomSessionName;
	if (events === undefined || childName === undefined) return Promise.resolve();
	return reserveReleasedChildren(events, [
		{
			childName,
			...(options.intercomGroup === undefined ? {} : { group: options.intercomGroup }),
			aliases: [childSessionId, intercomId].filter((id): id is string => id !== undefined),
			wake,
		},
	]);
}
