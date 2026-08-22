import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "vitest";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type {
	SingleResult,
	SubagentAttemptStatus,
	SubagentToolResult,
	Usage,
} from "../../packages/subagents/src/shared/types.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
};

function makeAgent(name: string): AgentConfig {
	return {
		name,
		description: `${name} test agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "You are a test agent.",
		source: "project",
		filePath: `/tmp/${name}.md`,
	};
}

function makeState(): ExecutorDeps["state"] {
	return {
		baseCwd: "",
		currentSessionId: null,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function makeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: { custom: async <T>() => undefined as T },
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "parent-session",
			getLeafId: () => null,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function result(
	agent: string,
	task: string,
	status: SubagentAttemptStatus = "ok",
	finalOutput = `output:${task}`,
): SingleResult {
	return {
		agent,
		task,
		status,
		messages: [],
		usage,
		finalOutput,
		artifactPaths: {
			inputPath: `/tmp/${task}-in.md`,
			outputPath: `/tmp/${task}-out.md`,
			jsonlPath: `/tmp/${task}.jsonl`,
			metadataPath: `/tmp/${task}-meta.json`,
		},
	};
}

function makeHarness(input?: {
	agents?: AgentConfig[];
	discoverAgents?: ExecutorDeps["discoverAgents"];
	runSync?: SubagentExecutorRuntimeDeps["runSync"];
}): {
	cwd: string;
	ctx: ExtensionContext;
	executor: ReturnType<typeof createSubagentExecutor>;
	cleanup: () => void;
} {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-burst-"));
	const agents = input?.agents ?? [makeAgent("echo")];
	const runSync =
		input?.runSync ??
		(async (_parentCwd, _agents, agentName, task) => {
			return result(agentName, task);
		});
	const deps: ExecutorDeps = {
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent-session-name",
		} as unknown as ExecutorDeps["pi"],
		state: makeState(),
		config: { parallel: { concurrency: 4, maxTasks: 50 } } as ExecutorDeps["config"],
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: input?.discoverAgents ?? (() => ({ agents })),
		runtime: { runSync },
	};
	return {
		cwd,
		ctx: makeContext(cwd),
		executor: createSubagentExecutor(deps),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function execute(
	harness: ReturnType<typeof makeHarness>,
	id: string,
	params: SubagentParamsLike,
	onUpdate?: (result: SubagentToolResult) => void,
): Promise<SubagentToolResult> {
	return harness.executor.execute(id, params, new AbortController().signal, onUpdate, harness.ctx);
}

test("coalesces concurrent sibling SINGLE calls and routes one child result to each caller", async () => {
	const launches: string[] = [];
	let launchObservedCallCount = 0;
	let issuedCallCount = 0;
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			launchObservedCallCount = issuedCallCount;
			launches.push(task);
			return result(agentName, task);
		},
	});
	try {
		const calls = ["A", "B", "C"].map((task, index) => {
			const promise = execute(harness, `call-${index}`, { agent: "echo", task });
			issuedCallCount += 1;
			return promise;
		});
		const outputs = await Promise.all(calls);

		assert.equal(launchObservedCallCount, 3, "the synchronous burst must collect before any child starts");
		assert.deepEqual(launches, ["A", "B", "C"]);
		assert.equal(new Set(outputs.map((output) => output.details?.runId)).size, 1);
		assert.deepEqual(
			outputs.map((output) => output.details?.mode),
			["parallel", "parallel", "parallel"],
		);
		assert.deepEqual(
			outputs.map((output) => output.details?.results.map((child) => child.task)),
			[["A"], ["B"], ["C"]],
		);
		for (let index = 0; index < outputs.length; index++) {
			const content = outputs[index]?.content[0];
			const text = content?.type === "text" ? content.text : "";
			assert.match(text, new RegExp(`output:${["A", "B", "C"][index]}`));
			for (const sibling of ["A", "B", "C"].filter((task) => task !== ["A", "B", "C"][index])) {
				assert.doesNotMatch(text, new RegExp(`output:${sibling}`));
			}
			assert.doesNotMatch(text, /Rejected: a subagent call is already in progress/);
		}
	} finally {
		harness.cleanup();
	}
});

test("preserves each sibling call's cwd-scoped agent discovery", async () => {
	const discoveries: string[] = [];
	const launches: string[] = [];
	const harness = makeHarness({
		discoverAgents: (cwd) => {
			discoveries.push(cwd);
			return { agents: [makeAgent(cwd.endsWith("nested") ? "nested-agent" : "root-agent")] };
		},
		runSync: async (_parentCwd, _agents, agentName, task) => {
			launches.push(agentName);
			return result(agentName, task);
		},
	});
	const nestedCwd = join(harness.cwd, "nested");
	mkdirSync(nestedCwd, { recursive: true });
	try {
		const outputs = await Promise.all([
			execute(harness, "root", { agent: "root-agent", task: "root task", cwd: "." }),
			execute(harness, "nested", { agent: "nested-agent", task: "nested task", cwd: "nested" }),
		]);

		assert.deepEqual(discoveries, [harness.cwd, nestedCwd]);
		assert.deepEqual(launches, ["root-agent", "nested-agent"]);
		assert.equal(new Set(outputs.map((output) => output.details?.runId)).size, 1);
		assert.deepEqual(
			outputs.map((output) => output.details?.results.map((child) => child.task)),
			[["root task"], ["nested task"]],
		);
		for (const output of outputs) {
			assert.doesNotMatch(
				output.content[0]?.type === "text" ? output.content[0].text : "",
				/Rejected: a subagent call is already in progress/,
			);
		}
	} finally {
		harness.cleanup();
	}
});

test("keeps same-name agent configs aligned to each originating discovery cwd", async () => {
	const discoveryCalls: Array<{ cwd: string; scope: string }> = [];
	const launches: Array<{ task: string; filePath: string | undefined }> = [];
	const harness = makeHarness({
		discoverAgents: (cwd, scope) => {
			discoveryCalls.push({ cwd, scope });
			return {
				agents: [
					{
						...makeAgent("worker"),
						filePath: join(cwd, "worker.md"),
						systemPrompt: `worker from ${cwd}`,
					},
				],
			};
		},
		runSync: async (_parentCwd, agents, agentName, task) => {
			launches.push({ task, filePath: agents[0]?.filePath });
			return result(agentName, task);
		},
	});
	const projectA = join(harness.cwd, "project-a");
	const projectB = join(harness.cwd, "project-b");
	mkdirSync(projectA, { recursive: true });
	mkdirSync(projectB, { recursive: true });
	try {
		const outputs = await Promise.all([
			execute(harness, "a", {
				agent: "worker",
				task: "A",
				cwd: "project-a",
				agentScope: "project",
			}),
			execute(harness, "b", {
				tasks: [{ agent: "worker", task: "B", count: 2 }],
				cwd: "project-b",
				agentScope: "project",
			}),
		]);

		assert.deepEqual(discoveryCalls, [
			{ cwd: projectA, scope: "project" },
			{ cwd: projectB, scope: "project" },
		]);
		assert.deepEqual(launches, [
			{ task: "A", filePath: join(projectA, "worker.md") },
			{ task: "B", filePath: join(projectB, "worker.md") },
			{ task: "B", filePath: join(projectB, "worker.md") },
		]);
		assert.deepEqual(
			outputs.map((output) => output.details?.results.map((child) => child.task)),
			[["A"], ["B", "B"]],
		);
	} finally {
		harness.cleanup();
	}
});

test("keeps solitary explicit PARALLEL discovery at its top-level cwd", async () => {
	const discoveryCalls: string[] = [];
	const launches: Array<{ cwd: string | undefined; agentPaths: string[] }> = [];
	const harness = makeHarness({
		discoverAgents: (cwd) => {
			discoveryCalls.push(cwd);
			return {
				agents: [
					{ ...makeAgent("worker"), filePath: join(cwd, "worker.md") },
					{ ...makeAgent("helper"), filePath: join(cwd, "helper.md") },
				],
			};
		},
		runSync: async (_parentCwd, agents, agentName, task, options) => {
			launches.push({ cwd: options.cwd, agentPaths: agents.map((agent) => agent.filePath) });
			return result(agentName, task);
		},
	});
	const projectA = join(harness.cwd, "project-a");
	const projectB = join(harness.cwd, "project-b");
	mkdirSync(projectA, { recursive: true });
	mkdirSync(projectB, { recursive: true });
	try {
		const output = await execute(harness, "parallel", {
			tasks: [{ agent: "worker", task: "from A", cwd: "../project-b" }],
			cwd: "project-a",
		});

		assert.equal(output.isError, undefined);
		assert.deepEqual(discoveryCalls, [projectA]);
		assert.deepEqual(launches, [
			{
				cwd: projectB,
				agentPaths: [join(projectA, "worker.md"), join(projectA, "helper.md")],
			},
		]);
	} finally {
		harness.cleanup();
	}
});

test("coalesces sibling SINGLE calls across the host tool-callback event-loop boundary", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const launches: string[] = [];
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			launches.push(task);
			started.resolve();
			await release.promise;
			return result(agentName, task);
		},
	});
	try {
		const calls = ["A", "B"].map(async (task, index) => {
			// Interactive callback activity yields every sibling tool invocation
			// through setImmediate before it reaches the registered extension.
			await waitForImmediate();
			return execute(harness, `call-${index}`, { agent: "echo", task });
		});

		await started.promise;
		await waitForImmediate();
		release.resolve();
		const outputs = await Promise.all(calls);

		assert.deepEqual(launches, ["A", "B"]);
		assert.deepEqual(
			outputs.map((output) => output.details?.mode),
			["parallel", "parallel"],
		);
		assert.equal(new Set(outputs.map((output) => output.details?.runId)).size, 1);
		for (const output of outputs) {
			assert.doesNotMatch(
				output.content[0]?.type === "text" ? output.content[0].text : "",
				/Rejected: a subagent call is already in progress/,
			);
		}
	} finally {
		release.resolve();
		harness.cleanup();
	}
});

test("keeps a solitary SINGLE call single and a solitary tasks call parallel", async () => {
	const harness = makeHarness();
	try {
		const single = await execute(harness, "single", { agent: "echo", task: "single task" });
		const parallel = await execute(harness, "parallel", {
			tasks: [
				{ agent: "echo", task: "parallel A" },
				{ agent: "echo", task: "parallel B" },
			],
		});

		assert.equal(single.details?.mode, "single");
		assert.deepEqual(
			single.details?.results.map((child) => child.task),
			["single task"],
		);
		assert.equal(parallel.details?.mode, "parallel");
		assert.deepEqual(
			parallel.details?.results.map((child) => child.task),
			["parallel A", "parallel B"],
		);
		assert.notEqual(single.details?.runId, parallel.details?.runId);
	} finally {
		harness.cleanup();
	}
});

test("management bypasses burst collection before and during child execution", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			started.resolve();
			await release.promise;
			return result(agentName, task);
		},
	});
	try {
		const first = execute(harness, "first", { agent: "echo", task: "A" });
		const interleavedManagement = execute(harness, "list", { action: "list" });
		const second = execute(harness, "second", { agent: "echo", task: "B" });

		await started.promise;
		const activeManagement = await execute(harness, "status", { action: "status" });
		release.resolve();
		const [firstResult, listResult, secondResult] = await Promise.all([first, interleavedManagement, second]);

		assert.equal(listResult.details?.mode, "management");
		assert.equal(activeManagement.details?.mode, "management");
		assert.equal(activeManagement.isError, undefined);
		assert.deepEqual(
			firstResult.details?.results.map((child) => child.task),
			["A"],
		);
		assert.deepEqual(
			secondResult.details?.results.map((child) => child.task),
			["B"],
		);
	} finally {
		release.resolve();
		harness.cleanup();
	}
});

test("rejects execution overlap that arrives after a child starts", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let launches = 0;
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			launches += 1;
			started.resolve();
			await release.promise;
			return result(agentName, task);
		},
	});
	try {
		const first = execute(harness, "first", { agent: "echo", task: "A" });
		await started.promise;
		const late = await execute(harness, "late", { agent: "echo", task: "B" });
		release.resolve();
		await first;

		assert.equal(late.isError, true);
		assert.equal(
			late.content[0]?.type === "text" ? late.content[0].text : "",
			"Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
		);
		assert.equal(launches, 1);
	} finally {
		release.resolve();
		harness.cleanup();
	}
});

test("keeps sequential awaited execution calls as independent SINGLE runs", async () => {
	const launches: string[] = [];
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			launches.push(task);
			return result(agentName, task);
		},
	});
	try {
		const first = await execute(harness, "first", { agent: "echo", task: "A" });
		const second = await execute(harness, "second", { agent: "echo", task: "B" });

		assert.deepEqual(launches, ["A", "B"]);
		assert.equal(first.details?.mode, "single");
		assert.equal(second.details?.mode, "single");
		assert.notEqual(first.details?.runId, second.details?.runId);
	} finally {
		harness.cleanup();
	}
});

test("rejects a coalesced burst above the expanded 50-task cap before launch", async () => {
	let launches = 0;
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			launches += 1;
			return result(agentName, task);
		},
	});
	try {
		const outputs = await Promise.all([
			execute(harness, "first", { tasks: [{ agent: "echo", task: "A", count: 25 }] }),
			execute(harness, "second", { tasks: [{ agent: "echo", task: "B", count: 26 }] }),
		]);

		assert.equal(launches, 0);
		for (const output of outputs) {
			assert.equal(output.isError, true);
			assert.equal(output.content[0]?.type === "text" ? output.content[0].text : "", "Max 50 tasks");
			assert.deepEqual(output.details, { mode: "parallel", results: [] });
		}
	} finally {
		harness.cleanup();
	}
});

test("flattens mixed SINGLE and tasks input in source order without deduplicating count expansion", async () => {
	const launches: string[] = [];
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			launches.push(task);
			return result(agentName, task);
		},
	});
	try {
		const [mixed, sibling] = await Promise.all([
			execute(harness, "mixed", {
				agent: "echo",
				task: "SINGLE-first",
				tasks: [{ agent: "echo", task: "duplicate", count: 2 }],
			}),
			execute(harness, "sibling", { agent: "echo", task: "last" }),
		]);

		assert.deepEqual(launches, ["SINGLE-first", "duplicate", "duplicate", "last"]);
		assert.deepEqual(
			mixed.details?.results.map((child) => child.task),
			["SINGLE-first", "duplicate", "duplicate"],
		);
		assert.deepEqual(
			sibling.details?.results.map((child) => child.task),
			["last"],
		);
	} finally {
		harness.cleanup();
	}
});

test("keeps result routing index-aligned after out-of-order completion and emits one aggregate live stream", async () => {
	const releaseFirst = Promise.withResolvers<void>();
	const firstUpdates: SubagentToolResult[] = [];
	const secondUpdates: SubagentToolResult[] = [];
	const completionOrder: string[] = [];
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task, options) => {
			const child = result(agentName, task);
			child.progress = {
				index: options.index ?? 0,
				agent: agentName,
				status: "completed",
				task,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 1,
			};
			options.onUpdate?.({
				content: [{ type: "text", text: `live:${task}` }],
				details: { mode: "single", results: [child] },
			});
			if (task === "slow-first") await releaseFirst.promise;
			else releaseFirst.resolve();
			completionOrder.push(task);
			return child;
		},
	});
	try {
		const outputs = await Promise.all([
			execute(harness, "first", { agent: "echo", task: "slow-first", includeProgress: true }, (update) =>
				firstUpdates.push(update),
			),
			execute(harness, "second", { agent: "echo", task: "fast-second", includeProgress: true }, (update) =>
				secondUpdates.push(update),
			),
		]);

		assert.deepEqual(completionOrder, ["fast-second", "slow-first"]);
		assert.deepEqual(
			outputs[0]?.details?.results.map((child) => child.task),
			["slow-first"],
		);
		assert.deepEqual(
			outputs[1]?.details?.results.map((child) => child.task),
			["fast-second"],
		);
		assert.deepEqual(
			outputs.map((output) => output.details?.progress?.map((item) => [item.index, item.task])),
			[[[0, "slow-first"]], [[0, "fast-second"]]],
		);
		assert.deepEqual(
			outputs.map((output) => output.details?.artifacts?.files.map((file) => file.outputPath)),
			[["/tmp/slow-first-out.md"], ["/tmp/fast-second-out.md"]],
		);
		assert.equal(firstUpdates.length > 0, true);
		assert.equal(secondUpdates.length, 0);
		for (const update of firstUpdates) {
			assert.equal(update.details?.mode, "parallel");
			assert.equal(update.details?.totalSteps, 2);
		}
	} finally {
		releaseFirst.resolve();
		harness.cleanup();
	}
});

test("uses a matching call-level cwd as the shared worktree root", async () => {
	const launches: Array<{ task: string; cwd: string; repoPrefix: string }> = [];
	let harness: ReturnType<typeof makeHarness>;
	const runGit = (cwd: string, args: string[]): string => {
		const git = spawnSyncCollect(["git", ...args], { cwd, env: createGitEnvironment() });
		assert.equal(git.exitCode, 0, git.stderr.toString());
		return git.stdout.toString("utf8");
	};
	harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task, options) => {
			const cwd = options.cwd ?? "";
			launches.push({ task, cwd, repoPrefix: runGit(cwd, ["rev-parse", "--show-prefix"]).trim() });
			writeFileSync(join(cwd, "tracked.txt"), `${task}\n`, "utf8");
			return result(agentName, task);
		},
	});
	const nestedCwd = join(harness.cwd, "nested");
	try {
		runGit(harness.cwd, ["init", "--quiet"]);
		runGit(harness.cwd, ["config", "user.name", "Atomic Fixture"]);
		runGit(harness.cwd, ["config", "user.email", "fixture@example.invalid"]);
		runGit(harness.cwd, ["config", "commit.gpgSign", "false"]);
		mkdirSync(nestedCwd, { recursive: true });
		writeFileSync(join(nestedCwd, "tracked.txt"), "seed\n", "utf8");
		runGit(harness.cwd, ["add", "nested/tracked.txt"]);
		runGit(harness.cwd, ["commit", "--quiet", "-m", "initial"]);

		const outputs = await Promise.all([
			execute(harness, "first", { agent: "echo", task: "A", cwd: "nested", worktree: true }),
			execute(harness, "second", { agent: "echo", task: "B", cwd: "nested", worktree: true }),
		]);

		assert.deepEqual(
			launches.map((launch) => [launch.task, launch.repoPrefix]),
			[
				["A", "nested/"],
				["B", "nested/"],
			],
		);
		assert.equal(new Set(launches.map((launch) => launch.cwd)).size, 2);
		for (let index = 0; index < outputs.length; index++) {
			const own = ["A", "B"][index]!;
			const sibling = ["B", "A"][index]!;
			const content = outputs[index]?.content[0];
			const text = content?.type === "text" ? content.text : "";
			assert.match(text, new RegExp(`output:${own}`));
			assert.doesNotMatch(text, new RegExp(`output:${sibling}`));
			assert.doesNotMatch(text, /worktree isolation uses the shared cwd/);
			assert.match(text, /=== Worktree Changes ===/);
			assert.match(text, /Full patches:/);
			assert.deepEqual(
				outputs[index]?.details?.results.map((child) => child.task),
				[own],
			);
		}
		const worktreeSuffixes = outputs.map((output) => {
			const text = output.content[0]?.type === "text" ? output.content[0].text : "";
			return text.slice(text.indexOf("=== Worktree Changes ==="));
		});
		assert.equal(worktreeSuffixes[0], worktreeSuffixes[1]);
		for (const suffix of worktreeSuffixes) {
			assert.match(suffix, /--- Task 1 \(echo\):/);
			assert.match(suffix, /--- Task 2 \(echo\):/);
		}
	} finally {
		harness.cleanup();
	}
});

test("preserves shared interrupt guidance while projecting each caller's child results", async () => {
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			const child = result(agentName, task);
			if (task === "A") child.interrupted = true;
			return child;
		},
	});
	try {
		const outputs = await Promise.all([
			execute(harness, "first", { agent: "echo", task: "A" }),
			execute(harness, "second", { agent: "echo", task: "B" }),
		]);
		const expected = "Parallel run paused after interrupt (echo). Waiting for explicit next action.";

		assert.deepEqual(
			outputs.map((output) => output.content),
			[[{ type: "text", text: expected }], [{ type: "text", text: expected }]],
		);
		assert.deepEqual(
			outputs.map((output) => output.details?.results.map((child) => child.task)),
			[["A"], ["B"]],
		);
	} finally {
		harness.cleanup();
	}
});
test("rejects differing call-level cwd values for one coalesced worktree before launch", async () => {
	let launches = 0;
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task) => {
			launches += 1;
			return result(agentName, task);
		},
	});
	try {
		mkdirSync(join(harness.cwd, "one"), { recursive: true });
		mkdirSync(join(harness.cwd, "two"), { recursive: true });
		const outputs = await Promise.all([
			execute(harness, "first", { agent: "echo", task: "A", cwd: "one", worktree: true }),
			execute(harness, "second", { agent: "echo", task: "B", cwd: "two", worktree: true }),
		]);
		const expected = "Cannot coalesce sibling subagent calls: incompatible top-level field 'cwd' for worktree.";

		assert.equal(launches, 0);
		for (const output of outputs) {
			assert.equal(output.isError, true);
			assert.equal(output.content[0]?.type === "text" ? output.content[0].text : "", expected);
			assert.deepEqual(output.details, { mode: "parallel", results: [] });
		}
	} finally {
		harness.cleanup();
	}
});

test("rejects the full burst before launch when run-wide fields conflict", async () => {
	const cases: Array<{
		field: "concurrency" | "worktree" | "context";
		first: SubagentParamsLike;
		second: SubagentParamsLike;
	}> = [
		{ field: "concurrency", first: { concurrency: 1 }, second: { concurrency: 2 } },
		{ field: "worktree", first: { worktree: true }, second: { worktree: false } },
		{ field: "context", first: { context: "fresh" }, second: { context: "fork" } },
	];

	for (const testCase of cases) {
		let launches = 0;
		const harness = makeHarness({
			runSync: async (_parentCwd, _agents, agentName, task) => {
				launches += 1;
				return result(agentName, task);
			},
		});
		try {
			const outputs = await Promise.all([
				execute(harness, "first", { agent: "echo", task: "A", ...testCase.first }),
				execute(harness, "second", { agent: "echo", task: "B", ...testCase.second }),
			]);
			const expected = `Cannot coalesce sibling subagent calls: incompatible top-level field '${testCase.field}'.`;

			assert.equal(launches, 0);
			for (const output of outputs) {
				assert.equal(output.isError, true);
				assert.equal(output.content[0]?.type === "text" ? output.content[0].text : "", expected);
				assert.deepEqual(output.details, { mode: "parallel", results: [] });
			}
		} finally {
			harness.cleanup();
		}
	}
});

test("keeps each contributed task's originating cwd and group", async () => {
	const launches: Array<{ task: string; cwd: string | undefined; group: string | undefined }> = [];
	const harness = makeHarness({
		runSync: async (_parentCwd, _agents, agentName, task, options) => {
			launches.push({ task, cwd: options.cwd, group: options.intercomGroup });
			return result(agentName, task);
		},
	});
	try {
		mkdirSync(join(harness.cwd, "one", "nested"), { recursive: true });
		mkdirSync(join(harness.cwd, "two"), { recursive: true });
		await Promise.all([
			execute(harness, "first", {
				agent: "echo",
				task: "top-one",
				cwd: "one",
				group: "group-one",
				tasks: [{ agent: "echo", task: "nested-one", cwd: "nested", group: "task-group" }],
			}),
			execute(harness, "second", { agent: "echo", task: "top-two", cwd: "two", group: "group-two" }),
		]);

		assert.deepEqual(launches, [
			{ task: "top-one", cwd: join(harness.cwd, "one"), group: "group-one" },
			{ task: "nested-one", cwd: join(harness.cwd, "one", "nested"), group: "task-group" },
			{ task: "top-two", cwd: join(harness.cwd, "two"), group: "group-two" },
		]);
	} finally {
		harness.cleanup();
	}
});
