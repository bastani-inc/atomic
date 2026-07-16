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
	private readonly seen = new Set<string>();
	private readonly pending = new Set<Promise<void>>();
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
			if (this.seen.has(key)) return { decision: "duplicate", completion: Promise.resolve() };
			this.seen.add(key);
		}
		if (!this.open) {
			const completion = this.invoke(routeLate);
			this.releaseKeyOnFailure(key, completion);
			return { decision: "late", completion };
		}

		const completion = this.invoke(deliver);
		this.pending.add(completion);
		this.releaseKeyOnFailure(key, completion);
		void completion.then(
			() => this.pending.delete(completion),
			() => this.pending.delete(completion),
		);
		return { decision: "admitted", completion };
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

	private releaseKeyOnFailure(key: string | undefined, completion: Promise<void>): void {
		if (key === undefined) return;
		void completion.catch(() => { this.seen.delete(key); });
	}

	private invoke(callback: () => void | Promise<void>): Promise<void> {
		try {
			return Promise.resolve(callback());
		} catch (error) {
			return Promise.reject(error);
		}
	}
}
