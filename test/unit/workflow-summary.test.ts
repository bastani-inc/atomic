import assert from "node:assert/strict";
import { test } from "vitest";
import {
	createWorkflowSummaryService,
	workflowSummaryInput,
} from "../../packages/workflows/src/extension/workflow-summary.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const settle = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

function fixture() {
	const store = createStore();
	store.recordRunStart({
		id: "summary-run",
		name: "build",
		inputs: { objective: "Fix the compiler" },
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	return store;
}

for (const status of ["completed", "killed", "skipped"] as const) {
	test(`workflow summaries cancel stale requests and finish with ${status} context`, async () => {
		const store = fixture();
		const prompts: string[] = [];
		const saved: string[] = [];
		const requests: { signal: AbortSignal; finish: (summary: string) => void }[] = [];
		const service = createWorkflowSummaryService({
			store,
			resolveContext: () => ({
				generateWorkflowSummary: async (text, signal) => {
					prompts.push(text);
					return new Promise<string>((resolve) => {
						requests.push({ signal, finish: resolve });
					});
				},
			}),
			persist: async (_id, summary) => {
				saved.push(summary);
			},
		});
		service.request("summary-run");
		service.request("summary-run");
		await settle();
		assert.equal(prompts.length, 1);
		assert.match(prompts[0], /Fix the compiler/);
		store.recordRunEnd("summary-run", status);
		assert.equal(prompts.length, 2, "terminal generation must be admitted synchronously");
		assert.equal(requests[0].signal.aborted, true);
		assert.equal(requests[1].signal.aborted, false);
		requests[0].finish("Stale heartbeat");
		await settle();
		service.request("summary-run");
		assert.equal(prompts.length, 2, "superseded completion must not clear the active terminal request");
		assert.ok(prompts[1].includes(`Status: ${status}`));
		requests[1].finish("Completed compiler repair");
		await settle();
		assert.deepEqual(saved, ["Completed compiler repair"]);
		service.dispose();
	});
}

test("terminal workflow summaries run without heartbeat scheduling and persist in the durable catalog", async () => {
	const store = fixture();
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: "summary-run",
		name: "build",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	const service = createWorkflowSummaryService({
		store,
		resolveContext: () => ({ generateWorkflowSummary: async () => "Compiler repair completed" }),
		persist: async (id, summary, through) => {
			await backend.persistSummary!(id, summary, through);
		},
	});
	store.recordRunEnd("summary-run", "completed");
	await settle();
	assert.equal(backend.getWorkflow("summary-run")?.summary, "Compiler repair completed");
	assert.ok(backend.getWorkflow("summary-run")?.summarizedThrough);
	assert.equal(backend.toMetadata("summary-run")?.summary, "Compiler repair completed");
	service.dispose();
});

test("disabled, failed, and cancelled workflow summary requests remain silent", async () => {
	const store = fixture();
	let calls = 0;
	let enabled = false;
	let signal: AbortSignal | undefined;
	const service = createWorkflowSummaryService({
		store,
		resolveContext: () => ({
			isSessionSummaryEnabled: () => enabled,
			generateWorkflowSummary: async (_text, requestSignal) => {
				calls++;
				signal = requestSignal;
				throw new Error("offline");
			},
		}),
		persist: async () => {
			assert.fail("must not persist");
		},
	});
	service.request("summary-run");
	await settle();
	assert.equal(calls, 0);
	enabled = true;
	service.request("summary-run");
	await settle();
	assert.equal(calls, 1);
	service.request("summary-run");
	service.dispose();
	await settle();
	assert.equal(signal?.aborted, true);
});

test("workflow summary input is bounded and includes latest stage outputs", () => {
	const store = fixture();
	const run = store.runs()[0];
	const text = workflowSummaryInput({
		...run,
		inputs: {
			...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`other${i}`, "y".repeat(20000)])),
			objective: "Fix the compiler",
		},
		toolNodes: [],
		stages: [
			{
				id: "stage",
				name: "compile",
				status: "completed",
				parentIds: [],
				toolEvents: [],
				result: "x".repeat(20000),
			},
		],
	});
	assert.ok(text.length <= 16000);
	assert.match(text, /Fix the compiler/);
	assert.match(text, /compile: completed/);
	assert.ok(text.endsWith("x".repeat(1500)));
});

test("recoverable active-blocked runs generate and persist blocked summary context", async () => {
	const store = fixture();
	const prompts: string[] = [];
	const saved: string[] = [];
	const service = createWorkflowSummaryService({
		store,
		resolveContext: () => ({
			generateWorkflowSummary: async (text, _signal, options) => {
				assert.equal(options?.terminal, true);
				prompts.push(text);
				return "Blocked awaiting credentials";
			},
		}),
		persist: async (_id, summary) => {
			saved.push(summary);
		},
	});
	store.recordRunBlocked("summary-run", "Configure credentials", {
		failureKind: "auth",
		failureCode: "missing_api_key",
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		failureMessage: "Configure credentials",
		resumable: true,
		blockedAt: 2,
	});
	assert.equal(store.runs()[0].status, "running");
	await settle();
	assert.equal(prompts.length, 1);
	assert.match(prompts[0], /Status: blocked/);
	assert.deepEqual(saved, ["Blocked awaiting credentials"]);
	service.dispose();
});

for (const blockedSummary of ["finished", "pending"] as const) {
	test(`${blockedSummary} blocked summary is replaced when the run is killed`, async () => {
		const store = fixture();
		const prompts: string[] = [];
		const saved: string[] = [];
		const requests: { signal: AbortSignal; finish: (summary: string) => void }[] = [];
		const service = createWorkflowSummaryService({
			store,
			resolveContext: () => ({
				generateWorkflowSummary: async (text, signal, options) => {
					assert.equal(options?.terminal, true);
					prompts.push(text);
					return new Promise<string>((resolve) => requests.push({ signal, finish: resolve }));
				},
			}),
			persist: async (_id, summary) => {
				saved.push(summary);
			},
		});
		try {
			store.recordRunBlocked("summary-run", "Configure credentials", {
				failureKind: "auth",
				failureCode: "missing_api_key",
				failureRecoverability: "recoverable",
				failureDisposition: "active_blocked",
				failureMessage: "Configure credentials",
				resumable: true,
				blockedAt: 2,
			});
			assert.match(prompts[0], /Status: blocked/);
			if (blockedSummary === "finished") {
				requests[0].finish("Blocked awaiting credentials");
				await settle();
			}
			store.recordRunEnd("summary-run", "killed");
			assert.equal(prompts.length, 2, "killed status must request a new terminal summary");
			assert.match(prompts[1], /Status: killed/);
			if (blockedSummary === "pending") {
				assert.equal(requests[0].signal.aborted, true);
				requests[0].finish("Stale blocked summary");
				await settle();
				service.request("summary-run");
				assert.equal(prompts.length, 2, "stale completion must not clear the killed request");
			}
			requests[1].finish("Workflow killed");
			await settle();
			assert.deepEqual(
				saved,
				blockedSummary === "finished" ? ["Blocked awaiting credentials", "Workflow killed"] : ["Workflow killed"],
			);
		} finally {
			service.dispose();
		}
	});
}
