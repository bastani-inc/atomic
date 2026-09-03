import { describe } from "vitest";
import {
	type AgentSession,
	assert,
	type CreateAgentSessionOptions,
	createStore,
	deferred,
	mockSession,
	run,
	type StageSnapshot,
	sleep,
	type ToolDefinition,
	Type,
	test,
	workflow,
} from "./executor-shared.js";

describe("executor.run", () => {
	test("continuation replays multiple completed parallel siblings without topology drift", async () => {
		const st = createStore();
		const def = workflow({
			name: "resume-parallel-roots-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const results = await ctx.parallel(
					[
						{ name: "alpha", prompt: "alpha" },
						{ name: "beta", prompt: "beta" },
					],
					{ concurrency: 2, failFast: false },
				);
				await ctx.stage("fail-after-parallel").prompt(results.map((result) => result.text).join(","));
				return {};
			},
		});

		const firstRun = await run(
			def,
			{},
			{
				store: st,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "alpha" || text === "beta") return `${text}:done`;
							throw new Error("continuation test failure");
						},
					},
				},
			},
		);
		assert.equal(firstRun.status, "failed");
		const source = st.runs().find((candidate) => candidate.id === firstRun.runId)!;
		const failedStageId = source.failedStageId!;

		const continuationCalls: string[] = [];
		const continued = await run(
			def,
			{},
			{
				store: st,
				continuation: { source, resumeFromStageId: failedStageId },
				adapters: {
					prompt: {
						prompt: async (text) => {
							continuationCalls.push(text);
							return "resumed";
						},
					},
				},
			},
		);

		assert.equal(continued.status, "completed");
		assert.deepEqual(continuationCalls, ["alpha:done,beta:done"]);
		assert.equal(continued.stages.find((stage) => stage.name === "alpha")?.replayed, true);
		assert.equal(continued.stages.find((stage) => stage.name === "beta")?.replayed, true);
	});

	test("continuation rejects ambiguous duplicate-name replay topology", async () => {
		const st = createStore();
		const def = workflow({
			name: "resume-ambiguous-duplicate-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.parallel(
					[
						{ name: "duplicate", prompt: "one" },
						{ name: "duplicate", prompt: "two" },
					],
					{ concurrency: 2, failFast: false },
				);
				await ctx.stage("fail-after-duplicates").prompt("fail");
				return {};
			},
		});

		const firstRun = await run(
			def,
			{},
			{
				store: st,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text === "fail") throw new Error("continuation test failure");
							return `${text}:done`;
						},
					},
				},
			},
		);
		assert.equal(firstRun.status, "failed");
		const source = st.runs().find((candidate) => candidate.id === firstRun.runId)!;
		const failedStageId = source.failedStageId!;

		const ambiguousReplayDef = workflow({
			name: "resume-ambiguous-duplicate-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("duplicate").prompt("one-of-two-roots");
				return {};
			},
		});

		const continued = await run(
			ambiguousReplayDef,
			{},
			{
				store: st,
				continuation: { source, resumeFromStageId: failedStageId },
				adapters: {
					prompt: {
						prompt: async () => "unexpected",
					},
				},
			},
		);

		assert.equal(continued.status, "failed");
		assert.match(continued.error ?? "", /insufficient_state: replay topology ambiguous/);
	});

	test("replayed stage contexts reject mutation methods", async () => {
		const st = createStore();
		const sourceDef = workflow({
			name: "resume-replay-mutation-source-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const first = await ctx.stage("first").prompt("first");
				await ctx.stage("second").prompt(`second:${first}`);
				return {};
			},
		});

		const firstRun = await run(
			sourceDef,
			{},
			{
				store: st,
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text.startsWith("second:")) throw new Error("continuation test failure");
							return "first-result";
						},
					},
				},
			},
		);
		assert.equal(firstRun.status, "failed");
		const source = st.runs().find((candidate) => candidate.id === firstRun.runId)!;
		const failedStageId = source.failedStageId!;

		const mutationDef = workflow({
			name: "resume-replay-mutation-source-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("first").setModel("openai/example" as never);
				return {};
			},
		});

		const continued = await run(
			mutationDef,
			{},
			{
				store: st,
				continuation: { source, resumeFromStageId: failedStageId },
				adapters: {
					prompt: {
						prompt: async () => "unexpected",
					},
				},
			},
		);

		assert.equal(continued.status, "failed");
		assert.match(continued.error ?? "", /replayed stage "first" cannot set model/);
		const replayed = continued.stages.find((stage) => stage.name === "first")!;
		assert.equal(replayed.replayed, true);
	});

	test("continuation replays completed parallel sibling after failed source stage", async () => {
		const st = createStore();
		let failOnce = true;
		const def = workflow({
			name: "resume-parallel-sibling-wf",
			description: "",
			inputs: {},
			outputs: {
				results: Type.Optional(Type.Any()),
			},
			run: async (ctx) => {
				const results = await ctx.parallel(
					[
						{ name: "failed-first", prompt: "fail-once" },
						{ name: "completed-second", prompt: "already-done" },
					],
					{ concurrency: 2, failFast: false },
				);
				return {
					results: results.map((result) => result.text).join(","),
				};
			},
		});

		const firstRunCalls: string[] = [];
		const firstRun = await run(
			def,
			{},
			{
				store: st,
				adapters: {
					prompt: {
						prompt: async (text) => {
							firstRunCalls.push(text);
							if (text === "fail-once" && failOnce) {
								failOnce = false;
								throw new Error("continuation test failure");
							}
							return `${text}:ok`;
						},
					},
				},
			},
		);

		assert.equal(firstRun.status, "failed");
		assert.deepEqual(firstRunCalls.sort(), ["already-done", "fail-once"]);
		const source = st.runs().find((candidate) => candidate.id === firstRun.runId)!;
		const failed = source.stages.find((stage) => stage.name === "failed-first")!;
		const completed = source.stages.find((stage) => stage.name === "completed-second")!;
		assert.equal(failed.status, "failed");
		assert.equal(completed.status, "completed");
		assert.ok(source.stages.indexOf(completed) > source.stages.indexOf(failed));

		const continuationCalls: string[] = [];
		const continued = await run(
			def,
			{},
			{
				store: st,
				continuation: { source, resumeFromStageId: failed.id },
				adapters: {
					prompt: {
						prompt: async (text) => {
							continuationCalls.push(text);
							return `${text}:resumed`;
						},
					},
				},
			},
		);

		assert.equal(continued.status, "completed");
		assert.deepEqual(continuationCalls, ["fail-once"]);
		const replayed = continued.stages.find((stage) => stage.name === "completed-second")!;
		assert.equal(replayed.status, "completed");
		assert.equal(replayed.replayed, true);
		assert.equal(replayed.replayedFromStageId, completed.id);
	});

	test("rate-limited fallback attempts are recorded on the active-blocked stage snapshot", async () => {
		const def = workflow({
			name: "failed-fallback-metadata",
			description: "",
			inputs: {},
			outputs: {
				ok: Type.Boolean(),
			},
			run: async (ctx) => {
				await ctx.task("scout", {
					prompt: "inspect",
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
				});
				return { ok: true };
			},
		});

		const result = await run(
			def,
			{},
			{
				adapters: {
					agentSession: {
						async create(options) {
							const modelValue = (options as { readonly model?: string }).model;
							const model = typeof modelValue === "string" ? modelValue : "object-model";
							return {
								...mockSession(),
								async prompt() {
									throw new Error(`${model} rate limit exceeded`);
								},
							};
						},
					},
				},
				store: createStore(),
			},
		);

		assert.equal(result.status, "running");
		assert.equal(result.stages[0]?.status, "failed");
		assert.equal(result.stages[0]?.failureDisposition, "active_blocked");
		assert.equal(result.stages[0]?.failureRecoverability, "recoverable");
		assert.deepEqual(result.stages[0]?.attemptedModels, ["anthropic/primary", "openai/fallback"]);
		assert.deepEqual(
			result.stages[0]?.modelAttempts?.map((attempt) => attempt.success),
			[false, false],
		);
	});

	test("explicit model stage publishes running fast-mode metadata before prompt resolves", async () => {
		const promptGate = deferred<string | undefined>();
		const st = createStore();
		const def = workflow({
			name: "explicit-model-running-fast-metadata",
			description: "",
			inputs: {},
			outputs: {
				ok: Type.Boolean(),
			},
			run: async (ctx) => {
				await ctx.stage("scout", { model: "openai/gpt-5.1-codex" }).prompt("inspect");
				return { ok: true };
			},
		});

		const runPromise = run(
			def,
			{},
			{
				adapters: {
					agentSession: {
						async create() {
							return {
								session: {
									...mockSession(),
									model: {
										provider: "openai",
										id: "gpt-5.1-codex",
									} as AgentSession["model"],
									async prompt() {
										await promptGate.promise;
									},
								},
								settingsManager: {
									getCodexFastModeSettings: () => ({
										chat: false,
										workflow: true,
									}),
								},
							};
						},
					},
				},
				store: st,
			},
		);

		try {
			const deadline = Date.now() + 1000;
			let runningStage: StageSnapshot | undefined;
			while (Date.now() < deadline) {
				runningStage = st
					.runs()
					.flatMap((runSnapshot) => runSnapshot.stages)
					.find((stage) => stage.name === "scout" && stage.status === "running");
				if (runningStage !== undefined) break;
				await sleep(5);
			}

			assert.equal(runningStage?.model, "openai/gpt-5.1-codex");
			assert.equal(runningStage?.fastMode, true);
		} finally {
			promptGate.resolve(undefined);
			await runPromise;
		}
	});

	// Issue #2812: the successful attempt has to be on the *running* stage
	// snapshot that the durable checkpoint, the status writer, and every other
	// store subscriber read — not only on the terminal completion record. Store
	// notifications are synchronous, so subscribing captures the exact ordering:
	// the last running snapshot must already carry the fallback success.
	test("a fallback success reaches the running stage snapshot before the completed one", async () => {
		const st = createStore();
		const schema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
		const observed: Array<{ status: string; attempts: Array<{ model: string; success: boolean }> }> = [];
		const unsubscribe = st.subscribe((snapshot) => {
			for (const runSnapshot of snapshot.runs) {
				for (const stage of runSnapshot.stages) {
					if (stage.name !== "scout") continue;
					observed.push({
						status: stage.status,
						attempts: (stage.modelAttempts ?? []).map((attempt) => ({
							model: attempt.model,
							success: attempt.success,
						})),
					});
				}
			}
		});
		const def = workflow({
			name: "running-fallback-attempt-metadata",
			description: "",
			inputs: {},
			outputs: { ok: Type.Boolean() },
			run: async (ctx) => {
				await ctx
					.stage("scout", {
						model: "anthropic/primary",
						fallbackModels: ["openai/fallback"],
						schema,
					})
					.prompt("partition the work");
				return { ok: true };
			},
		});

		const result = await run(
			def,
			{},
			{
				adapters: {
					agentSession: {
						async create(options: CreateAgentSessionOptions) {
							const modelValue = (options as { readonly model?: string }).model;
							const model = typeof modelValue === "string" ? modelValue : "object-model";
							const structuredTool = options.customTools?.find(
								(tool): tool is ToolDefinition => tool.name === "structured_output",
							);
							return {
								...mockSession(),
								async prompt() {
									// The primary burns its whole correction budget on clean
									// turns that never call the tool; the fallback answers.
									if (model === "anthropic/primary" || structuredTool === undefined) return;
									await structuredTool.execute(
										"structured-call-fallback",
										{ ok: true } as Parameters<ToolDefinition["execute"]>[1],
										undefined,
										undefined,
										{} as Parameters<ToolDefinition["execute"]>[4],
									);
								},
							};
						},
					},
				},
				store: st,
			},
		);
		unsubscribe();

		assert.equal(result.status, "completed");
		const expected = [
			{ model: "anthropic/primary", success: false },
			{ model: "anthropic/primary", success: false },
			{ model: "anthropic/primary", success: false },
			{ model: "anthropic/primary", success: false },
			{ model: "openai/fallback", success: true },
		];
		const firstTerminalIndex = observed.findIndex((entry) => entry.status === "completed");
		assert.notEqual(firstTerminalIndex, -1);
		const lastRunning = observed
			.slice(0, firstTerminalIndex)
			.filter((entry) => entry.status === "running")
			.at(-1);
		// Before the fix this snapshot held only the four failed primary attempts.
		assert.deepEqual(lastRunning?.attempts, expected);
		assert.deepEqual(observed[firstTerminalIndex]?.attempts, expected);
	});
});
