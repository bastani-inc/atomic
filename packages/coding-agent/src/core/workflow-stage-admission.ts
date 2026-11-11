import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { OrchestrationContext } from "./extensions/context-types.ts";
import { AgentTaskHost, type AgentTaskHostBinding } from "./tasks/agent-adapter.js";
import { type ChildTaskCompletionRoute, childTaskCompletionRoute } from "./tasks/child-command-owner.js";
import { taskCompletionEnvelope } from "./tasks/completion.js";
import { commandOutputExcerpt, taskCompletionMessage } from "./tasks/completion-message.js";
import type { OwnerId, OwnerScope, SettlementReceipt, TaskRecord } from "./tasks/contracts.js";
import { ToolDetachmentError } from "./tool-detachment-errors.ts";

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

/** A task of the stage that settled while the stage had no session; handed to the next session that binds. */
export interface ParkedTaskSettlement {
	readonly ownerId: OwnerId;
	readonly receipt: SettlementReceipt;
	readonly kind?: TaskRecord["kind"];
}

/**
 * The close reason of every stage generation. One shared value: an error made at close time would keep, in its stack,
 * the session that closed the generation reachable for as long as the stage lives.
 */
const STAGE_GENERATION_CLOSED = new DOMException("Workflow stage generation closed", "AbortError");

/**
 * Runs a callback in the async context of this module's load, outside every session. The stage's task owner outlives
 * the session that first binds it, so its watches and timers must not start in that session's async context.
 */
const outsideAnySession = AsyncLocalStorage.snapshot();

function admissionKeys(entries: Iterable<PersistedWorkflowStageAdmission>): string[] {
	return Array.from(entries).flatMap((entry) =>
		entry.type === "custom_message" && typeof entry.stageAdmissionKey === "string" ? [entry.stageAdmissionKey] : [],
	);
}

/** The stage's task a settlement reports, read from the owner's snapshot while the stage is parked. */
function settledTask(host: AgentTaskHost, receipt: SettlementReceipt): TaskRecord | undefined {
	const watched = host.watchOwnerTasks();
	if (!watched.ok) return undefined;
	const task = watched.value.snapshot.tasks.find((item) => item.ref.taskId === receipt.taskId);
	watched.value.dispose();
	return task;
}

/**
 * Hand a worker's settled shell to the live worker that launched it, as the stage's session would. A close of the stage
 * may leave its record unreadable: the notice then still names the shell and why it stopped.
 */
async function deliverToWorker(
	host: AgentTaskHost,
	route: ChildTaskCompletionRoute,
	settlement: ParkedTaskSettlement,
	task: TaskRecord | undefined,
): Promise<void> {
	const lease = host.resolveTask(settlement.receipt.taskId);
	const output = lease.ok && task !== undefined ? await commandOutputExcerpt(host, lease.value, task) : undefined;
	const envelope = taskCompletionEnvelope(settlement.ownerId, settlement.receipt, "command");
	await route.deliver(taskCompletionMessage(envelope, task, output));
}

/**
 * Let go of everything a workflow stage's admission boundary holds of the session the stage is about to dispose, so a
 * released stage keeps none of it reachable: its task host refuses launches, delivers no heartbeat, reports no cleanup
 * quarantine (the owner still tracks it, and the stage's close still fails if it is never confirmed), and queues the
 * completions of tasks that settle meanwhile for the stage's next session, and its admission keys are forgotten
 * until that session restores them from its transcript. Does nothing for a context that is not a workflow stage's.
 */
export function parkWorkflowStageForRelease(orchestrationContext: OrchestrationContext): void {
	if (orchestrationContext.kind !== "workflow-stage") return;
	orchestrationContext.messageAdmission?.boundary.park();
}

export class WorkflowStageAdmissionBoundary {
	private open = true;
	private parked = false;
	private readonly completed: Set<string>;
	private readonly parkedSettlements: ParkedTaskSettlement[] = [];
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
		const scope = this.taskScope;
		this.taskHost ??= outsideAnySession(() => new AgentTaskHost({ ...binding, scope }));
		if (this.parked) this.taskHost.reportSettledTasks();
		this.parked = false;
		this.taskHost.updateBinding({ authorizeCommandLaunch: undefined, ...binding });
		return this.taskHost;
	}
	hasAgentTaskHost(): boolean {
		return this.taskHost !== undefined;
	}

	/** The stage's task host, whichever of its sessions bound it; undefined until the first binds it. */
	agentTaskHost(): AgentTaskHost | undefined {
		return this.taskHost;
	}

	/** Task completions that arrived while the stage was parked, handed once to the session that binds next. */
	takeParkedTaskSettlements(): ParkedTaskSettlement[] {
		return this.parkedSettlements.splice(0);
	}

	/** See {@link parkWorkflowStageForRelease}. */
	park(): void {
		this.completed.clear();
		const host = this.taskHost;
		const scope = this.taskScope;
		if (!host || !scope) return;
		this.parked = true;
		const refuseParkedLaunch = (): void => {
			throw new ToolDetachmentError("stage-parked", { sessionId: scope.sessionId });
		};
		host.updateBinding({
			heartbeat: undefined,
			onTaskCleanupQuarantined: undefined,
			authorizeLaunch: refuseParkedLaunch,
			// The stage's live workers keep running their shells in its owner while it is released (#4639).
			authorizeCommandLaunch: (_intent, origin) => {
				if (origin !== "subagent-child") refuseParkedLaunch();
			},
			onTaskSettled: (ref, receipt) => {
				host.retainTaskRecord(receipt.taskId);
				const task = settledTask(host, receipt);
				const settlement: ParkedTaskSettlement = { ownerId: ref.ownerId, receipt, kind: task?.kind };
				// Only shells a worker launched have a worker's route.
				const worker = childTaskCompletionRoute(host, receipt.taskId);
				if (worker === undefined) {
					this.parkedSettlements.push(settlement);
					return;
				}
				// A worker that ended before its notice arrived leaves it to the stage's next session.
				void deliverToWorker(host, worker, settlement, task).then(
					() => host.releaseTaskRecord(receipt.taskId),
					() => this.parkedSettlements.push(settlement),
				);
			},
		});
	}

	/** Take back the admission keys a reopened session's transcript records. */
	restoreCompleted(entries: Iterable<PersistedWorkflowStageAdmission>): void {
		for (const key of admissionKeys(entries)) this.completed.add(key);
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
		return new WorkflowStageAdmissionBoundary(drainAdmittedWork, admissionKeys(entries));
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
		if (!this.closeController.signal.aborted) this.closeController.abort(STAGE_GENERATION_CLOSED);
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
