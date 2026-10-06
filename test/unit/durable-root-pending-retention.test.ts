import assert from "node:assert/strict";
import { test } from "vitest";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

function entry(runId: string, id: string, status: "queued" | "delivered" = "delivered"): PendingStageMessage {
	return {
		runId,
		id,
		stageKey: "review",
		status,
		queuedAt: "now",
		from: { id: "sender", name: "sender" },
		message: { id, timestamp: 1, content: { text: "amendment".repeat(20) } },
	};
}

test("bounds settled messages across sibling runs with cold retry deduplication (#3467)", async () => {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend(sdk);
	const root = "root";
	backend.registerWorkflow({ workflowId: root, name: "root", inputs: {}, createdAt: 1, status: "running" });
	await backend.flush();
	let firstBytes = 0;
	for (let index = 0; index < 200; index++) {
		const childId = `child-${index}`;
		const child = new ScopedDurableBackend(backend, { rootWorkflowId: root, scopePrefix: childId });
		await child.persistPendingStageMessages(childId, [entry(childId, "message")]);
		if (index === 49) firstBytes = Buffer.byteLength(JSON.stringify(backend.toMetadata(root)));
	}
	await backend.persistPendingStageMessages(root, [entry(root, "pending", "queued")]);
	const messages = backend.getWorkflow(root)?.pendingStageMessages ?? [];
	assert.equal(messages.filter((message) => message.status === "delivered").length, 50);
	assert.ok(Buffer.byteLength(JSON.stringify(backend.toMetadata(root))) < firstBytes + 1_000);
	const resumed = new DbosDurableBackend(sdk);
	await resumed.hydrateWorkflow(root);
	assert.deepEqual(resumed.getWorkflow(root)?.pendingStageMessages, messages);
	assert.equal((await resumed.readSettledPendingStageMessage(root, "message", "child-0"))?.status, "delivered");
	const store = createStore();
	store.recordRunStart({ id: "child-0", name: "child", inputs: {}, status: "running", stages: [], startedAt: 1 });
	const scoped = new ScopedDurableBackend(resumed, { rootWorkflowId: root, scopePrefix: "child-0" });
	const retry = await store.queueStageMessage(entry("child-0", "message"), undefined, undefined, scoped);
	assert.ok(retry?.ok);
	assert.equal(retry.deduplicated, true);
	assert.equal(retry.entry.status, "delivered");
	assert.equal(store.pendingStageMessagesFor("child-0", "review").length, 0);
});

test("archives sibling receipts before replacing root metadata through write failures (#3467)", async () => {
	const sdk = createMockSdk();
	let failedPrefix: string | undefined;
	const backend = new DbosDurableBackend({
		...sdk,
		recordStepOutput: async (workflowId, stepName, output) => {
			if (failedPrefix !== undefined && stepName.startsWith(failedPrefix)) throw new Error("interrupted");
			await sdk.recordStepOutput(workflowId, stepName, output);
		},
	});
	backend.registerWorkflow({ workflowId: "root", name: "root", inputs: {}, createdAt: 1, status: "running" });
	await backend.flush();
	for (let index = 0; index < 50; index++) {
		await backend.persistPendingStageMessages("root", [entry(`child-${index}`, "message")], `child-${index}`);
	}
	for (const prefix of ["__atomic_pending_receipt:", "__atomic_metadata:"]) {
		failedPrefix = prefix;
		await assert.rejects(
			backend.persistPendingStageMessages("root", [entry("child-50", "message")], "child-50"),
			/interrupted/,
		);
		const resumed = new DbosDurableBackend(sdk);
		await resumed.hydrateWorkflow("root");
		assert.equal(resumed.getWorkflow("root")?.pendingStageMessages?.length, 50);
		assert.equal(resumed.getWorkflow("root")?.pendingStageMessages?.[0]?.runId, "child-0");
	}
	failedPrefix = undefined;
	await backend.persistPendingStageMessages("root", [entry("child-50", "message")], "child-50");
	assert.equal(backend.getWorkflow("root")?.pendingStageMessages?.length, 50);
	assert.equal((await backend.readSettledPendingStageMessage("root", "message", "child-0"))?.status, "delivered");
});
