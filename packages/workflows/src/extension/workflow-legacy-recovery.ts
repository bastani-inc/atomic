import { isDatabaseExecutor } from "../durable/dbos-owner-fence.js";
import { getDurableBackend } from "../durable/factory.js";
import { isSdkDurableRunInScope } from "../durable/sdk-recovery-scope.js";
import { isFullRunId } from "../shared/run-id.js";
import type { PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import type { ExtensionRuntime } from "./runtime.js";
import { WorkflowInstanceOwnershipError, workflowCaller } from "./workflow-instance-owner.js";
import type { WorkflowOwnerResources } from "./workflow-owner-resources.js";

export async function enrollLegacySdkRecovery(
	args: WorkflowToolArgs,
	ctx: PiExecuteContext,
	access: "sdk" | undefined,
	runtime: ExtensionRuntime,
	owner: WorkflowOwnerResources,
	signal?: AbortSignal,
): Promise<void> {
	const id = args.runId;
	signal?.throwIfAborted();
	if (
		access !== "sdk" ||
		args.action !== "resume" ||
		args.legacyRecovery?.olderWorkersStopped !== true ||
		args.stageId !== undefined ||
		args.all === true ||
		id === undefined ||
		!isFullRunId(id)
	) {
		throw new WorkflowInstanceOwnershipError(
			"Legacy recovery requires an SDK root resume with its full UUID and confirmation that older workers have stopped.",
		);
	}
	if (owner.store.runs().some((run) => run.id === id)) {
		throw new WorkflowInstanceOwnershipError(
			"Legacy enrollment cannot replace a locally attached workflow executor.",
		);
	}
	const inspected = await runtime.inspectDurableWorkflow(id);
	if (inspected.kind !== "found") throw new WorkflowInstanceOwnershipError(inspected.message);
	const backend = getDurableBackend();
	const handle = backend.getLoadableWorkflow(id);
	const interruptedEnrollment =
		handle?.legacyRecoveryPending === true &&
		handle.ownerLiveness === "dead" &&
		["blocked", "paused"].includes(handle.status);
	if (
		handle === undefined ||
		!isSdkDurableRunInScope(handle, typeof ctx.cwd === "string" ? ctx.cwd : undefined) ||
		handle.ownerExecutorId === undefined ||
		(isDatabaseExecutor(handle.ownerExecutorId) && !interruptedEnrollment) ||
		!["running", "paused", "blocked"].includes(handle.status) ||
		backend.enrollLegacyWorkflow === undefined
	) {
		throw new WorkflowInstanceOwnershipError(
			"Legacy recovery is unavailable for this run or working directory; inspect it without taking ownership.",
		);
	}
	signal?.throwIfAborted();
	if (
		!(await backend.enrollLegacyWorkflow(id, { olderWorkersStopped: true, modelOwner: workflowCaller(ctx), signal }))
	) {
		throw new WorkflowInstanceOwnershipError(
			"Legacy workflow ownership changed while enrollment was pending; inspect it again before retrying.",
		);
	}
}
