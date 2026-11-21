import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { createSubagentChildRecordSink } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { subagentChildrenAwaitingResume } from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { type ChildSpec, SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.ts";

/** The start budget of the test whose launch record is never saved: the attempt must give up within it. */
const UNSAVED_START_BUDGET_MS = 300;
const NOT_SAVED = "Subagent did not start: its launch could not be saved in this session: disk full. Nothing was run.";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "worker",
	description: "worker",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/worker.md",
};

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "atomic-launch-record-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return { root, promptLog: join(root, "prompts.log") };
}

async function admit(root: string, spec: Partial<ChildSpec>) {
	const control = new SubagentControlRuntime({ path: "launch-parent", depth: 0 }, join(root, "sessions"));
	control.registerAgents([agent]);
	const admitted = (
		await control.admitChildSession(
			{ taskName: "worker", task: "do the work", agent, cwd: root, ...spec },
			{ path: "launch-parent", depth: 0 },
		)
	).admitted;
	assert.ok(admitted);
	return { control, admitted };
}

const signals = () => ({ abort: new AbortController().signal, interrupt: new AbortController().signal });

test("an attempt whose launch record could not be saved runs nothing and says why", async () => {
	const { root, promptLog } = fixture();
	const { control, admitted } = await admit(root, { testSession: { output: "ran anyway", promptLogPath: promptLog } });

	const attempt = await control.runChildAttempt(admitted, {}, signals(), undefined, {
		reportActivity: () => {},
		bindChildLaunch: () => Promise.resolve("disk full."),
	});

	assert.equal(attempt.status, "error");
	assert.equal(attempt.cause, NOT_SAVED);
	assert.equal(attempt.startError, undefined, "a launch that could not be saved is not a stalled start to retry");
	assert.equal(existsSync(promptLog), false, "no prompt was sent");
});

test("an attempt waits for its launch record: one never saved runs nothing and ends as a stalled start", async () => {
	const { root, promptLog } = fixture();
	const { control, admitted } = await admit(root, {
		sessionStartTimeoutMs: UNSAVED_START_BUDGET_MS,
		testSession: { output: "ran before its launch was saved", promptLogPath: promptLog },
	});

	const attempt = await control.runChildAttempt(admitted, {}, signals(), undefined, {
		reportActivity: () => {},
		bindChildLaunch: () => new Promise<undefined>(() => {}),
	});

	assert.equal(attempt.status, "error");
	assert.ok(attempt.startError, attempt.cause);
	assert.equal(existsSync(promptLog), false, "no prompt was sent before the launch was saved");
});

test("an attempt runs once its launch record is saved, after it", async () => {
	const { root, promptLog } = fixture();
	const { control, admitted } = await admit(root, { testSession: { output: "done", promptLogPath: promptLog } });
	let promptedBeforeSaved: boolean | undefined;

	const attempt = await control.runChildAttempt(admitted, {}, signals(), undefined, {
		reportActivity: () => {},
		bindChildLaunch: () =>
			new Promise<undefined>((resolve) =>
				setTimeout(() => {
					promptedBeforeSaved = existsSync(promptLog);
					resolve(undefined);
				}, 20),
			),
	});

	assert.equal(attempt.status, "ok");
	assert.equal(promptedBeforeSaved, false);
	assert.equal(existsSync(promptLog), true);
});

test("an attempt that waited for its launch record leaves nothing listening on signals that outlive it", async () => {
	const { root } = fixture();
	const { control, admitted } = await admit(root, { testSession: { output: "done" } });
	const abort = new AbortController();
	const interrupt = new AbortController();

	const attempt = await control.runChildAttempt(
		admitted,
		{},
		{ abort: abort.signal, interrupt: interrupt.signal },
		undefined,
		{ reportActivity: () => {}, bindChildLaunch: () => Promise.resolve(undefined) },
	);

	assert.equal(attempt.status, "ok");
	assert.deepEqual(
		[getEventListeners(abort.signal, "abort").length, getEventListeners(interrupt.signal, "abort").length],
		[0, 0],
	);
});

test("an SDK child whose launch record could not be saved is not retried or run on another model", async () => {
	const { root, promptLog } = fixture();
	const launches: string[] = [];

	const result = await runSingleInProcess(root, agent, "do the work", {
		runId: "launch-not-saved-sdk",
		sessionDir: join(root, "sessions"),
		recordChildLaunch: (launch) => {
			launches.push(launch.model ?? "none");
			return Promise.resolve("disk full");
		},
		testSession: { output: "ran anyway", promptLogPath: promptLog },
	});

	assert.equal(result.status, "error");
	assert.equal(result.error, NOT_SAVED);
	assert.equal(launches.length, 1);
	assert.equal(existsSync(promptLog), false);
});

test("a launch the owner's session could not save fails the child's task with the reason, also in status", async () => {
	const { root, promptLog } = fixture();
	const owner = SessionManager.inMemory(root);
	const ctx = { sessionManager: owner } as unknown as ExtensionContext;
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: owner.getSessionId() },
		authorizeLaunch() {},
	});
	cleanups.push(() => void host.close("session-close"));
	// The owner's store takes the child's first record, then fills up before its launch is saved.
	const pi = {
		appendEntry: async <T>(type: string, data?: T) => {
			if ((data as { launchLeafId?: string | null } | undefined)?.launchLeafId !== undefined)
				throw new Error("disk full");
			await owner.appendCustomEntry(type, data);
		},
	};

	const response = await runAgentTask({
		host,
		cwd: root,
		agents: [agent],
		agent: "worker",
		task: "do the work",
		options: {
			runId: "launch-not-saved",
			index: 0,
			sessionDir: join(root, "sessions"),
			testSession: { output: "ran anyway", promptLogPath: promptLog },
		},
		recordChild: createSubagentChildRecordSink(pi, ctx),
		runtime: { runSync },
	});
	assert.equal(response.kind, "admitted");
	const settled = await host.waitForTask(response.observation.taskId as TaskId);

	assert.ok(settled.ok && settled.value.kind === "settled", JSON.stringify(settled));
	assert.match(JSON.stringify(settled.value.result), new RegExp(NOT_SAVED.replaceAll(".", "\\.")));
	assert.equal(existsSync(promptLog), false);
	const status = subagentChildrenAwaitingResume(ctx, "launch-not-saved:0").join("\n");
	assert.match(status, /record-append-failed/, status);
});
