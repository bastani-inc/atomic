import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { SessionWriteOptions } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { OwnerId, Sequence, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { loadTaskOwnTranscriptEntries } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { readTaskTranscript } from "../../packages/coding-agent/src/core/tasks/transcript.js";
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
	override readRange(sessionId: string, startSeq: number, endSeq: number) {
		if (this.unreadable) {
			this.unreadable = false;
			return Promise.reject(new Error("EIO: i/o error, read"));
		}
		return super.readRange(sessionId, startSeq, endSeq);
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

test(
	"a child whose tool call fails to save fails naming the storage error and resumes without it (#5210)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new FullOnFinalAnswerStore();
		store.rejects = `"id":"ci-1"`;
		const manager = await SessionManager.create(store, env.root);
		toolThenAnswer(env);
		const result = await runSingleInProcess(env.root, agent, "check CI and answer", {
			...env.options("tool-call-save", { sessionManager: manager }),
		});
		assert.equal(result.status, "error");
		assert.match(result.error ?? "", /^The child's session could not save its work \(.*ENOSPC/);

		store.full = false;
		env.faux.setResponses([
			{ role: "assistant", content: [{ type: "text", text: "starting over" }], stopReason: "stop" } as never,
		]);
		const resumed = await runSingleInProcess(env.root, agent, "try again", {
			...env.options("tool-call-save-2", {
				sessionManager: await SessionManager.open(store, manager.getSessionId()),
				resumeSession: true,
			}),
		});
		assert.equal(resumed.status, "ok");
		const reopened = await SessionManager.open(store, manager.getSessionId());
		const calls = reopened
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
			.filter((message) => message.content.some((part) => part.type === "toolCall"));
		assert.deepEqual(calls, [], "the unsaved call is not saved by the resume");
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

/** Launches the CI-then-answer child in the background on `sessionManager` and waits for its task to settle. */
async function settleInBackground(
	env: Awaited<ReturnType<typeof liveChildEnvironment>>,
	runId: string,
	sessionManager: SessionManager,
	settingsManager?: SettingsManager,
) {
	const owner = SessionManager.inMemory(env.root);
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: owner.getSessionId() },
		authorizeLaunch() {},
	});
	cleanups.push(() => void host.close("session-close"));
	toolThenAnswer(env);
	const baseOptions = env.options(runId, { sessionManager, resumeSession: true });
	const response = await runAgentTask({
		host,
		cwd: env.root,
		agents: [agent],
		agent: "waiter",
		task: "check CI and answer",
		options: {
			...baseOptions,
			...(settingsManager === undefined
				? {}
				: {
						getChildSessionOptions: (childOptions) => ({
							...baseOptions.getChildSessionOptions!(childOptions),
							settingsManager,
						}),
					}),
			index: 0,
		},
		recordChild: createSubagentChildRecordSink(
			{ appendEntry: async (type, data) => void (await owner.appendCustomEntry(type, data)) },
			{ sessionManager: owner },
		),
		runtime: { runSync },
	});
	assert.ok(response.kind === "admitted");
	await answerCi(env);
	const taskId = response.observation.taskId as TaskId;
	const settled = await host.waitForTask(taskId);
	assert.ok(settled.ok && settled.value.kind === "settled", JSON.stringify(settled));
	return { host, taskId, result: settled.value.result };
}

/** What `/tasks` detail, the task's transcript and its completion card show of a settled child, read as they read it. */
async function settledViews(host: AgentTaskHost, taskId: TaskId) {
	const lease = host.resolveTask(taskId);
	assert.ok(lease.ok);
	const view = ownerTaskViewSource(new OwnerTaskStore(host.ownerBinding.supervisor, host.ownerBinding.owner));
	const detail = await view.taskDetailText(taskId);
	const transcript = await readTaskTranscript(lease.value);
	// The completion card's excerpt is the last assistant text of the task's own entries.
	const entries = (await loadTaskOwnTranscriptEntries(lease.value)) ?? [];
	const answers = entries.filter(
		(entry) => entry.type === "message" && JSON.stringify(entry.message).includes(FINAL_ANSWER),
	).length;
	const card = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
	return {
		detailOutput: detail.output,
		transcriptKinds: transcript.ok ? transcript.value.items.map((item) => item.kind) : transcript.error.code,
		answers,
		cardOutput: card?.type === "message" ? JSON.stringify(card.message) : undefined,
	};
}

/**
 * A JSON-lines session whose disk fills up when the final answer is saved. With `lands`, the write lands first and the
 * file cannot be read back right then, so the session cannot tell it was saved.
 */
async function fullFileSession(root: string, lands: boolean): Promise<SessionManager> {
	const dir = mkdtempSync(join(root, "child-session-"));
	const manager = await SessionManager.create(dir, root);
	const store = manager.getSessionStore();
	const append = store.append.bind(store);
	const load = store.load.bind(store);
	let unreadable = false;
	store.load = (sessionId) => {
		if (!unreadable) return load(sessionId);
		unreadable = false;
		return Promise.reject(new Error("EIO: i/o error, read"));
	};
	const readRange = store.readRange!.bind(store);
	store.readRange = (id, start, end) => {
		if (unreadable) {
			unreadable = false;
			return Promise.reject(new Error("EIO: i/o error, read"));
		}
		return readRange(id, start, end);
	};
	store.append = async (sessionId, entries, options) => {
		if (!JSON.stringify(entries).includes(FINAL_ANSWER)) return append(sessionId, entries, options);
		if (lands) {
			await append(sessionId, entries, options);
			unreadable = true;
		}
		throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
	};
	return manager;
}

test(
	"a background child whose final answer fails to save settles failed, and its card and /tasks keep the answer (#5210)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const { host, taskId, result } = await settleInBackground(
			env,
			"final-answer-background",
			await SessionManager.create(new FullOnFinalAnswerStore(), env.root),
		);
		assert.ok(result.kind === "failed", JSON.stringify(result));
		assert.match(result.message, /final answer could not be saved/);
		assert.match(result.message, /ENOSPC: no space left on device/);

		// The completion outbox and /tasks output hold the answer the runner received.
		assert.ok(result.output);
		const head = retainedTaskOutput(result.output.ownerId, result.output.taskId)?.head;
		assert.match(head ?? "", new RegExp(FINAL_ANSWER));
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
			head,
		);
		assert.equal(card.status, "failed");
		assert.match(card.preview, /ENOSPC/);
		assert.match(card.preview, new RegExp(FINAL_ANSWER));

		// Its history, read back from its session store, ends with the answer the store lacks.
		const views = await settledViews(host, taskId);
		assert.equal(views.detailOutput, FINAL_ANSWER);
		assert.equal(views.answers, 1);
		assert.match(views.cardOutput ?? "", new RegExp(FINAL_ANSWER));
		assert.ok(Array.isArray(views.transcriptKinds));
		assert.equal(views.transcriptKinds.at(-1), "response", JSON.stringify(views.transcriptKinds));
	},
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"a finished child whose answer its session file lacks shows it once in /tasks, its transcript and card, also once the file is gone (#5210)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const manager = await fullFileSession(env.root, false);
		const { host, taskId, result } = await settleInBackground(env, "final-answer-file", manager);
		assert.ok(result.kind === "failed", JSON.stringify(result));
		const file = manager.getSessionFile();
		assert.ok(file);
		assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(FINAL_ANSWER));

		const views = await settledViews(host, taskId);
		assert.equal(views.detailOutput, FINAL_ANSWER);
		assert.equal(views.answers, 1);
		assert.match(views.cardOutput ?? "", new RegExp(FINAL_ANSWER));
		assert.ok(Array.isArray(views.transcriptKinds));
		assert.equal(views.transcriptKinds.filter((kind) => kind === "response").length, 1);
		assert.equal(views.transcriptKinds.at(-1), "response");

		// With its file gone, what it keeps of its prompt and answer still ends with the answer.
		rmSync(file);
		const gone = await settledViews(host, taskId);
		assert.equal(gone.detailOutput, FINAL_ANSWER);
		assert.equal(gone.answers, 1);
		assert.match(gone.cardOutput ?? "", new RegExp(FINAL_ANSWER));
	},
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"a finished child whose failed answer save landed in its session file shows the answer exactly once (#5210)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const manager = await fullFileSession(env.root, true);
		const { host, taskId, result } = await settleInBackground(env, "final-answer-landed", manager);
		assert.ok(result.kind === "failed", JSON.stringify(result));
		const file = manager.getSessionFile();
		assert.ok(file);
		assert.match(readFileSync(file, "utf8"), new RegExp(FINAL_ANSWER));

		const views = await settledViews(host, taskId);
		assert.equal(views.detailOutput, FINAL_ANSWER);
		assert.equal(views.answers, 1);
		assert.ok(Array.isArray(views.transcriptKinds));
		assert.equal(views.transcriptKinds.filter((kind) => kind === "response").length, 1);
	},
	CHILD_LOAD_TIMEOUT_MS,
);

