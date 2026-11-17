import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { runParallelPath } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel.js";
import type {
	ExecutionContextData,
	ResolvedExecutorDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { createParallelWorktreeSetup } from "../../packages/subagents/src/runs/foreground/subagent-executor-worktree.js";
import { routeSubagentModel } from "../../packages/subagents/src/runs/shared/model-router.js";

vi.mock("../../packages/subagents/src/runs/shared/model-router.js", () => ({ routeSubagentModel: vi.fn() }));
vi.mock("../../packages/subagents/src/runs/foreground/subagent-executor-worktree.js", async (original) => ({
	...(await original<object>()),
	createParallelWorktreeSetup: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

function fixture() {
	const parent = new AbortController();
	const data = {
		params: {
			tasks: [
				{ agent: "worker", task: "a" },
				{ agent: "worker", task: "b" },
			],
		},
		agents: [{ name: "worker", model: "auto" }],
		ctx: { modelRegistry: { getAvailable: () => [], getAll: () => [] } },
		intercomBridge: { active: false },
		signal: parent.signal,
	} as unknown as ExecutionContextData;
	const deps = { config: {}, state: { foregroundControls: new Map() } } as unknown as ResolvedExecutorDeps;
	const sentinel = { content: [], details: { mode: "parallel", results: [] } };
	vi.mocked(createParallelWorktreeSetup).mockResolvedValue({ errorResult: sentinel } as Awaited<
		ReturnType<typeof createParallelWorktreeSetup>
	>);
	return { parent, run: () => runParallelPath(data, deps), sentinel };
}

test("failed parallel route cancels its uncooperative sibling without cancelling parent or admitting children", async () => {
	const f = fixture();
	const failure = new Error("routing failed");
	const signals: AbortSignal[] = [];
	vi.mocked(routeSubagentModel).mockImplementation(({ signal }) => {
		signals.push(signal!);
		return signals.length === 1 ? Promise.reject(failure) : new Promise(() => {});
	});
	await assert.rejects(f.run(), (error) => error === failure);
	assert.equal(signals.length, 2);
	assert.equal(signals[1]!.aborted, true);
	assert.equal(f.parent.signal.aborted, false);
	assert.equal(vi.mocked(createParallelWorktreeSetup).mock.calls.length, 0);
});

test("successful routes release parent cancellation linkage before admission", async () => {
	const f = fixture();
	const signals: AbortSignal[] = [];
	vi.mocked(routeSubagentModel).mockImplementation(async ({ signal }) => {
		signals.push(signal!);
		return { modelOverride: "test/model" } as Awaited<ReturnType<typeof routeSubagentModel>>;
	});
	assert.equal(await f.run(), f.sentinel);
	assert.equal(signals.length, 2);
	assert.equal(
		signals.some((signal) => signal.aborted),
		false,
	);
	f.parent.abort();
	assert.equal(
		signals.some((signal) => signal.aborted),
		false,
	);
});

test("parent cancellation promptly ends routing even when providers do not cooperate", async () => {
	const f = fixture();
	const started = Promise.withResolvers<void>();
	const signals: AbortSignal[] = [];
	vi.mocked(routeSubagentModel).mockImplementation(({ signal }) => {
		signals.push(signal!);
		if (signals.length === 2) started.resolve();
		return new Promise(() => {});
	});
	const pending = f.run();
	await started.promise;
	const reason = new Error("parent cancelled");
	f.parent.abort(reason);
	await assert.rejects(pending, (error) => error === reason);
	assert.equal(
		signals.every((signal) => signal.aborted),
		true,
	);
	assert.equal(vi.mocked(createParallelWorktreeSetup).mock.calls.length, 0);
});

test("already cancelled parent starts no parallel routing", async () => {
	const f = fixture();
	const reason = new Error("already cancelled");
	f.parent.abort(reason);
	await assert.rejects(f.run(), (error) => error === reason);
	assert.equal(vi.mocked(routeSubagentModel).mock.calls.length, 0);
	assert.equal(vi.mocked(createParallelWorktreeSetup).mock.calls.length, 0);
});
