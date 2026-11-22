/**
 * Pipelined per-(sender, target) send-order gate for multi-node routing.
 *
 * Read-only shared-store lookups and local lookup timers start immediately in parallel when sends arrive,
 * while observable commits (local socket handoff, shared outbox enqueue, remote-reservation hold, or reply
 * handoff) wait for strictly earlier in-flight sends from the same canonical sender to the same canonical
 * target.
 *
 * State machine per ticket:
 *   - `resolving`: remote send whose canonical target identity is not yet resolved.
 *   - `resolved`: canonical target identity is known (immediate for local sends, after resolution for remote sends).
 *   - `done`: observable commit or failure completed; removed immediately so idle senders retain no memory.
 *
 * Every wait edge points strictly backward in arrival sequence number (`earlier.seq < current.seq`), so the
 * wait-for graph is acyclic and deadlock-free even when local sends fall back re-entrantly to remote routing.
 */

interface DeferredWait {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

function createDeferredWait(): DeferredWait {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

export type SendOrderPhase = "resolving" | "resolved" | "done";

export interface SendOrderTicket {
	readonly senderKey: string;
	readonly seq: number;
	readonly rawTarget: string;
	readonly arrivedRegSeq: number;
	isLocal: boolean;
	phase: SendOrderPhase;
	targetIdentity: string | undefined;
}

interface InternalTicket extends SendOrderTicket {
	previousTargetIdentity?: string;
	targetKnownWait?: DeferredWait;
	reenteredWait?: DeferredWait;
	finishedWait?: DeferredWait;
}

export type BeginSendTicketOptions =
	| {
			readonly senderKey: string;
			readonly rawTarget: string;
			readonly arrivedRegSeq: number;
			readonly isLocal: true;
			readonly targetIdentity: string;
	  }
	| {
			readonly senderKey: string;
			readonly rawTarget: string;
			readonly arrivedRegSeq: number;
			readonly isLocal: false;
	  };

export interface WaitForEarlierOptions {
	readonly targetIdentity: string;
	/** Local target's registration epoch on this broker (enables O(1) skip of earlier remote sends). */
	readonly targetRegSeq?: number;
	/** Local target's awaited session ID, if any (checked when skipping earlier remote sends). */
	readonly awaitedId?: string;
	/** Local target's held alias session ID, if any (checked when skipping earlier remote sends). */
	readonly aliasId?: string;
	/** Resolved remote target identifiers, used to skip unrelated still-resolving remote sends. */
	readonly remoteTarget?: {
		readonly sessionId: string;
		readonly name?: string;
		readonly atomicSessionId?: string;
		readonly aliases?: readonly string[];
	};
	/** Local lookup deadline promise: bounds a local send's wait on earlier unbounded remote sends. */
	readonly localBound?: Promise<"expired">;
}

function rawTargetCouldMatchRemote(
	rawTarget: string,
	remote: NonNullable<WaitForEarlierOptions["remoteTarget"]>,
): boolean {
	if (rawTarget === remote.sessionId) return true;
	if (remote.atomicSessionId !== undefined && rawTarget === remote.atomicSessionId) return true;
	if (remote.name !== undefined && rawTarget.toLowerCase() === remote.name.toLowerCase()) return true;
	if (rawTarget.length === 8 && remote.sessionId.toLowerCase().startsWith(rawTarget.toLowerCase())) return true;
	if (remote.aliases?.includes(rawTarget) === true) return true;
	return false;
}

/**
 * Coordinates commit order per canonical `(senderKey, targetIdentity)` without serializing independent
 * read-only store lookups or introducing cross-target or cross-sender head-of-line blocking.
 */
export class SendOrderGate {
	private nextSeq = 0;
	private closed = false;
	private readonly bySender = new Map<string, InternalTicket[]>();

	/** Number of senders with at least one in-flight send ticket (0 when idle). */
	get activeSenders(): number {
		return this.bySender.size;
	}

	/** Reserve a FIFO arrival ticket synchronously when a send enters multi-node routing. */
	begin(options: BeginSendTicketOptions): SendOrderTicket {
		const ticket: InternalTicket = {
			senderKey: options.senderKey,
			seq: ++this.nextSeq,
			rawTarget: options.rawTarget,
			arrivedRegSeq: options.arrivedRegSeq,
			isLocal: options.isLocal,
			phase: options.isLocal ? "resolved" : "resolving",
			targetIdentity: options.isLocal ? options.targetIdentity : undefined,
		};
		if (this.closed) {
			ticket.phase = "done";
			return ticket;
		}
		let list = this.bySender.get(options.senderKey);
		if (list === undefined) {
			list = [];
			this.bySender.set(options.senderKey, list);
		}
		list.push(ticket);
		return ticket;
	}

	/** Record the resolved canonical target identity for a remote send, unblocking unrelated targets immediately. */
	resolveTarget(ticket: SendOrderTicket, targetIdentity: string): void {
		const internal = ticket as InternalTicket;
		if (internal.phase === "done") return;
		internal.targetIdentity = targetIdentity;
		if (internal.phase === "resolving") {
			internal.phase = "resolved";
			const wait = internal.targetKnownWait;
			internal.targetKnownWait = undefined;
			wait?.resolve();
		}
	}

	/**
	 * Transition a local send ticket in place to remote resolution when local handoff falls back re-entrantly
	 * because the local target disconnected, was fenced, or lost an alias. Keeps the original arrival `seq`.
	 */
	reenterRemote(ticket: SendOrderTicket): void {
		const internal = ticket as InternalTicket;
		if (internal.phase === "done") return;
		if (internal.targetIdentity !== undefined) internal.previousTargetIdentity = internal.targetIdentity;
		internal.isLocal = false;
		internal.targetIdentity = undefined;
		internal.phase = "resolving";
		internal.targetKnownWait = undefined;
		const reentered = internal.reenteredWait;
		internal.reenteredWait = undefined;
		reentered?.resolve();
	}

	/**
	 * Wait for all strictly earlier in-flight sends from the same sender that target (or may target)
	 * `options.targetIdentity`. Returns `undefined` synchronously on the uncontended fast path so callers
	 * incur zero extra Promise allocations or microtasks.
	 */
	waitForEarlier(ticket: SendOrderTicket, options: WaitForEarlierOptions): Promise<void> | undefined {
		const internal = ticket as InternalTicket;
		if (this.closed || internal.phase === "done") return undefined;
		this.resolveTarget(internal, options.targetIdentity);
		const list = this.bySender.get(internal.senderKey);
		if (list === undefined || list.length <= 1) return undefined;
		if (!this.hasBlockingEarlier(list, internal, options)) return undefined;
		return this.waitLoop(internal, options);
	}

	/** Mark a ticket done, wake any waiting later sends, and prune empty sender entries. */
	finish(ticket: SendOrderTicket): void {
		const internal = ticket as InternalTicket;
		if (internal.phase === "done") return;
		internal.phase = "done";
		const targetWait = internal.targetKnownWait;
		internal.targetKnownWait = undefined;
		targetWait?.resolve();
		const reenteredWait = internal.reenteredWait;
		internal.reenteredWait = undefined;
		reenteredWait?.resolve();
		const finishedWait = internal.finishedWait;
		internal.finishedWait = undefined;
		finishedWait?.resolve();
		const list = this.bySender.get(internal.senderKey);
		if (list !== undefined) {
			const index = list.indexOf(internal);
			if (index !== -1) list.splice(index, 1);
			if (list.length === 0) this.bySender.delete(internal.senderKey);
		}
	}

	/** Unblock all waiting sends and clear all state when the router closes. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const list of this.bySender.values()) {
			for (const ticket of list) {
				ticket.phase = "done";
				ticket.targetKnownWait?.resolve();
				ticket.targetKnownWait = undefined;
				ticket.reenteredWait?.resolve();
				ticket.reenteredWait = undefined;
				ticket.finishedWait?.resolve();
				ticket.finishedWait = undefined;
			}
		}
		this.bySender.clear();
	}

	private waitKind(earlier: InternalTicket, current: InternalTicket, options: WaitForEarlierOptions): "skip" | "target" | "finish" {
		if (earlier.phase === "done") return "skip";
		if (earlier.phase === "resolved") {
			return earlier.targetIdentity === options.targetIdentity ? "finish" : "skip";
		}
		// Earlier remote send is still resolving its target identity.
		if (earlier.previousTargetIdentity === options.targetIdentity) return "target";
		if (current.isLocal && options.targetRegSeq !== undefined && options.targetRegSeq <= earlier.arrivedRegSeq) {
			const matchesAlias = earlier.rawTarget === options.awaitedId || earlier.rawTarget === options.aliasId;
			if (!matchesAlias) return "skip";
		}
		if (!current.isLocal && options.remoteTarget !== undefined && !rawTargetCouldMatchRemote(earlier.rawTarget, options.remoteTarget)) {
			return "skip";
		}
		return "target";
	}

	private hasBlockingEarlier(
		list: readonly InternalTicket[],
		current: InternalTicket,
		options: WaitForEarlierOptions,
	): boolean {
		for (const earlier of list) {
			if (earlier.seq >= current.seq) break;
			if (this.waitKind(earlier, current, options) !== "skip") return true;
		}
		return false;
	}

	private awaitTargetKnown(ticket: InternalTicket): Promise<void> {
		if (ticket.phase !== "resolving" || this.closed) return Promise.resolve();
		ticket.targetKnownWait ??= createDeferredWait();
		return ticket.targetKnownWait.promise;
	}

	private awaitReentered(ticket: InternalTicket): Promise<void> {
		if (!ticket.isLocal || ticket.phase === "done" || this.closed) return Promise.resolve();
		ticket.reenteredWait ??= createDeferredWait();
		return ticket.reenteredWait.promise;
	}

	private awaitFinished(ticket: InternalTicket): Promise<void> {
		if (ticket.phase === "done" || this.closed) return Promise.resolve();
		ticket.finishedWait ??= createDeferredWait();
		return ticket.finishedWait.promise;
	}

	private async waitLoop(current: InternalTicket, options: WaitForEarlierOptions): Promise<void> {
		let localBoundExpired = false;
		const boundPromise = options.localBound?.then(() => {
			localBoundExpired = true;
		});
		while (!this.closed && current.phase !== "done") {
			const list = this.bySender.get(current.senderKey);
			if (list === undefined) return;
			let waited = false;
			for (const earlier of list) {
				if (earlier.seq >= current.seq) break;
				const kind = this.waitKind(earlier, current, options);
				if (kind === "skip") continue;
				const bounded = current.isLocal && !earlier.isLocal && boundPromise !== undefined;
				if (bounded && localBoundExpired) continue;
				const wait = kind === "target" ? this.awaitTargetKnown(earlier) : this.awaitFinished(earlier);
				if (bounded) await Promise.race([wait, boundPromise]);
				else if (current.isLocal && earlier.isLocal && boundPromise !== undefined)
					await Promise.race([wait, this.awaitReentered(earlier)]);
				else await wait;
				waited = true;
				break;
			}
			if (!waited) return;
		}
	}
}
