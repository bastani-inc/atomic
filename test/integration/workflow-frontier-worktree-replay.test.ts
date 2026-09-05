import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	workflowInterruptAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { sleep } from "../helpers/runtime.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";

// Exercise the public executor without creating another Git checkout for this regression.
const filesystem = vi.hoisted(() => ({ prepared: 0, cleaned: 0, collected: 0 }));
vi.mock("../../packages/workflows/src/runs/shared/worktree-setup.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/workflows/src/runs/shared/worktree-setup.js")>()),
	createWorktrees: (cwd: string) => {
		filesystem.prepared++;
		return { cwd, baseCommit: "fixture", worktrees: [{ path: cwd, agentCwd: cwd, branch: "fixture" }] };
	},
	cleanupWorktrees: () => {
		filesystem.cleaned++;
	},
}));
vi.mock("../../packages/workflows/src/runs/shared/worktree-diff.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/workflows/src/runs/shared/worktree-diff.js")>()),
	diffWorktrees: () => {
		filesystem.collected++;
		return [];
	},
}));

afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "workflow did not settle");
		await sleep(10);
	}
}

// PR #2864 discussion_r3939119993: live preparation must not displace cached predecessors.
test("public tool-frontier resume replays a completed worktree task without preparing it again", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	let models = 0;
	let tools = 0;
	const definition = workflow({
		name: "worktree-frontier-replay",
		description: "preserve worktree task replay before the exact frontier",
		inputs: {},
		outputs: { text: Type.String() },
		run: async (ctx) => {
			const task = await ctx.task("cached-task", { prompt: "cached", worktree: true });
			await ctx.tool("target", {}, async ({ signal }) => {
				tools++;
				if (tools === 1)
					await new Promise<void>((_resolve, reject) =>
						signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
					);
				return true;
			});
			return { text: task.text };
		},
	});
	const runtime = createExtensionRuntime({
		store,
		registry: createRegistry([definition]),
		adapters: {
			prompt: {
				prompt: async () => {
					models++;
					return "  cached\n";
				},
			},
		},
	});
	const started = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
	assert.ok(started.action === "run");
	await waitFor(() => tools === 1);
	const source = store.runs().find((run) => run.id === started.runId)!;
	const target = source.toolNodes!.find((node) => node.name === "target")!;
	await workflowInterruptAction({ action: "interrupt", runId: source.id, stageId: target.id });
	await waitFor(() => source.endedAt !== undefined);
	assert.equal(source.status, "failed");
	assert.deepEqual(filesystem, { prepared: 1, cleaned: 1, collected: 1 });
	const resumed = await workflowResumeAction(
		{ action: "resume", runId: source.id },
		{ getRuntime: () => runtime, policy: INTERACTIVE_WORKFLOW_POLICY, ensureWorkflowResourcesLoaded: async () => {} },
	);
	assert.ok(resumed.action === "resume");
	assert.equal(resumed.status, "running", resumed.message);
	await waitFor(() => store.runs().some((run) => run.resumedFromRunId === source.id && run.endedAt !== undefined));
	const continuation = store.runs().find((run) => run.resumedFromRunId === source.id)!;
	assert.equal(continuation.status, "completed", continuation.error);
	assert.deepEqual(continuation.result, { text: "  cached\n" });
	assert.deepEqual([models, tools], [1, 2]);
	assert.deepEqual(filesystem, { prepared: 1, cleaned: 1, collected: 1 });
});

test("live task admission still resolves reusable worktree options before model execution", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	let models = 0;
	const definition = workflow({
		name: "task-worktree-options",
		description: "keep existing reusable worktree validation after admission",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("live-task", { prompt: "live", gitWorktreeDir: "" });
			return {};
		},
	});
	const runtime = createExtensionRuntime({
		store,
		registry: createRegistry([definition]),
		adapters: {
			prompt: {
				prompt: async () => {
					models++;
					return "live";
				},
			},
		},
	});
	const started = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
	assert.ok(started.action === "run");
	await waitFor(() => store.runs().some((run) => run.id === started.runId && run.endedAt !== undefined));
	const ended = store.runs().find((run) => run.id === started.runId)!;
	assert.equal(ended.status, "failed");
	assert.match(ended.error ?? "", /gitWorktreeDir cannot be empty/);
	assert.equal(models, 0);
});
