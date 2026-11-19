import { AsyncLocalStorage } from "node:async_hooks";
import { SessionKeyDigests } from "./storage/session/key-digests.js";

interface PersistedAdmission {
	readonly type: string;
	readonly stageAdmissionKey?: string;
}

function admissionKeys(entries: Iterable<PersistedAdmission>): string[] {
	return Array.from(entries).flatMap((entry) =>
		entry.type === "custom_message" && typeof entry.stageAdmissionKey === "string" ? [entry.stageAdmissionKey] : [],
	);
}

/** Ordered, idempotent admission of subagent messages and task notices. */
export class MessageAdmissionBoundary {
	private open = true;
	private readonly completed = new SessionKeyDigests();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly pending = new Set<Promise<void>>();
	private readonly invocationContext = new AsyncLocalStorage<string>();
	private readonly messageDeliveryContext = new AsyncLocalStorage<{ active: boolean }>();
	private readonly awaitedTurnContext = new AsyncLocalStorage<{ active: boolean }>();
	private readonly messageDeliveries = new Set<Promise<void>>();
	private messageDeliveryTail: Promise<void> | undefined;
	private constructor(completedKeys: Iterable<string>, encoded?: string) {
		if (encoded) this.completed.mergeEncoded(encoded);
		for (const key of completedKeys) this.completed.add(key);
	}

	/** `encoded` holds the packed admission-key digests a resume keeps for entries outside its window. */
	static restore(
		entries: Iterable<PersistedAdmission>,
		keys: Iterable<string> = [],
		encoded?: string,
	): MessageAdmissionBoundary {
		return new MessageAdmissionBoundary([...keys, ...admissionKeys(entries)], encoded);
	}

	/** One FIFO position for an external operation, including its retry waits. */
	runMessageDelivery(deliver: () => void | Promise<void>, ifClosed: () => never): Promise<void> {
		return this.admit(undefined, () => this.serializeMessageDelivery(deliver), ifClosed);
	}

	/** Reentrant SDK commits stay inside their producer's FIFO position. */
	serializeMessageDelivery(deliver: () => void | Promise<void>): Promise<void> {
		if (this.messageDeliveryContext.getStore()) return this.invoke(deliver);
		const scope = { active: true };
		const invoke = () => this.messageDeliveryContext.run(scope, () => this.invoke(deliver));
		const delivery = this.messageDeliveryTail ? this.messageDeliveryTail.then(invoke) : invoke();
		const settled = delivery.catch(() => undefined);
		this.messageDeliveryTail = settled;
		this.messageDeliveries.add(settled);
		void settled.then(() => {
			scope.active = false;
			this.messageDeliveries.delete(settled);
			if (this.messageDeliveryTail === settled) this.messageDeliveryTail = undefined;
		});
		return delivery;
	}

	/**
	 * Starts a turn that the current message delivery awaits before it settles. That turn must not wait for the
	 * registered deliveries: its own delivery is among them, and every other one is queued behind it.
	 */
	runAwaitedTurn<T>(start: () => T): T {
		const delivery = this.messageDeliveryContext.getStore();
		return delivery ? this.awaitedTurnContext.run(delivery, start) : start();
	}

	/** True inside a turn started by {@link runAwaitedTurn} while its delivery is still in flight. */
	startsAwaitedTurn(): boolean {
		return this.awaitedTurnContext.getStore()?.active === true;
	}

	/** Excludes tracked model turns: joining those from a native poll would deadlock. */
	async waitForMessageDeliveries(): Promise<void> {
		while (this.messageDeliveries.size > 0) await Promise.all([...this.messageDeliveries]);
	}

	hasMessageDeliveries(): boolean {
		return this.messageDeliveries.size > 0;
	}

	admit(key: string | undefined, deliver: () => void | Promise<void>, ifClosed: () => never): Promise<void> {
		if (key !== undefined) {
			if (this.completed.has(key)) return Promise.resolve();
			const inFlight = this.inFlight.get(key);
			if (inFlight) return this.invocationContext.getStore() === key ? Promise.resolve() : inFlight;
		}
		const admitted = this.open;
		const action = admitted ? deliver : ifClosed;
		let completion: Promise<void>;
		if (key === undefined) {
			completion = this.invoke(action);
		} else {
			let resolveCompletion!: () => void;
			let rejectCompletion!: (reason?: unknown) => void;
			completion = new Promise<void>((resolve, reject) => {
				resolveCompletion = resolve;
				rejectCompletion = reject;
			});
			void completion.catch(() => {});
			this.inFlight.set(key, completion);
			const delivery = this.invocationContext.run(key, () => this.invoke(action));
			void delivery.then(resolveCompletion, rejectCompletion);
			void completion.then(
				() => {
					if (this.inFlight.get(key) !== completion) return;
					this.inFlight.delete(key);
					this.completed.add(key);
				},
				() => {
					if (this.inFlight.get(key) === completion) this.inFlight.delete(key);
				},
			);
		}
		if (admitted) {
			this.pending.add(completion);
			void completion.then(
				() => this.pending.delete(completion),
				() => this.pending.delete(completion),
			);
		}
		return completion;
	}

	/** Join already-reserved queue commits before a native turn polls its input. */
	async waitForPendingDeliveries(): Promise<void> {
		await Promise.allSettled([...this.pending]);
	}

	hasPendingDeliveries(): boolean {
		return this.pending.size > 0;
	}

	isOpen(): boolean {
		return this.open;
	}

	seal(): void {
		this.open = false;
	}

	private invoke(callback: () => void | Promise<void>): Promise<void> {
		try {
			return Promise.resolve(callback());
		} catch (error) {
			return Promise.reject(error);
		}
	}
}
