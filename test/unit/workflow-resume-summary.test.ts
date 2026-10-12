import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionAPI, PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { injectWorkflowResumeSummary } from "../../packages/workflows/src/extension/workflow-resume-summary.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function run(): RunSnapshot {
	return {
		id: "summary-run",
		name: "Ship feature",
		inputs: {},
		status: "paused",
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
