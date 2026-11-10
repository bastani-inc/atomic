import { describe, vi } from "vitest";
import { createCompletedStageAnswerer } from "../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import { createPostMortemHandleResolver } from "../../packages/workflows/src/extension/postmortem-deps.js";
import {
	acquirePostMortemStageHandle,
	ensurePostMortemStageHandle,
} from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import type {
	ReleasedStage,
	StageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { assert, createStageControlRegistry, run, test, waitForMicrotasks, workflow } from "./executor-shared.js";
import { createPersistedStageFixture, type PersistedStageFixture } from "./persisted-stage-fixture.js";

/** Long enough for a release to load the saved transcript and dispose the session; failing tests wait this long. */
const RELEASE_SETTLE_MS = 2_000;

interface EndedRun {
	readonly registry: StageControlRegistry;
	readonly store: ReturnType<typeof createStore>;
	readonly fixture: PersistedStageFixture;
	readonly runId: string;
	readonly stageId: string;
	readonly released: ReleasedStage[];
	readonly resolve: ReturnType<typeof createPostMortemHandleResolver>;
	/** Stage sessions created and not yet disposed. */
	live(): number;
}

/** Runs a one-stage workflow to its end, which releases the completed stage's session. */
async function endedRunWithReleasedStage(): Promise<EndedRun> {
	const registry = createStageControlRegistry();
	const store = createStore();
	const fixture = createPersistedStageFixture({ reply: (text) => `answer to: ${text}` });
	const released: ReleasedStage[] = [];
	registry.onStageReleased((stage) => released.push(stage));
	const def = workflow({
		name: "reopened-stage-release",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("only").prompt("workflow prompt");
			return {};
		},
	});
	await run(def, {}, { store, stageControlRegistry: registry, adapters: fixture.adapters });
	const runSnapshot = store.runs()[0]!;
	const stageId = runSnapshot.stages[0]!.id;
	assert.equal(fixture.disposals(), 1, "the run's end released the completed stage");
	return {
		registry,
		store,
		fixture,
		runId: runSnapshot.id,
		stageId,
		released,
		resolve: createPostMortemHandleResolver({
			adapters: fixture.adapters,
			resolveDefaultStageSessionDir: () => undefined,
			store,
			stageControlRegistry: registry,
		}),
		live: () => fixture.sessions.length - fixture.disposals(),
	};
}

/** Waits for the release that follows the last hold ending; nothing here asks the registry to release. */
async function untilReleased(ended: EndedRun): Promise<void> {
	await vi.waitFor(
		() => {
			assert.equal(ended.live(), 0, "the reopened session went back to its saved transcript");
			assert.equal(ended.registry.get(ended.runId, ended.stageId), undefined);
		},
		{ timeout: RELEASE_SETTLE_MS, interval: 5 },
	);
}

function attachPane(ended: EndedRun): WorkflowAttachPane {
	return new WorkflowAttachPane({
		store: ended.store,
		graphTheme: deriveGraphTheme({}),
		runId: ended.runId,
		stageControlRegistry: ended.registry,
		resolvePostMortemHandle: ended.resolve,
		initialAttachStageId: ended.stageId,
		onClose: () => {},
	});
}

async function mountedChatHandle(ended: EndedRun, pane: WorkflowAttachPane) {
	await vi.waitFor(() => assert.equal(pane._hasChatView, true), { timeout: RELEASE_SETTLE_MS, interval: 5 });
	const handle = ended.registry.get(ended.runId, ended.stageId);
	assert.ok(handle, "the attached chat holds the reopened stage's handle");
	return handle;
}

