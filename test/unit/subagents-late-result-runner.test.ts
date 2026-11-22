import assert from "node:assert/strict";
import type { DetachedToolResult, SessionEntry } from "@bastani/atomic";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SESSION_HISTORY_PAGE_ENTRIES } from "../../packages/coding-agent/src/core/storage/session/types.js";
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
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.ts";
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

for (const compacted of [false, true])
	test(
		`a late result for a call that reused an earlier call's id reaches the child after the earlier call's late result did${compacted ? ", across a compaction" : ""} (#3274)`,
		async () => {
			const env = await liveChildEnvironment(cleanups);
			const store = new MemorySessionStore();
			const childSession = await SessionManager.create(store, env.root);
			const sessionId = childSession.getSessionId();
			// A provider numbering each response's calls from 0 gives both background calls one id.
			const waitCall = (run: string) =>
				fauxAssistantMessage([fauxToolCall("wait_for_ci", { run }, { id: "ci-1" })], { stopReason: "toolUse" });
			const run = async (task: string, extra: Partial<RunSyncOptions>) =>
				runSingleInProcess(env.root, agent, task, {
					...env.options("reused-late", {
						sessionManager: await SessionManager.open(store, sessionId),
						resumeSession: true,
						releaseWhenWaiting: { afterMs: 0 },
						...extra,
					}),
				});
			env.faux.setResponses([waitCall("7")]);
			assert.ok((await run("watch CI", {})).released, "released waiting on its first call");
			// Told the call still runs, it finishes its turn; the call's late result then wakes it.
			env.faux.setResponses([fauxAssistantMessage("Waiting.")]);
			await run("", { resumeToolResults: [result("ci-1", SUBAGENT_STILL_RUNNING_RESULT)], skipTaskPrompt: true });
			env.faux.setResponses([fauxAssistantMessage("Run 7 done.")]);
			const first = await run("", {
				resumeLateToolResults: [result("ci-1", "FIRST-RUN-OUTPUT")],
				skipTaskPrompt: true,
			});
			assert.equal(first.status, "ok");
			// It starts a second background call, which its provider gives the same id, and is told it still runs.
			const transcript = await SessionManager.open(store, sessionId);
			if (compacted)
				await transcript.appendCompaction("summary", null, 100, {
					strategy: "verbatim-lines",
					promptVersion: 7,
					parameters: { query: "" },
					stats: {
						linesBefore: 3,
						linesDeleted: 3,
						linesKept: 0,
						rangeCount: 1,
						tokensBefore: 100,
						tokensAfter: 10,
						percentReduction: 90,
					},
					form: "cleared",
				});
			await transcript.appendMessage({ role: "user", content: "now run 8", timestamp: Date.now() });
			await transcript.appendMessage(waitCall("8"));
			await transcript.appendMessage({
				role: "toolResult",
				toolCallId: "ci-1",
				toolName: "wait_for_ci",
				content: [{ type: "text", text: SUBAGENT_STILL_RUNNING_RESULT }],
				isError: false,
				timestamp: Date.now(),
			});
			await transcript.appendMessage(fauxAssistantMessage("Waiting on run 8."));
			const requests: Context["messages"][] = [];
			env.faux.setResponses([
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("Run 8 done.");
				},
			]);
			const saved: string[] = [];

			const woken = await run("", {
				resumeLateToolResults: [result("ci-1", "SECOND-RUN-OUTPUT")],
				skipTaskPrompt: true,
				taskExecution: taskExecution(new AbortController().signal, {
					toolResultsSaved: (ids) => void saved.push(...ids),
				}),
			});

			assert.equal(woken.status, "ok");
			assert.equal(requests.length, 1, "the second call's result starts a turn");
			assert.equal(count(requests[0] ?? [], "SECOND-RUN-OUTPUT"), 1);
			assert.deepEqual(saved, ["ci-1"]);
		},
		LIVE_CHILD_TIMEOUT_MS,
	);

test(
	"a woken child whose restore found its late result's call reads none of its history back again to save the notice",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const writer = await SessionManager.create(store, env.root);
		await writer.appendMessage({ role: "user", content: "watch CI", timestamp: 1 });
		const callEntry = await writer.appendMessage(
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		);
		await writer.appendMessage({
			role: "toolResult",
			toolCallId: "ci-1",
			toolName: "wait_for_ci",
			content: [{ type: "text", text: SUBAGENT_STILL_RUNNING_RESULT }],
			isError: false,
			timestamp: 2,
		});
		// More turns since the call than a page of history holds, then a compaction: a reopened session holds only what
		// follows it, so reading back to the call reads pages of the stored history.
		for (let turn = 0; turn < SESSION_HISTORY_PAGE_ENTRIES * 2; turn++)
			await writer.appendMessage({ role: "user", content: `turn ${turn}`, timestamp: 3 });
		await writer.appendCompaction("summary", null, 100, {
			strategy: "verbatim-lines",
			promptVersion: 7,
			parameters: { query: "" },
			stats: {
				linesBefore: 3,
				linesDeleted: 3,
				linesKept: 0,
				rangeCount: 1,
				tokensBefore: 100,
				tokensAfter: 10,
				percentReduction: 90,
			},
			form: "cleared",
		});
		await writer.appendMessage(fauxAssistantMessage("Waiting."));
		const sessionId = writer.getSessionId();
		const reopened = await SessionManager.open(store, sessionId, env.root, { history: "tail" });
		assert.equal(reopened.hasFullHistory(), false, "the reopened session holds only its window");
		// The run opens its own copy of the session: count the pages any copy reads.
		let pages = 0;
		const readHistory = SessionManager.prototype.readHistory;
		const spy = vi.spyOn(SessionManager.prototype, "readHistory").mockImplementation(function (
			this: SessionManager,
			options,
		) {
			const read = readHistory.call(this, options);
			return (async function* () {
				for await (const page of read) {
					pages++;
					yield page;
				}
			})();
		});
		cleanups.push(() => spy.mockRestore());
		env.faux.setResponses([fauxAssistantMessage("Run 7 done.")]);
		const late = result("ci-1", "RUN-7-OUTPUT");
		const calls = new Map([["ci-1", callEntry]]);

		const woken = await runSingleInProcess(env.root, agent, "", {
			...env.options("late-call-known", {
				sessionManager: reopened,
				resumeSession: true,
				resumeLateToolResults: [late],
				resumeLateToolResultCalls: calls,
				skipTaskPrompt: true,
			}),
		});

		assert.equal(woken.status, "ok");
		assert.equal(pages, 0, "no page of its history was read back");
		const notices = (await SessionManager.open(store, sessionId))
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === SUBAGENT_LATE_TOOL_RESULT_TYPE);
		assert.equal(notices.length, 1);
		const [notice] = notices;
		assert.ok(notice?.type === "custom_message");
		assert.equal(notice.stageAdmissionKey, lateToolResultNoticeKey([late], calls), "admitted as its call's notice");
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
