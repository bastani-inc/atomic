import assert from "node:assert/strict";
import { test } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { ExtensionAPI, PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { injectWorkflowResumeSummary } from "../../packages/workflows/src/extension/workflow-resume-summary.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

function run(): RunSnapshot {
	return {
		id: "summary-run",
		name: "Ship feature",
		inputs: {},
		status: "paused",
		toolNodes: [],
		stages: [],
		startedAt: 1,
		summary: "Tests pass; awaiting review",
		summarizedThrough: 1000,
	};
}

test("resume posts model-visible summary context once without triggering a turn", async () => {
	const messages: Parameters<NonNullable<ExtensionAPI["sendMessage"]>>[] = [];
	const pi: ExtensionAPI = {
		sendMessage: (...args) => {
			messages.push(args);
		},
	};
	const ctx: PiCommandContext = { ui: { notify() {} } };
	await injectWorkflowResumeSummary(pi, ctx, "summary-run", run());
	await injectWorkflowResumeSummary(pi, ctx, "summary-run", run());
	assert.equal(messages.length, 1);
	const [message, options] = messages[0]!;
	assert.match(String(message.content), /summary-run\nWorkflow: Ship feature\nStatus: paused/);
	assert.match(String(message.content), /1970-01-01T00:00:01.000Z/);
	assert.match(String(message.content), /Tests pass; awaiting review/);
	assert.equal(options?.triggerTurn, false);
});

test("resume with no summary or disabled summaries adds no context", async () => {
	let calls = 0;
	const pi: ExtensionAPI = {
		sendMessage: () => {
			calls++;
		},
	};
	await injectWorkflowResumeSummary(pi, { ui: { notify() {} } }, "missing-run");
	await injectWorkflowResumeSummary(
		pi,
		{ ui: { notify() {} }, isSessionSummaryEnabled: () => false },
		"summary-run",
		run(),
	);
	assert.equal(calls, 0);
});

test("a later pause can supply fresh resume context without duplicating the live attachment", async () => {
	let calls = 0;
	const pi: ExtensionAPI = {
		sendMessage: () => {
			calls++;
		},
	};
	const ctx: PiCommandContext = { ui: { notify() {} } };
	await injectWorkflowResumeSummary(pi, ctx, "summary-run", { ...run(), pausedAt: 100 });
	await injectWorkflowResumeSummary(pi, ctx, "summary-run", { ...run(), status: "running" });
	assert.equal(calls, 1);
	await injectWorkflowResumeSummary(pi, ctx, "summary-run", { ...run(), pausedAt: 200 });
	assert.equal(calls, 2);
});

test("durable resumes without snapshots deliver again after pause or detach, not during a live attachment", async () => {
	const backend = await createMemoryTestBackend();
	await backend.registerWorkflow({
		workflowId: "durable-summary",
		name: "Ship feature",
		inputs: {},
		status: "paused",
		createdAt: 1,
	});
	await backend.persistSummary("durable-summary", "Ready for review", 1000);
	setDurableBackend(backend);
	try {
		const messages: string[] = [];
		const pi: ExtensionAPI = {
			sendMessage: (message) => {
				messages.push(String(message.content));
			},
		};
		const ctx: PiCommandContext = { ui: { notify() {} } };
		for (const boundary of ["initial", "pause", "detach"]) {
			if (boundary !== "initial") await backend.setWorkflowStatus("durable-summary", "paused");
			await injectWorkflowResumeSummary(pi, ctx, "durable-summary", undefined, undefined, backend);
			await injectWorkflowResumeSummary(pi, ctx, "durable-summary", undefined, undefined, backend);
			await backend.setWorkflowStatus("durable-summary", "running");
			await injectWorkflowResumeSummary(pi, ctx, "durable-summary", undefined, undefined, backend);
			assert.equal(messages.length, ["initial", "pause", "detach"].indexOf(boundary) + 1);
		}
		await backend.setWorkflowStatus("durable-summary", "paused");
		await injectWorkflowResumeSummary(pi, ctx, "durable-summary", undefined, undefined, backend);
		await backend.persistSummary("durable-summary", "Updated review context", 2000);
		await injectWorkflowResumeSummary(pi, ctx, "durable-summary", undefined, undefined, backend);
		assert.equal(messages.length, 4, "summary writes do not create a resume boundary");
		assert.match(messages[0]!, /Ready for review/);
		assert.equal(
			backend.toMetadata("durable-summary")?.transitionClaimId,
			backend.getWorkflow("durable-summary")?.transitionClaimId,
		);
	} finally {
		setDurableBackend(undefined);
	}
});

test("missing durable summary lookups cannot prevent workflow recovery", async () => {
	const backend = await createMemoryTestBackend();
	backend.getLoadableWorkflow = () => {
		throw new Error("WorkflowRunNotFoundError");
	};
	setDurableBackend(backend);
	try {
		const messages: string[] = [];
		const pi: ExtensionAPI = {
			sendMessage: (message) => {
				messages.push(String(message.content));
			},
		};
		await injectWorkflowResumeSummary(pi, { ui: { notify() {} } }, "missing-run", undefined, undefined, backend);
		assert.deepEqual(messages, []);
		await injectWorkflowResumeSummary(pi, { ui: { notify() {} } }, "summary-run", run(), undefined, backend);
		assert.equal(messages.length, 1);
	} finally {
		setDurableBackend(undefined);
	}
});
