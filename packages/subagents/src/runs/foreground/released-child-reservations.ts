import { isStaleExtensionContextError } from "@bastani/atomic";
import type { ConfirmedRelease, ReleaseObservation } from "../../../../intercom/broker/released-child-receipts.js";
import type { IntercomEventBus, RunSyncOptions } from "../../shared/types.js";
import { type HoldNoticeEpisode, holdNoticeEpisode, newerRelease, observeRelease } from "./released-child-receipts.js";
import { childReleaseKey, reservationRecordLookup, subagentChildRecordsOf } from "./subagent-child-card-state.js";
import { subagentChildRequestEvents } from "./subagent-child-owner.js";
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
	/**
	 * The task of the run that released or parked the child, which this reservation is for. Kept in this process, never
	 * sent: a failure of it is not reported once the child's latest record is another run's (#5551).
	 */
	readonly taskId?: string;
}

/** Deliver a reservation failure to the launching session, without retaining a registry per child. */
export const SUBAGENT_HOLD_FAILURE_EVENT = "subagent:released-child-hold-failure";
/** The broker took the reservations of these children: payload {@link ReleasedChildHoldRecovery}. */
export const SUBAGENT_HOLD_RECOVERED_EVENT = "subagent:released-child-hold-recovered";

export interface ReleasedChildHoldFailure {
	/** The children this failure leaves without a hold: exactly those the broker refused or never took. */
	readonly childNames: readonly string[];
	/** The task each child's request was made for, by child name, when the request knew it (#5551). */
	readonly taskIds?: ReadonlyMap<string, string>;
	/** Shared by all frames of this request, not retained after it settles. */
	readonly recordOf?: ReturnType<typeof reservationRecordLookup>;
	readonly error: Error;
	handled?: boolean;
}

export const pendingHoldNoticeEpisodes = new WeakMap<ReleasedChildHoldFailure, HoldNoticeEpisode>();

