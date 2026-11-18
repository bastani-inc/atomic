/**
 * #5492: a finished invocation that still owes a sender an undeliverable notice keeps its route past the retention, so
 * the notice can go out over it. Once its notices went out, the retention applies to it again: the bridge withdraws the
 * routes of finished invocations past the bound without waiting for another invocation to finish.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import {
	registerPendingStageIntercomBridge,
	TERMINAL_INVOCATION_ROUTE_RETENTION,
} from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

/** Finished invocations past the retention, each owing a notice for a message its pending stage never took. */
const PAST_RETENTION = 3;

test("finished invocations kept past the bound while they owed notices give up their routes once the notices went out (#5492)", async () => {
	const store = createStore();
	const backend = await createMemoryTestBackend();
	bindStoreDurableBackend(store, backend);
	const routed = new Set<string>();
	let noticesGoOut = false;
	let noticesSent = 0;
	const bridge = registerPendingStageIntercomBridge(
		{
			events: {
				emit(event: string, payload: Record<string, unknown>) {
					if (event === "atomic:workflow-pending-stage-route") {
						routed.add(payload.runId as string);
						payload.completion = Promise.resolve();
					} else if (event === "atomic:workflow-pending-stage-route-retired") {
						routed.delete(payload.runId as string);
					} else if (event === "atomic:workflow-pending-stage-undeliverable") {
						payload.handled = true;
						payload.completion = Promise.resolve(noticesGoOut);
						if (noticesGoOut) noticesSent += 1;
					}
				},
			},
		},
		store,
	);
	try {
		const invocations = TERMINAL_INVOCATION_ROUTE_RETENTION + PAST_RETENTION;
		for (let index = 0; index < invocations; index++) {
			const id = testRunId(`notice-${index}`);
			const group = `workflow:${id}`;
			await backend.commitWorkflowRegistration({
				workflowId: id,
				name: "owes-a-notice",
				inputs: {},
				status: "running",
				createdAt: index + 1,
			});
			store.recordRunStart({
				id,
				name: "owes-a-notice",
				inputs: {},
				status: "running",
				toolNodes: [],
				stages: [{ id: "pending-stage", name: "pending-stage", status: "pending", parentIds: [], toolEvents: [] }],
				startedAt: index + 1,
			});
			const queued = await store.queueStageMessage(
				{
					runId: id,
					stageKey: "pending-stage",
					from: { id: "sender", group },
					message: { id: `message-${index}`, timestamp: index, content: { text: "hello" } },
					queuedAt: "2026-11-18T00:00:00.000Z",
				},
				group,
				group,
				backend,
			);
			assert.equal(queued?.ok, true);
			store.recordRunStart({ ...store.run(id)!, status: "completed", endedAt: index + 2 });
			await bridge.flush();
		}
		assert.equal(routed.size, invocations, "every finished invocation that owes a notice keeps its route");

		noticesGoOut = true;
		for (let pass = 0; pass < 3; pass++) {
			bridge.refresh();
			await bridge.flush();
		}
		assert.equal(noticesSent, invocations);
		assert.equal(
			routed.size,
			TERMINAL_INVOCATION_ROUTE_RETENTION,
			"the retention applies again once no notice is owed",
		);
	} finally {
		bridge();
	}
});
