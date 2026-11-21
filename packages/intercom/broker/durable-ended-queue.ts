import type net from "node:net";
import { Socket } from "node:net";
import type { SessionInfo } from "../types.js";
import {
	type DepartedChildrenJournal,
	departureKey,
	type JournalDeparture,
	type RestoredEndedQueue,
	type WakeSender,
} from "./departed-children.js";
import { type EndedChildMessages, type EndedChildWakeBudget, markMaybeDelivered } from "./ended-child-wakes.js";
import type { HeldSend } from "./restoring-recipients.js";
import { type BrokerConnectedSession, detachSend, type SendClientMessage, senderAtReceipt } from "./send-handler.js";
import { intercomMessageBytes } from "../message-size.js";
import type { Message } from "../types.js";
import type { SubagentEndedOutcome } from "./recipient-gone-errors.js";
import type {
	EndedChildQueueStore,
	EndedQueueCounted,
	EndedQueueEntry,
	EndedQueueRow,
	EndedWakeBudgetEvent,
} from "./sql-ended-child-queue-store.js";
import { PRESENCE_REGISTRATION_BOUND_MS } from "./multinode-router.js";

/**
 * #5999 durable wake queue: how long a session's registration waits, at most, for the broker to know whether its queue
 * of messages for subagents that ended is kept where it outlives the broker. A store that is not open by then is not
 * used by this broker: the queue stays in its memory, as before, and senders are told what a later broker lost. With a
 * shared `storage`, it counts from when multi-node routing has started: the store opens in its database.
 */
export const ENDED_QUEUE_OPEN_WAIT_MS = 2_000;
/** Test-only override of {@link ENDED_QUEUE_OPEN_WAIT_MS} for the decision at the first registration, in milliseconds. */
export const ENDED_QUEUE_OPEN_WAIT_ENV = "ATOMIC_INTERCOM_ENDED_QUEUE_OPEN_WAIT_MS";
/** The longest delay a timer takes as given. */
const MAX_TIMER_MS = 2_147_483_647;

/** The wait a broker gives its store at the first registration: the default, unless a test overrides it. */
export function endedQueueOpenWaitMs(env: NodeJS.ProcessEnv = process.env): number {
	const value = env[ENDED_QUEUE_OPEN_WAIT_ENV];
	const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_MS ? parsed : ENDED_QUEUE_OPEN_WAIT_MS;
}
/**
 * The longest that wait lasts in all, as long as a registration waits for its presence lease in a shared database. It
 * includes what comes before the store can open: with a shared `storage`, multi-node routing's start (on a cold start
 * its storage modules compile, and a remote database takes its time to answer); with the local store, loading the
 * store's code, which on a busy machine can take longer than the open wait itself (#6126).
 */
export const ENDED_QUEUE_TOTAL_WAIT_MS = PRESENCE_REGISTRATION_BOUND_MS;
/** How long a send that may join a restored queue waits for the restored rows, at most. */
export const ENDED_QUEUE_LOAD_WAIT_MS = 5_000;

/** What a queued message's sender is told while its `queued` answer still waits for the message to be kept. */
type EarlyOutcome = { readonly kind: "delivered" } | { readonly kind: "failed"; readonly reason: string };

/** A queued message as the store keeps it: its frame and its sender as JSON, and the bytes they take. */
interface StoredForm {
	readonly requestJson: string;
	readonly senderJson: string;
	readonly bytes: number;
}

/** What an earlier broker kept, taken up again: see `DepartedChildren.restore`. */
export interface RestoredEndedQueues {
	readonly queues: readonly RestoredEndedQueue[];
	/** Messages the delivered-message authority shows reached their subagent. */
	readonly delivered: ReadonlyArray<{ readonly held: HeldSend; readonly sender: BrokerConnectedSession }>;
	/** Messages whose launching session had no host session to come back as. */
	readonly ownerless: ReadonlyArray<{ readonly held: HeldSend; readonly childName: string }>;
	readonly budget: readonly EndedWakeBudgetEvent[];
}

/** A failure kept for a sender that was not connected when its queued message failed. */
export interface KeptFailure {
	readonly messageId: string;
	readonly reason: string;
	/** Who the failure is from: the subagent the message was for, as its sender addressed it. */
	readonly target: string;
	readonly childName: string;
}

