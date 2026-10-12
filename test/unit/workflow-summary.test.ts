import assert from "node:assert/strict";
import { test } from "vitest";
import { createInMemoryTestBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	createWorkflowSummaryService,
	workflowSummaryInput,
} from "../../packages/workflows/src/extension/workflow-summary.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

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
		stages: [],
		startedAt: 1,
	});
	return store;
}

test("workflow summaries deduplicate concurrent requests and finish with terminal context", async () => {
	const store = fixture();
	const prompts: string[] = [];
	const saved: string[] = [];
	let finish: ((summary: string) => void) | undefined;
	const service = createWorkflowSummaryService({
		store,
		resolveContext: () => ({
			generateWorkflowSummary: async (text) => {
				prompts.push(text);
				return new Promise<string>((resolve) => {
					finish = resolve;
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
	store.recordRunEnd("summary-run", "completed");
	finish!("Compiler fixed");
	await settle();
	assert.equal(prompts.length, 2);
	assert.match(prompts[1], /Status: completed/);
	finish!("Completed compiler repair");
	await settle();
	assert.deepEqual(saved, ["Compiler fixed", "Completed compiler repair"]);
	service.dispose();
});

test("terminal workflow summaries run without heartbeat scheduling and persist in the durable catalog", async () => {
	const store = fixture();
	const backend = createInMemoryTestBackend();
	backend.registerWorkflow({ workflowId: "summary-run", name: "build", inputs: {}, status: "running", createdAt: 1 });
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