test(
	"a settled child whose final answer failed to save keeps the answer in its card and /tasks while its session is still shutting down (#5210)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const settingsManager = SettingsManager.inMemory();
		const shutdownEntered = Promise.withResolvers<void>();
		const releaseShutdown = Promise.withResolvers<void>();
		settingsManager.flush = async () => {
			shutdownEntered.resolve();
			await releaseShutdown.promise;
		};
		try {
			const { host, taskId, result } = await settleInBackground(
				env,
				"final-answer-held-shutdown",
				await SessionManager.create(new FullOnFinalAnswerStore(), env.root),
				settingsManager,
			);
			assert.ok(result.kind === "failed", JSON.stringify(result));
			await shutdownEntered.promise;
			const view = ownerTaskViewSource(new OwnerTaskStore(host.ownerBinding.supervisor, host.ownerBinding.owner));
			assert.equal(view.followTaskTranscript(taskId)?.historyOnly, false);
			assert.ok(view.followTaskTranscript(taskId)?.session?.chatSession);

			const duringShutdown = await settledViews(host, taskId);
			assert.equal(duringShutdown.detailOutput, FINAL_ANSWER);
			assert.equal(duringShutdown.answers, 1);
			assert.match(duringShutdown.cardOutput ?? "", new RegExp(FINAL_ANSWER));
			assert.ok(Array.isArray(duringShutdown.transcriptKinds));
			assert.equal(
				duringShutdown.transcriptKinds.at(-1),
				"response",
				JSON.stringify(duringShutdown.transcriptKinds),
			);

			releaseShutdown.resolve();
			await vi.waitFor(
				() => {
					assert.equal(view.followTaskTranscript(taskId)?.historyOnly, true);
				},
				{ timeout: CHILD_LOAD_TIMEOUT_MS },
			);

			const afterShutdown = await settledViews(host, taskId);
			assert.equal(afterShutdown.detailOutput, FINAL_ANSWER);
			assert.equal(afterShutdown.answers, 1);
			assert.match(afterShutdown.cardOutput ?? "", new RegExp(FINAL_ANSWER));
			assert.ok(Array.isArray(afterShutdown.transcriptKinds));
			assert.equal(afterShutdown.transcriptKinds.at(-1), "response", JSON.stringify(afterShutdown.transcriptKinds));
		} finally {
			releaseShutdown.resolve();
		}
	},
	CHILD_LOAD_TIMEOUT_MS,
);
