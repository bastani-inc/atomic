import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "vitest";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../src/core/extensions/workflow-run-control.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalResourceContext, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

it("history search keeps a trailing budget continuation after a workflow exceeds the per-file match limit (#5250)", async () => {
	const cwd = resolve("/project");
	const run: WorkflowRunSummary = {
		runId: "many-lines",
		name: "history search",
		status: "completed",
		startedAt: 1,
		elapsedMs: 1,
		activeStages: [],
		awaitingInput: [],
		awaitingInputCount: 0,
	};
	const detail: WorkflowRunDetail = {
		...run,
		inputs: {},
		stages: [],
		summary: Array.from({ length: 100 }, (_, index) => `needle ${index} ${"x".repeat(200)}`).join("\n"),
	};
	const router = createHistoryRouter({
		cwd,
		sessionStore: () => undefined,
		workflows: () => ({ listRuns: async () => [run], getRun: async () => detail }),
		budget: { bytes: 10_000 },
	});
	const request: InternalSearchRequest = {
		pattern: "needle",
		ignoreCase: false,
		literal: false,
		contextBefore: 0,
		contextAfter: 0,
	};
	const path = "history://workflows/many-lines";
	const raw = (await router.search!(path, request)) ?? "";
	assert.ok(
		raw.split("\n").filter((line) => /^history:\/\/workflows\/many-lines:[1-9]\d*: /.test(line)).length > 20,
		raw,
	);
	assert.match(raw, /the byte budget ran out; continue with history:\/\/workflows\/many-lines\?cursor=/);
	const rows = raw.split("\n");
	const notes = rows.filter((line) => line.startsWith(`${path}:0: `));
	const matches = rows.filter((line) => !line.startsWith(`${path}:0: `));
	// A source that answers every URL with this same page makes no progress: the search follows its stop once, keeps
	// the stop it could not get past, and ends rather than looping.
	let calls = 0;
	const ctx = {
		cwd,
		internalResourceRouter: {
			search: async () => {
				calls++;
				return [...matches, ...notes].join("\n");
			},
		},
	} as InternalResourceContext;
	const result = await createSearchToolDefinition(cwd, { contextBefore: 0, contextAfter: 0 }).execute(
		"search-history-budget",
		{ pattern: "needle", paths: path },
		undefined,
		undefined,
		ctx as never,
	);
	const output = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	assert.equal(
		output.split("\n").filter((line) => /^history:\/\/workflows\/many-lines:[1-9]\d*: /.test(line)).length,
		matches.length,
	);
	assert.equal(calls, 2);
	assert.match(
		output,
		/history:\/\/workflows\/many-lines:0: \[.*the byte budget ran out; continue with history:\/\/workflows\/many-lines\?cursor=/,
	);
});
