import type { ExtensionContext, SessionStore } from "@bastani/atomic";
import {
	requestSupervisorAuthorization,
	type SupervisorAuthorization,
} from "../../intercom/supervisor-authorization.js";
import type { IntercomEventBus } from "../../shared/types.js";
import { inheritedIntercomGroup } from "../shared/intercom-group.js";
import { readSubagentChildRecords, type SubagentChildRecord, subagentChildOwner } from "./subagent-child-records.js";
import { readPreviousIntercomId, reopenChildSession } from "./subagent-child-session.js";

/**
 * Asks Intercom to have the broker hold sends from any sender to a child this session is restoring, or is about
 * to restore, by the supervisor capability just issued for that child (#3760). The broker holds them until the
 * child registers with that capability, the owner releases the hold, or the owner disconnects.
 */
export const SUBAGENT_RESERVE_RESTORING_CHILD_EVENT = "subagent:reserve-restoring-child";
/** Ends that hold; with `gone` (the reason) held and later senders are told the child did not survive the restart. */
export const SUBAGENT_RELEASE_RESTORING_CHILD_EVENT = "subagent:release-restoring-child";
/**
 * Workflows asks Subagents to keep the background subagents of an interrupted run's stages addressable while the run
 * waits for `/workflow resume` (#3760). The answer is the hold to end when the run is taken over or finishes.
 */
export const WORKFLOW_DORMANT_RUN_SUBAGENT_HOLD_EVENT = "atomic:workflow-dormant-run-subagent-hold";

export interface SubagentReserveRestoringChildRequest {
	readonly capability: string;
	readonly group?: string;
	/** The child's Atomic session id and the Intercom id it had before the restart. */
	readonly aliases: readonly string[];
	/** Only keeps the child addressable until the supervisor that restores it reserves it and takes the hold over. */
	readonly dormant?: boolean;
	completion?: Promise<void>;
}

export interface SubagentReleaseRestoringChildRequest {
	readonly capability: string;
	readonly gone?: string;
	/** Told to the senders held now when the child is coming back elsewhere; later sends are routed normally. */
	readonly refusal?: string;
	completion?: Promise<void>;
}

export interface WorkflowDormantRunSubagentHold {
	/** Settles once every hold is in place. */
	readonly ready: Promise<void>;
	/** End every hold. With `refusal` the senders held now are told that reason, otherwise they are routed normally. */
	release(refusal?: string): Promise<void>;
}

export interface WorkflowDormantRunSubagentHoldRequest {
	readonly runId: string;
	/** The run's invocation group, for children whose record names none. */
	readonly group: string;
	/** Sessions of the run's stages that will be resumed; their `subagent-child` records name the children. */
	readonly stageSessionIds: readonly string[];
	/** The launching session, whose store holds the stage sessions; defaults to the one the extension last saw start. */
	readonly context?: Pick<ExtensionContext, "sessionManager">;
	completion?: Promise<WorkflowDormantRunSubagentHold>;
}

/**
 * The broker's hold on a child's Intercom targets while its owner restores it (#3760): sends from any sender to
 * its name, Atomic session id or pre-restart Intercom id wait for the child instead of failing with `Session not found`.
 */
export interface ChildTargetHold {
	/** The supervisor capability the hold was made under; the relaunched child registers with it. */
	readonly authorization: SupervisorAuthorization;
	/** Also hold sends addressed to `alias`. */
	add(alias: string): Promise<void>;
	/** Reserve everything again under the same capability, as a restoration taking an earlier hold over does. */
	refresh(): Promise<void>;
	/** End the hold; held sends go through ordinary routing, or are told `refusal` when it is given. */
	release(refusal?: string): Promise<void>;
	/** End the hold as gone; held and later senders are told the child did not survive the restart. */
	gone(reason: string): Promise<void>;
}

/** Holding is best effort: without it senders get `Session not found`, as they did before the hold existed. */
function emitIntercomRequest(events: IntercomEventBus, eventName: string, request: { completion?: Promise<void> }) {
	try {
		events.emit(eventName, request);
	} catch {
		return Promise.resolve();
	}
	return (request.completion ?? Promise.resolve()).catch(() => undefined);
}

/**
 * Authorize this session as the child's supervisor and, under that capability, have the broker hold sends to the
 * child's name and Atomic session id. Undefined when the child has no Intercom name or no Intercom extension
 * answers. Rejects when Intercom is present but cannot issue the capability yet.
 */
