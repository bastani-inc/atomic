import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, vi } from "vitest";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../src/core/extensions/workflow-run-control.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const cwd = resolve("/project");
const createdAt = "2026-10-01T00:00:00.000Z";
const request: InternalSearchRequest = {
	pattern: "needle",
	ignoreCase: false,
	literal: false,
	contextBefore: 0,
	contextAfter: 0,
};

function runSummary(): WorkflowRunSummary {
	return {
		runId: "many-lines",
		name: "history search",
		status: "completed",
		startedAt: 1,
		elapsedMs: 1,
		activeStages: [],
		awaitingInput: [],
		awaitingInputCount: 0,
	};
}

it("a workflow-heavy root history search leaves room for a complete session row (#5250)", async () => {
	const store = new MemorySessionStore();
	const text = `needle ${"s".repeat(400)} session end`;
	await store.create({ id: "session", version: SESSION_FORMAT_VERSION, createdAt, cwd }, [
		{
			type: "message",
			id: "message",
			parentId: null,
			timestamp: createdAt,
			message: { role: "user", content: text, timestamp: Date.parse(createdAt) },
		},
	]);
	const run = runSummary();
	const detail: WorkflowRunDetail = {
		...run,
		inputs: {},
		stages: [],
		summary: Array.from({ length: 100 }, (_, index) => `needle workflow ${index} ${"w".repeat(200)}`).join("\n"),
	};
	for (const bytes of [1_400, 1_600, 1_800, 2_000]) {
		const router = createHistoryRouter({
			cwd,
			sessionStore: () => store,
			workflows: () => ({ listRuns: async () => [run], getRun: async () => detail }),
			budget: { bytes },
		});
		const output = (await router.search!("history://", request)) ?? "";
		assert.ok(Buffer.byteLength(output) <= bytes, output);
		assert.ok(output.split("\n").includes(`history://sessions/session:1: ${text}`), `${bytes}: ${output}`);
		assert.match(output, /history:\/\/workflows\/many-lines:[1-9]\d*: .*needle workflow/);
	}
	await store.close();
});

it("a root history search preserves limit and offset when a domain cannot be searched (#5250)", async () => {
	const router = createHistoryRouter({
		cwd,
		sessionStore: () => {
			throw new Error("zero rows must not read the store");
		},
		workflows: () => {
			throw new Error("zero rows must not read workflows");
		},
		budget: { rows: 0 },
	});
	const output = (await router.search!("history://?limit=3&offset=7", request)) ?? "";
	for (const domain of ["sessions", "workflows"]) {
		const continuation = new RegExp(
			`^history://${domain}:0: \\[.*continue with (history://${domain}[^\\s]+)\\]$`,
			"m",
		).exec(output)?.[1];
		assert.ok(continuation, output);
		const next = new URL(continuation);
		assert.equal(next.searchParams.get("limit"), "3", output);
		assert.equal(next.searchParams.get("offset"), "7", output);
	}
});

it("a root history search rejects cancellation as both domain searches finish (#5250)", async () => {
	const controller = new AbortController();
	const reason = new Error("history search cancelled");
	const store = new MemorySessionStore();
	const router = createHistoryRouter({
		cwd,
		sessionStore: () => store,
		workflows: () => ({
			listRuns: async () => [],
			getRun: async () => {
				throw new Error("an empty workflow listing must not read a run");
			},
		}),
	});
	const settle = Promise.allSettled.bind(Promise);
	const spy = vi.spyOn(Promise, "allSettled").mockImplementationOnce(async (values) => {
		const results = await settle(values);
		assert.ok(results.every((result) => result.status === "fulfilled"));
		controller.abort(reason);
		return results;
	});
	try {
		await assert.rejects(
			async () => router.search!("history://", { ...request, signal: controller.signal }),
			(error: Error) => error === reason,
		);
		assert.equal(spy.mock.calls.length, 1);
	} finally {
		spy.mockRestore();
		await store.close();
	}
});
