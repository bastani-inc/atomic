import { afterEach, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStageControlRegistry, run, test, workflow } from "./executor-shared.js";
import { createPersistedStageFixture } from "./persisted-stage-fixture.js";

afterEach(closeMemoryTestBackends);

test("replacing a completed stage of a still-running workflow leaves its session to that workflow (#5559)", async () => {
	const registry = createStageControlRegistry();
	const fixture = createPersistedStageFixture({ reply: () => "done" });
	const def = workflow({
		name: "live-stage-owner",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const stage = ctx.stage("review");
			await stage.prompt("review");
			assert.ok(ctx.runId);
			const [handle] = registry.forRun(ctx.runId);
			assert.ok(handle);
			assert.equal(handle.status, "completed");
			registry.register({ ...handle, dispose: () => {} });
			await stage.sendUserMessage("use the stage again");
			return {};
		},
	});
	try {
		const result = await run(def, {}, { stageControlRegistry: registry, adapters: fixture.adapters });
		assert.equal(result.status, "completed");
		assert.deepEqual(fixture.sessions[0]!.prompts, ["review", "use the stage again"]);
		assert.equal(fixture.sessions[0]!.disposals, 1, "its execution released it when it ended");
	} finally {
		await registry.clear();
	}
});

async function failThenResume(onPrompt?: (text: string) => Promise<void>, beforeRetry?: () => Promise<void>) {
	const registry = createStageControlRegistry();
	const store = createStore();
	let first = true;
	const fixture = createPersistedStageFixture({
		reply: () => "done",
		async onPrompt(text) {
			if (first) {
				first = false;
				throw new Error("first attempt failed");
			}
			await onPrompt?.(text);
		},
	});
	const def = workflow({
		name: "resumed-stage-chat",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			if (!first) await beforeRetry?.();
			await ctx.task("review", { prompt: "review" });
			return {};
		},
	});
	const opts = {
		stageControlRegistry: registry,
		durableBackend: await createMemoryTestBackend(),
		store,
		adapters: fixture.adapters,
	};
	const failed = await run(def, {}, opts);
	assert.equal(failed.status, "failed");
	const [handle] = registry.forRun(failed.runId);
	assert.ok(handle);
	return {
		registry,
		store,
		fixture,
		handle,
		resume: () => run(def, {}, { ...opts, runId: failed.runId }),
	};
}

test("resuming a failed workflow after it ended releases its previous stage session (#5559)", async () => {
	const { registry, fixture, resume } = await failThenResume();
	try {
		assert.equal(fixture.sessions[0]!.disposals, 0);
		assert.equal((await resume()).status, "completed");
		assert.equal(fixture.sessions[0]!.disposals, 1, "replacement released the failed session");
	} finally {
		await registry.clear();
	}
	assert.equal(fixture.sessions[0]!.disposals, 1);
});

test("resume refuses an active post-mortem chat turn and succeeds after it finishes (#5559)", async () => {
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const { registry, handle, fixture, resume } = await failThenResume(async (text) => {
		if (text !== "old chat") return;
		entered.resolve();
		await finish.promise;
	});
	const turn = handle.prompt("old chat");
	try {
		await entered.promise;
		await assert.rejects(resume, /stage "review".*turn.*Esc.*resume/i);
		assert.equal(fixture.sessions.length, 1);
		assert.equal(registry.peek(handle.runId, handle.stageId), handle);
		finish.resolve();
		await turn;
		assert.equal((await resume()).status, "completed");
	} finally {
		finish.resolve();
		await turn.catch(() => {});
		await registry.clear();
	}
});

test("the old chat cannot start a turn during resume admission or after displacement while a reader still holds it (#5559)", async () => {
	const entered = Promise.withResolvers<void>();
	const allowStage = Promise.withResolvers<void>();
	const { registry, fixture, handle, resume } = await failThenResume(undefined, async () => {
		entered.resolve();
		await allowStage.promise;
	});
	const close = handle.subscribe(() => {});
	const resumed = resume();
	try {
		await entered.promise;
		await assert.rejects(() => handle.prompt("before replacement"), /resuming/);
		allowStage.resolve();
		assert.equal((await resumed).status, "completed");
		assert.equal(fixture.sessions[0]!.disposals, 0, "an external reader still holds the old session");
		await assert.rejects(() => handle.prompt("after replacement"), /replaced/);
		close();
		await vi.waitFor(() => assert.equal(fixture.sessions[0]!.disposals, 1));
		assert.deepEqual(fixture.sessions[0]!.prompts, ["review"]);
	} finally {
		allowStage.resolve();
		close();
		await resumed;
		await registry.clear();
	}
});

test("closing a pane on a previous run cannot clear a successor's attachment in another registry (#5559)", async () => {
	const { registry, store, handle } = await failThenResume();
	const old = store.run(handle.runId)!;
	const pane = new WorkflowAttachPane({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: handle.runId,
		initialAttachStageId: handle.stageId,
		stageControlRegistry: registry,
		onClose: () => {},
	});
	try {
		store.recordRunStart({
			...old,
			status: "running",
			stages: old.stages.map((stage) => ({ ...stage, attached: true })),
		});
		pane.dispose();
		assert.equal(store.run(handle.runId)?.stages[0]?.attached, true);
	} finally {
		pane.dispose();
		await registry.clear();
	}
});

test("two open stage panes follow a same-id resume and send to the resumed session (#5559)", async () => {
	const { registry, store, fixture, handle, resume } = await failThenResume();
	const openPane = () =>
		new WorkflowAttachPane({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: handle.runId,
			stageControlRegistry: registry,
			initialAttachStageId: handle.stageId,
			onClose: () => {},
		});
	const first = openPane();
	const second = openPane();
	try {
		assert.ok(first._hasChatView && second._hasChatView);
		for (const character of "second ") second.handleInput(character);
		second.setVisible(false);
		assert.equal((await resume()).status, "completed");
		second.setVisible(true);
		assert.equal(second._chatInputBuffer, "second ");
		assert.equal(fixture.sessions[0]!.disposals, 1, "both panes let go of the failed session");
		assert.equal(fixture.sessions[1]!.disposals, 0, "the resumed session is mounted");
		for (const [pane, text] of [
			[first, "first pane"],
			[second, "second pane"],
		] as const) {
			for (const character of text.slice(pane._chatInputBuffer?.length ?? 0)) pane.handleInput(character);
			assert.equal(pane._chatInputBuffer, text);
			pane.handleInput("\r");
			await vi.waitFor(() => assert.ok(fixture.sessions[1]!.prompts.includes(text)));
		}
		assert.deepEqual(fixture.sessions[0]!.prompts, ["review"]);
	} finally {
		first.dispose();
		second.dispose();
		await registry.clear();
	}
});
