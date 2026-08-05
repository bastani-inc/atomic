import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import registerSubagentNotify from "../../packages/subagents/src/runs/background/notify.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/inprocess/background-single.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { ASYNC_DIR, SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../packages/subagents/src/shared/types.js";

const artifactConfig = {
	enabled: false,
	includeInput: false,
	includeOutput: false,
	includeJsonl: false,
	includeMetadata: false,
	cleanupDays: 0,
};

function makeAgent(): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Test agent",
		source: "project",
		filePath: "/tmp/worker.md",
	};
}

function testPi(): ExtensionAPI {
	return { events: { emit: () => {} } } as unknown as ExtensionAPI;
}

test("executeAsyncSingle initializes progress in isolated async storage", async () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-async-parent-"));
	const childCwd = join(parentCwd, "child");
	const artifactsDir = join(parentCwd, "disabled-artifacts");
	mkdirSync(childCwd);
	const cwdProgressPath = join(childCwd, "progress.md");
	writeFileSync(cwdProgressPath, "project sentinel");
	const runId = `progress-${crypto.randomUUID()}`;
	try {
		const result = await executeAsyncSingle(runId, {
			agent: "worker",
			task: "implement the fix",
			agentConfig: makeAgent(),
			ctx: {
				pi: testPi(),
				cwd: parentCwd,
				currentSessionId: "parent",
				workflowSessionMetadata: { runId: "run-1", stageId: "stage-1", stageName: "build" },
			},
			cwd: "child",
			artifactsDir,
			artifactConfig,
			shareEnabled: false,
			progress: true,
			maxSubagentDepth: 1,
		});

		const progressPath = join(ASYNC_DIR, runId, "progress", "progress.md");
		assert.equal(result.isError, undefined);
		assert.equal(result.details.results[0]?.status, "continued");
		assert.match(result.details.results[0]?.path ?? "", new RegExp(`^${runId}/`));
		assert.equal(existsSync(join(parentCwd, "progress.md")), false, "parent cwd must not receive progress");
		assert.equal(readFileSync(cwdProgressPath, "utf8"), "project sentinel");
		assert.equal(existsSync(progressPath), true);
		assert.equal(existsSync(join(artifactsDir, "progress", runId, "progress.md")), false);
		assert.match(readFileSync(progressPath, "utf8"), /# Progress/);
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
		rmSync(parentCwd, { recursive: true, force: true });
	}
});

test("executeAsyncSingle prefers run-scoped artifact storage", async () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-async-artifacts-"));
	const artifactsDir = join(parentCwd, "artifacts");
	const runId = `progress-${crypto.randomUUID()}`;
	try {
		const result = await executeAsyncSingle(runId, {
			agent: "worker",
			task: "implement the fix",
			agentConfig: makeAgent(),
			ctx: {
				pi: testPi(),
				cwd: parentCwd,
				currentSessionId: "parent",
			},
			artifactsDir,
			artifactConfig: { ...artifactConfig, enabled: true },
			shareEnabled: false,
			progress: true,
			maxSubagentDepth: 1,
		});

		const progressPath = join(artifactsDir, "progress", runId, "progress.md");
		assert.equal(result.isError, undefined);
		assert.equal(result.details.results[0]?.status, "continued");
		assert.equal(existsSync(progressPath), true);
		assert.equal(existsSync(join(parentCwd, "progress.md")), false);
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
		rmSync(parentCwd, { recursive: true, force: true });
	}
});

