import assert from "node:assert/strict";
import { test } from "vitest";
import { DbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { classifyLatestMetadata, encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import type { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { getDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

for (const ownerState of ["own-dead", "own-alive", "foreign-dead", "foreign-alive"] as const) {
	test(`same-ID checkpoint reconciliation across failed generations respects ${ownerState} (#3419)`, async () => {
		const rows = new Map<
			string,
			{
				workflowID: string;
				status: string;
				input: readonly WorkflowSerializableValue[];
				output?: WorkflowSerializableValue;
			}
		>();
		const main = async () => null;
		const checkpoint = async (_id: string, _step: string, output: WorkflowSerializableValue) => output;
		const dbos = {
			launch: async () => {},
			shutdown: async () => {},
			startWorkflow:
				(target: unknown, params: { workflowID: string }) =>
				async (...input: WorkflowSerializableValue[]) => {
					const output = target === checkpoint ? input[2] : undefined;
					rows.set(params.workflowID, { workflowID: params.workflowID, status: "SUCCESS", input, output });
					return { getResult: async () => output };
				},
			listWorkflows: async (query: { workflowIDs?: string[]; workflow_id_prefix?: string }) =>
				[...rows.values()].filter((row) =>
					query.workflowIDs
						? query.workflowIDs.includes(row.workflowID)
						: query.workflow_id_prefix
							? row.workflowID.startsWith(query.workflow_id_prefix)
							: true,
				),
			resumeWorkflow: async () => ({ getResult: async () => undefined }),
			cancelWorkflow: async () => {},
		} as unknown as DbosStatic;
		let unavailable = false;
		let generation = 0;
		const lost = new Set<string>();
		const recovered: string[] = [];
		const makeFence = () => {
			const executorId = `atomic-db-${String(++generation).padStart(8, "0")}-1111-4111-8111-111111111111`;
			return {
				executorId,
				get invalidated() {
					return lost.has(executorId);
				},
				close: async () => {},
				withRowAuthority: async (_authority: object, callback: () => Promise<unknown>) => callback(),
				write: async (_id: string, callback: () => Promise<unknown>) => {
					if (unavailable || lost.has(executorId)) {
						lost.add(executorId);
						throw new DbosDependencyError();
					}
					return callback();
				},
				recover: async (id: string, callback: () => Promise<unknown>) => {
					recovered.push(id);
					assert.ok(lost.has(id), "only a retired own executor can be recovered");
					if (ownerState === "own-alive") return undefined;
					return callback();
				},
				liveness: async (id: string) => (lost.has(id) ? "dead" : "alive"),
			} as unknown as DbosOwnerFence;
		};
		const owner = getDbosProcessOwner();
		const previousFactory = owner.createExecutorFence;
		owner.createExecutorFence = makeFence;
		try {
			const initialFence = makeFence();
			const sdk = createRealDbosHandle(dbos, main, checkpoint, initialFence);
			const backend = new DbosDurableBackend(sdk);
			backend.registerWorkflow({ workflowId: "same-id", name: "test", inputs: {}, status: "running", createdAt: 1 });
			await backend.flush();
			const oldCallback = backend.executionView();
			unavailable = true;
			await assert.rejects(
				backend.recordCheckpointAsync({
					kind: "tool",
					workflowId: "same-id",
					checkpointId: "lost",
					name: "tool",
					argsHash: "hash",
					args: {},
					output: "done",
					completedAt: 2,
				}),
				DbosDependencyError,
			);
			backend.setWorkflowStatus("same-id", "blocked", undefined, true);
			await assert.rejects(backend.flush(), DbosDependencyError);
			assert.equal(generation, 2, "quit attempted another owner while SQL was down");
			unavailable = false;
			if (ownerState.startsWith("foreign")) {
				for (const row of rows.values()) {
					if (!row.workflowID.includes(":checkpoint:__atomic_metadata:")) continue;
					const current = classifyLatestMetadata(await sdk.listStepRecords("same-id"), "same-id");
					assert.equal(current.kind, "current");
					if (current.kind === "current")
						row.output = encodeMetadata({
							...current.metadata,
							ownerExecutorId: "atomic-db-99999999-1111-4111-8111-111111111111",
						});
				}
			}
			if (ownerState !== "own-dead") {
				const before = structuredClone([...rows]);
				await assert.rejects(
					backend.reconcileWorkflowAdmission("same-id"),
					ownerState === "own-alive" ? /still active/ : /ownership changed/,
				);
				assert.deepEqual([...rows], before, "refused adoption cannot mutate authoritative records");
				assert.deepEqual(recovered, ownerState === "own-alive" ? [initialFence.executorId] : []);
				assert.equal(backend.isCheckpointUnavailable("same-id"), true);
				return;
			}
			await backend.reconcileWorkflowAdmission("same-id");
			assert.equal(generation, 3);
			assert.deepEqual(recovered, [initialFence.executorId]);
			const authoritative = classifyLatestMetadata(await sdk.listStepRecords("same-id"), "same-id");
			assert.equal(authoritative.kind, "current");
			if (authoritative.kind === "current") {
				assert.equal(authoritative.metadata.status, "blocked");
				assert.notEqual(authoritative.metadata.ownerExecutorId, initialFence.executorId);
			}
			assert.equal(backend.getWorkflow("same-id")?.status, "blocked");
			assert.equal(backend.isCheckpointUnavailable("same-id"), false);
			await assert.rejects(
				oldCallback.recordCheckpointAsync({
					kind: "tool",
					workflowId: "same-id",
					checkpointId: "late",
					name: "tool",
					argsHash: "hash",
					args: {},
					output: "late",
					completedAt: 3,
				}),
				/generation changed/,
			);
		} finally {
			owner.createExecutorFence = previousFactory;
		}
	});
}
