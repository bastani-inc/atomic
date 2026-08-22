import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { Value } from "typebox/value";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function makeAgent(defaultProgress?: boolean): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Test agent",
		source: "project",
		filePath: "/tmp/worker.md",
		defaultProgress,
	};
}

function makeResult(task: string): SingleResult {
	return { agent: "worker", task, status: "ok", messages: [], usage, finalOutput: "done" };
}

function extractProgressPath(task: string): string {
	return task.match(/Create and maintain progress at: ([^\r\n]+[\\/]progress\.md)/)?.[1] ?? "";
}

function makeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(cwd, "parent-session.jsonl"),
			getSessionId: () => "parent",
			getLeafId: () => null,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function makeExecutor(
	cwd: string,
	runtime: Partial<SubagentExecutorRuntimeDeps>,
	defaultProgress?: boolean,
	authorizeSupervisor?: (childName: string) => { capability: string; supervisorSessionId: string; childName: string },
	intercomBridgeMode?: "off",
): ReturnType<typeof createSubagentExecutor> {
	const state: ExecutorDeps["state"] = {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
	return createSubagentExecutor({
		pi: {
			events: {
				on: () => () => {},
				emit: (channel: string, payload: unknown) => {
					if (channel !== "subagent:supervisor-authorization" || !authorizeSupervisor) return;
					const request = payload as { childName: string; completion?: Promise<object> };
					request.completion = Promise.resolve(authorizeSupervisor(request.childName));
				},
			},
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state,
		config: {
			parallel: { concurrency: 4, maxTasks: 50 },
			...(intercomBridgeMode ? { intercomBridge: { mode: intercomBridgeMode } } : {}),
		},
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [makeAgent(defaultProgress)] }),
		runtime,
	});
}

