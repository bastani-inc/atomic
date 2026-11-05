import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultSessionDirPath, JsonlSessionStore, SessionManager } from "@bastani/atomic";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { ForkCopyFailedError } from "../../packages/workflows/src/durable/fork-errors.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createDurableTaskPrimitive } from "../../packages/workflows/src/durable/stage-primitive.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { readText, writeFileEnsuringDir } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

for (const decision of [undefined, false, true] as const) {
	test(`cross-project resume ${decision === undefined ? "requires interactive confirmation" : decision ? "forks checkpoints" : "declines without changes"} (#3577)`, async () => {
		const backend = await createMemoryTestBackend();
		const store = createStore();
		const jobs = createJobTracker();
		let executions = 0;
		const def = workflow({
			name: "fork-test",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("saved", {}, async () => {
					executions++;
					return "saved";
				});
				return {};
			},
		});
		const registry = createRegistry().register(def);
		const id = testRunId("cross-project-source");
		await run(def, {}, { runId: id, durableBackend: backend, store: createStore(), cwd: "/source-project" });
		await backend.commitWorkflowStatus(id, "paused", 0, true);
		const original = structuredClone(backend.getWorkflow(id));
		let prompted = false;
		const result = await resumeDurableWorkflow(id, {
			registry,
			durableBackend: backend,
			jobs,
			baseRunOpts: { store, cwd: "/target-project" },
			...(decision === undefined
				? {}
				: {
						confirmCrossProjectFork: async (cwd: string) => {
							prompted = true;
							assert.equal(cwd, "/source-project");
							return decision;
						},
					}),
		});
		assert.equal(result.ok, decision === true, result.message);
		assert.equal(prompted, decision !== undefined);
		assert.deepEqual(backend.getWorkflow(id), original);
		if (result.ok) {
			assert.notEqual(result.runId, id);
			await jobs.get(result.runId)?.promise;
			assert.equal(backend.getWorkflow(result.runId)?.invocationCwd, "/target-project");
			assert.equal(executions, 1);
		} else {
			assert.match(result.message, decision === undefined ? /\/workflow resume.*interactive/i : /cancelled/i);
			assert.equal(store.runs().length, 0);
		}
	});
}

test("same-project resume retains its identity without prompting (#3577)", async () => {
	const backend = await createMemoryTestBackend();
	const store = createStore();
	const jobs = createJobTracker();
	const def = workflow({
		name: "same-project",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("saved", {}, async () => "saved");
			return {};
		},
	});
	const id = testRunId("same-project");
	await run(def, {}, { runId: id, durableBackend: backend, cwd: process.cwd(), store: createStore() });
	await backend.commitWorkflowStatus(id, "paused", 0, true);
	const result = await resumeDurableWorkflow(id, {
		registry: createRegistry().register(def),
		durableBackend: backend,
		jobs,
		baseRunOpts: { store, cwd: process.cwd() },
		confirmCrossProjectFork: async () => {
			assert.fail("same project must not prompt");
		},
	});
	assert.ok(result.ok, result.message);
	assert.equal(result.runId, id);
	await jobs.get(id)?.promise;
	assert.equal(backend.getWorkflow(id)?.status, "completed");
});

