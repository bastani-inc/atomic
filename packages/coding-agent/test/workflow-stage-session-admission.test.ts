import assert from "node:assert/strict";
import { test } from "vitest";
import type { OrchestrationContext } from "../src/core/extensions/context-types.js";
import { parkWorkflowStageForRelease, WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.js";
import { createHarness } from "./suite/harness.js";

interface StageMessageAdmission {
	readonly boundary: WorkflowStageAdmissionBoundary;
	readonly extensionState: Map<string, object>;
	isOpen(): boolean;
}

function stageContext() {
	return {
		kind: "workflow-stage" as const,
		workflowRunId: crypto.randomUUID(),
		workflowStageId: "stage-a",
		workflowStageName: "Stage A",
		constraints: { disableWorkflowTool: true as const },
	};
}

const admissionOf = (context: object): StageMessageAdmission | undefined =>
	(context as { messageAdmission?: StageMessageAdmission }).messageAdmission;

test("a session opened for a workflow stage gives the stage a message admission that follows its boundary (#4309)", async () => {
	const context = stageContext();
	const harness = await createHarness({ orchestrationContext: context });
	try {
		const admission = admissionOf(context);
		assert.ok(admission !== undefined);
		assert.equal(admission.isOpen(), true);
		assert.ok(admission.extensionState instanceof Map);
		assert.equal(admission.extensionState.size, 0);

		admission.boundary.seal();

		assert.equal(admission.isOpen(), false);
	} finally {
		await harness.cleanup();
	}
});

test("the stage keeps its first admission for the sessions it opens later (#4309)", async () => {
	const context = stageContext();
	const first = await createHarness({ orchestrationContext: context });
	try {
		const admission = admissionOf(context);
		assert.ok(admission !== undefined);
		await first.cleanup();

		const second = await createHarness({ orchestrationContext: context });
		try {
			assert.equal(admissionOf(context), admission);
			assert.equal(admission.isOpen(), true);
		} finally {
			await second.cleanup();
		}
	} finally {
		await first.cleanup();
	}
});

test("closing a stage's admission aborts its close signal once, naming the closed generation (#4309)", async () => {
	const boundary = new WorkflowStageAdmissionBoundary();
	assert.equal(boundary.closeSignal.aborted, false);

	await boundary.close();

	assert.equal(boundary.isOpen(), false);
	assert.equal(boundary.closeSignal.aborted, true);
	const reason = boundary.closeSignal.reason;
	assert.ok(reason instanceof DOMException);
	assert.equal(reason.name, "AbortError");
	assert.equal(reason.message, "Workflow stage generation closed");

	await boundary.close();

	assert.equal(boundary.closeSignal.reason, reason);
});

test("stage generations close with one shared reason, so no generation's close holds anything of its own (#4309)", async () => {
	const first = new WorkflowStageAdmissionBoundary();
	const second = new WorkflowStageAdmissionBoundary();

	await first.close();
	await second.close();

	assert.equal(first.closeSignal.reason, second.closeSignal.reason);
});

test("a restored transcript counts only custom messages with a text admission key as admitted (#4309)", async () => {
	const entries = [
		{ type: "custom_message", stageAdmissionKey: "saved" },
		{ type: "custom", stageAdmissionKey: "other-entry" },
		{ type: "custom_message" },
	];
	const restored = WorkflowStageAdmissionBoundary.restore(entries);
	const reopened = new WorkflowStageAdmissionBoundary();
	reopened.restoreCompleted(entries);

	for (const boundary of [restored, reopened]) {
		const noop = (): void => {};
		assert.equal(boundary.admit("saved", noop, noop).decision, "duplicate");
		const other = boundary.admit("other-entry", noop, noop);
		assert.equal(other.decision, "admitted");
		await other.completion;
		await boundary.close();
	}
});

test("parking a workflow stage that has no admission yet does nothing (#4309)", () => {
	assert.doesNotThrow(() => parkWorkflowStageForRelease(stageContext()));
});

test("parking a context of another kind leaves the admission it carries alone (#4309)", async () => {
	const boundary = WorkflowStageAdmissionBoundary.restore([{ type: "custom_message", stageAdmissionKey: "saved" }]);
	// The public export is callable from JavaScript with any orchestration context; only a stage's is parked.
	const context = { ...stageContext(), kind: "subagent", messageAdmission: { boundary } };

	parkWorkflowStageForRelease(context as unknown as OrchestrationContext);

	const noop = (): void => {};
	assert.equal(boundary.admit("saved", noop, noop).decision, "duplicate");
	await boundary.close();
});
