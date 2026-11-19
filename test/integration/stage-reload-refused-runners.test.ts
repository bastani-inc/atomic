import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import type { OperationId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { collectGarbage } from "../helpers/collect-garbage.js";

test("a stage reload does not keep the runners of refused ordinary launches (#5629)", async () => {
	const harness = await createHarness({
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: randomUUID(),
			workflowStageId: "stage",
			workflowStageName: "stage",
			constraints: { disableWorkflowTool: true },
		},
	});
	try {
		const host = harness.session.getAgentTaskHost();
		const launch = async (index: number) => {
			const payload = Buffer.alloc(1024 * 1024, index);
			await assert.rejects(
				host.startAgentTask({ kind: "agent", agent: "worker", task: "work" }, randomUUID() as OperationId, () => {
					throw new Error(`unexpected dispatch: ${payload[0]}`);
				}),
				/Task owner is closed/,
			);
			return new WeakRef(payload);
		};
		await harness.session.reload({
			beforeSessionStart: async () => {
				await launch(0); // Start any one-time host services before the measured calls.
				const refs: WeakRef<Buffer>[] = [];
				for (let i = 1; i <= 64; i++) refs.push(await launch(i));
				await collectGarbage(5);
				assert.equal(refs.filter((ref) => ref.deref() !== undefined).length, 0);
			},
		});
	} finally {
		await harness.cleanup();
	}
});
