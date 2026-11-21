import assert from "node:assert/strict";
import type { DetachedToolResult, SessionEntry } from "@bastani/atomic";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import {
	lateToolResultNotice,
	lateToolResultNoticeIds,
	lateToolResultNoticeKey,
	SUBAGENT_LATE_TOOL_RESULT_TYPE,
} from "../../packages/subagents/src/runs/foreground/late-tool-result-notice.ts";
import {
	SUBAGENT_RELEASED_WAKE_PROMPT,
	SUBAGENT_STILL_RUNNING_RESULT,
} from "../../packages/subagents/src/runs/foreground/released-children.ts";
import { resumeNoteMessage } from "../../packages/subagents/src/runs/foreground/resume-note.ts";
import { SUBAGENT_RESUME_CONTINUATION_PROMPT } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.ts";
import { SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT } from "../../packages/subagents/src/runs/foreground/subagent-run-control.ts";
import { queuedResumeStart } from "../../packages/subagents/src/runs/foreground/task-execution.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { sleep } from "../helpers/runtime.js";

/** A live child loads its real resources, once per run here; that load is the structural cost of these tests. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
/** Long enough for a restored child to send a request, had anything started its turn. */
const QUIET_WINDOW_MS = 250;

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

function result(toolCallId: string, text: string, isError = false): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text }], details: undefined },
		isError,
	};
}

function textOf(message: Context["messages"][number]): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

type TaskExecution = NonNullable<Parameters<typeof runSingleInProcess>[3]["taskExecution"]>;

/** The hooks a task host gives a run, with the ones a test listens to. */
function taskExecution(
	signal: AbortSignal,
	hooks: Pick<TaskExecution, "toolResultsSaved" | "reportTurnPaused" | "bindTranscript"> = {},
): TaskExecution {
	return { signal, reportActivity() {}, onExecution() {}, ...hooks };
}

/** How often `text` appears across a request's messages. */
function count(request: Context["messages"], text: string): number {
	return request.reduce((total, message) => total + (textOf(message).split(text).length - 1), 0);
}

/** A child whose first call was answered still running by a wake, and that waits on a second call when released. */
async function childWaitingAfterStillRunning(env: Awaited<ReturnType<typeof liveChildEnvironment>>, runId: string) {
	const store = new MemorySessionStore();
	const childSession = await SessionManager.create(store, env.root);
	env.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
	]);
	const first = await runSingleInProcess(env.root, agent, "watch CI", {
		...env.options(runId, { sessionManager: childSession, resumeSession: true, releaseWhenWaiting: { afterMs: 0 } }),
	});
	assert.equal(first.status, "interrupted");
	env.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "8" }, { id: "ci-2" })], { stopReason: "toolUse" }),
	]);
	const second = await runSingleInProcess(env.root, agent, "", {
		...env.options(runId, {
			sessionManager: await SessionManager.open(store, childSession.getSessionId()),
			resumeSession: true,
			releaseWhenWaiting: { afterMs: 0 },
			resumeToolResults: [result("ci-1", SUBAGENT_STILL_RUNNING_RESULT)],
			skipTaskPrompt: true,
		}),
	});
	assert.equal(second.status, "interrupted");
	assert.deepEqual(second.released?.waitingOn, [{ toolCallId: "ci-2", toolName: "wait_for_ci" }]);
	return { store, sessionId: childSession.getSessionId() };
}

