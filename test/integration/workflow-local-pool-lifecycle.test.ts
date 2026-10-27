import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { fixture, SINGLE_POOL, waitUntil } from "../helpers/workflow-local-pool-lifecycle.js";

/** Pause, resume and quit reaching a root's pooled worker. Restarts are in workflow-local-pool-lifecycle-*.test.ts. */

test(
	"root pause and resume reach workers without losing committed results (#3869)",
	async () => {
		const f = await fixture();
		try {
			const queue = await f.ready();
			await toolControlRegistry.runControl("root")!.pause();
			const leaseState = (await f.journal.leaseState("root"))!;
			const lease = { runId: "root", holderId: leaseState.holderId!, epoch: leaseState.epoch };
			assert.equal((await queue.control(lease)).state, "paused");
			const [before] = await queue.inspect("root");
			await toolControlRegistry.runControl("root")!.resume();
			assert.equal((await queue.control(lease)).state, "running");
			await f.release();
			assert.equal((await f.running).status, "completed");
			const [after] = await queue.inspect("root");
			assert.equal(after!.id, before!.id);
			assert.equal(after!.generation, before!.generation);
			assert.equal(after!.state, "completed");
		} finally {
			if (toolControlRegistry.runControl("root")?.paused) await toolControlRegistry.runControl("root")!.resume();
			await f.release();
			await f.close();
		}
	},
	SINGLE_POOL.timeoutMs,
);

test(
	"a worker tool finishing while the root is paused commits its checkpoint without a new attempt (#3869)",
	async () => {
		const f = await fixture();
		try {
			const queue = await f.ready();
			await f.finishing();
			const [before] = await queue.inspect("root");
			await toolControlRegistry.runControl("root")!.pause();
			assert.equal((await f.journal.getRun("root"))?.status, "paused");
			await f.release();
			await waitUntil(async () => {
				await f.backend.hydrateWorkflow("root");
				return f.backend.listCheckpoints("root").some((entry) => entry.kind === "tool" && entry.name === "finish");
			}, f.budget);
			const [paused] = await queue.inspect("root");
			assert.equal(paused!.id, before!.id);
			assert.equal(paused!.generation, before!.generation);
			assert.equal(f.pool.workerPids.length, 1);
			await toolControlRegistry.runControl("root")!.resume();
			const result = await f.running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [after] = await queue.inspect("root");
			assert.equal(after!.id, before!.id);
			assert.equal(after!.generation, before!.generation);
			assert.equal(after!.state, "completed");
		} finally {
			if (toolControlRegistry.runControl("root")?.paused) await toolControlRegistry.runControl("root")!.resume();
			await f.release();
			await f.close();
		}
	},
	SINGLE_POOL.timeoutMs,
);

test(
	"root quit waits for worker teardown and retains resumable work (#3869)",
	async () => {
		const f = await fixture();
		try {
			const queue = await f.ready();
			await f.finishing();
			const [before] = await queue.inspect("root");
			await toolControlRegistry.runControl("root")!.quit();
			assert.equal((await f.running).status, "paused");
			assert.equal(f.pool.workerPids.length, 0);
			assert.equal(
				f.store
					.runs()
					.find((entry) => entry.parentRunId === f.root)
					?.toolNodes.find((node) => node.name === "finish")?.status,
				"cancelled",
				"the worker publishes graceful tool cancellation before teardown",
			);
			const [after] = await queue.inspect("root");
			assert.equal(after!.id, before!.id);
			assert.equal(after!.state, "leased");
		} finally {
			await f.close();
		}
	},
	SINGLE_POOL.timeoutMs,
);

test(
	"pooled quit blocks the next local tool before worker cleanup finishes (#3869)",
	async () => {
		const childCompleted = Promise.withResolvers<void>();
		const releaseRoot = Promise.withResolvers<void>();
		const cleanup = Promise.withResolvers<void>();
		const toolAttempted = Promise.withResolvers<void>();
		let toolCalls = 0;
		const f = await fixture(randomUUID(), async (ctx) => {
			childCompleted.resolve();
			await releaseRoot.promise;
			try {
				await ctx.tool("local-after-child", {}, async () => ++toolCalls);
			} finally {
				toolAttempted.resolve();
			}
		});
		const control = f.pool.control.bind(f.pool);
		const intercepted = vi.spyOn(f.pool, "control").mockImplementation(async (state) => {
			if (state === "quit") await cleanup.promise;
			await control(state);
		});
		let quitSettled = false;
		try {
			await f.release();
			await childCompleted.promise;
			const quitting = toolControlRegistry
				.runControl(f.root)!
				.quit()
				.finally(() => {
					quitSettled = true;
				});
			releaseRoot.resolve();
			await toolAttempted.promise;
			assert.equal(toolCalls, 0, "quit closes local tool admission before worker cleanup");
			assert.notEqual(f.store.runs().find((entry) => entry.id === f.root)?.status, "completed");
			assert.equal(quitSettled, false, "quit still waits for worker cleanup acknowledgement");
			cleanup.resolve();
			await quitting;
			assert.equal((await f.running).status, "paused", "quit cannot become normal completion");
			assert.equal(f.pool.workerPids.length, 0);
		} finally {
			releaseRoot.resolve();
			cleanup.resolve();
			intercepted.mockRestore();
			await f.close();
		}
	},
	SINGLE_POOL.timeoutMs,
);