test("root progress true is schema-valid and independent from includeProgress", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-root-progress-"));
	try {
		const captured: string[] = [];
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				captured.push(task);
				return makeResult(task);
			},
		});
		const context = makeContext(cwd);
		const cwdProgressPath = join(cwd, "progress.md");
		writeFileSync(cwdProgressPath, "project sentinel");
		const invocation = { agent: "worker", task: "review only; do not edit files", progress: true };
		assert.equal(Value.Check(SubagentParams, invocation), true);
		const result = await executor.execute("explicit", invocation, new AbortController().signal, undefined, context);
		const runId = result.details?.runId;
		assert.ok(runId);
		const progressPath = join(cwd, "subagent-artifacts", "progress", runId, "progress.md");
		assert.ok((captured[0] ?? "").includes(`Create and maintain progress at: ${progressPath}`));
		assert.equal(existsSync(progressPath), true);
		assert.equal(readFileSync(cwdProgressPath, "utf8"), "project sentinel");

		await executor.execute(
			"telemetry",
			{
				agent: "worker",
				task: "inspect behavior",
				includeProgress: true,
			},
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(
			readFileSync(cwdProgressPath, "utf8"),
			"project sentinel",
			"includeProgress must not enable file tracking",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("single progress false overrides default and omission inherits it", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-default-progress-"));
	try {
		const tasks: string[] = [];
		const executor = makeExecutor(
			cwd,
			{
				runSync: async (_cwd, _agents, _agent, task) => {
					tasks.push(task);
					return makeResult(task);
				},
			},
			true,
		);
		const context = makeContext(cwd);
		await executor.execute(
			"disabled",
			{
				agent: "worker",
				task: "implement one",
				progress: false,
			},
			new AbortController().signal,
			undefined,
			context,
		);
		assert.doesNotMatch(tasks[0] ?? "", /Create and maintain progress/);
		assert.equal(existsSync(join(cwd, "progress.md")), false);

		const result = await executor.execute(
			"inherited",
			{
				agent: "worker",
				task: "implement two",
			},
			new AbortController().signal,
			undefined,
			context,
		);
		const runId = result.details?.runId;
		assert.ok(runId);
		const progressPath = join(cwd, "subagent-artifacts", "progress", runId, "progress.md");
		assert.ok((tasks[1] ?? "").includes(`Create and maintain progress at: ${progressPath}`));
		assert.match(readFileSync(progressPath, "utf8"), /# Progress/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground artifacts-disabled progress storage is removed after success", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-cleanup-"));
	try {
		let progressPath = "";
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				progressPath = extractProgressPath(task);
				assert.ok(progressPath);
				assert.equal(existsSync(progressPath), true, "progress storage must exist while the child runs");
				return makeResult(task);
			},
		});

		const result = await executor.execute(
			"cleanup",
			{
				agent: "worker",
				task: "implement",
				progress: true,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			makeContext(cwd),
		);

		assert.equal(result.isError, undefined);
		assert.equal(existsSync(progressPath), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground artifacts-disabled progress storage is removed after child failure", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-failure-"));
	try {
		let progressPath = "";
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				progressPath = extractProgressPath(task);
				assert.equal(existsSync(progressPath), true);
				return { ...makeResult(task), status: "error" as const, error: "failed" };
			},
		});

		const result = await executor.execute(
			"cleanup-failure",
			{
				agent: "worker",
				task: "implement",
				progress: true,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			makeContext(cwd),
		);

		assert.equal(result.isError, true);
		assert.equal(existsSync(progressPath), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground artifacts-disabled progress storage is removed after a synchronous runtime throw", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-sync-throw-"));
	try {
		let progressPath = "";
		const originalError = new Error("sync runtime failure");
		const executor = makeExecutor(cwd, {
			runSync: (_cwd, _agents, _agent, task) => {
				progressPath = extractProgressPath(task);
				assert.equal(existsSync(progressPath), true);
				throw originalError;
			},
		});

		const result = await executor.execute(
			"cleanup-sync-throw",
			{
				agent: "worker",
				task: "implement",
				progress: true,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			makeContext(cwd),
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /sync runtime failure/);
		assert.equal(existsSync(progressPath), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground artifacts-disabled progress storage is removed after a rejected runtime promise", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-rejection-"));
	try {
		let progressPath = "";
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				progressPath = extractProgressPath(task);
				assert.equal(existsSync(progressPath), true);
				throw new Error("async runtime failure");
			},
		});

		const result = await executor.execute(
			"cleanup-rejection",
			{
				agent: "worker",
				task: "implement",
				progress: true,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			makeContext(cwd),
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /async runtime failure/);
		assert.equal(existsSync(progressPath), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground detached child retains artifacts-disabled progress storage until runtime reports exit", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-detached-"));
	try {
		let progressPath = "";
		let reportDetachedExit: ((result: SingleResult) => void) | undefined;
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task, options) => {
				progressPath = extractProgressPath(task);
				reportDetachedExit = options.onDetachedExit;
				return { ...makeResult(task), detached: true };
			},
		});

		await executor.execute(
			"retain-detached",
			{
				agent: "worker",
				task: "implement",
				progress: true,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			makeContext(cwd),
		);

		assert.equal(existsSync(progressPath), true, "detached child may still write progress");
		assert.ok(reportDetachedExit);
		reportDetachedExit(makeResult("implement"));
		assert.equal(existsSync(progressPath), false, "progress storage is transient after detached child exit");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
test("foreground read-only task suppresses inherited defaultProgress", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-readonly-progress-"));
	try {
		let capturedTask = "";
		const executor = makeExecutor(
			cwd,
			{
				runSync: async (_cwd, _agents, _agent, task) => {
					capturedTask = task;
					return makeResult(task);
				},
			},
			true,
		);

		await executor.execute(
			"readonly",
			{
				agent: "worker",
				task: "Inspect only; do not edit files.",
			},
			new AbortController().signal,
			undefined,
			makeContext(cwd),
		);

		assert.doesNotMatch(capturedTask, /Create and maintain progress/);
		assert.equal(existsSync(join(cwd, "subagent-artifacts", "progress")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume inherits single-agent defaultProgress", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-progress-"));
	try {
		const sessionFile = join(cwd, "worker.jsonl");
		writeFileSync(sessionFile, "");
		let resumedTask = "";
		let runSyncAttempt = 0;
		const executor = makeExecutor(
			cwd,
			{
				runSync: async (_cwd, _agents, _agent, task) => {
					resumedTask = task;
					const interrupted = runSyncAttempt++ === 0;
					return {
						...makeResult(task),
						sessionFile,
						...(interrupted ? { status: "interrupted" as const, interrupted: true } : {}),
					};
				},
			},
			true,
		);
		const context = makeContext(cwd);
		const initial = await executor.execute(
			"initial",
			{ agent: "worker", task: "implement" },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.ok(initial.details?.runId);

		const resumed = await executor.execute(
			"resume",
			{ action: "resume", id: initial.details.runId, message: "continue implementation" },
			new AbortController().signal,
			undefined,
			context,
		);

		assert.equal(resumed.isError, undefined);
		assert.match(resumedTask, /Create and maintain progress/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume requests and forwards a fresh supervisor authorization", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-supervisor-"));
	try {
		const sessionFile = join(cwd, "worker.jsonl");
		writeFileSync(sessionFile, "");
		const authorizedChildren: string[] = [];
		const capturedAuthorizations: Array<
			{ capability: string; supervisorSessionId: string; childName: string } | undefined
		> = [];
		let runSyncAttempt = 0;
		const executor = makeExecutor(
			cwd,
			{
				runSync: async (_cwd, _agents, _agent, task, options) => {
					capturedAuthorizations.push(options.supervisorAuthorization);
					const interrupted = runSyncAttempt++ === 0;
					return {
						...makeResult(task),
						sessionFile,
						...(interrupted ? { status: "interrupted" as const, interrupted: true } : {}),
					};
				},
			},
			true,
			(childName) => {
				authorizedChildren.push(childName);
				return {
					capability: `cap-${authorizedChildren.length}`,
					supervisorSessionId: "supervisor-id",
					childName,
				};
			},
		);
		const context = makeContext(cwd);
		const initial = await executor.execute(
			"initial",
			{ agent: "worker", task: "implement" },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.ok(initial.details?.runId);

		const resumed = await executor.execute(
			"resume",
			{ action: "resume", id: initial.details.runId, message: "continue implementation" },
			new AbortController().signal,
			undefined,
			context,
		);

		assert.equal(resumed.isError, undefined);
		assert.equal(authorizedChildren.length, 2);
		assert.equal(authorizedChildren[0], authorizedChildren[1]);
		assert.deepEqual(
			capturedAuthorizations.map((authorization) => authorization?.capability),
			["cap-1", "cap-2"],
		);
		for (const authorization of capturedAuthorizations) {
			assert.equal(authorization?.childName, authorizedChildren[0]);
			assert.equal(authorization?.supervisorSessionId, "supervisor-id");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("inactive bridge requests no initial supervisor authorization", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-no-supervisor-"));
	try {
		const authorizedChildren: string[] = [];
		let capturedAuthorization: Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]["supervisorAuthorization"];
		const executor = makeExecutor(
			cwd,
			{
				runSync: async (_cwd, _agents, _agent, task, options) => {
					capturedAuthorization = options.supervisorAuthorization;
					return makeResult(task);
				},
			},
			false,
			(childName) => {
				authorizedChildren.push(childName);
				return { capability: "unexpected", supervisorSessionId: "supervisor-id", childName };
			},
			"off",
		);

		await executor.execute(
			"initial",
			{ agent: "worker", task: "implement" },
			new AbortController().signal,
			undefined,
			makeContext(cwd),
		);

		assert.deepEqual(authorizedChildren, []);
		assert.equal(capturedAuthorization, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume suppresses inherited defaultProgress for a read-only follow-up", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-readonly-"));
	try {
		const sessionFile = join(cwd, "worker.jsonl");
		writeFileSync(sessionFile, "");
		let resumedTask = "";
		let runSyncAttempt = 0;
		const executor = makeExecutor(
			cwd,
			{
				runSync: async (_cwd, _agents, _agent, task) => {
					resumedTask = task;
					const interrupted = runSyncAttempt++ === 0;
					return {
						...makeResult(task),
						sessionFile,
						...(interrupted ? { status: "interrupted" as const, interrupted: true } : {}),
					};
				},
			},
			true,
		);
		const context = makeContext(cwd);
		const initial = await executor.execute(
			"initial",
			{ agent: "worker", task: "implement" },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.ok(initial.details?.runId);

		await executor.execute(
			"resume",
			{ action: "resume", id: initial.details.runId, message: "Review only; do not edit files." },
			new AbortController().signal,
			undefined,
			context,
		);

		assert.doesNotMatch(resumedTask, /Create and maintain progress/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume explicit progress overrides read-only suppression", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-explicit-"));
	try {
		const sessionFile = join(cwd, "worker.jsonl");
		writeFileSync(sessionFile, "");
		let resumedTask = "";
		let runSyncAttempt = 0;
		const executor = makeExecutor(
			cwd,
			{
				runSync: async (_cwd, _agents, _agent, task) => {
					resumedTask = task;
					const interrupted = runSyncAttempt++ === 0;
					return {
						...makeResult(task),
						sessionFile,
						...(interrupted ? { status: "interrupted" as const, interrupted: true } : {}),
					};
				},
			},
			true,
		);
		const context = makeContext(cwd);
		const initial = await executor.execute(
			"initial",
			{ agent: "worker", task: "implement" },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.ok(initial.details?.runId);

		await executor.execute(
			"resume",
			{
				action: "resume",
				id: initial.details.runId,
				message: "Review only; do not edit files.",
				progress: true,
			},
			new AbortController().signal,
			undefined,
			context,
		);

		assert.match(resumedTask, /Create and maintain progress/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