export async function holdChildTargets(
	events: IntercomEventBus,
	record: SubagentChildRecord,
	group: string | undefined,
	options: { readonly dormant?: boolean } = {},
): Promise<ChildTargetHold | undefined> {
	if (!record.intercomTarget) return undefined;
	const authorization = await requestSupervisorAuthorization(events, record.intercomTarget);
	if (!authorization) return undefined;
	const { capability } = authorization;
	const known = new Set<string>();
	const reserve = (aliases: readonly string[], all = false) => {
		for (const alias of aliases) known.add(alias);
		const request: SubagentReserveRestoringChildRequest = {
			capability,
			aliases: all ? [...known] : aliases,
			...(group ? { group } : {}),
			...(options.dormant === true ? { dormant: true } : {}),
		};
		return emitIntercomRequest(events, SUBAGENT_RESERVE_RESTORING_CHILD_EVENT, request);
	};
	let ended = false;
	const end = (outcome: { gone?: string; refusal?: string } = {}) => {
		if (ended) return Promise.resolve();
		ended = true;
		const request: SubagentReleaseRestoringChildRequest = { capability, ...outcome };
		return emitIntercomRequest(events, SUBAGENT_RELEASE_RESTORING_CHILD_EVENT, request);
	};
	await reserve(record.childSessionId ? [record.childSessionId] : []);
	return {
		authorization,
		add: (alias) => (ended ? Promise.resolve() : reserve([alias])),
		refresh: () => (ended ? Promise.resolve() : reserve([], true)),
		release: (refusal) => end(refusal === undefined ? {} : { refusal }),
		gone: (reason) => end({ gone: reason }),
	};
}

/** Intercom may still be starting when a session has just started; ask again shortly, for about 1.5 s in all. */
const HOLD_RETRY_DELAYS_MS = [0, 25, 50, 100, 200, 400, 800];

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

async function holdChildTargetsWhenReady(
	events: IntercomEventBus,
	record: SubagentChildRecord,
	group: string | undefined,
	options: { readonly dormant?: boolean },
	isWanted: () => boolean,
): Promise<ChildTargetHold | undefined> {
	for (const delay of HOLD_RETRY_DELAYS_MS) {
		await pause(delay);
		if (!isWanted()) return undefined;
		try {
			return await holdChildTargets(events, record, group, options);
		} catch {
			// Intercom has not finished starting this session yet.
		}
	}
	return undefined;
}

/**
 * The child's pre-restart Intercom id sits in the child's own session. Reading it is the slow part of a hold, so it
 * follows the hold: the child's name and Atomic session id are held from the first moment, this id as soon as it is read.
 */
async function holdPreviousIntercomId(
	ctx: Pick<ExtensionContext, "sessionManager">,
	record: SubagentChildRecord,
	hold: ChildTargetHold,
): Promise<void> {
	try {
		const reopened = await reopenChildSession(ctx, record);
		if ("reason" in reopened) return;
		const previousIntercomId = readPreviousIntercomId(reopened.sessionManager);
		if (previousIntercomId) await hold.add(previousIntercomId);
	} catch {
		// The restoration reads it again and holds it then.
	}
}

/**
 * How long a hold taken when a session starts waits for the session's recovery to restore the child. A host that
 * never runs recovery (print mode) restores nothing, so senders then get `Session not found` again.
 */
export const EARLY_CHILD_HOLD_MAX_MS = 60_000;

interface EarlyChildHold {
	readonly hold: Promise<ChildTargetHold | undefined>;
	readonly expire: ReturnType<typeof setTimeout>;
	wanted: boolean;
}

const earlyHolds = new Map<string, EarlyChildHold>();

export function childHoldKey(ownerSessionId: string, childId: string): string {
	return `${ownerSessionId}\u0000${childId}`;
}

function endEarlyHold(key: string, early: EarlyChildHold): void {
	early.wanted = false;
	clearTimeout(early.expire);
	if (earlyHolds.get(key) === early) earlyHolds.delete(key);
	void early.hold.then((hold) => hold?.release()).catch(() => undefined);
}

/**
 * Hold the targets of every background child this session launched that had not settled when it was interrupted
 * (#3760), as soon as Intercom can issue the capability: well before the session's recovery restores them. Sends
 * by their name, Atomic session id or pre-restart Intercom id are then held instead of failing with `Session not
 * found`. The restoration takes each hold over with the same capability, so nothing held is dropped or repeated;
 * a hold nothing takes over ends after `EARLY_CHILD_HOLD_MAX_MS`, when its session ends, or when its owner disconnects.
 * Settles when every hold is in place; it never rejects.
 */