/** The sender fields a restarted broker needs to deliver a message as its sender was when the broker took it. */
interface SenderSnapshot {
	readonly info: SessionInfo;
	readonly registrationGroup?: string;
	readonly registrationName?: string;
	readonly registrationReturnAddress?: string;
	readonly supervisorId?: string;
	readonly supervisorReturnAddress?: string;
	readonly acknowledgesReceipt?: true;
	readonly hostedBy?: string;
	readonly reach?: BrokerConnectedSession["reach"];
}

export interface DurableEndedQueueHost {
	/** Opens the store this broker keeps the queue in, or resolves undefined when it keeps it in memory. */
	readonly openStore: () => Promise<EndedChildQueueStore | undefined>;
	/** With a shared `storage`: settles once multi-node routing's first attempt did, after which the store opens. */
	readonly routingStarted: () => Promise<void> | undefined;
	/**
	 * With the local store: settles once the store's code has loaded (or failed to), which it does as the store opens or
	 * earlier, as the broker warms it. The open wait counts from then.
	 */
	readonly storeCodeLoaded?: () => Promise<unknown> | undefined;
	/**
	 * This broker keeps the queue in memory although a store may hold messages: its sessions are told those were lost, so
	 * the next broker that opens the store must drop them rather than deliver them.
	 */
	readonly retireStore: () => void;
	readonly budget: EndedChildWakeBudget;
	/**
	 * What the delivered-message authority knows of this message: its recipient confirmed it (`delivered`), or it was
	 * handed over and not confirmed (`uncertain`), or neither.
	 */
	readonly delivered: (held: HeldSend, sender: BrokerConnectedSession) => "delivered" | "uncertain" | "unknown";
	readonly log: (text: string) => void;
}

function snapshotOf(sender: BrokerConnectedSession): SenderSnapshot {
	// Its presence status is free text a session sets and no delivery reads: kept, it would count toward every message.
	const { status: _status, ...info } = sender.info;
	return {
		info,
		...(sender.registrationGroup === undefined ? {} : { registrationGroup: sender.registrationGroup }),
		...(sender.registrationName === undefined ? {} : { registrationName: sender.registrationName }),
		...(sender.registrationReturnAddress === undefined ? {} : { registrationReturnAddress: sender.registrationReturnAddress }),
		...(sender.supervisorId === undefined ? {} : { supervisorId: sender.supervisorId }),
		...(sender.supervisorReturnAddress === undefined ? {} : { supervisorReturnAddress: sender.supervisorReturnAddress }),
		...(sender.acknowledgesReceipt === true ? { acknowledgesReceipt: true as const } : {}),
		...(sender.hostedBy === undefined ? {} : { hostedBy: sender.hostedBy }),
		...(sender.reach === undefined ? {} : { reach: sender.reach }),
	};
}

/** The socket of a send a restarted broker took up again: its sender's connection is gone; nothing is written to it. */
export function restoredSendSocket(): net.Socket {
	const socket = new Socket();
	socket.destroy();
	return socket;
}

const restoredSockets = new WeakSet<net.Socket>();

/** Whether `held` is a send a restarted broker took up again (its sender's connection is not the one that sent it). */
export function isRestoredSend(held: HeldSend): boolean {
	return restoredSockets.has(held.socket);
}

/**
 * #5999 durable wake queue: the broker's side of keeping messages for subagents that ended where they outlive it.
 *
 * - Which store keeps them is decided once, when the first session registers: the local file by default, the shared
 *   database with multi-node routing on, or memory when neither opens in time. Registrations wait for that decision
 *   (bounded), because `registered.instanceId` names what keeps them: the store's identity, the same across restarts,
 *   or this process's when only memory does, so a client is told a message was lost only when it was.
 * - A queued message's sender is answered `queued` once its row is written; an outcome that comes first (it reached the
 *   subagent, or failed) is its answer instead.
 * - Rows are deleted once the subagent confirmed saving the message, or its sender was told it failed; a failure for a
 *   sender that is not connected is kept until it registers again.
 * - The rows a broker finds are taken up again in the order they were queued: as its departures, see
 *   `DepartedChildren.restore`.
 */
