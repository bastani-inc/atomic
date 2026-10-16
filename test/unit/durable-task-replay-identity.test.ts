import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkflowTaskResult } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";
import { createStore, mockSession, run, tmpdir, workflow } from "./executor-shared.js";

// #1859: task replay must preserve returned identity, not only the graph snapshot.
test("public task retains thinking identity through checkpoint serialization and replay", async () => {
	const runId = "task-thinking-replay";
	const backend = new JournalTestBackend();
	const returned: WorkflowTaskResult[] = [];
	let creates = 0;
	let prompts = 0;
	const adapters = {
		agentSession: {
			async create() {
				creates++;
				return {
					...mockSession(),
					sessionFile: undefined,
					thinkingLevel: "high" as const,
					async prompt() {
						prompts++;
						return undefined;
					},
				};
			},
		},
	};
	const definition = workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			returned.push(await ctx.task("identity", { prompt: "local fixture" }));
			if (returned.length === 1) throw new Error("pause after completed task");
			return {};
		},
	});
	const liveStore = createStore();
	const live = await run(
		definition,
		{},
		{ runId, cwd: tmpdir(), store: liveStore, durableBackend: backend, adapters },
	);
	assert.equal(live.status, "failed");
	assert.match(live.error ?? "", /pause after completed task/);
	assert.equal(returned[0]?.thinkingLevel, "high");
	assert.equal(liveStore.runs()[0]?.stages[0]?.thinkingLevel, "high");

	const restored = await backend.reopen();
	for (const checkpoint of restored.listCheckpoints(runId)) {
		if (checkpoint.kind === "stage" && checkpoint.output !== undefined)
			assert.equal(checkpoint.thinkingLevel, "high");
	}
	const replayStore = createStore();
	const replay = await run(
		definition,
		{},
		{ runId, cwd: tmpdir(), store: replayStore, durableBackend: restored, adapters },
	);
	assert.equal(replay.status, "completed");
	assert.equal(creates, 1);
	assert.equal(prompts, 1);
	assert.equal(replayStore.runs()[0]?.stages[0]?.thinkingLevel, "high");
	assert.deepEqual(returned[1], returned[0]);
});

// #1859: use the same base-first precedence as model metadata, without truthiness checks.
test.each([
	{ label: "base wins", base: "high", checkpoint: "low", expected: "high" },
	{ label: "explicit off wins", base: "off", checkpoint: "high", expected: "off" },
	{ label: "empty base wins", base: "", checkpoint: "high", expected: "" },
	{ label: "raw base wins", base: " unusual level ", checkpoint: "high", expected: " unusual level " },
	{ label: "checkpoint fallback", checkpoint: "high", expected: "high" },
	{ label: "checkpoint off", checkpoint: "off", expected: "off" },
	{ label: "empty checkpoint", checkpoint: "", expected: "" },
	{ label: "legacy omission" },
	{ label: "terminal checkpoint", checkpoint: "high", expected: "high", terminal: true },
])("public task replay preserves $label", async ({ base, checkpoint, expected, terminal }) => {
	const runId = "task-thinking-precedence";
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "failed" });
	backend.recordCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "recorded-task",
		name: "identity",
		replayKey: "stage:task:identity:1",
		completedAt: 2,
		...(checkpoint !== undefined ? { thinkingLevel: checkpoint } : {}),
		output: terminal
			? "recorded text"
			: {
					name: "identity",
					stageName: "identity",
					text: "recorded text",
					...(base !== undefined ? { thinkingLevel: base } : {}),
				},
	});
	let returned: WorkflowTaskResult | undefined;
	const definition = workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			returned = await ctx.task("identity", { prompt: "must not run" });
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{
			runId,
			cwd: tmpdir(),
			store: createStore(),
			durableBackend: backend,
			adapters: {
				agentSession: {
					async create() {
						throw new Error("replay must not create a session");
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.ok(returned);
	assert.equal(returned.text, "recorded text");
	assert.equal(returned.thinkingLevel, expected);
	assert.equal(Object.hasOwn(returned, "thinkingLevel"), expected !== undefined);
});
