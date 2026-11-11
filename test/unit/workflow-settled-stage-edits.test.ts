import { afterEach, beforeEach, describe, vi } from "vitest";
import { createGraphStoreSnapshot } from "../../packages/workflows/src/shared/graph-store-snapshot.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { start } from "./run-eviction-helpers.js";

useTemporaryAgentDir();

const watching = (text: string): boolean => text.startsWith("watch");

/** Differences between the graph snapshot and a full derivation, found at every store change as the overlay reads it. */
function followGraphSnapshots(store: Store): string[] {
	const stale: string[] = [];
	store.subscribeInvalidation(() => {
		const snapshot = store.graphSnapshot();
		const full = createGraphStoreSnapshot(store.runs(), store.notices(), snapshot.version);
		for (const [runIndex, run] of full.runs.entries())
			for (const stage of run.stages) {
				const shown = snapshot.runs[runIndex]?.stages.find((candidate) => candidate.id === stage.id);
				if (JSON.stringify(shown) !== JSON.stringify(stage))
					stale.push(`${stage.name} (${stage.status}) at ${snapshot.version}`);
			}
	});
	return stale;
}

describe("a graph snapshot shows every field of a stage the executor edits after it settled (#4642)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z").getTime());
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("the results a waiting stage held are gone from its graph snapshot once the stage has finished (#4642)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		vi.spyOn(backend, "commitCheckpoint").mockImplementation(async (checkpoint, options) => {
			if (
				checkpoint.kind === "stage" &&
				checkpoint.wait !== undefined &&
				checkpoint.replayKey.startsWith("stage:agent:")
			)
				throw new Error("journal unreachable");
			return commit(checkpoint, options);
		});
		const started = start(
			workflow({
				name: "settled-wait-results",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const stage = ctx.stage("agent");
					await Promise.all([
						ctx.stage("other").prompt("watch other"),
						(async () => {
							await stage.prompt("plan");
							await stage.sendUserMessage("watch ci");
						})(),
					]);
					return {};
				},
			}),
			{ durableBackend: backend, detachWhen: watching },
		);
		const stale = followGraphSnapshots(started.store);
		await vi.advanceTimersByTimeAsync(10_000);
		started.service.finishAll();
		let finished = false;
		void started.result.finally(() => {
			finished = true;
		});
		while (!finished) await vi.advanceTimersByTimeAsync(500);
		assert.equal((await started.result).status, "completed");
		assert.deepEqual(stale, []);
	});

	test("a field a caller's onStageEnd callback sets on the ended stage shows in the graph snapshot (#4642)", async () => {
		vi.useRealTimers();
		const store = createStore();
		const stale = followGraphSnapshots(store);
		const midRun: unknown[] = [];
		const worktree = { id: "snap", root: "/work", head: "abc", tree: "def", omittedCount: 0, warnings: [] };
		const result = await run(
			workflow({
				name: "settled-worktree-snapshot",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("s").prompt("x");
					await new Promise((resolve) => setTimeout(resolve, 50));
					const shown = store.graphSnapshot().runs[0]?.stages.find((candidate) => candidate.name === "s");
					midRun.push(shown?.snapshot, shown?.skippedReason);
					return {};
				},
			}),
			{},
			{
				adapters: { prompt: { prompt: async (text: string) => `ok:${text}` } },
				store,
				onStageEnd: async (_runId, stage) => {
					stage.snapshot = worktree;
					stage.skippedReason = "edited by the caller";
				},
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(midRun, [worktree, "edited by the caller"], "read while the run is still running");
		assert.deepEqual(stale, []);
	});

	test("the store is told of the ended stage once a caller's onStageEnd callback has returned, whatever the callback did (#4642)", async () => {
		vi.useRealTimers();
		const store = createStore();
		const announced: string[] = [];
		const editRun = store.editRun.bind(store);
		store.editRun = (runId, edit) => {
			const edited = edit(store.run(runId)!);
			for (const stageId of edited.stageIds ?? []) announced.push(stageId);
			return editRun(runId, () => edited);
		};
		const events: string[] = [];
		const result = await run(
			workflow({
				name: "settled-callback",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.stage("s").prompt("x");
					return {};
				},
			}),
			{},
			{
				adapters: { prompt: { prompt: async (text: string) => `ok:${text}` } },
				store,
				onStageEnd: async (_runId, stage) => {
					announced.length = 0;
					events.push(`callback ${stage.id}`);
				},
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(events.length, 1);
		assert.equal(announced.length > 0, true, "the ended stage was announced after the callback");
	});
	test("a workflow-boundary stage shows what an async onStageEnd callback sets after an await (#4642)", async () => {
		vi.useRealTimers();
		const store = createStore();
		const stale = followGraphSnapshots(store);
		const midRun: unknown[] = [];
		const child = workflow({
			name: "settled-boundary-child",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("inner").prompt("x");
				return {};
			},
		});
		const result = await run(
			workflow({
				name: "settled-boundary-parent",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.workflow(child);
					await new Promise((resolve) => setTimeout(resolve, 50));
					const shown = store
						.graphSnapshot()
						.runs.find((candidate) => candidate.name === "settled-boundary-parent")
						?.stages.find((candidate) => candidate.name === "workflow:settled-boundary-child");
					midRun.push(shown?.skippedReason);
					return {};
				},
			}),
			{},
			{
				adapters: { prompt: { prompt: async (text: string) => `ok:${text}` } },
				store,
				onStageEnd: async (_runId, stage) => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					stage.skippedReason = `edited ${stage.name}`;
				},
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(midRun, ["edited workflow:settled-boundary-child"], "read while the parent is still running");
		assert.deepEqual(stale, []);
	});

	test("a stage ended through a promise-returning hook is named to the store again once the hook settles, and a rejection still rejects (#4642)", async () => {
		vi.useRealTimers();
		const { endStageWithHook } = await import("../../packages/workflows/src/runs/foreground/executor-lifecycle.js");
		const named: string[][] = [];
		const store = {
			editRun: (_runId: string, edit: () => { stageIds?: string[] }) => named.push(edit().stageIds ?? []),
		} as unknown as Store;
		const stage = { id: "s1", status: "completed" } as Parameters<typeof endStageWithHook>[2];
		let release: () => void = () => {};
		endStageWithHook(store, "r", stage, () => new Promise<void>((resolve) => (release = resolve)));
		assert.deepEqual(named, [["s1"]], "named once right away");
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(named, [["s1"], ["s1"]], "named again after the hook settled");

		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			endStageWithHook(store, "r", stage, async () => {
				throw new Error("hook failed");
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			process.off("unhandledRejection", onRejection);
		}
		assert.deepEqual(named.slice(2), [["s1"], ["s1"]], "named before and after the rejected hook");
		assert.equal((rejections[0] as Error | undefined)?.message, "hook failed");
	});
});
