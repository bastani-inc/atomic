import type { PendingStageMessageDelivery } from "../shared/store-types.js";

/** A position in one workflow's receipt change log; a reset workflow starts a new log. */
export interface PendingStageReceiptCursor {
	readonly log: object;
	readonly length: number;
}

/** Messages whose delivery receipts changed since a cursor; `undefined` when any message may have changed. */
export interface PendingStageReceiptChanges {
	readonly cursor: PendingStageReceiptCursor;
	readonly messageIds: readonly string[] | undefined;
}

type Admissions = Set<string | undefined>;

/**
 * One stage's receipts for one message. A receipt is keyed by its logical run (`undefined` for receipts
 * recorded without accounting), its session and its admission, each possibly absent. A context admission
 * with a session also records a receipt that matches any session of the stage.
 */
class StageReceipts {
	private readonly exact = new Map<string | undefined, Map<string | undefined, Admissions>>();
	private readonly anySession = new Map<string | undefined, Admissions>();

	has(logicalRunId: string | undefined, sessionId: string | undefined, admission: string | undefined): boolean {
		return this.exact.get(logicalRunId)?.get(sessionId)?.has(admission) ?? false;
	}

	hasAnySession(logicalRunId: string | undefined, admission: string | undefined): boolean {
		return this.anySession.get(logicalRunId)?.has(admission) ?? false;
	}

	/** Add a receipt; returns whether it was new. */
	add(logicalRunId: string | undefined, sessionId: string | undefined, admission: string | undefined): boolean {
		let bySession = this.exact.get(logicalRunId);
		if (bySession === undefined) {
			bySession = new Map();
			this.exact.set(logicalRunId, bySession);
		}
		let admissions = bySession.get(sessionId);
		if (admissions === undefined) {
			admissions = new Set();
			bySession.set(sessionId, admissions);
		}
		if (admissions.has(admission)) return false;
		admissions.add(admission);
		return true;
	}

	addAnySession(logicalRunId: string | undefined, admission: string | undefined): boolean {
		let admissions = this.anySession.get(logicalRunId);
		if (admissions === undefined) {
			admissions = new Set();
			this.anySession.set(logicalRunId, admissions);
		}
		if (admissions.has(admission)) return false;
		admissions.add(admission);
		return true;
	}
}

interface WorkflowReceipts {
	/** message → delivery run → stage → receipts */
	readonly byMessage: Map<string, Map<string, Map<string, StageReceipts>>>;
	/** Message ids in the order their receipts changed. */
	readonly log: string[];
}

/** Archived sticky delivery receipts per durable workflow, looked up through nested maps without key building. */
export class PendingStageReceiptIndex {
	private readonly workflows = new Map<string, WorkflowReceipts>();

	/**
	 * Record one archived delivery. Returns whether the exact receipt was new, which decides whether its
	 * accounting may raise the delivery count.
	 */
	add(workflowId: string, messageId: string, delivery: PendingStageMessageDelivery, logicalRunId?: string): boolean {
		let workflow = this.workflows.get(workflowId);
		if (workflow === undefined) {
			workflow = { byMessage: new Map(), log: [] };
			this.workflows.set(workflowId, workflow);
		}
		let byRun = workflow.byMessage.get(messageId);
		if (byRun === undefined) {
			byRun = new Map();
			workflow.byMessage.set(messageId, byRun);
		}
		let byStage = byRun.get(delivery.runId);
		if (byStage === undefined) {
			byStage = new Map();
			byRun.set(delivery.runId, byStage);
		}
		let receipts = byStage.get(delivery.stageId);
		if (receipts === undefined) {
			receipts = new StageReceipts();
			byStage.set(delivery.stageId, receipts);
		}
		const added = receipts.add(logicalRunId, delivery.sessionId, delivery.admission);
		let changed = added;
		if (receipts.add(logicalRunId, undefined, undefined)) changed = true;
		if (
			delivery.admission === "context" &&
			delivery.sessionId !== undefined &&
			receipts.addAnySession(logicalRunId, "context")
		)
			changed = true;
		if (changed) workflow.log.push(messageId);
		return added;
	}

	/** Whether a receipt exists for the delivery, counted under `logicalRunId` or recorded without accounting. */
	has(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		logicalRunId: string,
		anySession = false,
	): boolean {
		const receipts = this.workflows
			.get(workflowId)
			?.byMessage.get(messageId)
			?.get(delivery.runId)
			?.get(delivery.stageId);
		if (receipts === undefined) return false;
		if (anySession && delivery.admission === "context")
			return (
				receipts.hasAnySession(logicalRunId, delivery.admission) ||
				receipts.hasAnySession(undefined, delivery.admission)
			);
		return (
			receipts.has(logicalRunId, delivery.sessionId, delivery.admission) ||
			receipts.has(undefined, delivery.sessionId, delivery.admission)
		);
	}

	changesSince(workflowId: string, cursor: PendingStageReceiptCursor | undefined): PendingStageReceiptChanges {
		let workflow = this.workflows.get(workflowId);
		if (workflow === undefined) {
			workflow = { byMessage: new Map(), log: [] };
			this.workflows.set(workflowId, workflow);
		}
		const next = { log: workflow.log, length: workflow.log.length };
		if (cursor === undefined || cursor.log !== workflow.log || cursor.length > workflow.log.length)
			return { cursor: next, messageIds: undefined };
		return { cursor: next, messageIds: workflow.log.slice(cursor.length) };
	}

	delete(workflowId: string): void {
		this.workflows.delete(workflowId);
	}

	clear(): void {
		this.workflows.clear();
	}
}
