import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
	DBOS_ADMISSION_TIMEOUT_MS,
	DbosDependencyError,
	dbosAdmissionContext,
} from "../../packages/workflows/src/durable/dbos-admission.js";
import { reconcileDbosAdmission } from "../../packages/workflows/src/durable/dbos-admission-recovery.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import type { DurableWorkflowMetadata } from "../../packages/workflows/src/durable/types.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

type Row = { workflowID: string; status: string; input: readonly WorkflowSerializableValue[]; output?: unknown };

// A DBOS seam whose root markers stay PENDING until an outcome write lands.
// Like the production admission pool (`fenceDbosAdmissionPool`), a marker's own
// continuation inherits the admission signal that started it and cannot
// persist its outcome once that admission is abandoned.
function harness(racedStart?: { readonly id: string; readonly inputs: WorkflowSerializableValue }) {
	const rows = new Map<string, Row>();
	const markers = new Map<string, { signal?: AbortSignal; done: PromiseWithResolvers<WorkflowSerializableValue> }>();
	const waits: { id: string; locked: boolean }[] = [];
	let locked = false;
	let raced = racedStart;
	const marker = (id: string) => {
		let entry = markers.get(id);
		if (entry === undefined) {
			entry = { done: Promise.withResolvers() };
			entry.done.promise.catch(() => {});
			markers.set(id, entry);
		}
		return entry;
	};
	const handle = (id: string) => ({
		workflowID: id,
		getStatus: async () => null,
		getResult: () => {
			waits.push({ id, locked });
			return marker(id).done.promise;
		},
	});
	const main = async (_name: string, inputs: WorkflowSerializableValue) => inputs;
	const checkpoint = async (_id: string, _step: string, output: WorkflowSerializableValue) => output;
	const dbos = {
		launch: async () => {},
		shutdown: async () => {},
		startWorkflow:
			(target: unknown, params: { workflowID: string }) =>
			async (...input: WorkflowSerializableValue[]) => {
				const id = params.workflowID;
				if (target === checkpoint) {
					rows.set(id, { workflowID: id, status: "SUCCESS", input, output: input[2] });
					return { workflowID: id, getStatus: async () => null, getResult: async () => input[2] };
				}
				if (raced?.id === id) {
					// Another invocation inserted this root after the identity check.
					rows.set(id, { workflowID: id, status: "PENDING", input: [input[0] ?? null, raced.inputs] });
					raced = undefined;
					throw new Error(`Workflow ${id} already exists`);
				}
				if (rows.has(id)) throw new Error(`Workflow ${id} already exists`);
				rows.set(id, { workflowID: id, status: "PENDING", input });
				marker(id).signal = dbosAdmissionContext.getStore();
				return handle(id);
			},
		retrieveWorkflow: (id: string) => handle(id),
		listWorkflows: async (query: { workflowIDs?: string[]; workflow_id_prefix?: string }) =>
			[...rows.values()].filter((row) =>
				query.workflowIDs !== undefined
					? query.workflowIDs.includes(row.workflowID)
					: row.workflowID.startsWith(query.workflow_id_prefix ?? ""),
			),
		deleteWorkflows: async () => {},
		cancelWorkflow: async () => {},
		resumeWorkflow: async () => handle(""),
	} as unknown as DbosStatic;
	const fence = {
		executorId: "atomic-db-00000001-1111-4111-8111-111111111111",
		invalidated: false,
		close: async () => {},
		compactMetadata: async () => {},
		withRowAuthority: async (_authority: object, callback: () => Promise<unknown>) => callback(),
		write: async (_id: string, callback: () => Promise<unknown>) => {
			locked = true;
			try {
				return await callback();
			} finally {
				locked = false;
			}
		},
		recover: async (_id: string, callback: () => Promise<unknown>) => callback(),
		liveness: async () => "alive",
	} as unknown as DbosOwnerFence;
	const settle = (id: string): void => {
		const row = rows.get(id);
		assert.ok(row);
		row.status = "SUCCESS";
		row.output = row.input[1];
		marker(id).done.resolve(row.input[1] ?? null);
	};
	return {
		sdk: createRealDbosHandle(dbos, main, checkpoint, fence, [], { settleRootMarker: true }),
		rows,
		waits,
		metadataRows: (id: string) =>
			[...rows.keys()].filter((key) => key.startsWith(`${id}:checkpoint:__atomic_metadata`)),
		/** The original marker continuation's outcome write; refused once its admission is abandoned. */
		completeOriginal(id: string): boolean {
			if (marker(id).signal?.aborted !== false) return false;
			settle(id);
			return true;
		},
		/** A writer outside the abandoned admission's fence (another session, or an already-sent write). */
		completeExternally: settle,
		/** DBOS durably records the root as failed; awaiting its result rethrows the stored error. */
		failExternally(id: string): void {
			const row = rows.get(id);
			assert.ok(row);
			row.status = "ERROR";
			marker(id).done.reject(new Error("root marker failed"));
		},
	};
}