test("async completion persists artifacts and delivers one non-empty bounded terminal envelope", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-async-terminal-"));
	const artifactsDir = join(root, "artifacts");
	const sessionRoot = join(root, "sessions");
	const runId = `terminal-${crypto.randomUUID()}`;
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const completions: Array<{ envelope?: string; summary?: string }> = [];
	const messages: Array<{ content?: string }> = [];
	const terminal = Promise.withResolvers<{ envelope?: string; summary?: string }>();
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			const handlers = listeners.get(event) ?? new Set();
			handlers.add(handler);
			listeners.set(event, handlers);
			return () => {
				handlers.delete(handler);
			};
		},
		emit(event: string, data: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(data);
			if (event !== SUBAGENT_ASYNC_COMPLETE_EVENT) return;
			const completion = data as { envelope?: string; summary?: string };
			completions.push(completion);
			terminal.resolve(completion);
		},
	};
	const pi = {
		events,
		sendMessage(message: { content?: string }) {
			messages.push(message);
		},
	} as never as ExtensionAPI;
	const unregister = registerSubagentNotify(pi);
	clearSubagentControls();
	try {
		const output = "first line of terminal output\nsecond line that must be truncated";
		const launched = await executeAsyncSingle(runId, {
			agent: "worker",
			task: "implement the fix",
			agentConfig: makeAgent(),
			ctx: { pi, cwd: root, currentSessionId: "parent" },
			artifactsDir,
			artifactConfig: {
				enabled: true,
				includeInput: true,
				includeOutput: true,
				includeJsonl: true,
				includeMetadata: true,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxOutput: { bytes: 16, lines: 1 },
			maxSubagentDepth: 1,
			testSession: { output },
		});
		assert.equal(launched.details.results[0]?.status, "continued");

		const completion = await terminal.promise;
		assert.equal(completions.length, 1);
		const envelope = completion.envelope;
		assert.ok(envelope);
		assert.ok(envelope.trim());
		assert.match(envelope, /TRUNCATED/);
		assert.equal(envelope.includes(output), false);
		assert.equal(messages.length, 1);
		assert.match(messages[0]?.content ?? "", /TRUNCATED/);
		assert.doesNotMatch(messages[0]?.content ?? "", /unknown completed|\(no output\)/);
		assert.deepEqual(readFileSync(join(artifactsDir, `${runId}_worker_output.md`), "utf8"), output);
		assert.equal(existsSync(join(artifactsDir, `${runId}_worker_meta.json`)), true);
		assert.equal(existsSync(join(artifactsDir, `${runId}_worker.jsonl`)), true);
	} finally {
		unregister();
		clearSubagentControls();
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("async tool dispatch persists terminal artifacts beside the parent session without a duplicate session tree", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-async-dispatch-"));
	const parentSessionFile = join(root, "sessions", "parent.jsonl");
	const parentArtifactsDir = join(dirname(parentSessionFile), "subagent-artifacts");
	const tempArtifactsDir = join(root, "temp-artifacts");
	const childSessionsRoot = join(dirname(parentSessionFile), "parent");
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const terminal = Promise.withResolvers<void>();
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			const handlers = listeners.get(event) ?? new Set();
			handlers.add(handler);
			listeners.set(event, handlers);
			return () => handlers.delete(handler);
		},
		emit(event: string, data: unknown) {
			for (const handler of listeners.get(event) ?? []) handler(data);
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) terminal.resolve();
		},
	};
	const pi = {
		events,
		getSessionName: () => "parent",
	} as never as ExtensionAPI;
	const state: ExecutorDeps["state"] = {
		baseCwd: "",
		currentSessionId: null,
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
	const executor = createSubagentExecutor({
		pi,
		state,
		config: { maxSubagentDepth: 2, parallel: { concurrency: 4, maxTasks: 50 } },
		asyncByDefault: false,
		tempArtifactsDir,
		getSubagentSessionRoot: () => childSessionsRoot,
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [makeAgent()] }),
	});
	const context = {
		cwd: root,
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => parentSessionFile,
			getSessionId: () => "parent",
			getLeafId: () => null,
		},
	} as never as ExtensionContext;
	clearSubagentControls();
	try {
		const launched = await executor.execute(
			"subagent",
			{ agent: "worker", task: "implement the fix", async: true },
			new AbortController().signal,
			undefined,
			context,
		);
		const runId = launched.details.runId;
		assert.ok(runId);
		assert.equal(launched.details.results[0]?.status, "continued");

		await terminal.promise;

		assert.deepEqual(readdirSync(join(childSessionsRoot, runId)), ["run-0"]);
		assert.equal(existsSync(tempArtifactsDir), false);
		assert.equal(readFileSync(join(parentArtifactsDir, `${runId}_worker_output.md`), "utf8"), "done");
		assert.equal(existsSync(join(parentArtifactsDir, `${runId}_worker_meta.json`)), true);
		assert.equal(existsSync(join(parentArtifactsDir, `${runId}_worker.jsonl`)), true);
		const history = readFileSync(join(parentArtifactsDir, "run-history.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const entry = JSON.parse(line) as { path: string; status: string };
				return { path: entry.path, status: entry.status };
			});
		assert.deepEqual(history, [{ path: `${runId}/worker_1`, status: "ok" }]);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});
