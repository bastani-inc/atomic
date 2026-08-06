import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/inprocess/background-single.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { sleep, spawnSyncCollect } from "../helpers/runtime.js";

type ProcessRow = {
	pid: number;
	command: string;
};

function probeChildren(): Set<string> {
	if (process.platform === "win32") {
		const query = [
			`$parent=${process.pid};`,
			`Get-CimInstance Win32_Process -Filter "ParentProcessId = $parent"`,
			"| Select-Object ProcessId,Name,CommandLine",
			"| ConvertTo-Json -Compress",
		].join(" ");
		const result = spawnSyncCollect(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", query], {
			stdout: "pipe",
			stderr: "pipe",
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const raw = result.stdout.toString("utf8").trim();
		if (!raw) return new Set();
		const parsed = JSON.parse(raw) as
			| { ProcessId?: number; Name?: string; CommandLine?: string }
			| Array<{ ProcessId?: number; Name?: string; CommandLine?: string }>;
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		return new Set(
			rows
				.filter((row) => typeof row.ProcessId === "number")
				.filter((row) => !/^(?:powershell|pwsh)(?:\.exe)?$/iu.test(row.Name ?? ""))
				.map((row) => `${row.ProcessId}:${row.CommandLine ?? row.Name ?? ""}`),
		);
	}

	const result = spawnSyncCollect(["ps", "-axo", "pid=,ppid=,command="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const rows: ProcessRow[] = [];
	for (const line of result.stdout.toString("utf8").split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
		if (!match || Number(match[2]) !== process.pid) continue;
		const command = match[3] ?? "";
		if (/(?:^|\/)ps(?:\s|$)/u.test(command)) continue;
		rows.push({ pid: Number(match[1]), command });
	}
	return new Set(rows.map((row) => `${row.pid}:${row.command}`));
}

function assertNoNewChildren(before: Set<string>, label: string): void {
	const after = probeChildren();
	const newChildren = [...after].filter((child) => !before.has(child));
	assert.deepEqual(newChildren, [], `${label} created OS child processes: ${newChildren.join(", ")}`);
}

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "in-process probe worker",
		systemPrompt: "Return the fixture output.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "/tmp/in-process-probe-worker.md",
	};
}

function state(): ExecutorDeps["state"] {
	return {
		baseCwd: "",
		currentSessionId: "parent",
		asyncJobs: new Map(),
		subagentInProgress: false,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeExecutor(root: string, gate: Promise<void>) {
	const worker = agent();
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "zero-process-parent",
	} as unknown as ExecutorDeps["pi"];
	const runtime: NonNullable<ExecutorDeps["runtime"]> = {
		runSync: async (cwd, agents, agentName, task, options) =>
			runSync(cwd, agents, agentName, task, {
				...options,
				testSession: { output: task, promptGate: gate },
			}),
		executeAsyncSingle: (id, params) =>
			executeAsyncSingle(id, {
				...params,
				testSession: { output: params.task ?? "async", promptGate: gate },
			}),
		isAsyncAvailable: () => true,
		formatAsyncStartedMessage: (headline) => `Launched: ${headline}`,
	};
	const executor = createSubagentExecutor({
		pi,
		state: state(),
		config: { maxSubagentDepth: 5, parallel: { concurrency: 4, maxTasks: 50 } },
		asyncByDefault: false,
		tempArtifactsDir: join(root, "temp-artifacts"),
		getSubagentSessionRoot: () => join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker] }),
		runtime,
	});
	const context = {
		cwd: root,
		mode: "tui",
		hasUI: false,
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(root, "parent.jsonl"),
			getSessionId: () => "parent",
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
	} as never as ExtensionContext;
	return { executor, context };
}

/**
 * The process snapshot is taken while fixture turns are held open. It proves
 * that the real single, parallel, sequential-chain, and async executor paths
 * do not add descendants to the Vitest worker. It does not assert the
 * interactive host's own engine topology or provider subprocesses outside this
 * runner boundary; those are covered by the coding-agent integration suites.
 */
test("single, parallel, chain, and async subagent modes create no OS child processes", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagents-zero-process-"));
	clearSubagentControls();
	try {
		const singleGate = Promise.withResolvers<void>();
		const singleExecutor = makeExecutor(root, singleGate.promise);
		const singleBefore = probeChildren();
		const single = singleExecutor.executor.execute(
			"single",
			{ agent: "worker", task: "single" },
			new AbortController().signal,
			undefined,
			singleExecutor.context,
		);
		await sleep(50);
		assertNoNewChildren(singleBefore, "single");
		singleGate.resolve();
		assert.equal((await single).details.results[0]?.status, "ok");

		const parallelGate = Promise.withResolvers<void>();
		const parallelExecutor = makeExecutor(root, parallelGate.promise);
		const parallelBefore = probeChildren();
		const parallel = parallelExecutor.executor.execute(
			"parallel",
			{
				tasks: [
					{ agent: "worker", task: "parallel one" },
					{ agent: "worker", task: "parallel two" },
					{ agent: "worker", task: "parallel three" },
				],
			},
			new AbortController().signal,
			undefined,
			parallelExecutor.context,
		);
		await sleep(50);
		assertNoNewChildren(parallelBefore, "parallel");
		parallelGate.resolve();
		assert.deepEqual(
			(await parallel).details.results.map((result) => result.status),
			["ok", "ok", "ok"],
		);

		const chainGate = Promise.withResolvers<void>();
		const chainExecutor = makeExecutor(root, chainGate.promise);
		const chainBefore = probeChildren();
		const chain = chainExecutor.executor.execute(
			"chain",
			{
				chain: [
					{ agent: "worker", task: "chain one" },
					{ agent: "worker", task: "chain two" },
				],
			},
			new AbortController().signal,
			undefined,
			chainExecutor.context,
		);
		await sleep(50);
		assertNoNewChildren(chainBefore, "chain");
		chainGate.resolve();
		assert.deepEqual(
			(await chain).details.results.map((result) => result.status),
			["ok", "ok"],
		);

		const asyncGate = Promise.withResolvers<void>();
		const asyncExecutor = makeExecutor(root, asyncGate.promise);
		const asyncBefore = probeChildren();
		const launched = await asyncExecutor.executor.execute(
			"async",
			{ agent: "worker", task: "async", async: true },
			new AbortController().signal,
			undefined,
			asyncExecutor.context,
		);
		assert.equal(launched.details.results[0]?.status, "continued");
		await sleep(50);
		assertNoNewChildren(asyncBefore, "async");
		asyncGate.resolve();
		await sleep(100);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});
