import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { SessionWriteOptions } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { OwnerId, Sequence, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { readTaskTranscriptSnapshot } from "../../packages/coding-agent/src/core/tasks/transcript.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { createSubagentChildRecordSink } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { retainedTaskOutput } from "../../packages/subagents/src/runs/foreground/task-output-retention.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { agent } from "../helpers/released-task-launch.js";

const CHILD_LOAD_TIMEOUT_MS = 120_000;
const FINAL_ANSWER = "the final answer is 42";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

/** A store whose disk fills up exactly when the child's final answer is appended, until it is freed. */
class FullOnFinalAnswerStore extends MemorySessionStore {
	full = true;
	/** The text whose message the full disk rejects. */
	rejects = FINAL_ANSWER;
	/**
	 * When set, the answer's write lands before the store reports it failed, and the store cannot be read back right
	 * then, so the session cannot tell it was saved.
	 */
	landsAnyway = false;
	private unreadable = false;
	override load(sessionId: string) {
		if (this.unreadable) {
			this.unreadable = false;
			return Promise.reject(new Error("EIO: i/o error, read"));
		}
		return super.load(sessionId);
	}
	override append(sessionId: string, entries: readonly SessionEntry[], options: SessionWriteOptions) {
		if (
			this.full &&
			entries.some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes(this.rejects))
		) {
			const error = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
			if (this.landsAnyway)
				return super.append(sessionId, entries, options).then(() => {
					this.unreadable = true;
					return Promise.reject(error);
				});
			return Promise.reject(error);
		}
		return super.append(sessionId, entries, options);
	}
}

/** The faux model calls a tool first, so the child has a saved turn of its own before its final answer. */
function toolThenAnswer(env: Awaited<ReturnType<typeof liveChildEnvironment>>) {
	env.faux.setResponses([
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "ci-1", name: "wait_for_ci", arguments: { run: "1" } }],
			stopReason: "toolUse",
		} as never,
		{ role: "assistant", content: [{ type: "text", text: FINAL_ANSWER }], stopReason: "stop" } as never,
	]);
}

/** Answers the child's CI wait as soon as it starts. */
async function answerCi(env: Awaited<ReturnType<typeof liveChildEnvironment>>): Promise<void> {
	for (let turn = 0; turn < 2_000 && env.answers.length === 0; turn++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	env.answers[0]?.({ content: [{ type: "text", text: "CI is green" }], details: undefined });
}

test(
	"a foreground child whose final answer fails to save fails naming the storage error and keeps the answer (#5210)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		toolThenAnswer(env);
		const running = runSingleInProcess(env.root, agent, "check CI and answer", {
			...env.options("final-answer-save", {
				sessionManager: await SessionManager.create(new FullOnFinalAnswerStore(), env.root),
			}),
		});
		await answerCi(env);
		const result = await running;
		assert.equal(result.status, "error");
		assert.match(result.error ?? "", /final answer could not be saved/);
		assert.match(result.error ?? "", /ENOSPC: no space left on device/);
		assert.match(result.finalOutput ?? "", new RegExp(FINAL_ANSWER));
	},
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"a child whose tool result fails to save fails naming the storage error, with no answer to keep (#5210)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new FullOnFinalAnswerStore();
		store.rejects = "CI is green";
		toolThenAnswer(env);
		const running = runSingleInProcess(env.root, agent, "check CI and answer", {
			...env.options("tool-result-save", { sessionManager: await SessionManager.create(store, env.root) }),
		});
		await answerCi(env);
		const result = await running;
		assert.equal(result.status, "error");
		assert.match(
			result.error ?? "",
			/^The child's session could not save its work \(.*ENOSPC: no space left on device/,
		);
		assert.doesNotMatch(result.finalOutput ?? "", new RegExp(FINAL_ANSWER));
	},
	CHILD_LOAD_TIMEOUT_MS,
);