export async function holdRunningSubagentChildren(events: IntercomEventBus, ctx: ExtensionContext): Promise<void> {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const running = [...readSubagentChildRecords(ctx.sessionManager.getEntries(), ownerSessionId).values()].filter(
		(record) => record.state === "running" && record.intercomTarget,
	);
	await Promise.all(
		running.map(async (record) => {
			const key = childHoldKey(ownerSessionId, record.childId);
			if (earlyHolds.has(key)) return;
			const early: EarlyChildHold = {
				wanted: true,
				expire: setTimeout(() => endEarlyHold(key, early), EARLY_CHILD_HOLD_MAX_MS),
				hold: holdChildTargetsWhenReady(
					events,
					record,
					record.intercomGroup ?? inheritedIntercomGroup(ctx),
					{},
					() => early.wanted,
				),
			};
			early.expire.unref?.();
			earlyHolds.set(key, early);
			const hold = await early.hold.catch(() => undefined);
			if (hold === undefined) {
				if (earlyHolds.get(key) === early) endEarlyHold(key, early);
				return;
			}
			if (early.wanted) await holdPreviousIntercomId(ctx, record, hold);
		}),
	).catch(() => undefined);
}

/** The hold taken for this child when its session started, handed to the restoration that now owns it. */
export function takeEarlyChildHold(key: string): Promise<ChildTargetHold | undefined> | undefined {
	const early = earlyHolds.get(key);
	if (early === undefined) return undefined;
	earlyHolds.delete(key);
	clearTimeout(early.expire);
	return early.hold.catch(() => undefined);
}

/** End the holds of the session's children that nothing took over, because its session ended. */
export function releaseEarlyChildHolds(ownerSessionId: string): void {
	const prefix = `${ownerSessionId}\u0000`;
	for (const [key, early] of [...earlyHolds]) if (key.startsWith(prefix)) endEarlyHold(key, early);
}

/**
 * Keep the background subagents of an interrupted workflow run's stages addressable until `/workflow resume`
 * restores them (#3760). The launching session is the only one running while the run is down. For each stage that
 * will be resumed it reads the `subagent-child` records its session holds, read-only from this session's store, and
 * holds the targets of every child that had not settled. A stage whose records cannot be read is skipped. The
 * hold is dormant: the resumed stage's own restoration reserves the same child with its fresh capability and takes
 * it over, with the sends held so far.
 */
export function holdDormantRunSubagentChildren(
	events: IntercomEventBus,
	ctx: Pick<ExtensionContext, "sessionManager">,
	request: Pick<WorkflowDormantRunSubagentHoldRequest, "group" | "stageSessionIds">,
): WorkflowDormantRunSubagentHold {
	const holds: ChildTargetHold[] = [];
	let released = false;
	let refusal: string | undefined;
	const holdStage = async (store: SessionStore, stageSessionId: string): Promise<void> => {
		let records: SubagentChildRecord[];
		try {
			const snapshot = await store.load(stageSessionId);
			records = [...readSubagentChildRecords(snapshot.entries, stageSessionId).values()].filter(
				(record) => record.state === "running" && record.intercomTarget,
			);
		} catch {
			return;
		}
		await Promise.all(
			records.map(async (record) => {
				const hold = await holdChildTargetsWhenReady(
					events,
					record,
					record.intercomGroup ?? request.group,
					{ dormant: true },
					() => !released,
				).catch(() => undefined);
				if (hold === undefined) return;
				if (released) {
					await hold.release(refusal);
					return;
				}
				holds.push(hold);
				await holdPreviousIntercomId(ctx, record, hold);
			}),
		);
	};
	const ready = (async () => {
		let store: SessionStore;
		try {
			store = ctx.sessionManager.getSessionStore();
		} catch {
			return;
		}
		await Promise.all(
			[...new Set(request.stageSessionIds)].map((stageSessionId) => holdStage(store, stageSessionId)),
		);
	})().catch(() => undefined);
	return {
		ready,
		async release(reason) {
			released = true;
			refusal = reason;
			await Promise.all(holds.splice(0).map((hold) => hold.release(reason)));
			await ready;
		},
	};
}