test("cross-project fork replays nested stage and tool checkpoints without changing the source (#3577)", async () => {
	const backend = await createMemoryTestBackend();
	const jobs = createJobTracker();
	const store = createStore();
	let calls = 0;
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("nested-tool", {}, async () => {
				calls++;
				return "saved";
			});
			await ctx.stage("nested-stage").complete("saved");
			return {};
		},
	});
	const def = workflow({
		name: "parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child);
			return {};
		},
	});
	const id = testRunId("nested-fork");
	const adapters = {
		complete: {
			complete: async (text: string) => {
				calls++;
				return text;
			},
		},
	};
	await run(def, {}, { runId: id, durableBackend: backend, cwd: "/source-project", store: createStore(), adapters });
	await backend.commitWorkflowStatus(id, "paused", 0, true);
	const original = structuredClone(backend.listCheckpoints(id));
	assert.equal(calls, 2);
	const result = await resumeDurableWorkflow(id, {
		registry: createRegistry(),
		resolveDefinition: async () => def,
		durableBackend: backend,
		jobs,
		baseRunOpts: { store, cwd: "/target-project", adapters },
		confirmCrossProjectFork: async () => true,
	});
	assert.ok(result.ok, result.message);
	await jobs.get(result.runId)?.promise;
	assert.equal(backend.getWorkflow(result.runId)?.status, "completed", JSON.stringify(store.runs()));
	assert.equal(calls, 2);
	assert.deepEqual(backend.listCheckpoints(id), original);
	assert.ok(store.runs().every((snapshot) => snapshot.id !== id));
});

