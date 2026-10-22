import "../helpers/provider-rate-limit-isolation.js";
import assert from "node:assert/strict";
import { test } from "vitest";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { createStore, run, workflow } from "./executor-shared.js";
import { makeMockSession } from "./stage-runner-helpers.js";

test("rate-limit counts survive task results and durable completed inspection (#3864)", async () => {
	const backend = await JournalTestBackend.create();
	const definition = workflow({
		name: "rate-limit-persistence",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const result = await ctx.task("limited", {
				model: "persistence-a/model",
				fallbackModels: ["persistence-b/model"],
				prompt: "go",
			});
			assert.equal(result.rateLimits?.find((entry) => entry.provider === "persistence-a")?.rateLimitCount, 1);
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{
			runId: "rate-limit-persistence-run",
			store: createStore(),
			durableBackend: backend,
			adapters: {
				agentSession: {
					async create(options) {
						const model = String(options.model);
						return {
							session: makeMockSession({
								async prompt() {
									if (model === "persistence-a/model")
										throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
									return "ok";
								},
							}).session,
							settingsManager: { getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 }) },
						};
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed");
	const completed = backend
		.listCompletedWorkflows()
		.find((entry) => entry.workflowId === "rate-limit-persistence-run");
	assert.ok(completed);
	const snapshots = await completedWorkflowRunSnapshots(backend, completed);
	const stage = snapshots.flatMap((entry) => entry.stages).find((entry) => entry.name === "limited");
	assert.equal(stage?.rateLimits?.find((entry) => entry.provider === "persistence-a")?.rateLimitCount, 1);
	assert.ok(stage?.rateLimits?.every((entry) => entry.waitingUntil === undefined));
});
