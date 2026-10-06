import { getDurableBackend } from "../durable/factory.js";
import type { Store } from "../shared/store.js";
import type { PiExecuteContext } from "./public-types.js";

const anonymousCallers = new WeakMap<object, string>();

export class WorkflowInstanceOwnershipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowInstanceOwnershipError";
	}
}

/** Session IDs survive host replacement; unattributed callers retain object-local authority only. */
export function workflowCaller(ctx: Pick<PiExecuteContext, "sessionId" | "sessionManager">): string {
	const sessionId = ctx.sessionId ?? ctx.sessionManager?.getSessionId?.();
	if (sessionId) return sessionId;
	const caller = ctx.sessionManager ?? ctx;
	let id = anonymousCallers.get(caller);
	if (id === undefined) {
		id = crypto.randomUUID();
		anonymousCallers.set(caller, id);
	}
	return id;
}

/** Admission metadata, not the disposable routing reservation, owns a live or retained instance. */
export function assertWorkflowInstanceOwner(id: string, ctx: PiExecuteContext, store: Store): void {
	const runs = store.runs();
	const backend = getDurableBackend();
	const seen = new Set<string>();
	const assertOne = (runId: string): void => {
		if (seen.has(runId)) return;
		seen.add(runId);
		const local = runs.find((run) => run.id === runId);
		const durable = backend.getWorkflow(runId);
		const modelOwner = durable?.modelOwner ?? local?.modelOwner;
		if (modelOwner !== undefined) {
			if (modelOwner !== workflowCaller(ctx))
				throw new WorkflowInstanceOwnershipError("Workflow instance belongs to another caller/session.");
		} else if ((durable?.origin ?? local?.origin) === "agent") {
			throw new WorkflowInstanceOwnershipError(
				"Workflow instance ownership is unavailable; another caller cannot assume authority.",
			);
		}
		const parentId = durable?.rootWorkflowId ?? local?.parentRunId;
		if (parentId !== undefined) assertOne(parentId);
	};
	assertOne(id);
	// Inspection/control of a root can include its authored children, including expanded stage targets.
	const descendants = [id];
	for (const parentId of descendants) {
		for (const run of runs) {
			if (run.parentRunId !== parentId || descendants.includes(run.id)) continue;
			assertOne(run.id);
			descendants.push(run.id);
		}
	}
}