export class DurableEndedQueue {
	private store: EndedChildQueueStore | undefined;
	private deciding: Promise<void> | undefined;
	private decidedNow = false;
	private loading: Promise<void> | undefined;
	private loadedNow = false;
	private readonly early = new Map<string, EarlyOutcome | undefined>();
	/** While an earlier broker's messages are read: the subagents (names and ids) they are for. */
	private pending: Set<string> | undefined;
	private readonly deferred: Array<() => void> = [];
	/** Failures kept for senders that were not connected, by the sender's return address (or session id). */
	private readonly kept = new Map<string, Map<string, KeptFailure>>();

	constructor(private readonly host: DurableEndedQueueHost) {}

	/** The identity of the store that keeps the queue, once it is decided and durable. */
	get storeId(): string | undefined {
		return this.store?.id;
	}

	get durable(): boolean {
		return this.store !== undefined;
	}

	get decided(): boolean {
		return this.decidedNow;
	}

	get loaded(): boolean {
		return this.loadedNow;
	}

	/**
	 * Decide, once, which store keeps the queue; resolves when decided, within {@link ENDED_QUEUE_OPEN_WAIT_MS} of what
	 * the store needs before it can open (routing's start with a shared `storage`, the store's code with the local one),
	 * and within {@link ENDED_QUEUE_TOTAL_WAIT_MS} in all. `restore`
	 * receives what an earlier broker kept, once the store is open: read a page at a time, the event loop running between
	 * pages. Until then, sends to the subagents it kept messages for wait ({@link holds}), so none overtakes them.
	 */
	decide(restore: (restored: RestoredEndedQueues) => void): Promise<void> {
		if (this.deciding !== undefined) return this.deciding;
		let settle: () => void = () => {};
		const decided = new Promise<void>((resolve) => {
			settle = () => {
				this.decidedNow = true;
				resolve();
			};
		});
		const timers: ReturnType<typeof setTimeout>[] = [];
		const wait = (ms: number) => {
			const timer = setTimeout(() => {
				if (this.decidedNow) return;
				this.host.log(
					`Intercom broker keeps messages for subagents that ended in memory only: their store did not open within ${ms} ms`,
				);
				this.host.retireStore();
				this.loadedNow = true;
				settle();
			}, ms);
			timer.unref();
			timers.push(timer);
		};
		const openWaitMs = endedQueueOpenWaitMs();
		const waitToOpen = () => {
			if (!this.decidedNow) wait(openWaitMs);
		};
		const before = this.host.routingStarted() ?? this.host.storeCodeLoaded?.();
		if (before === undefined) wait(openWaitMs);
		else {
			wait(ENDED_QUEUE_TOTAL_WAIT_MS);
			void before.then(waitToOpen, waitToOpen);
		}
		let finishLoad: () => void = () => {};
		this.loading = new Promise<void>((resolve) => {
			finishLoad = () => {
				this.loadedNow = true;
				resolve();
			};
		});
		void (async () => {
			let store: EndedChildQueueStore | undefined;
			try {
				store = await this.host.openStore();
			} catch (error) {
				this.host.log(
					`Intercom broker keeps messages for subagents that ended in memory only: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (this.decidedNow) {
				// Too late: this broker already told its sessions their messages are kept in memory.
				await store?.close().catch(() => {});
				finishLoad();
				return;
			}
			for (const timer of timers) clearTimeout(timer);
			this.store = store;
			if (store !== undefined) this.journalBudget(store);
			else this.host.retireStore();
			settle();
			if (store === undefined) {
				finishLoad();
				return;
			}
			try {
				this.pending = new Set(await store.targets());
				const restored = this.restoration();
				const { budget } = await store.load((rows) => restored.add(rows));
				restore({ ...restored.result(), budget });
			} catch (error) {
				this.host.log(
					`Intercom broker could not read the messages kept for subagents that ended: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			this.pending = undefined;
			finishLoad();
			for (const deferred of this.deferred.splice(0)) deferred();
		})();
		this.deciding = decided;
		return decided;
	}

	/**
	 * Whether a send to `target` waits for what an earlier broker kept for it to be taken up again: one of its senders'
	 * later messages must not reach it first. Sends to any other session never wait.
	 */
	holds(target: string): boolean {
		return this.pending !== undefined && this.pending.has(target.trim().toLowerCase());
	}

	/** Runs `send` once what an earlier broker kept is taken up again, after it, in the order asked. */
	whenRestored(send: () => void): void {
		if (this.pending === undefined) send();
		else this.deferred.push(send);
	}

	/** Resolves once what an earlier broker kept is taken up again (or it is known there is none), within a bound. */
	untilLoaded(): Promise<void> {
		if (this.loadedNow || this.loading === undefined) return Promise.resolve();
		return Promise.race([
			this.loading,
			new Promise<void>((resolve) => setTimeout(resolve, ENDED_QUEUE_LOAD_WAIT_MS).unref()),
		]);
	}

	private journalBudget(store: EndedChildQueueStore): void {
		const write = (promise: Promise<void>) =>
			void promise.catch((error: Error) => this.host.log(`Intercom broker could not record a wake: ${error.message}`));
		this.host.budget.journal = {
			wake: (childKey, at, depth) => write(store.recordBudget({ childKey, kind: "wake", at, depth })),
			awake: (childKey, depth, at) => write(store.recordBudget({ childKey, kind: "awake", at, depth })),
		};
	}

	/** What `DepartedChildren` writes through. */
	readonly journal: DepartedChildrenJournal = {
		queued: (held, departure) => {
			const store = this.store;
			if (store === undefined) return undefined;
			const sender = this.senderOf(held);
			// Never answered `queued` from memory while the store is what this broker says keeps it.
			if (sender === undefined) return Promise.reject(new Error("its sender is not known"));
			this.early.set(held.messageId, undefined);
			return store.add(this.entryOf(held, departure, sender));
		},
		wake: (departure, wake) => {
			this.write(this.store?.setWake(departureKeyOf(departure), wake));
		},
		ownerAway: (departures, since) => {
			this.write(this.store?.setOwnerAway(departures.map(departureKeyOf), since));
		},
		rekeyOwner: (departure, ownerSessionId) => {
			this.write(this.store?.rekeyOwner(departureKeyOf(departure), ownerSessionId));
		},
	};

	/** The sender as the send handler took `held`: a restarted broker delivers it as that sender. */
	private senderOf(held: HeldSend): BrokerConnectedSession | undefined {
		return senderAtReceipt(held.clientMessage as SendClientMessage);
	}

	/**
	 * What the caps count of the store: the rows kept for `departure`'s subagent, and all of them, never less than it
	 * holds (see `EndedChildQueueStore.counted`). Undefined while only memory keeps the queue.
	 */
	storedCounts(departure: JournalDeparture): EndedQueueCounted | undefined {
		return this.store?.counted(departureKeyOf(departure));
	}

	/**
	 * Resolves once the store has counted what it kept before this broker opened it, at once while only memory keeps the
	 * queue, or after {@link ENDED_QUEUE_OPEN_WAIT_MS} at most: a message that may not fit waits no longer than that.
	 */
	untilCounted(): Promise<void> {
		const store = this.store;
		if (store === undefined) return Promise.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			store.whenCounted(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ENDED_QUEUE_OPEN_WAIT_MS);
				timer.unref();
			}),
		]).finally(() => clearTimeout(timer));
	}

	/**
	 * The bytes `held` takes in the store, as it is written there: its frame and its sender, as JSON. Undefined while only
	 * memory keeps the queue. Serialized once, and written as serialized.
	 */
	storedBytes(held: HeldSend): number | undefined {
		if (this.store === undefined) return undefined;
		return this.storedForm(held)?.bytes;
	}

	private readonly stored = new WeakMap<HeldSend, StoredForm>();

	private storedForm(held: HeldSend): StoredForm | undefined {
		const known = this.stored.get(held);
		if (known !== undefined) return known;
		const sender = this.senderOf(held);
		if (sender === undefined) return undefined;
		const requestJson = JSON.stringify(held.clientMessage);
		const senderJson = JSON.stringify(snapshotOf(sender));
		const form = { requestJson, senderJson, bytes: Buffer.byteLength(requestJson) + Buffer.byteLength(senderJson) };
		this.stored.set(held, form);
		return form;
	}

	private entryOf(held: HeldSend, departure: JournalDeparture, sender: BrokerConnectedSession): EndedQueueEntry {
		const form = this.storedForm(held);
		return {
			messageId: held.messageId,
			ownerSessionId: departure.ownerSessionId,
			...(departure.ownerHost === undefined ? {} : { ownerHost: departure.ownerHost }),
			childKey: departure.childKey,
			child: departure.child,
			sender: snapshotOf(sender) as unknown as Record<string, unknown>,
			request: held.clientMessage as Record<string, unknown>,
			...(form === undefined ? {} : { requestJson: form.requestJson, senderJson: form.senderJson }),
			bytes: form?.bytes ?? intercomMessageBytes((held.clientMessage.message as Message).content),
			queuedAt: Date.now(),
			...(departure.wake === undefined ? {} : { wake: departure.wake }),
		};
	}

	private write(promise: Promise<void> | undefined): void {
		void promise?.catch((error: Error) =>
			this.host.log(`Intercom broker could not update a message kept for a subagent that ended: ${error.message}`),
		);
	}

	/** Whether `messageId`'s `queued` answer still waits for its row to be written. */
	awaitingAnswer(messageId: string): boolean {
		return this.early.has(messageId);
	}

	/** An outcome of a message whose `queued` answer still waits: it becomes the answer. False when none waits. */
	settleEarly(messageId: string, outcome: EarlyOutcome): boolean {
		if (!this.early.has(messageId)) return false;
		if (this.early.get(messageId) === undefined) this.early.set(messageId, outcome);
		return true;
	}

	/** The row of `messageId` is written (or could not be): the outcome that came first, if any; it answers no more. */
	takeEarly(messageId: string): EarlyOutcome | undefined {
		const outcome = this.early.get(messageId);
		this.early.delete(messageId);
		return outcome;
	}

	/** The message reached its subagent, or its sender was told it failed: its row goes. */
	settled(messageIds: readonly string[]): void {
		this.write(this.store?.remove(messageIds));
	}

	/** The messages were handed to their subagent: a restart before it confirms them does not wake it for them. */
	handedOver(messageIds: readonly string[]): void {
		this.write(this.store?.dispatched(messageIds));
	}

	/**
	 * The message failed while its sender was not connected: kept, with its reason, until a session with the sender's
	 * return address (or id) registers. False when only memory keeps the queue: the failure has nobody to go to.
	 */
	keepFailure(held: HeldSend, failure: KeptFailure): boolean {
		const store = this.store;
		const key = held.senderReturnAddress ?? held.senderId;
		if (store === undefined) return false;
		const forSender = this.kept.get(key) ?? new Map<string, KeptFailure>();
		forSender.set(failure.messageId, failure);
		this.kept.set(key, forSender);
		this.write(store.fail(failure.messageId, failure.reason, Date.now()));
		return true;
	}

	/** The failures kept for a session registering with this return address or id; each is told once, then removed. */
	takeFailures(returnAddress: string | undefined, sessionId: string): KeptFailure[] {
		const failures: KeptFailure[] = [];
		for (const key of returnAddress === undefined ? [sessionId] : [returnAddress, sessionId]) {
			const forSender = this.kept.get(key);
			if (forSender === undefined) continue;
			this.kept.delete(key);
			failures.push(...forSender.values());
		}
		return failures;
	}

	/**
	 * The rows an earlier broker kept, page by page, as `DepartedChildren.restore` takes them, and those it can tell at
	 * once: rows the delivered-message authority shows reached their subagent, rows whose failure waits for its sender,
	 * and rows whose owner can never come back (it had no host session).
	 */
	private restoration(): {
		readonly add: (rows: readonly EndedQueueRow[]) => void;
		readonly result: () => Omit<RestoredEndedQueues, "budget">;
	} {
		const queues = new Map<
			string,
			RestoredEndedQueue & { sends: Array<{ held: HeldSend; sender: WakeSender; bytes: number }> }
		>();
		const delivered: Array<{ readonly held: HeldSend; readonly sender: BrokerConnectedSession }> = [];
		const ownerless: Array<{ readonly held: HeldSend; readonly childName: string }> = [];
		const add = (rows: readonly EndedQueueRow[]): void => {
			for (const row of rows) {
				const sender = restoredSender(row);
				const held = restoredHeld(row, sender);
				if (row.failed !== undefined) {
					this.keepRestoredFailure(held, row);
					continue;
				}
				const known = this.host.delivered(held, sender);
				if (known === "delivered") {
					delivered.push({ held, sender });
					continue;
				}
				if (known === "uncertain" || row.dispatched === true) markMaybeDelivered(held);
				if (row.ownerHost === undefined) {
					ownerless.push({ held, childName: row.child.childName });
					continue;
				}
				const key = JSON.stringify([row.ownerHost, row.childKey]);
				const queue = queues.get(key);
				const sends = queue?.sends ?? [];
				sends.push({ held, sender: wakeSenderOfSnapshot(sender), bytes: row.bytes });
				// The latest row says how the departure stood last.
				queues.set(key, {
					ownerSessionId: row.ownerSessionId,
					ownerHost: row.ownerHost,
					childName: row.child.childName,
					group: row.child.group,
					aliases: row.child.aliases,
					...(row.child.childId === undefined ? {} : { childId: row.child.childId }),
					outcome: row.child.outcome as SubagentEndedOutcome,
					messages: row.child.messages as EndedChildMessages,
					sends,
					...(row.wake === undefined ? (queue?.wake === undefined ? {} : { wake: queue.wake }) : { wake: row.wake }),
					...((queue?.awaySince ?? row.ownerAwaySince) === undefined
						? {}
						: { awaySince: (queue?.awaySince ?? row.ownerAwaySince) as number }),
				});
			}
		};
		return { add, result: () => ({ queues: [...queues.values()], delivered, ownerless }) };
	}

	private keepRestoredFailure(held: HeldSend, row: EndedQueueRow): void {
		const key = held.senderReturnAddress ?? held.senderId;
		const forSender = this.kept.get(key) ?? new Map<string, KeptFailure>();
		const target = typeof row.request.logicalTarget === "string" ? row.request.logicalTarget : String(row.request.to);
		forSender.set(row.messageId, {
			messageId: row.messageId,
			reason: row.failed?.reason ?? "",
			target: target.trim(),
			childName: row.child.childName,
		});
		this.kept.set(key, forSender);
	}

	/** Every write so far is done, and the store is closed. */
	async close(): Promise<void> {
		await this.store?.close().catch(() => {});
	}
}

