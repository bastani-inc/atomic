import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { test } from "vitest";
import type { Cleanup } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";

function collectGarbage(): void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") {
		existing();
		return;
	}
	v8.setFlagsFromString("--expose-gc");
	try {
		(vm.runInNewContext("gc") as () => void)();
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

function analysisAgent(): AgentConfig {
	return {
		name: "analysis",
		description: "analysis agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/analysis.md",
	};
}

test("a completed in-process child keeps its transcript but not its session (#3622)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-retention-"));
	clearSubagentControls();
	try {
		// The task supervisor keeps only the most recently bound source for the task's lifetime.
		let retained: TaskTranscriptSource | undefined;
		let cleanup: Promise<Cleanup> | undefined;
		const hooks: TaskExecutionHooks = {
			signal: new AbortController().signal,
			reportActivity() {},
			bindTranscript(source) {
				retained = source;
			},
			onExecution(execution) {
				cleanup = execution.cleanup;
			},
			yieldTaskWait() {},
			isParentObserving: () => false,
		};
		let session: WeakRef<object> | undefined;

		const result = await runSingleInProcess(root, analysisAgent(), "inspect the fixture", {
			cwd: root,
			runId: "completed-child-retention",
			sessionDir: root,
			taskExecution: hooks,
			testSession: {
				output: "child answer",
				dispose(this: object) {
					session = new WeakRef(this);
				},
			},
		});

		assert.equal(result.status, "ok");
		await cleanup;
		assert.ok(session, "the child session was disposed");
		const texts = retained?.getEntries().flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []));
		assert.deepEqual(texts, ["user", "assistant"], "the retained transcript still shows the whole conversation");
		// A WeakRef target stays alive until the job that created the ref ends.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		collectGarbage();
		assert.equal(session.deref(), undefined, "the task's transcript source still pins the disposed child session");
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a running in-process child offers its live session to a chat of its task, and a completed one offers none (#4640)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-chat-session-"));
	clearSubagentControls();
	try {
		const bound: TaskTranscriptSource[] = [];
		let cleanup: Promise<Cleanup> | undefined;
		const hooks: TaskExecutionHooks = {
			signal: new AbortController().signal,
			reportActivity() {},
			bindTranscript: (source) => void bound.push(source),
			onExecution(execution) {
				cleanup = execution.cleanup;
			},
			yieldTaskWait() {},
			isParentObserving: () => false,
		};

		await runSingleInProcess(root, analysisAgent(), "inspect the fixture", {
			cwd: root,
			runId: "live-chat-session",
			sessionDir: root,
			taskExecution: hooks,
			testSession: { output: "child answer" },
		});
		await cleanup;

		const liveIndex = bound.findIndex((source) => source.subscribe !== undefined);
		const live = bound[liveIndex];
		const settled = bound.slice(liveIndex + 1);
		assert.ok(live?.chatSession, "the running child's session reaches its task's chat");
		assert.equal(live.isRunning?.(), live.chatSession.isStreaming, "a turn is under way as the session says");
		assert.deepEqual(live.getQueuedMessages?.(), { steering: [], followUp: [] });
		assert.ok(settled.length > 0, "the completed child's transcript replaced the live one");
		for (const source of settled) {
			for (const member of ["chatSession", "isRunning", "getQueuedMessages"])
				assert.equal(Object.hasOwn(source, member), false, `a completed child offers no ${member}`);
		}
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a running and a completed in-process child offer their chat the child's own cwd to complete paths in (#4755)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-chat-commands-"));
	const childCwd = join(root, "child-cwd");
	mkdirSync(childCwd);
	clearSubagentControls();
	try {
		const bound: TaskTranscriptSource[] = [];
		let cleanup: Promise<Cleanup> | undefined;
		const hooks: TaskExecutionHooks = {
			signal: new AbortController().signal,
			reportActivity() {},
			bindTranscript: (source) => void bound.push(source),
			onExecution(execution) {
				cleanup = execution.cleanup;
			},
			yieldTaskWait() {},
			isParentObserving: () => false,
		};

		await runSingleInProcess(root, analysisAgent(), "inspect the fixture", {
			cwd: childCwd,
			runId: "chat-commands",
			sessionDir: root,
			taskExecution: hooks,
			testSession: { output: "child answer" },
		});
		await cleanup;

		const liveIndex = bound.findIndex((source) => source.subscribe !== undefined);
		const settled = bound.slice(liveIndex + 1);
		assert.equal(bound[liveIndex]?.commands?.().cwd, childCwd, "the running child's chat completes in its cwd");
		assert.ok(settled.length > 0, "the completed child's transcript replaced the live one");
		for (const source of settled)
			assert.equal(source.commands?.().cwd, childCwd, "the completed child's chat keeps the cwd it had");
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});
