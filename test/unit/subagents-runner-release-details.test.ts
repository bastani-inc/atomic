import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { Cleanup } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { INTERCOM_SESSION_IDENTITY_ENTRY } from "../../packages/intercom/session-identity.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE_CHILD_TIMEOUT_MS = 120_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "waiter",
	description: "waits on CI",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/waiter.md",
};

const waitCall = () =>
	fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" });

function transcriptHooks(bound: TaskTranscriptSource[], cleanups: Array<Promise<Cleanup>> = []): TaskExecutionHooks {
	return {
		signal: new AbortController().signal,
		reportActivity() {},
		bindTranscript(source) {
			bound.push(source);
		},
		onExecution(execution) {
			cleanups.push(execution.cleanup);
		},
		yieldTaskWait() {},
		isParentObserving: () => false,
	};
}

test(
	"a released child keeps only its session id as its task transcript, and a settled one keeps its entries (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const releasedBound: TaskTranscriptSource[] = [];
		const releasedCleanups: Array<Promise<Cleanup>> = [];
		const releasedManager = await SessionManager.create(new MemorySessionStore(), env.root);
		env.faux.setResponses([waitCall()]);
		const released = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("transcript-released", {
				sessionManager: releasedManager,
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
				taskExecution: transcriptHooks(releasedBound, releasedCleanups),
			}),
		});
		assert.equal(released.status, "interrupted");
		await Promise.all(releasedCleanups);
		const releasedSource = releasedBound.at(-1);
		assert.ok(releasedSource);
		assert.equal(releasedSource.getSessionId(), releasedManager.getSessionId());
		assert.deepEqual(releasedSource.getEntries(), []);

		const settledBound: TaskTranscriptSource[] = [];
		const settledCleanups: Array<Promise<Cleanup>> = [];
		env.faux.setResponses([fauxAssistantMessage("done")]);
		const settled = await runSingleInProcess(env.root, agent, "say done", {
			...env.options("transcript-settled", { taskExecution: transcriptHooks(settledBound, settledCleanups) }),
		});
		assert.equal(settled.status, "ok");
		await Promise.all(settledCleanups);
		const settledSource = settledBound.at(-1);
		assert.ok(settledSource);
		assert.deepEqual(
			settledSource.getEntries().flatMap((entry) => (entry.type === "message" ? [entry.message.role] : [])),
			["system", "user", "assistant"],
		);
		assert.notEqual(settledSource, settledBound[0]);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a released child carries the Intercom id its session registered under, and none when it never registered (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const registered = await SessionManager.create(new MemorySessionStore(), env.root);
		await registered.appendCustomEntry(INTERCOM_SESSION_IDENTITY_ENTRY, {
			sessionId: registered.getSessionId(),
			intercomSessionId: "icom-before",
		});
		env.faux.setResponses([waitCall()]);
		const withId = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("intercom-id", {
				sessionManager: registered,
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
			}),
		});
		assert.equal(withId.released?.intercomId, "icom-before");

		const plain = await SessionManager.create(new MemorySessionStore(), env.root);
		env.faux.setResponses([waitCall()]);
		const without = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("no-intercom-id", {
				sessionManager: plain,
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
			}),
		});
		assert.ok(without.released);
		assert.equal(Object.hasOwn(without.released, "intercomId"), false);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

/** A manager whose store does not hold its session, so reopening it fails before any session exists. */
async function sessionNotInItsStore(root: string): Promise<SessionManager> {
	const saved = await SessionManager.create(new MemorySessionStore(), root);
	const elsewhere = await SessionManager.create(new MemorySessionStore(), root);
	return Object.assign(Object.create(saved) as SessionManager, {
		getSessionStore: () => elsewhere.getSessionStore(),
		getSessionId: () => saved.getSessionId(),
	});
}

test("a child that never opened its session binds no transcript and still returns its failure (#4326)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-no-session-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const bound: TaskTranscriptSource[] = [];
	const cleared: number[] = [];
	const pending: Array<Promise<Cleanup>> = [];
	const result = await runSingleInProcess(root, agent, "never starts", {
		cwd: root,
		runId: "no-session",
		sessionDir: join(root, "sessions"),
		sessionManager: await sessionNotInItsStore(root),
		resumeSession: true,
		taskExecution: {
			...transcriptHooks(bound, pending),
			clearExtensionStatuses: () => void cleared.push(1),
		},
		testSession: { output: "unused" },
	});
	assert.notEqual(result.status, "ok");
	await Promise.all(pending);
	assert.equal(cleared.length, 1);
	assert.equal(bound.length, 0);
});

test("a child whose task hooks do not take a transcript still settles (#4326)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-no-transcript-hook-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const result = await runSingleInProcess(root, agent, "say done", {
		cwd: root,
		runId: "no-transcript-hook",
		sessionDir: join(root, "sessions"),
		taskExecution: {
			signal: new AbortController().signal,
			reportActivity() {},
			onExecution() {},
			yieldTaskWait() {},
			isParentObserving: () => false,
		},
		testSession: { output: "done" },
	});
	assert.equal(result.status, "ok");
	assert.equal(result.finalOutput, "done");
});