export interface ReleasedChildHoldRecovery {
	readonly childNames: readonly string[];
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

function recordHoldFailure(
	events: IntercomEventBus,
	childNames: readonly string[],
	error: Error,
	taskIds?: ReadonlyMap<string, string>,
	recordOf?: ReleasedChildHoldFailure["recordOf"],
	episode?: HoldNoticeEpisode,
): void {
	if (closedOwnerSession(error)) return;
	const failure: ReleasedChildHoldFailure = {
		childNames,
		...(taskIds === undefined || taskIds.size === 0 ? {} : { taskIds }),
		...(recordOf === undefined ? {} : { recordOf }),
		error,
	};
	if (episode) pendingHoldNoticeEpisodes.set(failure, episode);
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
	| "taskId"
>;

/** Whether the broker should hold sends for this child: it is released, or was stopped while it waited (#5551). */
export function isHeldChildRecord(
	record: Pick<ChildReservationFacts, "state" | "terminalStatus" | "waitingOn">,
): boolean {
	if (record.state !== "terminal") return false;
	if (record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS) return true;
	return (record.waitingOn?.length ?? 0) > 0 && PARKED_STATUSES.has(record.terminalStatus ?? "");
}

/**
 * What the broker should hold for this child, if it is released or was stopped while it waited: a released child wakes
 * its owner when a send is held for it, a stopped one only holds the send. Undefined for every other child.
 */
export function releasedChildReservation(record: ChildReservationFacts): ReleasedChildReservation | undefined {
	if (record.intercomTarget === undefined || !isHeldChildRecord(record)) return undefined;
	const released = record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS;
	return {
		childName: record.intercomTarget,
		...(record.intercomGroup === undefined ? {} : { group: record.intercomGroup }),
		aliases: [record.childSessionId, record.releasedIntercomId].filter((id): id is string => id !== undefined),
		wake: released,
		...(record.taskId === undefined ? {} : { taskId: record.taskId }),
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

/** The broker takes at most this many children per frame, and refuses a frame whole. */
const RESERVATION_FRAME_MAX = 500;

/**
 * The latest reservation request made for each child on each owner's bus, while it is in flight: a request that a later
 * one for the same child overtook leaves that child to the later one (#5551). Holds only children with a request in flight.
 */
const latestReservations = new WeakMap<IntercomEventBus, Map<string, object>>();
// Keep a release key live only for its pending confirmation or reconnect request. The record index only borrows it.
const interestedReleases = new WeakMap<ReleasedChildReservation, object>();
interface ReservationOwner {
	readonly sessionId: string;
	readonly repairs: WeakMap<object, ConfirmedRelease>;
	readonly notices: Map<string, HoldNoticeEpisode>;
}
const reservationOwners = new WeakMap<IntercomEventBus, ReservationOwner>();

/** An in-flight retry must not use a release, or an owner session, that ended while the broker answered. */
export function bindReleasedChildReservationOwner(
	events: IntercomEventBus,
	sessionId: string,
	notices: Map<string, HoldNoticeEpisode>,
): () => void {
	const owner: ReservationOwner = { sessionId, repairs: new WeakMap(), notices };
	reservationOwners.set(events, owner);
	return () => {
		if (reservationOwners.get(events) === owner) reservationOwners.delete(events);
	};
}

/** The child of `frame` the broker refused the whole frame for, when the refusal names one of them. */
function refusedChildOf(
	error: Error,
	frame: readonly ReleasedChildReservation[],
): ReleasedChildReservation | undefined {
	const refusal = error as Error & { readonly childName?: unknown };
	if (error.name !== "ReleasedChildReservationError" || typeof refusal.childName !== "string") return undefined;
	const childName = refusal.childName;
	return frame.find((child) => child.childName === childName || child.childName.trim() === childName);
}

/**
 * Reserve one frame. A child the broker refused is reported alone, and the others, which a refused frame leaves
 * unreserved, are asked for again without it: each try leaves one out, so this ends. A failure that names no child of
 * the frame, as a lost connection, is reported for the whole frame. A child a later request overtook is left to it.
 */
async function reserveFrame(
	events: IntercomEventBus,
	frame: readonly ReleasedChildReservation[],
	current: (child: ReleasedChildReservation) => boolean,
	recordOf: ReleasedChildHoldFailure["recordOf"],
): Promise<void> {
	let asked = frame;
	while (asked.length > 0) {
		let error: Error | undefined;
		const owner = reservationOwners.get(events);
		let receipts: Map<ReleasedChildReservation, ReleaseObservation> | undefined;
		try {
			// Associate the serialized item (not its name or the outer promise) with a native receipt.
			const children = asked.map((item) => {
				const { taskId: _taskId, ...child } = item;
				if (owner && interestedReleases.has(item)) {
					receipts ??= new Map();
					receipts.set(item, observeRelease(child, child.childName));
				}
				return child;
			});
			await emitIntercomRequest(events, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children });
		} catch (caught) {
			error = caught as Error;
		}
		if (error === undefined) {
			const recovered = asked.filter(current);
			if (recovered.length > 0) {
				if (owner && receipts)
					for (const item of recovered) {
						const receipt = receipts.get(item)?.repair;
						const key = interestedReleases.get(item);
						if (receipt && key) owner.repairs.set(key, receipt);
					}
				const recovery: ReleasedChildHoldRecovery = { childNames: recovered.map((child) => child.childName) };
				emitToOwner(events, SUBAGENT_HOLD_RECOVERED_EVENT, recovery);
			}
			return;
		}
		const refused = refusedChildOf(error, asked);
		const failed = (refused === undefined ? asked : [refused]).filter(current);
		if (failed.length > 0) {
			const taskIds = new Map<string, string>();
			for (const child of failed) if (child.taskId !== undefined) taskIds.set(child.childName, child.taskId);
			recordHoldFailure(
				events,
				failed.map((child) => child.childName),
				error,
				taskIds,
				recordOf,
			);
		}
		if (refused === undefined) return;
		asked = asked.filter((child) => {
			if (child === refused || !current(child)) return false;
			if (recordOf === undefined) return true;
			const latest = recordOf(child.childName);
			return (
				latest !== undefined &&
				latest.taskId === child.taskId &&
				isHeldChildRecord(latest) &&
				(latest.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS) === child.wake
			);
		});
	}
}

/**
 * Reserve released children at the broker, or park them, in requests of one broker frame each, whatever their number.
 * Idempotent per child. A failure is reported for exactly the children it leaves without a hold, with the task each
 * was reserved for, so a child the broker took, or one a later request asked for again, is never named (#5551).
 */
export async function reserveReleasedChildren(
	ownerEvents: IntercomEventBus,
	children: readonly ReleasedChildReservation[],
): Promise<void> {
	if (children.length === 0) return;
	// Parking and reconnects share the same in-flight requests on this generation's bus.
	const events = subagentChildRequestEvents(ownerEvents);
	if (!events) return;
	const inFlight = latestReservations.get(events) ?? new Map<string, object>();
	latestReservations.set(events, inFlight);
	const request = {};
	for (const child of children) inFlight.set(child.childName, request);
	const owner = reservationOwners.get(events);
	const current = (child: ReleasedChildReservation) =>
		inFlight.get(child.childName) === request && reservationOwners.get(events) === owner;
	const recordOf = owner === undefined ? undefined : reservationRecordLookup(owner.sessionId);
	try {
		const frames: Promise<void>[] = [];
		for (let start = 0; start < children.length; start += RESERVATION_FRAME_MAX)
			frames.push(reserveFrame(events, children.slice(start, start + RESERVATION_FRAME_MAX), current, recordOf));
		// Every frame settles before this call stops answering for its children.
		const rejected = (await Promise.allSettled(frames)).find((outcome) => outcome.status === "rejected");
		if (rejected !== undefined) throw rejected.reason;
	} finally {
		for (const child of children) if (inFlight.get(child.childName) === request) inFlight.delete(child.childName);
	}
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

/**
 * Tell the broker this owner is waking the child, so the sends held for it may wait longer. `taskId`: the run whose
 * release this wake ends, so a refusal is not reported once the child's latest record is another run's.
 */
export function acknowledgeReleasedChildWake(
	ownerEvents: IntercomEventBus,
	childName: string,
	taskId?: string,
	childId?: string,
): Promise<void> {
	const events = subagentChildRequestEvents(ownerEvents);
	if (!events) return Promise.resolve();
	const request = { childName };
	const owner = reservationOwners.get(events);
	const release =
		owner && childId !== undefined && taskId !== undefined
			? childReleaseKey(childId, owner.sessionId, childName, taskId, true)
			: undefined;
	const observation = release ? observeRelease(request, childName) : undefined;
	return emitIntercomRequest(events, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, request).catch((error: Error) => {
		const report = (episode?: HoldNoticeEpisode) =>
			recordHoldFailure(
				events,
				[childName],
				error,
				taskId === undefined ? undefined : new Map([[childName, taskId]]),
				undefined,
				episode,
			);
		const refusal = observation?.refusal;
		if (
			refusal &&
			refusal.error.deref() === error &&
			owner &&
			release &&
			reservationOwners.get(events) === owner &&
			childId !== undefined &&
			taskId !== undefined &&
			childReleaseKey(childId, owner.sessionId, childName, taskId, false) === release
		) {
			const repair = owner.repairs.get(release);
			if (repair && newerRelease(refusal.stamp, repair.stamp)) {
				const verify = repair.verify.deref();
				if (verify) {
					// Decide which episode this refusal belonged to now, not a network round trip later.
					const episode = holdNoticeEpisode(owner.notices, childName, taskId);
					episode.checks++;
					const finish = (current: boolean) => {
						try {
							if (!current && reservationOwners.get(events) === owner) report(episode);
						} finally {
							episode.checks--;
							if (!episode.checks && !episode.told && owner.notices.get(childName) === episode)
								owner.notices.delete(childName);
						}
					};
					return verify(childName, repair.stamp).then(finish, () => finish(false));
				}
			}
		}
		report();
	});
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
		if (reservation === undefined) continue;
		if (reservation.wake && reservation.taskId !== undefined) {
			const key = childReleaseKey(record.childId, ownerSessionId, reservation.childName, reservation.taskId, true);
			if (key) interestedReleases.set(reservation, key);
		}
		reservations.push(reservation);
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
	taskId?: string,
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
			...(taskId === undefined ? {} : { taskId }),
		},
	]);
}
