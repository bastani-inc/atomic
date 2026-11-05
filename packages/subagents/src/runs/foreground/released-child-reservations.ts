import type { IntercomEventBus, RunSyncOptions } from "../../shared/types.js";
import { ReleasedChildError } from "./released-child-errors.js";
import { subagentChildRecordsOf } from "./subagent-child-card-state.js";
import {
	SUBAGENT_CHILD_RELEASED_STATUS,
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

/** What the broker holds for one released child: its name, its other ids, and whether a send wakes its owner. */
export interface ReleasedChildReservation {
	readonly childName: string;
	readonly group?: string;
	readonly aliases: readonly string[];
	/** True: the first send held for it asks the owner to wake it. False: parked (paused or quit), never woken. */
	readonly wake: boolean;
}

/** Failures to keep a released child addressable, counted so they are not lost. */
export const releasedChildHoldFailures: { count: number; last?: ReleasedChildError } = { count: 0 };

function recordHoldFailure(childName: string | undefined, error: Error): void {
	releasedChildHoldFailures.count += 1;
	releasedChildHoldFailures.last = new ReleasedChildError(
		"hold-failed",
		childName === undefined ? {} : { childName },
		{ cause: error },
	);
}

const PARKED_STATUSES: ReadonlySet<string> = new Set(["paused", "quit", SUBAGENT_CHILD_STAGE_PAUSED_STATUS]);

/**
 * What the broker should hold for this child, if it is released or was stopped while it waited: a released child wakes
 * its owner when a send is held for it, a stopped one only holds the send. Undefined for every other child.
 */
export function releasedChildReservation(record: SubagentChildRecord): ReleasedChildReservation | undefined {
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
	return emitIntercomRequest(events, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children }).catch((error: Error) =>
		recordHoldFailure(children.length === 1 ? children[0]?.childName : undefined, error),
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
		(error: Error) => recordHoldFailure(childNames.length === 1 ? childNames[0] : undefined, error),
	);
}

/** Tell the broker this owner is waking the child, so the sends held for it may wait longer. */
export function acknowledgeReleasedChildWake(events: IntercomEventBus, childName: string): Promise<void> {
	return emitIntercomRequest(events, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName }).catch(
		(error: Error) => recordHoldFailure(childName, error),
	);
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
