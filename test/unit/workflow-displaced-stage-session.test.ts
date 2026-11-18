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

async function failThenResume(onPrompt?: (text: string) => Promise<void>) {
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
		assert.equal((await resume()).status, "completed");
		assert.equal(fixture.sessions[0]!.disposals, 1, "both panes let go of the failed session");
		assert.equal(fixture.sessions[1]!.disposals, 0, "the resumed session is mounted");
		for (const [pane, text] of [
			[first, "first pane"],
			[second, "second pane"],
		] as const) {
			for (const character of text) pane.handleInput(character);
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
