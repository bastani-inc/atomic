import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore, SessionManager } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { createDurableStagePrimitive } from "../../packages/workflows/src/durable/stage-primitive.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createReplayStageContext } from "../../packages/workflows/src/runs/foreground/executor-stage-replay.js";
import { readReplayedStageMessages } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import { setAgentSessionAdapterDefaultCwd } from "../../packages/workflows/src/runs/foreground/stage-runner-session-options.js";
import {
	isStageReleasedError,
	StageReleasedError,
	StageWaitError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";

const DEFAULT_CWD = "/run/cwd";

async function storeWith(text: string): Promise<{ store: MemorySessionStore; sessionId: string }> {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	await manager.appendMessage({ role: "user", content: text, timestamp: 1 });
	return { store, sessionId: manager.getSessionId() };
}

function contents(messages: readonly object[]): string[] {
	return messages.map((message) => (message as { readonly content: string }).content);
}

function openedCwds(): () => (string | undefined)[] {
	const open = vi.spyOn(SessionManager, "open");
	return () => open.mock.calls.map((call) => call[2]);
}

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("which store a replayed stage's readMessages() reads (#4309)", () => {
	test("a stage's own sessionStore, sessionManager or sessionDir is read instead of the run's session store", async () => {
		const runStore = new MemorySessionStore();
		const ownStore = await storeWith("own store");
		assert.deepEqual(
			contents(
				await readReplayedStageMessages(
					{ sessionStore: ownStore.store },
					{ adapters: { sessionStore: runStore }, defaultCwd: DEFAULT_CWD },
					ownStore.sessionId,
				),
			),
			["own store"],
		);

		const managed = await storeWith("own manager");
		const manager = await SessionManager.open(managed.store, managed.sessionId, process.cwd());
		assert.deepEqual(
			contents(
				await readReplayedStageMessages(
					{ sessionManager: manager },
					{ adapters: { sessionStore: runStore }, defaultCwd: DEFAULT_CWD },
					managed.sessionId,
				),
			),
			["own manager"],
		);

		const directory = mkdtempSync(join(tmpdir(), "replayed-stage-dir-"));
		directories.push(directory);
		const diskStore = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const onDisk = await SessionManager.create(diskStore, process.cwd());
		await onDisk.appendMessage({ role: "user", content: "own directory", timestamp: 1 });
		await diskStore.close();
		assert.deepEqual(
			contents(
				await readReplayedStageMessages(
					{ sessionDir: directory, cwd: process.cwd() },
					{ adapters: { sessionStore: runStore }, defaultCwd: DEFAULT_CWD },
					onDisk.getSessionId(),
				),
			),
			["own directory"],
		);
	});

	test("without a store of its own, the run's session store is read, and a run without adapters reads the stage's store", async () => {
		const runStore = await storeWith("run store");
		assert.deepEqual(
			contents(
				await readReplayedStageMessages(
					{},
					{ adapters: { sessionStore: runStore.store }, defaultCwd: DEFAULT_CWD },
					runStore.sessionId,
				),
			),
			["run store"],
		);

		const ownStore = await storeWith("own store, no adapters");
		const cwds = openedCwds();
		assert.deepEqual(
			contents(
				await readReplayedStageMessages(
					{ sessionStore: ownStore.store },
					{ defaultCwd: DEFAULT_CWD },
					ownStore.sessionId,
				),
			),
			["own store, no adapters"],
		);
		assert.deepEqual(cwds(), [DEFAULT_CWD]);
	});

	test("the session opens in the stage's cwd, else its sessionManager's, else the adapter's default, else the run's", async () => {
		const { store, sessionId } = await storeWith("transcript");
		const manager = await SessionManager.open(store, sessionId, "/manager/cwd");
		const agentSession = { create: async () => assert.fail("no session is created") };
		setAgentSessionAdapterDefaultCwd(agentSession, "/adapter/cwd");
		const cwds = openedCwds();

		await readReplayedStageMessages(
			{ sessionStore: store, cwd: "/stage/cwd" },
			{ defaultCwd: DEFAULT_CWD },
			sessionId,
		);
		await readReplayedStageMessages(
			{ sessionManager: manager },
			{ adapters: { agentSession }, defaultCwd: DEFAULT_CWD },
			sessionId,
		);
		await readReplayedStageMessages(
			{ sessionStore: store },
			{ adapters: { agentSession }, defaultCwd: DEFAULT_CWD },
			sessionId,
		);
		await readReplayedStageMessages({ sessionStore: store }, { adapters: {}, defaultCwd: DEFAULT_CWD }, sessionId);

		assert.deepEqual(cwds(), ["/stage/cwd", "/manager/cwd", "/adapter/cwd", DEFAULT_CWD]);
	});
});

describe("replayed stage surfaces (#4309)", () => {
	test("a durable replayed stage without a reader of the run reads the session from the stage's own sessionStore", async () => {
		const { store, sessionId } = await storeWith("cached stage transcript");
		const backend = await JournalTestBackend.create();
		const replayKey = "stage:cached:1";
		await backend.commitWorkflowRegistration({
			workflowId: "wf-cached-reader",
			name: "cached-reader",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: "wf-cached-reader",
			checkpointId: `stage:${replayKey}`,
			name: "cached",
			replayKey,
			output: "cached output",
			sessionId,
			completedAt: Date.now(),
		});
		const stage = createDurableStagePrimitive({
			workflowId: "wf-cached-reader",
			backend,
			nextReplayKey: () => replayKey,
			stage: () => assert.fail("a replayed stage opens no live stage"),
		});

		const context = stage("cached", { sessionStore: store } satisfies StageOptions);

		assert.deepEqual(contents(await context.readMessages()), ["cached stage transcript"]);
	});

	test("the legacy replay context names agent as the member read", () => {
		const store = createStore();
		store.recordRunStart({
			id: "run",
			name: "replay",
			inputs: {},
			status: "running",
			stages: [],
			toolNodes: [],
			startedAt: 1,
		});
		const snapshot: StageSnapshot = { id: "stage", name: "saved", status: "running", parentIds: [], toolEvents: [] };
		const context = createReplayStageContext({
			runId: "run",
			name: "saved",
			stageId: "stage",
			stageSnapshot: snapshot,
			replaySource: { ...snapshot, status: "completed", result: "saved result" },
			activeStore: store,
			opts: {},
			tracker: new GraphFrontierTracker(),
			registerWorkflowExitCleanup: () => () => {},
			workflowExitSkippedReason: (reason) => `workflow-exit: ${reason}`,
			throwIfWorkflowExitSelected() {},
			readStoredMessages: async () => assert.fail("no stored messages are read"),
		});

		assert.throws(
			() => context.agent,
			(error: unknown) => isStageReleasedError(error) && error.fields.property === "agent",
		);
	});

	test("a replayed stage's hint names the member read, and agent when none is named", () => {
		const model = new StageReleasedError({ stageName: "saved", property: "model", replayed: true });
		assert.equal(
			model.hint,
			"The stage completed before the run was resumed and was replayed from its durable checkpoint, so it has no live session for stage.model to read and stage.rehydrate() cannot open one. Call await stage.readMessages() to read its stored transcript from the session store.",
		);
		const unnamed = new StageWaitError("stage-released", { stageName: "saved", replayed: true });
		assert.match(unnamed.hint, /no live session for stage\.agent to read/);
	});
});