function departureKeyOf(departure: JournalDeparture) {
	return {
		ownerSessionId: departure.ownerSessionId,
		...(departure.ownerHost === undefined ? {} : { ownerHost: departure.ownerHost }),
		childKey: departure.childKey,
	};
}

function restoredSender(row: EndedQueueRow): BrokerConnectedSession {
	const snapshot = row.sender as unknown as SenderSnapshot;
	const socket = restoredSendSocket();
	restoredSockets.add(socket);
	return { ...snapshot, socket, info: { ...snapshot.info } };
}

function restoredHeld(row: EndedQueueRow, sender: BrokerConnectedSession): HeldSend {
	const clientMessage = { ...row.request } as HeldSend["clientMessage"];
	// Delivered as its sender was when the earlier broker took it: that connection is gone.
	detachSend(clientMessage as unknown as SendClientMessage, sender);
	return {
		socket: sender.socket,
		senderId: sender.info.id,
		messageId: row.messageId,
		clientMessage,
		...(sender.registrationReturnAddress === undefined ? {} : { senderReturnAddress: sender.registrationReturnAddress }),
	};
}

/** As the broker's `wakeSenderOf`, for a sender an earlier broker took. */
function wakeSenderOfSnapshot(sender: BrokerConnectedSession): WakeSender {
	const name = sender.info.name?.trim();
	return {
		id: sender.info.id,
		info: sender.info,
		...(sender.reach === undefined ? {} : { reach: sender.reach }),
		waker: { id: sender.info.id, ...(name ? { name } : {}) },
		...(sender.supervisorId !== undefined && sender.registrationName !== undefined
			? { wakeKey: departureKey(sender.supervisorId, sender.registrationName) }
			: {}),
	};
}