async function resumeAfterFailedAnswer(landsAnyway: boolean): Promise<void> {
	const env = await liveChildEnvironment(cleanups);
	const store = new FullOnFinalAnswerStore();
	store.landsAnyway = landsAnyway;
	const manager = await SessionManager.create(store, env.root);
	toolThenAnswer(env);
	const running = runSingleInProcess(env.root, agent, "check CI and answer", {
		...env.options("final-answer-resume", { sessionManager: manager }),
	});
	await answerCi(env);
	assert.equal((await running).status, "error");

	store.full = false;
	env.faux.setResponses([
		{ role: "assistant", content: [{ type: "text", text: "still 42" }], stopReason: "stop" } as never,
	]);
	const resumed = await runSingleInProcess(env.root, agent, "are you sure?", {
		...env.options("final-answer-resume-2", {
			sessionManager: await SessionManager.open(store, manager.getSessionId()),
			resumeSession: true,
		}),
	});
	assert.equal(resumed.status, "ok");
	assert.equal(resumed.finalOutput, "still 42");
	const reopened = await SessionManager.open(store, manager.getSessionId());
	const texts = reopened
		.getBranch()
		.flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
		.filter((message) => message.role === "assistant" || message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
		);
	assert.equal(texts.filter((text) => text === FINAL_ANSWER).length, 1, JSON.stringify(texts));
	assert.ok(texts.indexOf(FINAL_ANSWER) < texts.findIndex((text) => text.includes("are you sure?")));
}

test(
	"a resumed child whose final answer failed to save continues after that answer, holding it once (#5210)",
	() => resumeAfterFailedAnswer(false),
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"a resumed child whose failed answer save landed after all holds that answer once (#5210)",
	() => resumeAfterFailedAnswer(true),
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"a background child whose final answer fails to save settles failed, and its card and /tasks keep the answer (#5210)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const owner = SessionManager.inMemory(env.root);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: owner.getSessionId() },
			authorizeLaunch() {},
		});
		cleanups.push(() => void host.close("session-close"));
		toolThenAnswer(env);
		const response = await runAgentTask({
			host,
			cwd: env.root,
			agents: [agent],
			agent: "waiter",
			task: "check CI and answer",
			options: {
				...env.options("final-answer-background", {
					sessionManager: await SessionManager.create(new FullOnFinalAnswerStore(), env.root),
					resumeSession: true,
				}),
				index: 0,
			},
			wait: { kind: "background" },
			recordChild: createSubagentChildRecordSink(
				{ appendEntry: async (type, data) => void (await owner.appendCustomEntry(type, data)) },
				{ sessionManager: owner, orchestrationContext: undefined },
			),
			runtime: { runSync },
		});
		assert.ok(response.kind === "admitted");
		await answerCi(env);
		const taskId = response.observation.taskId as TaskId;
		const settled = await host.waitForTask(taskId);
		assert.ok(settled.ok && settled.value.kind === "settled", JSON.stringify(settled));
		const result = settled.value.result;
		assert.ok(result.kind === "failed", JSON.stringify(result));
		assert.match(result.message, /final answer could not be saved/);
		assert.match(result.message, /ENOSPC: no space left on device/);

		// The completion outbox and /tasks output hold the answer the runner received.
		assert.ok(result.output);
		assert.match(
			retainedTaskOutput(result.output.ownerId, result.output.taskId)?.head ?? "",
			new RegExp(FINAL_ANSWER),
		);
		const card = taskCompletionNotice(
			{
				completionId: "final-answer",
				ownerId: "owner" as OwnerId,
				taskId,
				terminalSequence: "1" as Sequence,
				result,
				display: false,
			},
			{ kind: "agent", title: "answer", agentName: "waiter" },
			retainedTaskOutput(result.output.ownerId, result.output.taskId)?.head,
		);
		assert.equal(card.status, "failed");
		assert.match(card.preview, /ENOSPC/);
		assert.match(card.preview, new RegExp(FINAL_ANSWER));

		// The task's transcript ends with the answer, though the session file lacks it.
		const lease = host.resolveTask(taskId);
		assert.ok(lease.ok);
		const page = readTaskTranscriptSnapshot(lease.value);
		assert.ok(page.ok);
		const last = page.value.items.at(-1);
		assert.equal(last?.kind, "response", JSON.stringify(page.value.items));
	},
	CHILD_LOAD_TIMEOUT_MS,
);