test("forked stage conversations copy history without sharing the source session (#3577)", async () => {
	const root = mkdtempSync(join(tmpdir(), "workflow-fork-history-"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	try {
		const cwd = join(root, "target");
		const sourceCwd = join(root, "source");
		vi.stubEnv("ATOMIC_CODING_AGENT_SESSION_DIR", getDefaultSessionDirPath(sourceCwd));
		const sourcePath = join(getDefaultSessionDirPath(sourceCwd), "source.jsonl");
		const history = `${[
			{
				type: "session",
				version: 4,
				id: "source-session",
				createdAt: new Date().toISOString(),
				cwd: sourceCwd,
			},
			{
				type: "custom",
				id: "history-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "saved-history",
				data: { value: "retained" },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		await writeFileEnsuringDir(sourcePath, history);
		const backend = await createMemoryTestBackend();
		const id = testRunId("stage-session-source");
		await backend.commitWorkflowRegistration({
			workflowId: id,
			name: "history",
			inputs: { items: ["source"] },
			status: "paused",
			createdAt: 1,
			invocationCwd: sourceCwd,
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: id,
			checkpointId: "stage",
			name: "saved-stage",
			replayKey: "stage",
			sessionFile: sourcePath,
			sessionId: "source-session",
			output: {
				name: "saved-stage",
				stageName: "saved-stage",
				text: "saved",
				sessionId: "source-session",
				sessionFile: sourcePath,
			},
			completedAt: 1,
		});
		const originalCheckpoint = backend.listCheckpoints(id)[0];
		await backend.commitCheckpoint({ ...originalCheckpoint, checkpointId: "second-stage" });
		const sessionStore = await JsonlSessionStore.open(root, { exactDirectory: true });
		const forkSession = vi.spyOn(sessionStore, "create");
		let forkId: string;
		try {
			forkId = (
				await forkDurableRun(backend, {
					source: "cli",
					runId: id,
					cwd,
					carryMessages: "all",
					definition: workflow({
						name: "history",
						description: "",
						inputs: { items: Type.Array(Type.String()) },
						outputs: {},
						run: async () => ({}),
					}),
					sessionStore,
				})
			).runId;
			assert.equal(forkSession.mock.calls.length, 1);
		} finally {
			forkSession.mockRestore();
		}
		const forkedStages = backend.listCheckpoints(forkId).filter((entry) => entry.kind === "stage");
		assert.equal(forkedStages[1].sessionId, forkedStages[0].sessionId);
		const checkpoint = backend.listCheckpoints(forkId)[0];
		assert.equal(checkpoint.kind, "stage");
		if (checkpoint.kind !== "stage") assert.fail("stage checkpoint required");
		assert.ok(checkpoint.sessionFile);
		assert.notEqual(checkpoint.sessionFile, sourcePath);
		assert.notEqual(checkpoint.sessionId, "source-session");
		const task = createDurableTaskPrimitive({
			workflowId: forkId,
			backend,
			nextReplayKey: () => "stage",
			task: async () => {
				throw new Error("fork must replay the saved task");
			},
		});
		const replayed = await task("saved-stage", { prompt: "ignored" });
		assert.equal(replayed.sessionId, checkpoint.sessionId);
		assert.equal(replayed.sessionFile, checkpoint.sessionFile);
		const fork = await SessionManager.open(sessionStore, checkpoint.sessionId!);
		assert.equal(fork.getCwd(), cwd);
		assert.ok(fork.getEntries().some((entry) => entry.type === "custom" && entry.customType === "saved-history"));
		assert.equal(await readText(sourcePath), history);
		const forkItems = backend.getWorkflow(forkId)!.inputs.items;
		assert.ok(Array.isArray(forkItems));
		forkItems.push("fork-only");
		assert.deepEqual(backend.getWorkflow(id)!.inputs.items, ["source"]);
		await sessionStore.close();
	} finally {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

test("cross-project forks read the source project store and write the selected destination store", async () => {
	const root = mkdtempSync(join(tmpdir(), "workflow-fork-stores-"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	const destination = await JsonlSessionStore.open(join(root, "destination"), { exactDirectory: true });
	try {
		const sourceCwd = join(root, "source");
		const source = await SessionManager.create(sourceCwd);
		await source.appendMessage({ role: "user", content: "Source conversation", timestamp: 1 });
		const backend = await createMemoryTestBackend();
		const sourceId = testRunId("separate-stores");
		await backend.commitWorkflowRegistration({
			workflowId: sourceId,
			name: "history",
			inputs: {},
			status: "paused",
			createdAt: 1,
			invocationCwd: sourceCwd,
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: sourceId,
			checkpointId: "saved",
			name: "saved",
			replayKey: "saved",
			sessionId: source.getSessionId(),
			output: { text: "saved", sessionId: source.getSessionId() },
			completedAt: 1,
		});
		const { runId: forkId } = await forkDurableRun(backend, {
			source: "cli",
			runId: sourceId,
			cwd: join(root, "target"),
			carryMessages: "all",
			definition: workflow({ name: "history", description: "", inputs: {}, outputs: {}, run: async () => ({}) }),
			sessionStore: destination,
		});
		const checkpoint = backend.listCheckpoints(forkId)[0];
		assert.equal(checkpoint.kind, "stage");
		if (checkpoint.kind !== "stage") assert.fail("stage checkpoint required");
		const copied = await SessionManager.open(destination, checkpoint.sessionId!);
		assert.deepEqual(copied.buildSessionContext().messages, source.buildSessionContext().messages);
		assert.notEqual(copied.getSessionId(), source.getSessionId());
		await source.getSessionStore().close();
	} finally {
		await destination.close();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

test("cross-project fork retries an interrupted tool frontier and replays earlier work (#3577)", async () => {
	const backend = await createMemoryTestBackend();
	const jobs = createJobTracker();
	let earlierCalls = 0;
	let retryCalls = 0;
	let fail = true;
	const def = workflow({
		name: "failed-fork",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("earlier", {}, async () => {
				earlierCalls++;
				return "saved";
			});
			await ctx.tool("interrupted", {}, async () => {
				retryCalls++;
				if (fail) throw new Error("interrupted");
				return "done";
			});
			return {};
		},
	});
	const id = testRunId("failed-fork");
	await run(def, {}, { runId: id, durableBackend: backend, cwd: "/source-project", store: createStore() });
	assert.equal(backend.getWorkflow(id)?.status, "failed");
	const source = structuredClone(backend.getWorkflow(id));
	fail = false;
	const result = await resumeDurableWorkflow(id, {
		registry: createRegistry().register(def),
		durableBackend: backend,
		jobs,
		baseRunOpts: { store: createStore(), cwd: "/target-project" },
		confirmCrossProjectFork: async () => true,
	});
	assert.ok(result.ok, result.message);
	await jobs.get(result.runId)?.promise;
	assert.equal(backend.getWorkflow(result.runId)?.status, "completed", backend.getWorkflow(result.runId)?.error);
	assert.equal(earlierCalls, 1);
	assert.equal(retryCalls, 2);
	assert.deepEqual(backend.getWorkflow(id), source);
});

test("an interrupted cross-project fork copy leaves no run, and a retry forks every checkpoint (#3577, #4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("interrupted-copy");
	const definition = workflow({ name: "copy", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
	await backend.commitWorkflowRegistration({
		workflowId: sourceId,
		name: "copy",
		inputs: {},
		status: "paused",
		createdAt: 1,
	});
	for (const name of ["first", "second"]) {
		await backend.commitCheckpoint({
			kind: "tool",
			workflowId: sourceId,
			checkpointId: name,
			name,
			argsHash: name,
			output: "saved",
			completedAt: 1,
		});
	}
	const request = {
		source: "cli" as const,
		runId: sourceId,
		cwd: "/target-project",
		carryMessages: "all" as const,
		definition,
	};
	const create = backend.journal.createRunWithEvents.bind(backend.journal);
	const interrupted = vi
		.spyOn(backend.journal, "createRunWithEvents")
		.mockImplementationOnce(async (header, events) => {
			await assert.rejects(create(header, [...events, events[1]!]));
			throw new Error("copy interrupted");
		});
	const failure = await forkDurableRun(backend, request).catch((error: Error) => error);
	interrupted.mockRestore();
	assert.ok(failure instanceof ForkCopyFailedError);
	assert.equal(await backend.journal.getRun(failure.forkRunId), undefined);
	assert.ok(!backend.listResumableWorkflows().some((entry) => entry.workflowId === failure.forkRunId));
	const { runId: completedId } = await forkDurableRun(backend, request);
	assert.equal(backend.listCheckpoints(completedId).length, 2);
	assert.ok(backend.listResumableWorkflows().some((entry) => entry.workflowId === completedId));
});

test("forked sticky messages reach stages under the fork root (#3577)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("sticky-fork-source");
	const sourceStore = createStore();
	sourceStore.recordRunStart({
		id: sourceId,
		name: "sticky",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	await backend.commitWorkflowRegistration({
		workflowId: sourceId,
		name: "sticky",
		inputs: {},
		status: "paused",
		createdAt: 1,
	});
	const target = `workflow:${sourceId}/review-*`;
	await sourceStore.queueStickyStageMessage(
		{
			runId: sourceId,
			stageKey: target,
			targetPath: target,
			from: { id: "sender", group: `workflow:${sourceId}` },
			message: { id: "instruction", timestamp: 1, content: { text: "review carefully" } },
			queuedAt: new Date(1).toISOString(),
		},
		`workflow:${sourceId}`,
		`workflow:${sourceId}`,
		backend,
	);
	const original = structuredClone(backend.getWorkflow(sourceId));
	const { runId: forkId } = await forkDurableRun(backend, {
		source: "cli",
		runId: sourceId,
		cwd: "/target-project",
		carryMessages: "all",
		definition: workflow({ name: "sticky", description: "", inputs: {}, outputs: {}, run: async () => ({}) }),
	});
	const pending = backend.getWorkflow(forkId)!.pendingStageMessages;
	assert.equal(pending?.[0].stageKey, `workflow:${forkId}/review-*`);
	assert.equal(pending?.[0].targetPath, `workflow:${forkId}/review-*`);
	const store = createStore();
	store.recordRunStart({
		id: forkId,
		name: "sticky",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "review-stage", name: "review-one", status: "pending", parentIds: [], toolEvents: [] }],
		pendingStageMessages: pending === undefined ? undefined : [...pending],
	});
	bindStoreDurableBackend(store, backend);
	try {
		let delivered = 0;
		await createWorkflowPendingStageDelivery(store, forkId, "review-stage", "review-one").deliverPending(() => {
			delivered++;
		});
		assert.equal(delivered, 1);
		assert.deepEqual(backend.getWorkflow(sourceId), original);
	} finally {
		setDurableBackend(undefined);
	}
});
