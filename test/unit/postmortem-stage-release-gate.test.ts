import { describe, vi } from "vitest";
import { createPostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { assert, createStageControlRegistry, deferred, run, test, workflow } from "./executor-shared.js";
import {
	createPersistedStageFixture,
	type PersistedStageFixture,
	type PersistedStageFixtureOptions,
} from "./persisted-stage-fixture.js";

const SETTLE_MS = 2_000;

interface SavedStage {
	readonly fixture: PersistedStageFixture;
	readonly store: ReturnType<typeof createStore>;
	readonly registry: ReturnType<typeof createStageControlRegistry>;
	readonly runId: string;
	readonly stageId: string;
	/** A fresh post-mortem handle over the stage's saved transcript; `withStore: false` gives it no session store. */
	reopen(withStore?: boolean): StageControlHandle;
}

async function savedStage(options: PersistedStageFixtureOptions = {}): Promise<SavedStage> {
	const registry = createStageControlRegistry();
	const store = createStore();
	const fixture = createPersistedStageFixture(options);
	const def = workflow({
		name: "post-mortem-gate",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("only").prompt("workflow prompt");
			return {};
		},
	});
	await run(def, {}, { store, stageControlRegistry: registry, adapters: fixture.adapters });
	const stage = store.runs()[0]!.stages[0]!;
	return {
		fixture,
		store,
		registry,
		runId: store.runs()[0]!.id,
		stageId: stage.id,
		reopen: (withStore = true) =>
			createPostMortemStageHandle(
				store.runs()[0]!.id,
				stage,
				stage.sessionId!,
				fixture.adapters,
				undefined,
				undefined,
				withStore ? fixture.store : undefined,
			),
	};
}

function gateOf(handle: StageControlHandle) {
	const gate = handle.releaseGate;
	assert.ok(gate, "a post-mortem handle can be released again");
	return gate;
}

describe("the release gate of a reopened stage (#4642)", () => {
	test("a handle that never opened its session is idle and reopens from the store it was given", async () => {
		const stage = await savedStage();
		const handle = stage.reopen();
		const gate = gateOf(handle);

		assert.equal(gate.idle(), true);
		assert.equal(await gate.savedForReopen(), stage.fixture.store);
		assert.equal(stage.fixture.sessions.length, 1, "checking the transcript opens no session");
		assert.equal(await gateOf(stage.reopen(false)).savedForReopen(), undefined, "no store, nothing to reopen from");
	});

	test("a disposed handle is neither idle nor reopenable", async () => {
		const stage = await savedStage();
		const handle = stage.reopen();
		await handle.dispose?.();

		assert.equal(gateOf(handle).idle(), false);
		assert.equal(await gateOf(handle).savedForReopen(), undefined);
	});

	test("queued messages and a busy session keep the reopened session; their end is reported", async () => {
		const stage = await savedStage();
		const handle = stage.reopen();
		const gate = gateOf(handle);
		await handle.ensureAttached();
		const record = stage.fixture.sessions[1]!;
		let lifted = 0;
		gate.onHoldLifted(() => {
			lifted += 1;
		});
		assert.equal(gate.idle(), true, "an open session with nothing to do is idle");

		record.emit({ type: "queue_update", steering: ["later"], followUp: [] });
		assert.equal(gate.idle(), false, "a queued message keeps it");
		record.emit({ type: "queue_update", steering: [], followUp: [] });
		assert.equal(gate.idle(), true);

		record.activity.streaming = true;
		assert.equal(gate.idle(), false, "an active turn keeps it");
		record.activity.streaming = false;
		record.emit({ type: "agent_settled", aborted: false });
		assert.equal(gate.idle(), true);
		assert.equal(lifted, 3, "both queue updates and the settled turn were reported");
		await handle.dispose?.();
	});

	test("steering and follow-ups hold the reopened session while they run and reach it", async () => {
		const steered: string[] = [];
		const stage = await savedStage({ onSteer: (text) => void steered.push(text) });
		const handle = stage.reopen();
		const gate = gateOf(handle);
		await handle.ensureAttached();
		const followUp = vi.spyOn(stage.fixture.sessions[1]!.session, "followUp");
		const before = gate.holdsTaken();

		await handle.steer("steer it");
		await handle.followUp("follow it up");

		assert.equal(gate.holdsTaken(), before + 2);
		assert.deepEqual(steered, ["steer it"]);
		assert.deepEqual(
			followUp.mock.calls.map(([text]) => text),
			["follow it up"],
		);
		await handle.dispose?.();
	});

	test("a message admits through the caller's check, and a handle closed before admission refuses it", async () => {
		const opening = deferred();
		let opened = 0;
		const stage = await savedStage({
			onCreate: async () => {
				opened += 1;
				if (opened > 1) await opening.promise;
				return undefined;
			},
		});
		const handle = stage.reopen();
		let admitted = 0;
		const sending = handle.sendUserMessage?.("too late", undefined, () => {
			admitted += 1;
		});
		await vi.waitFor(() => assert.equal(opened, 2), { timeout: SETTLE_MS, interval: 5 });
		const disposed = handle.dispose?.();
		opening.resolve();

		await assert.rejects(sending!);
		await disposed;
		assert.equal(admitted, 0, "nothing was admitted to a closed handle");

		const open = stage.reopen();
		await open.sendUserMessage?.("on time", undefined, () => {
			admitted += 1;
		});
		assert.equal(admitted, 1);
		await open.dispose?.();
	});

	test("a disposed handle tells nobody about operations that fail after it closed", async () => {
		const stage = await savedStage();
		const handle = stage.reopen();
		let lifted = 0;
		gateOf(handle).onHoldLifted(() => {
			lifted += 1;
		});
		await handle.dispose?.();

		await assert.rejects(handle.prompt("after close"));
		assert.equal(lifted, 0);
	});
});