test(
	"a woken child continues its turn with its call's result and reads the late results of earlier calls in the same request, after that result",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const { store, sessionId } = await childWaitingAfterStillRunning(env, "late-continued");
		const requests: Context["messages"][] = [];
		env.faux.setResponses([
			(context) => {
				requests.push(context.messages);
				return fauxAssistantMessage("Both are green.");
			},
		]);
		const saved: string[] = [];
		const reportedUnsaved: string[] = [];
		const childSession = await SessionManager.open(store, sessionId);
		// The entries of the session the run writes, as its task's transcript reads them.
		let entries: () => readonly SessionEntry[] = () => [];
		// What the child's session holds of each result when the run reports it saved: the owner lets it go then (#5012).
		const holds = (toolCallId: string) =>
			entries().some(
				(entry) =>
					(entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === toolCallId) ||
					(entry.type === "custom_message" && lateToolResultNoticeIds(entry).includes(toolCallId)),
			);

		const woken = await runSingleInProcess(env.root, agent, "", {
			...env.options("late-continued", {
				sessionManager: childSession,
				resumeSession: true,
				resumeToolResults: [result("ci-2", "lint clean")],
				resumeLateToolResults: [result("ci-1", "tests green"), result("ci-0", "build broke", true)],
				skipTaskPrompt: true,
				taskExecution: taskExecution(new AbortController().signal, {
					bindTranscript: (source) => {
						entries = () => source.getEntries() as readonly SessionEntry[];
					},
					toolResultsSaved: (ids) => {
						saved.push(...ids);
						reportedUnsaved.push(...ids.filter((id) => !holds(id)));
					},
				}),
			}),
		});

		assert.equal(woken.status, "ok");
		assert.equal(requests.length, 1, "one request continues the turn and reads the late results");
		const request = requests[0] ?? [];
		const resultAt = request.findIndex((message) => message.role === "toolResult" && message.toolCallId === "ci-2");
		assert.ok(resultAt > 0 && request[resultAt - 1]?.role === "assistant", "the call's result follows the call");
		assert.equal(count(request, "tests green"), 1);
		assert.equal(count(request, "build broke"), 1);
		const noticeAt = request.findIndex((message) => textOf(message).includes("tests green"));
		assert.ok(noticeAt > resultAt, "the late results come after the call's result");
		assert.ok(saved.includes("ci-1") && saved.includes("ci-0"), "the late results are reported saved");
		assert.deepEqual(
			reportedUnsaved,
			[],
			`each is reported saved only once the child's session holds it: ${JSON.stringify(reportedUnsaved)} ${JSON.stringify(saved)}`,
		);
		const transcript = await SessionManager.open(store, sessionId);
		const userTexts = transcript
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
		assert.equal(userTexts.length, 1, "only the original task is a message from the user");
		assert.equal(
			transcript
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === SUBAGENT_LATE_TOOL_RESULT_TYPE)
				.length,
			1,
			"one notice for both",
		);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a late result and a message held for the child are read together in one request, each once",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const { store, sessionId } = await childWaitingAfterStillRunning(env, "late-with-message");
		// ci-2 was answered when the child last finished its turn; only late results remain.
		env.faux.setResponses([fauxAssistantMessage("Waiting on both.")]);
		const settled = await runSingleInProcess(env.root, agent, "", {
			...env.options("late-with-message", {
				sessionManager: await SessionManager.open(store, sessionId),
				resumeSession: true,
				resumeToolResults: [result("ci-2", SUBAGENT_STILL_RUNNING_RESULT)],
				skipTaskPrompt: true,
			}),
		});
		assert.equal(settled.status, "ok");
		const requests: Context["messages"][] = [];
		env.faux.setResponses([
			(context) => {
				requests.push(context.messages);
				return fauxAssistantMessage("Lint rerun; CI noted.");
			},
		]);

		const woken = await runSingleInProcess(env.root, agent, "Also rerun lint.", {
			...env.options("late-with-message", {
				sessionManager: await SessionManager.open(store, sessionId),
				resumeSession: true,
				resumeTaskLiteral: true,
				resumeLateToolResults: [result("ci-1", "tests green"), result("ci-2", "lint clean")],
			}),
		});

		assert.equal(woken.status, "ok");
		assert.equal(requests.length, 1);
		const request = requests[0] ?? [];
		assert.equal(count(request, "Also rerun lint."), 1);
		assert.equal(count(request, "tests green"), 1);
		assert.equal(count(request, "lint clean"), 1);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a child restored paused with a late result's notice it had not read sends no request until it is continued",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const child = await SessionManager.create(store, env.root);
		await child.appendMessage({ role: "user", content: "watch CI", timestamp: Date.now() });
		await child.appendMessage(fauxAssistantMessage("Done for now."));
		const late = [result("ci-1", "tests green")];
		const notice = lateToolResultNotice(late);
		// Saved as its delivery saves it, a card the model has not read yet, when the user paused the child.
		await child.appendCustomMessageEntry(
			notice.customType,
			notice.content,
			notice.display,
			notice.details,
			true,
			{ delivery: "steer" },
			lateToolResultNoticeKey(late),
		);
		env.faux.setResponses([fauxAssistantMessage("unexpected")]);
		const stop = new AbortController();
		const paused = Promise.withResolvers<void>();

		const restored = runSingleInProcess(env.root, agent, "", {
			...env.options("late-paused", {
				sessionManager: await SessionManager.open(store, child.getSessionId()),
				resumeSession: true,
				resumePaused: true,
				taskExecution: taskExecution(stop.signal, {
					reportTurnPaused: (isPaused) => {
						if (isPaused) paused.resolve();
						return undefined;
					},
				}),
			}),
		});
		// Restored paused; anything its restore started would have sent its request by now.
		await paused.promise;
		await sleep(QUIET_WINDOW_MS);
		const requests = env.faux.state.callCount;
		stop.abort("abort");
		await restored;

		assert.equal(requests, 0, "the unread notice does not run the paused child");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a child resumed with a message reads it and its resume note in one request, and no message from the user carries the note",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const child = await SessionManager.create(store, env.root);
		await child.appendMessage({ role: "user", content: "watch CI", timestamp: Date.now() });
		await child.appendMessage(fauxAssistantMessage("Stopped for now."));
		const requests: Context["messages"][] = [];
		env.faux.setResponses([
			(context) => {
				requests.push(context.messages);
				return fauxAssistantMessage("Wrapped up.");
			},
		]);

		const resumed = await runSingleInProcess(env.root, agent, "then wrap up", {
			...env.options("note-with-message", {
				sessionManager: await SessionManager.open(store, child.getSessionId()),
				resumeSession: true,
				resumeTaskLiteral: true,
				resumeNote: { kind: "resume", text: SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT },
			}),
		});

		assert.equal(resumed.status, "ok");
		assert.equal(requests.length, 1, "one request reads both");
		const request = requests[0] ?? [];
		assert.equal(count(request, "then wrap up"), 1);
		assert.equal(count(request, "Continue where you left off."), 1);
		const users = (await SessionManager.open(store, child.getSessionId()))
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [textOf(entry.message)] : [],
			);
		assert.deepEqual(users, ["watch CI", "then wrap up"], "the note is never a message from the user");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a child whose session holds a resume note no turn read yet is told it once, not again by its next run",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const child = await SessionManager.create(store, env.root);
		await child.appendMessage({ role: "user", content: "watch CI", timestamp: Date.now() });
		await child.appendMessage(fauxAssistantMessage("Working."));
		const note = resumeNoteMessage({ kind: "restart", text: SUBAGENT_RESUME_CONTINUATION_PROMPT });
		// Saved as its delivery saves it, before a restart stopped the run whose turn would have read it.
		await child.appendCustomMessageEntry(note.customType, note.content, true, note.details, true, {
			delivery: "steer",
		});
		const requests: Context["messages"][] = [];
		env.faux.setResponses([
			(context) => {
				requests.push(context.messages);
				return fauxAssistantMessage("Continued.");
			},
		]);

		const restored = await runSingleInProcess(env.root, agent, "", {
			...env.options("note-unread", {
				sessionManager: await SessionManager.open(store, child.getSessionId()),
				resumeSession: true,
				skipTaskPrompt: true,
				resumeNote: { kind: "restart", text: SUBAGENT_RESUME_CONTINUATION_PROMPT },
			}),
		});

		assert.equal(restored.status, "ok");
		assert.equal(requests.length, 1);
		assert.equal(count(requests[0] ?? [], "Atomic restarted while you were working"), 1, "told once");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a woken child stopped while it waited for its run's slot and resumed with a message reads the message as written, and is not told it was woken (#6161)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const child = await SessionManager.create(store, env.root);
		await child.appendMessage({ role: "user", content: "watch CI", timestamp: Date.now() });
		await child.appendMessage(fauxAssistantMessage("Waiting on CI."));
		const requests: Context["messages"][] = [];
		env.faux.setResponses([
			(context) => {
				requests.push(context.messages);
				return fauxAssistantMessage("Checked.");
			},
		]);
		const message = "Check this edge first.\nKeep  both  spaces.";
		// Its wake had nothing else to start its turn, so its note would have; the user's message now does.
		const start = queuedResumeStart(
			"",
			env.options("slot-wake-message", {
				sessionManager: await SessionManager.open(store, child.getSessionId()),
				resumeSession: true,
				skipTaskPrompt: true,
				resumeNote: { kind: "wake", text: SUBAGENT_RELEASED_WAKE_PROMPT },
			}),
			message,
		);

		const resumed = await runSingleInProcess(env.root, agent, start.task, start.options);

		assert.equal(resumed.status, "ok");
		assert.equal(requests.length, 1);
		const request = requests[0] ?? [];
		assert.equal(count(request, message), 1, "the message, as written");
		assert.equal(count(request, SUBAGENT_RELEASED_WAKE_PROMPT), 0, "never told it was woken");
	},
	LIVE_CHILD_TIMEOUT_MS,
);