const ticks = async (): Promise<void> => {
	for (let index = 0; index < 50; index++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const deadline = (): DbosDependencyError => new DbosDependencyError("Workflow database admission timed out.");

const inputs = { topic: "x" };
const registration = { workflowId: "root", name: "wf", inputs, status: "running" as const, createdAt: 1 };
const metadata: DurableWorkflowMetadata = {
	workflowId: "root",
	name: "wf",
	inputs,
	status: "running",
	completedCheckpoints: 0,
	pendingPrompts: 0,
	createdAt: 1,
	promptReservationEpoch: "epoch",
	updatedAt: 1,
	ownerExecutorId: "atomic-db-00000001-1111-4111-8111-111111111111",
};

/** First admission starts the marker, then its deadline expires before settlement. */
async function abandonFirstAdmission(h: ReturnType<typeof harness>, backend: DbosDurableBackend): Promise<void> {
	const first = new AbortController();
	const admission = backend.admitWorkflow("root", registration, first.signal);
	await ticks();
	assert.equal(h.rows.get("root")?.status, "PENDING");
	first.abort(deadline());
	await assert.rejects(admission, DbosDependencyError);
	assert.deepEqual(h.metadataRows("root"), []);
}

/** Leave a matching PENDING root without metadata, as an abandoned admission does. */
async function abandonRootStart(h: ReturnType<typeof harness>): Promise<void> {
	const first = new AbortController();
	const start = dbosAdmissionContext.run(first.signal, () => h.sdk.startWorkflow("root", "wf", inputs));
	await ticks();
	first.abort(deadline());
	await assert.rejects(start, DbosDependencyError);
	assert.equal(h.rows.get("root")?.status, "PENDING");
}

afterEach(() => {
	vi.useRealTimers();
});

test("same-ID retry settles the existing root outside the lock before publishing metadata", async () => {
	const h = harness();
	const backend = new DbosDurableBackend(h.sdk);
	await abandonFirstAdmission(h, backend);
	const waitsBefore = h.waits.length;
	let admitted = false;
	const retry = backend.admitWorkflow("root", registration, new AbortController().signal).then(() => {
		admitted = true;
	});
	await ticks();
	assert.equal(admitted, false, "retry must not return while the original marker is pending");
	assert.deepEqual(h.metadataRows("root"), [], "no metadata before the existing marker settles");
	assert.equal(h.waits.length, waitsBefore + 1, "retry waits on the existing marker");
	assert.equal(h.waits.at(-1)?.locked, false, "settlement must not hold the ownership lock");
	h.completeExternally("root");
	await retry;
	assert.equal(h.metadataRows("root").length, 1, "metadata is published after settlement");
});

test("duplicate-start fallback validates the raced root and settles it outside the lock", async () => {
	const h = harness({ id: "root", inputs });
	let started = false;
	const start = dbosAdmissionContext
		.run(new AbortController().signal, () => h.sdk.startWorkflow("root", "wf", inputs))
		.then(() => {
			started = true;
		});
	await ticks();
	assert.equal(started, false, "a duplicate start must wait for the raced marker");
	assert.deepEqual(h.waits, [{ id: "root", locked: false }]);
	h.completeExternally("root");
	await start;
	assert.equal(started, true);
});

test("duplicate-start fallback rejects a raced root with another identity without waiting", async () => {
	const h = harness({ id: "root", inputs: { topic: "other" } });
	await assert.rejects(
		dbosAdmissionContext.run(new AbortController().signal, () => h.sdk.startWorkflow("root", "wf", inputs)),
		/already exists|identity/,
	);
	assert.deepEqual(h.waits, []);
});

test("admission recovery settles an existing root before publishing recovery metadata", async () => {
	const h = harness();
	await abandonRootStart(h);
	const waitsBefore = h.waits.length;
	let recovered: boolean | undefined;
	const recovery = reconcileDbosAdmission(h.sdk, metadata, true).then((value) => {
		recovered = value;
	});
	await ticks();
	assert.equal(recovered, undefined, "recovery must wait for the existing marker");
	assert.deepEqual(h.metadataRows("root"), [], "no recovery metadata before settlement");
	assert.equal(h.waits.length, waitsBefore + 1);
	assert.equal(h.waits.at(-1)?.locked, false, "settlement must not hold the ownership lock");
	h.completeExternally("root");
	await recovery;
	assert.equal(recovered, true);
	assert.equal(h.metadataRows("root").length, 1);
});

test("abandoned admission recovery publishes no late metadata after the marker settles", async () => {
	const h = harness();
	await abandonRootStart(h);
	const caller = new AbortController();
	const recovery = dbosAdmissionContext.run(caller.signal, () => reconcileDbosAdmission(h.sdk, metadata, true));
	await ticks();
	caller.abort(deadline());
	await assert.rejects(recovery, DbosDependencyError);
	h.completeExternally("root");
	await ticks();
	assert.deepEqual(h.metadataRows("root"), [], "late settlement cannot publish recovery metadata");
});

test("same-ID retry of a terminally failed root fails closed without enrollment", async () => {
	const h = harness();
	const backend = new DbosDurableBackend(h.sdk);
	await abandonRootStart(h);
	h.failExternally("root");
	await assert.rejects(
		backend.admitWorkflow("root", registration, new AbortController().signal),
		/root marker failed/,
	);
	assert.deepEqual(h.metadataRows("root"), [], "a failed root is never enrolled as a run");
});

test("a root whose fenced continuation was abandoned fails retry boundedly without enrollment", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const h = harness();
	const backend = new DbosDurableBackend(h.sdk);
	await abandonFirstAdmission(h, backend);
	assert.equal(h.completeOriginal("root"), false, "the production pool refuses the abandoned outcome write");
	const retry = backend.admitWorkflow("root", registration, new AbortController().signal);
	const rejected = assert.rejects(retry, DbosDependencyError);
	await ticks();
	assert.deepEqual(h.metadataRows("root"), []);
	await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
	await rejected;
	assert.equal(h.rows.get("root")?.status, "PENDING");
	assert.deepEqual(h.metadataRows("root"), [], "a never-settled root is never enrolled");
	assert.equal(backend.isAdmissionUnavailable("root"), true, "the identity stays a bounded retry target");
});
