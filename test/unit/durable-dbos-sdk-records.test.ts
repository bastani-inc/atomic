import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { encodeCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

// Use the installed SDK's real best-effort listing and strict result decoders.
// These modules are not package exports, so resolve from its public entry point.
const require = createRequire(import.meta.url);
const sdkDirectory = dirname(require.resolve("@dbos-inc/dbos-sdk"));
const {
	DBOSJSON,
	DBOSPortableJSON,
	deserializeValue,
}: typeof import("../../node_modules/@dbos-inc/dbos-sdk/dist/src/serialization.js") = require(
	join(sdkDirectory, "serialization.js"),
);
const { toWorkflowStatus }: typeof import("../../node_modules/@dbos-inc/dbos-sdk/dist/src/workflow_management.js") =
	require(join(sdkDirectory, "workflow_management.js"));

async function listedOutput(workflowID: string, output: string, serialization: string) {
	const status = await toWorkflowStatus(
		{
			workflowUUID: workflowID,
			status: "SUCCESS",
			workflowName: "atomicWorkflowHandle",
			workflowClassName: "",
			workflowConfigName: "",
			authenticatedUser: "",
			output,
			error: null,
			input: null,
			assumedRole: "",
			authenticatedRoles: [],
			request: {},
			executorId: "test",
			applicationID: "test",
			createdAt: 1,
			priority: 0,
			serialization,
		},
		DBOSJSON,
	);
	return status as Awaited<ReturnType<DbosStatic["listWorkflows"]>>[number];
}

function sdkWithReads(reads: Pick<DbosStatic, "listWorkflows" | "retrieveWorkflow">): DbosStatic {
	const unused = (): never => {
		throw new Error("unexpected DBOS operation");
	};
	return {
		setConfig: unused,
		launch: unused,
		shutdown: unused,
		registerWorkflow: unused,
		startWorkflow: unused,
		resumeWorkflow: unused,
		cancelWorkflow: unused,
		deleteWorkflows: unused,
		...reads,
	};
}

const main = async () => null;
const checkpoint = async () => null;

// Issue #2897: checkpoint-heavy Windows resume must not reread bulk-loaded results.
test("reuses bulk-loaded non-string checkpoint outputs and strictly reads strings", async () => {
	const outputs: WorkflowSerializableValue[] = [{ raw: " text ", ordered: ["a", "a", ""] }, null, false, 0, ""];
	const statuses = outputs.map((output, index) => ({
		workflowID: `root:checkpoint:step-${index}`,
		status: "SUCCESS",
		createdAt: index,
		output,
	}));
	let listings = 0;
	let resultReads = 0;
	const sdk = sdkWithReads({
		listWorkflows: async (input) => {
			listings += 1;
			assert.deepEqual(input, { workflow_id_prefix: "root:checkpoint:", loadOutput: true, sortDesc: false });
			return statuses;
		},
		retrieveWorkflow: (id) => ({
			getStatus: async () => null,
			getResult: async () => {
				resultReads += 1;
				return statuses.find((status) => status.workflowID === id)!.output;
			},
		}),
	});
	const records = await createRealDbosHandle(sdk, main, checkpoint).listStepRecords("root");
	assert.deepEqual(
		records,
		outputs.map((output, index) => ({ stepName: `step-${index}`, output, completedAt: index })),
	);
	assert.equal(records[0]!.output, outputs[0], "preserve the SDK's deserialized value");
	assert.equal(listings, 1);
	assert.equal(resultReads, 1, "only the ambiguous string needs a strict result read");
});

test("exact step lookup keeps strict string and missing-output reads", async () => {
	const id = "root:checkpoint:__atomic_metadata:1:claim";
	for (const listed of [
		{ workflowID: id, status: "SUCCESS", createdAt: 1, output: "raw" },
		{ workflowID: id, status: "SUCCESS", createdAt: 1 },
	]) {
		let strictReads = 0;
		const sdk = sdkWithReads({
			listWorkflows: async (input) => {
				assert.deepEqual(input, { workflowIDs: [id], loadOutput: true, limit: 1 });
				return [listed];
			},
			retrieveWorkflow: () => ({
				getStatus: async () => null,
				getResult: async () => {
					strictReads++;
					return { durable: true };
				},
			}),
		});
		assert.deepEqual(
			await createRealDbosHandle(sdk, main, checkpoint).readStepRecord!("root", "__atomic_metadata:1:claim"),
			{
				stepName: "__atomic_metadata:1:claim",
				output: { durable: true },
				completedAt: 1,
			},
		);
		assert.equal(strictReads, 1);
	}
});

test("exact step lookup treats unfinished or mismatched records as absent", async () => {
	for (const statuses of [
		[],
		[{ workflowID: "root:checkpoint:other", status: "SUCCESS", output: { wrong: true } }],
		[{ workflowID: "root:checkpoint:claim", status: "PENDING", output: { early: true } }],
	]) {
		const sdk = sdkWithReads({
			listWorkflows: async () => statuses,
			retrieveWorkflow: () => {
				throw new Error("unexpected result read");
			},
		});
		assert.equal(await createRealDbosHandle(sdk, main, checkpoint).readStepRecord!("root", "claim"), undefined);
	}
});

test("exact step lookup propagates strict result errors", async () => {
	const id = "root:checkpoint:__atomic_metadata:1:claim";
	const failure = new Error("invalid serialized claim");
	const sdk = sdkWithReads({
		listWorkflows: async () => [{ workflowID: id, status: "SUCCESS", output: "ambiguous" }],
		retrieveWorkflow: () => ({
			getStatus: async () => null,
			getResult: async () => {
				throw failure;
			},
		}),
	});
	await assert.rejects(
		createRealDbosHandle(sdk, main, checkpoint).readStepRecord!("root", "__atomic_metadata:1:claim"),
		(error) => error === failure,
	);
});

test("reads only the exact claim without transferring unrelated checkpoint outputs", async () => {
	const workflowId = "root";
	const claimId = `${workflowId}:checkpoint:__atomic_metadata:42:claim`;
	const claim = { __atomicDurableMetadata: true, version: 3, metadata: { transitionClaimId: "winner" } };
	const largeOutput = { payload: "x".repeat(2_000_000) };
	const statuses = [
		{ workflowID: claimId, status: "SUCCESS", createdAt: 42, output: claim },
		{ workflowID: `${workflowId}:checkpoint:tool:large`, status: "SUCCESS", createdAt: 1, output: largeOutput },
	];
	const listings: Record<string, WorkflowSerializableValue>[] = [];
	let serializedResponseBytes = 0;
	const sdk = sdkWithReads({
		listWorkflows: async (input) => {
			listings.push(input);
			const ids = input.workflowIDs;
			const selected = Array.isArray(ids)
				? statuses.filter((status) => ids.includes(status.workflowID))
				: statuses.filter((status) => status.workflowID.startsWith(String(input.workflow_id_prefix)));
			serializedResponseBytes += Buffer.byteLength(JSON.stringify(selected));
			return selected;
		},
		retrieveWorkflow: () => ({
			getStatus: async () => null,
			getResult: async () => {
				throw new Error("unexpected fallback");
			},
		}),
	});
	const handle = createRealDbosHandle(sdk, main, checkpoint);
	const full = await handle.listStepRecords(workflowId);
	const fullBytes = serializedResponseBytes;
	serializedResponseBytes = 0;
	const exact = await handle.readStepRecord!(workflowId, "__atomic_metadata:42:claim");
	assert.equal(full.length, 2);
	assert.deepEqual(exact, { stepName: "__atomic_metadata:42:claim", output: claim, completedAt: 42 });
	assert.deepEqual(listings[1], { workflowIDs: [claimId], loadOutput: true, limit: 1 });
	assert.equal(listings.length, 2);
	assert.ok(fullBytes > 2_000_000);
	assert.ok(serializedResponseBytes < 300);
});

test("falls back to one result read when the bulk listing omits an output", async () => {
	const statuses = [
		{ workflowID: "root:checkpoint:present", status: "SUCCESS", createdAt: 2, output: { kept: true } },
		{ workflowID: "root:checkpoint:missing", status: "SUCCESS", createdAt: 3 },
	];
	const resultReads: string[] = [];
	const sdk = sdkWithReads({
		listWorkflows: async () => statuses,
		retrieveWorkflow: (id) => ({
			getStatus: async () => null,
			getResult: async () => {
				resultReads.push(id);
				return "late";
			},
		}),
	});
	const records = await createRealDbosHandle(sdk, main, checkpoint).listStepRecords("root");
	assert.deepEqual(records, [
		{ stepName: "present", output: { kept: true }, completedAt: 2 },
		{ stepName: "missing", output: "late", completedAt: 3 },
	]);
	assert.deepEqual(resultReads, ["root:checkpoint:missing"]);
});

test("preserves falsy outputs, strictly reading only the ambiguous empty string", async () => {
	const statuses = [
		{ workflowID: "root:checkpoint:empty-string", status: "SUCCESS", createdAt: 1, output: "" },
		{ workflowID: "root:checkpoint:zero", status: "SUCCESS", createdAt: 2, output: 0 },
		{ workflowID: "root:checkpoint:false", status: "SUCCESS", createdAt: 3, output: false },
		{ workflowID: "root:checkpoint:null", status: "SUCCESS", createdAt: 4, output: null },
	];
	let resultReads = 0;
	const sdk = sdkWithReads({
		listWorkflows: async () => statuses,
		retrieveWorkflow: (id) => ({
			getStatus: async () => null,
			getResult: async () => {
				resultReads += 1;
				return statuses.find((status) => status.workflowID === id)!.output;
			},
		}),
	});
	const records = await createRealDbosHandle(sdk, main, checkpoint).listStepRecords("root");
	assert.deepEqual(
		records,
		statuses.map((status) => ({
			stepName: status.workflowID.slice("root:checkpoint:".length),
			output: status.output,
			completedAt: status.createdAt,
		})),
	);
	assert.equal(resultReads, 1, "non-string falsy values are decoded; empty strings still need strict retrieval");
});

for (const failure of ["malformed JSON", "unavailable serializer"] as const) {
	for (const boundary of ["adapter", "hydration"] as const) {
		test(`propagates the original SDK ${failure} error through ${boundary}`, async () => {
			const workflowId = "61ad977f-45a1-41e7-a72c-cb03a2523990";
			const recordId = `${workflowId}:checkpoint:tool:stored`;
			const validRaw = DBOSJSON.stringify(
				encodeCheckpoint({
					kind: "tool",
					workflowId,
					checkpointId: "tool:stored",
					name: "stored",
					argsHash: "stored",
					output: "completed effect",
					completedAt: 2,
				}),
			);
			const metadata = await listedOutput(
				`${workflowId}:checkpoint:__atomic_metadata:3:test`,
				DBOSJSON.stringify(
					encodeMetadata({
						workflowId,
						name: "decode-probe",
						inputs: {},
						status: "paused",
						completedCheckpoints: 1,
						pendingPrompts: 0,
						createdAt: 1,
						updatedAt: 3,
						promptReservationEpoch: "test",
					}),
				),
				DBOSJSON.name(),
			);
			const root = await listedOutput(workflowId, DBOSJSON.stringify({}), DBOSJSON.name());
			let raw = validRaw;
			let serialization = DBOSJSON.name();
			let resultError: unknown;
			const resultReads: string[] = [];
			const sdk = sdkWithReads({
				listWorkflows: async (input) =>
					input.workflowIDs ? [root] : [metadata, await listedOutput(recordId, raw, serialization)],
				retrieveWorkflow: (id) => ({
					getStatus: async () => null,
					getResult: async () => {
						resultReads.push(id);
						assert.equal(id, recordId, "valid metadata must remain bulk-loaded");
						try {
							return (await deserializeValue(raw, serialization, DBOSJSON)) as WorkflowSerializableValue;
						} catch (error) {
							resultError = error;
							throw error;
						}
					},
				}),
			});
			const handle = createRealDbosHandle(sdk, main, checkpoint);
			const backend = new DbosDurableBackend(handle);
			assert.equal((await backend.hydrateWorkflowForInspection(workflowId)).kind, "current");
			const previous = backend.getWorkflow(workflowId);
			assert.equal(previous?.workflowId, workflowId);
			assert.equal(backend.getToolOutput(workflowId, "stored"), "completed effect");
			assert.deepEqual(resultReads, [], "valid checkpoint and metadata envelopes need no strict rereads");

			raw = failure === "malformed JSON" ? "{broken" : validRaw;
			serialization = failure === "malformed JSON" ? DBOSJSON.name() : "unavailable-test-serializer";
			assert.equal((await listedOutput(recordId, raw, serialization)).output, raw);
			const read = () =>
				boundary === "adapter"
					? handle.listStepRecords(workflowId)
					: backend.hydrateWorkflowForInspection(workflowId);
			await assert.rejects(read, (error) => {
				assert.equal(error, resultError, "surface the exact strict decoder error, not a replacement");
				if (failure === "malformed JSON") assert.ok(error instanceof SyntaxError);
				else {
					assert.ok(error instanceof TypeError);
					assert.equal(error.message, "Value deserialization type unavailable-test-serializer is not available");
				}
				return true;
			});
			assert.deepEqual(resultReads, [recordId]);
			assert.equal(backend.getWorkflow(workflowId), previous, "a read error must not suppress a hydrated root");
			assert.equal(backend.getToolOutput(workflowId, "stored"), "completed effect");
			if (boundary === "hydration") {
				const fresh = new DbosDurableBackend(handle);
				await assert.rejects(fresh.hydrateWorkflow(workflowId), (error) => error === resultError);
			}
		});
	}
}

for (const serializer of [DBOSJSON, DBOSPortableJSON]) {
	test(`preserves legitimate ${serializer.name()} strings and bulk checkpoint envelopes verbatim`, async () => {
		const values: WorkflowSerializableValue[] = [
			"",
			" \r\n\t é\u0000 ",
			"{broken",
			'{"ok":true}',
			null,
			false,
			0,
			-0,
		];
		const outputs = [
			...values,
			encodeCheckpoint({
				kind: "tool",
				workflowId: "root",
				checkpointId: "tool:values",
				name: "raw values",
				argsHash: "values",
				output: { values, duplicates: ["a", "a", ""], emptyArray: [], emptyObject: {} },
				completedAt: 1,
			}),
		];
		const rows = outputs.map((output, index) => ({
			id: `root:checkpoint:${index}`,
			raw: serializer.stringify(output),
		}));
		const statuses = await Promise.all(rows.map((row) => listedOutput(row.id, row.raw, serializer.name())));
		let listings = 0;
		const reads: string[] = [];
		const sdk = sdkWithReads({
			listWorkflows: async () => {
				listings += 1;
				return statuses;
			},
			retrieveWorkflow: (id) => ({
				getStatus: async () => null,
				getResult: async () => {
					reads.push(id);
					const row = rows.find((row) => row.id === id)!;
					return (await deserializeValue(row.raw, serializer.name(), DBOSJSON)) as WorkflowSerializableValue;
				},
			}),
		});
		const records = await createRealDbosHandle(sdk, main, checkpoint).listStepRecords("root");
		assert.equal(records.length, outputs.length);
		for (const [index, record] of records.entries()) {
			assert.deepEqual(record.output, await deserializeValue(rows[index]!.raw, serializer.name(), DBOSJSON));
			assert.equal(record.output, statuses[index]!.output, "reuse decoded envelopes by identity");
		}
		assert.equal(listings, 1);
		assert.deepEqual(
			reads,
			rows.slice(0, 4).map((row) => row.id),
			"all strings need strict reads, but envelopes do not",
		);
	});
}

test("preserves duplicate order, legacy IDs, exact step names and non-string object identity", async () => {
	const alias = { raw: " \r\n\t é\u0000 " };
	const outputs: WorkflowSerializableValue[] = [{ a: alias, b: alias }, [], {}, -0, 1.5, true];
	const statuses = outputs.map((output, index) => ({
		workflowId: `root:checkpoint:${index < 2 ? "duplicate" : "\n raw :name \r\n"}`,
		status: "SUCCESS",
		output,
	}));
	const sdk = sdkWithReads({
		listWorkflows: async () => statuses,
		retrieveWorkflow: () => {
			throw new Error("decoded non-strings must not be reread");
		},
	});
	const records = await createRealDbosHandle(sdk, main, checkpoint).listStepRecords("root");
	assert.equal(records.length, statuses.length);
	for (const [index, record] of records.entries()) {
		assert.equal(record.output, outputs[index]);
		assert.equal(record.stepName, statuses[index]!.workflowId.slice("root:checkpoint:".length));
		assert.ok(Object.hasOwn(record, "completedAt"));
		assert.equal(record.completedAt, undefined);
	}
});
