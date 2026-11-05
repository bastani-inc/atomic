import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AgentTaskHost, type AgentTaskHostBinding } from "./tasks/agent-adapter.js";
import type { OwnerScope } from "./tasks/contracts.js";

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

export interface PersistedWorkflowStageAdmission {
	readonly type: string;
	readonly stageAdmissionKey?: string;
}
export class WorkflowStageAdmissionBoundary {
	private open = true;
	private readonly completed: Set<string>;
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly pending = new Set<Promise<void>>();
	private readonly invocationContext = new AsyncLocalStorage<string>();
	private closePromise: Promise<void> | undefined;
	private readonly closeController = new AbortController();
	private readonly ownedSubagentRunIds = new Set<string>();
	private readonly stageAttemptId = randomUUID();
	private taskScope: Extract<OwnerScope, { kind: "workflow-stage" }> | undefined;
	private taskHost: AgentTaskHost | undefined;
	private readonly messageDeliveryContext = new AsyncLocalStorage<boolean>();
	private readonly messageAdmissionContext = new AsyncLocalStorage<{ active: boolean }>();
	private readonly messageDeliveries = new Set<Promise<void>>();
	private messageDeliveryTail: Promise<void> | undefined;
	private taskClose: ReturnType<AgentTaskHost["close"]> | undefined;

	/** Called by the actual stage session; replacement sessions retain the original identity. */
	bindTaskIdentity(sessionId: string, runId: string, stageId: string): void {
		this.taskScope ??= { kind: "workflow-stage", sessionId, runId, stageId, stageAttemptId: this.stageAttemptId };
	}

	/** Trusted companion integration only; the existing launch guard remains mandatory. */
	bindAgentTaskHost(binding: Omit<AgentTaskHostBinding, "scope">): AgentTaskHost {
		if (!this.open) throw new Error("Workflow stage generation is closed");
		if (!this.taskScope) throw new Error("Workflow stage task identity is not bound");
		this.taskHost ??= new AgentTaskHost({ ...binding, scope: this.taskScope });
		this.taskHost.updateBinding(binding);
		return this.taskHost;
	}
	hasAgentTaskHost(): boolean {
		return this.taskHost !== undefined;
	}

	/** Aborts synchronously when close begins so stage-owned work can terminate before late delivery. */
	get closeSignal(): AbortSignal {
		return this.closeController.signal;
	}
	private readonly drainAdmittedWork: () => Promise<void>;

	constructor(drainAdmittedWork: (() => Promise<void>) | undefined = undefined, completedKeys: Iterable<string> = []) {
		this.drainAdmittedWork = drainAdmittedWork ?? (async () => {});
		this.completed = new Set(completedKeys);
	}

	static restore(
		entries: Iterable<PersistedWorkflowStageAdmission>,
		drainAdmittedWork?: () => Promise<void>,
	): WorkflowStageAdmissionBoundary {
		return new WorkflowStageAdmissionBoundary(
			drainAdmittedWork,
			Array.from(entries).flatMap((entry) =>
				entry.type === "custom_message" && typeof entry.stageAdmissionKey === "string"
					? [entry.stageAdmissionKey]
					: [],
			),
		);
	}

	/** One FIFO position for an external operation, including its retry waits. */
	runMessageDelivery(
		deliver: () => void | Promise<void>,
		routeLate?: () => void | Promise<void>,
		preserveDestination = false,
	): Promise<void> {
		const late =
			routeLate ??
			(() => {
				throw new Error("Message admission is closed");
			});
		const invoke = (): void | Promise<void> => {
			if (!preserveDestination) return deliver();
			// Stage close drains the destination reserved at arrival. SDK commits
			// inside this operation must not be reclassified as late on retry or
			// after waiting for an earlier FIFO slot. Revoke on settlement so detached
			// descendants cannot admit new work into a closed generation.
			const reservation = { active: true };
			return this.messageAdmissionContext.run(reservation, async () => {
				try {
					await deliver();
				} finally {
					reservation.active = false;
				}
			});
		};
		return this.admit(undefined, () => this.serializeMessageDelivery(invoke), late).completion;
	}

	/** Reentrant SDK commits stay inside their producer's FIFO position. */
	serializeMessageDelivery(deliver: () => void | Promise<void>): Promise<void> {
		if (this.messageDeliveryContext.getStore()) return this.invoke(deliver);
		const invoke = () => this.messageDeliveryContext.run(true, () => this.invoke(deliver));
		const delivery = this.messageDeliveryTail ? this.messageDeliveryTail.then(invoke) : invoke();
		const settled = delivery.catch(() => undefined);
		this.messageDeliveryTail = settled;
		this.messageDeliveries.add(settled);
		void settled.then(() => {
			this.messageDeliveries.delete(settled);
			if (this.messageDeliveryTail === settled) this.messageDeliveryTail = undefined;
		});
		return delivery;
	}

	/** Excludes tracked model turns: joining those from a native poll would deadlock. */
	async waitForMessageDeliveries(): Promise<void> {
		while (this.messageDeliveries.size > 0) await Promise.all([...this.messageDeliveries]);
	}

	hasMessageDeliveries(): boolean {
		return this.messageDeliveries.size > 0;
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
				return {
					decision: "duplicate",
					completion: this.invocationContext.getStore() === key ? Promise.resolve() : inFlight,
				};
			}
		}
		const admitted = this.open || this.messageAdmissionContext.getStore()?.active === true;
		const decision: WorkflowStageAdmissionDecision = admitted ? "admitted" : "late";
		let completion: Promise<void>;
		if (key === undefined) {
			completion = this.invoke(admitted ? deliver : routeLate);
		} else {
			let resolveCompletion!: () => void;
			let rejectCompletion!: (reason?: unknown) => void;
			completion = new Promise<void>((resolve, reject) => {
				resolveCompletion = resolve;
				rejectCompletion = reject;
			});
			void completion.catch(() => {});
			this.inFlight.set(key, completion);
			const delivery = this.invocationContext.run(key, () => this.invoke(admitted ? deliver : routeLate));
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

	/** Join already-reserved queue commits before a native turn polls its input. */
	async waitForPendingDeliveries(): Promise<void> {
		await Promise.allSettled([...this.pending]);
	}

	hasPendingDeliveries(): boolean {
		return this.pending.size > 0;
	}

	registerOwnedSubagentRun(runId: string): void {
		this.ownedSubagentRunIds.add(runId);
	}

	ownsSubagentRun(runId: string): boolean {
		return this.ownedSubagentRunIds.has(runId);
	}

	isOpen(): boolean {
		return this.open;
	}

	seal(): void {
		this.open = false;
		this.taskClose ??= this.taskHost?.close("stage-close");
	}

	close(): Promise<void> {
		this.seal();
		if (!this.closeController.signal.aborted) this.closeController.abort();
		this.closePromise ??= this.finishClose();
		return this.closePromise;
	}

	private async finishClose(): Promise<void> {
		await Promise.allSettled([...this.pending]);
		await this.drainAdmittedWork();
		const closed = await this.taskClose;
		if (closed && !closed.ok) throw this.taskHost!.closeError("stage-close", closed.error);
	}

	private invoke(callback: () => void | Promise<void>): Promise<void> {
		try {
			return Promise.resolve(callback());
		} catch (error) {
			return Promise.reject(error);
		}
	}
}
