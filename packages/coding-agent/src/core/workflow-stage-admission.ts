import { AsyncLocalStorage } from "node:async_hooks";

export type WorkflowStageAdmissionDecision = "admitted" | "late" | "duplicate";

export interface WorkflowStageAdmissionResult {
	readonly decision: WorkflowStageAdmissionDecision;
	readonly completion: Promise<void>;
}

/**
 * Linearizable admission boundary for externally-produced workflow-stage traffic.
 * JavaScript execution between the state check and state transition is synchronous:
 * an enqueue that wins belongs to the stage, while close makes every later enqueue
 * use the external route. Stable keys make either outcome exactly-once.
 */
export class WorkflowStageAdmissionBoundary {
	private open = true;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly pending = new Set<Promise<void>>();
	private readonly invocationContext = new AsyncLocalStorage<string>();
	private closePromise: Promise<void> | undefined;
	private readonly drainAdmittedWork: () => Promise<void>;

	constructor(drainAdmittedWork: () => Promise<void> = async () => {}) {
		this.drainAdmittedWork = drainAdmittedWork;
	}

	admit(
		key: string | undefined,
		deliver: () => void | Promise<void>,
		routeLate: () => void | Promise<void>,
	): WorkflowStageAdmissionResult {
		if (key !== undefined) {
			if (this.completed.has(key)) return { decision: "duplicate", completion: Promise.resolve() };
			const inFlight = this.inFlight.get(key);
			if (inFlight) {
				return { decision: "duplicate", completion: this.invocationContext.getStore() === key ? Promise.resolve() : inFlight };
			}
		}
		const decision: WorkflowStageAdmissionDecision = this.open ? "admitted" : "late";
		let completion: Promise<void>;
		if (key === undefined) {
			completion = this.invoke(this.open ? deliver : routeLate);
		} else {
			let resolveCompletion!: () => void;
			let rejectCompletion!: (reason?: unknown) => void;
			completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
			void completion.catch(() => {});
			this.inFlight.set(key, completion);
			const delivery = this.invocationContext.run(key, () => this.invoke(this.open ? deliver : routeLate));
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
		if (decision === "admitted") this.trackAdmittedWork(completion);
		return { decision, completion };
	}

	trackAdmittedWork(completion: Promise<void>): void {
		this.pending.add(completion);
		void completion.then(
			() => this.pending.delete(completion),
			() => this.pending.delete(completion),
		);
	}

	isOpen(): boolean {
		return this.open;
	}

	seal(): void {
		this.open = false;
	}

	close(): Promise<void> {
		this.seal();
		this.closePromise ??= this.finishClose();
		return this.closePromise;
	}

	private async finishClose(): Promise<void> {
		await Promise.allSettled([...this.pending]);
		await this.drainAdmittedWork();
	}


	private invoke(callback: () => void | Promise<void>): Promise<void> {
		try {
			return Promise.resolve(callback());
		} catch (error) {
			return Promise.reject(error);
		}
	}
}
