/**
 * #5492: a finished invocation that still owes a sender an undeliverable notice keeps its route past the retention, so
 * the notice can go out over it, and does not take the place of a recently finished invocation that owes none. Once its
 * notices went out, the retention applies to it again: the bridge withdraws the routes of finished invocations past the
 * bound without waiting for another invocation to finish.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import {
	registerPendingStageIntercomBridge,
	TERMINAL_INVOCATION_ROUTE_RETENTION,
} from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

/** Finished invocations past the retention. */
const PAST_RETENTION = 3;

const disposals: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});

/** A workflows route bridge over a real store, whose Intercom side records routes and answers notices. */
async function bridgeHost() {
	const store = createStore();
	const backend = await createMemoryTestBackend();
	bindStoreDurableBackend(store, backend);
	const routed = new Set<string>();
	const state = { noticesGoOut: false, noticesSent: 0 };
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
						payload.completion = Promise.resolve(state.noticesGoOut);
						if (state.noticesGoOut) state.noticesSent += 1;
					}
				},
			},
		},
		store,
	);
	disposals.push(bridge);
	/** Runs one invocation to completion; with `owesNotice`, a message queued for its stage that never started. */
	const finish = async (name: string, owesNotice: boolean): Promise<string> => {
		const id = testRunId(name);
		const group = `workflow:${id}`;
		await backend.commitWorkflowRegistration({ workflowId: id, name, inputs: {}, status: "running", createdAt: 1 });
		store.recordRunStart({
			id,
			name,
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [{ id: "pending-stage", name: "pending-stage", status: "pending", parentIds: [], toolEvents: [] }],
			startedAt: 1,
		});
		if (owesNotice) {
			const queued = await store.queueStageMessage(
				{
					runId: id,
					stageKey: "pending-stage",
					from: { id: "sender", group },
					message: { id: `message-${name}`, timestamp: 1, content: { text: "hello" } },
					queuedAt: "2026-11-18T00:00:00.000Z",
				},
				group,
				group,
				backend,
			);
			assert.equal(queued?.ok, true);
		}
		store.recordRunStart({ ...store.run(id)!, status: "completed", endedAt: 2 });
		await bridge.flush();
		return id;
	};
	const settle = async (): Promise<void> => {
		for (let pass = 0; pass < 3; pass++) {
			bridge.refresh();
			await bridge.flush();
		}
	};
	return { routed, state, finish, settle };
}

test("finished invocations kept past the bound while they owed notices give up their routes once the notices went out (#5492)", async () => {
	const host = await bridgeHost();
	const invocations = TERMINAL_INVOCATION_ROUTE_RETENTION + PAST_RETENTION;
	for (let index = 0; index < invocations; index++) await host.finish(`notice-${index}`, true);
	assert.equal(host.routed.size, invocations, "every finished invocation that owes a notice keeps its route");

	host.state.noticesGoOut = true;
	await host.settle();
	assert.equal(host.state.noticesSent, invocations);
	assert.equal(
		host.routed.size,
		TERMINAL_INVOCATION_ROUTE_RETENTION,
		"the retention applies again once no notice is owed",
	);
});

test("an invocation that owes a notice does not take the place of a recently finished one (#5492)", async () => {
	const host = await bridgeHost();
	const owing = [await host.finish("owes-0", true), await host.finish("owes-1", true)];
	const recent: string[] = [];
	for (let index = 0; index < TERMINAL_INVOCATION_ROUTE_RETENTION; index++)
		recent.push(await host.finish(`recent-${index}`, false));
	await host.settle();

	assert.deepEqual(
		[...owing, ...recent].filter((id) => !host.routed.has(id)),
		[],
		`the ${TERMINAL_INVOCATION_ROUTE_RETENTION} most recently finished invocations and the two owing notices all keep their routes`,
	);
});