describe("a finished stage that was reopened returns to its saved transcript once nothing holds it", () => {
	test("attaching, messaging from the chat and detaching releases the stage again (#4642)", async () => {
		const ended = await endedRunWithReleasedStage();
		const pane = attachPane(ended);
		try {
			const handle = await mountedChatHandle(ended, pane);
			await handle.sendUserMessage?.("what did you change?");
			await waitForMicrotasks();
			assert.equal(ended.live(), 1, "the mounted chat keeps the reopened session");

			pane.retarget(ended.runId);
			await untilReleased(ended);
			assert.deepEqual(ended.fixture.sessions[1]!.prompts, ["what did you change?"]);

			pane.retarget(ended.runId, ended.stageId);
			const reopened = await mountedChatHandle(ended, pane);
			assert.notEqual(reopened, handle, "the next attach rebuilds the stage from its transcript");
			await reopened.sendUserMessage?.("and then?");
			assert.deepEqual(
				ended.fixture.sessions[2]!.session.messages.map((message) => message.role),
				["user", "assistant", "user", "assistant", "user", "assistant"],
				"the rebuilt session continues the saved conversation",
			);
			pane.retarget(ended.runId);
			await untilReleased(ended);
		} finally {
			pane.dispose();
			await ended.registry.clear();
		}
	});

	test("a message sent to a released stage reopens it for the turn and releases it after (#4642)", async () => {
		const ended = await endedRunWithReleasedStage();
		const resolved = await ended.resolve(ended.runId, ended.stageId);
		assert.equal(resolved?.ok, true);
		if (resolved?.ok !== true) return;

		await resolved.handle.sendUserMessage?.("any blockers?");
		await untilReleased(ended);
		assert.deepEqual(ended.fixture.sessions[1]!.prompts, ["any blockers?"]);
		assert.equal(resolved.handle.isDisposed, true);

		const again = await ended.resolve(ended.runId, ended.stageId);
		assert.equal(again?.ok, true);
		if (again?.ok !== true) return;
		await again.handle.prompt("one more");
		await untilReleased(ended);
		assert.equal(ended.fixture.sessions.length, 3, "each message rebuilt the stage once");
		assert.deepEqual(ended.fixture.sessions[2]!.prompts, ["one more"]);
	});

	test("a message delivered through a detached lease is released when the lease ends (#4642)", async () => {
		const ended = await endedRunWithReleasedStage();
		const stage = ended.store.runs()[0]!.stages[0]!;
		const acquired = await acquirePostMortemStageHandle(ended.runId, stage, {
			registry: ended.registry,
			adapters: ended.fixture.adapters,
		});
		assert.equal(acquired.ok, true);
		if (!acquired.ok) return;
		await acquired.lease.handle.sendUserMessage?.("status?");
		assert.equal(ended.live(), 1, "the lease keeps the session");
		await acquired.lease.release();
		await untilReleased(ended);
	});

	test("an Intercom ask reopens the stage for one turn, then it is released and announced under the same session (#4642)", async () => {
		const ended = await endedRunWithReleasedStage();
		const answer = createCompletedStageAnswerer(ended.resolve);
		const first = ended.released[0];
		assert.ok(first, "the run's end announced the released stage");

		assert.equal(await answer(ended.runId, ended.stageId, "which file?"), "answer to: which file?");
		await untilReleased(ended);
		assert.deepEqual(
			ended.released.map(({ runId, stageId, stageName, sessionId }) => ({ runId, stageId, stageName, sessionId })),
			[first, first],
			"each release announces the stage with the same session, so it keeps its Intercom name",
		);

		assert.equal(await answer(ended.runId, ended.stageId, "and the test?"), "answer to: and the test?");
		await untilReleased(ended);
		assert.equal(ended.fixture.sessions.length, 3);
		assert.deepEqual(
			ended.fixture.sessions[2]!.session.messages.map((message) => message.role),
			["user", "assistant", "user", "assistant", "user", "assistant"],
			"the second ask continues the conversation the first one saved",
		);
	});

	test("a chat mounted but hidden keeps the stage until it is unmounted (#4642)", async () => {
		const ended = await endedRunWithReleasedStage();
		const pane = attachPane(ended);
		try {
			const handle = await mountedChatHandle(ended, pane);
			await handle.sendUserMessage?.("still there?");
			pane.setVisible(false);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(pane._hasChatView, true, "the hidden pane keeps its chat mounted");
			assert.equal(ended.live(), 1, "a hidden mounted chat keeps the session");
			assert.equal(ended.registry.get(ended.runId, ended.stageId), handle);

			pane.dispose();
			await untilReleased(ended);
		} finally {
			pane.dispose();
			await ended.registry.clear();
		}
	});

	test("a handle claimed by one consumer is kept while another lets go, until the claimer used it (#4642)", async () => {
		const ended = await endedRunWithReleasedStage();
		const stage = ended.store.runs()[0]!.stages[0]!;
		const deps = { registry: ended.registry, adapters: ended.fixture.adapters };
		const watcher = await ensurePostMortemStageHandle(ended.runId, stage, deps);
		assert.equal(watcher.ok, true);
		if (!watcher.ok) return;
		const unsubscribe = watcher.handle.subscribe(() => {});
		const claimer = await ensurePostMortemStageHandle(ended.runId, stage, deps);
		assert.equal(claimer.ok, true);
		if (!claimer.ok) return;
		assert.equal(claimer.handle, watcher.handle);

		unsubscribe();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(ended.registry.get(ended.runId, ended.stageId), claimer.handle, "the claimer still has it");

		await claimer.handle.prompt("now I use it");
		await untilReleased(ended);
	});
});

describe("a stage the workflow body still holds keeps its session", () => {
	test("a chat opened and closed on a ctx.stage the body still holds does not release it (#4642)", async () => {
		const registry = createStageControlRegistry();
		const store = createStore();
		const fixture = createPersistedStageFixture();
		let ids: { runId: string; stageId: string } | undefined;
		let disposalsWhileHeld: number | undefined;
		const def = workflow({
			name: "held-stage-context",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("held");
				await stage.prompt("first");
				const handle = registry.get(ids!.runId, ids!.stageId)!;
				const closeChat = handle.subscribe(() => {});
				await handle.sendUserMessage?.("from the chat");
				closeChat();
				await new Promise((resolve) => setTimeout(resolve, 20));
				disposalsWhileHeld = fixture.disposals();
				await stage.sendUserMessage("the body uses it again");
				return {};
			},
		});

		const result = await run(
			def,
			{},
			{
				store,
				stageControlRegistry: registry,
				adapters: fixture.adapters,
				onStageStart: (runId, stage) => {
					ids ??= { runId, stageId: stage.id };
				},
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(disposalsWhileHeld, 0, "the chat closing did not release a stage the body holds");
		assert.equal(fixture.sessions.length, 1, "the body kept using the same session");
		assert.deepEqual(fixture.sessions[0]!.prompts, ["first", "from the chat", "the body uses it again"]);
		assert.equal(fixture.disposals(), 1, "the run's end released it");
	});
});
