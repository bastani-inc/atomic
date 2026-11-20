import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";

/** A live child loads its real resources; that load is the structural cost of these tests. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
/** Long enough for an ended run's queue drain to start another turn, had anything let it. */
const RESTART_WINDOW_MS = 150;
const CONDITION_WAIT_MS = 20_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "worker agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
	};
}

async function until(predicate: () => boolean, timeoutMs = CONDITION_WAIT_MS): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate() && performance.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), "condition never held");
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The texts of the context the model was given after its last answer: what reached it this turn. */
function newInput(context: { messages: ReadonlyArray<{ role: string; content: unknown }> }): string[] {
	const messages = context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]!.role !== "assistant") start--;
	return messages.slice(start).map((message) => JSON.stringify(message.content));
}

/** Runs a child that calls the blocking tool, then answers whatever reaches it next, recording what that was. */
async function blockedChild(runId: string) {
	const env = await liveChildEnvironment(cleanups);
	const inputs: string[][] = [];
	env.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("block", {}, { id: `${runId}-block` })], { stopReason: "toolUse" }),
		(context) => {
			inputs.push(newInput(context));
			return fauxAssistantMessage("answered the next message");
		},
	]);
	let source: TaskTranscriptSource | undefined;
	const stop = new AbortController();
	let settled = false;
	const run = runSingleInProcess(env.root, agent(), "run until paused", {
		...env.options(runId, {
			signal: stop.signal,
			taskExecution: {
				signal: stop.signal,
				reportActivity() {},
				bindTranscript(bound) {
					// The child's own session binds once it exists.
					if (bound.chatSession !== undefined) source ??= bound;
				},
				onExecution() {},
			},
		}),
	}).finally(() => {
		settled = true;
	});
	await until(() => env.blockStarted() && source !== undefined, LIVE_CHILD_START_WAIT_MS);
	return {
		env,
		run,
		stop,
		inputs,
		settled: () => settled,
		source: () => source!,
		session: () => source!.chatSession as unknown as AgentSession,
	};
}

test(
	"Esc pauses a busy subagent: its queued messages come back, and nothing restarts it until the next message, which continues it (EscPausesNotKills, PromptContinues)",
	async () => {
		const child = await blockedChild("esc-pause-typed");
		try {
			const session = child.session();
			const sessionId = child.source().getSessionId();
			await session.prompt("steer while blocked", { streamingBehavior: "steer" });
			await session.prompt("follow up later", { streamingBehavior: "followUp" });
			assert.deepEqual(child.source().getQueuedMessages?.(), {
				steering: ["steer while blocked"],
				followUp: ["follow up later"],
			});

			const taken = await child.source().pauseTurn!();

			assert.deepEqual(
				{ steering: [...taken.steering], followUp: [...taken.followUp] },
				{ steering: ["steer while blocked"], followUp: ["follow up later"] },
				"the typed messages come back, steering first, for the chat's editor",
			);
			await pause(RESTART_WINDOW_MS);
			assert.equal(child.source().isRunning?.(), false, "the paused subagent runs no turn");
			assert.equal(child.inputs.length, 0, "no queued message restarted it");
			assert.equal(child.settled(), false, "it is paused, not ended");
			assert.deepEqual(child.source().getQueuedMessages?.(), { steering: [], followUp: [] });

			await child.source().resumeTurn!();
			await session.prompt("continue with this", { streamingBehavior: "steer" });
			const result = await child.run;
			assert.equal(result.status, "ok");
			assert.equal(result.finalOutput, "answered the next message");
			assert.equal(child.source().getSessionId(), sessionId, "the same session continued");
			assert.equal(child.inputs.length, 1);
			const delivered = child.inputs[0]!.join("\n");
			assert.match(delivered, /continue with this/, "the next message is what the model receives");
			assert.doesNotMatch(delivered, /steer while blocked|follow up later/, "what came back is not delivered");
		} finally {
			child.stop.abort("user");
			await child.run;
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

/** The user message a request ends with, which the model is asked to answer; undefined when it ends otherwise. */
function askedToAnswer(context: { messages: ReadonlyArray<{ role: string; content: unknown }> }): string | undefined {
	const last = context.messages.findLast((message) => message.role !== "system");
	if (last?.role !== "user") return undefined;
	const content = last.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : "")).join("")
		: "";
}

/**
 * Runs a child that works one step (a tool that runs until `finishStep`), answers `quickReplies` times, then gets a
 * slow reply whose first token has not arrived when Esc ends the request, then answers the reader's next message.
 * `asked` records each user message a request asked the model to answer.
 */
async function childWithSlowReply(runId: string, quickReplies: number) {
	const env = await liveChildEnvironment(cleanups);
	const asked: string[] = [];
	const slowRequested = Promise.withResolvers<void>();
	const record = (context: { messages: ReadonlyArray<{ role: string; content: unknown }> }) => {
		const text = askedToAnswer(context);
		if (text !== undefined) asked.push(text);
	};
	const recorded =
		(reply: ReturnType<typeof fauxAssistantMessage>) =>
		(context: { messages: ReadonlyArray<{ role: string; content: unknown }> }) => {
			record(context);
			return reply;
		};
	env.faux.setResponses([
		recorded(
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "step" }, { id: `${runId}-step` })], {
				stopReason: "toolUse",
			}),
		),
		...Array.from({ length: quickReplies }, () => recorded(fauxAssistantMessage("step reported"))),
		async (context, options) => {
			record(context);
			slowRequested.resolve();
			const signal = options?.signal;
			if (signal !== undefined && !signal.aborted)
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("a reply Esc cut off");
		},
		recorded(fauxAssistantMessage("answered the next message")),
	]);
	let source: TaskTranscriptSource | undefined;
	const stop = new AbortController();
	let settled = false;
	const run = runSingleInProcess(env.root, agent(), "work in steps", {
		...env.options(runId, {
			signal: stop.signal,
			taskExecution: {
				signal: stop.signal,
				reportActivity() {},
				bindTranscript(bound) {
					if (bound.chatSession !== undefined) source ??= bound;
				},
				onExecution() {},
			},
		}),
	}).finally(() => {
		settled = true;
	});
	cleanups.push(() => stop.abort("user"));
	await until(() => env.answers.length === 1 && source !== undefined, LIVE_CHILD_START_WAIT_MS);
	return {
		run,
		asked,
		slowRequested: slowRequested.promise,
		settled: () => settled,
		source: source!,
		session: source!.chatSession as unknown as AgentSession,
		finishStep: () => env.answers[0]!({ content: [{ type: "text", text: "step done" }], details: undefined }),
	};
}

/** After Esc: nothing asks the model anything until the reader's next message, which continues the same run. */
async function assertPausedThenContinued(child: Awaited<ReturnType<typeof childWithSlowReply>>, delivered: string) {
	await pause(RESTART_WINDOW_MS);
	assert.deepEqual(child.asked.slice(1), [delivered], "the model was asked once, and nothing asked it again");
	assert.equal(child.source.isRunning?.(), false, "the paused subagent runs no turn");
	assert.equal(child.settled(), false, "it is paused, not ended");

	await child.source.resumeTurn!();
	// No turn pause outlives the continue, or it would keep the next interrupted delivery from its answer.
	assert.equal(child.session.turnPaused, false, "the continue ends the pause");
	await child.session.prompt("continue with this", { streamingBehavior: "steer" });
	const result = await child.run;
	assert.equal(result.status, "ok");
	assert.equal(result.finalOutput, "answered the next message");
	assert.deepEqual(child.asked.slice(1), [delivered, "continue with this"], "the reader's message continues it");
}

test(
	"Esc pauses a subagent whose steer was just delivered, before its reply began, with a follow-up queued: the follow-up comes back and the steer is not sent again (PauseHonored, NoDoubleDelivery)",
	async () => {
		const child = await childWithSlowReply("esc-pause-delivered-steer", 0);
		// Enter on a steer while a step runs; the step ends and the steer is delivered: its request is out.
		await child.session.prompt("QA", { streamingBehavior: "steer" });
		child.finishStep();
		await child.slowRequested;
		// Alt+Enter on a follow-up, then Esc.
		await child.session.prompt("LT", { streamingBehavior: "followUp" });

		const taken = await child.source.pauseTurn!();

		assert.deepEqual(
			{ steering: [...taken.steering], followUp: [...taken.followUp] },
			{ steering: [], followUp: ["LT"] },
			"the queued follow-up comes back; the steer the model already received does not",
		);
		await assertPausedThenContinued(child, "QA");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"Esc pauses a subagent whose follow-up was just delivered, before its reply began: the follow-up is not sent again (PauseHonored, NoDoubleDelivery)",
	async () => {
		const child = await childWithSlowReply("esc-pause-delivered-follow-up", 1);
		// Alt+Enter while a step runs; the subagent would stop after the step, so it takes the follow-up.
		await child.session.prompt("LT", { streamingBehavior: "followUp" });
		child.finishStep();
		await child.slowRequested;

		const taken = await child.source.pauseTurn!();

		assert.deepEqual([...taken.steering, ...taken.followUp], [], "nothing was still queued");
		await assertPausedThenContinued(child, "LT");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"another agent's message queued when Esc pauses a subagent is held, never handed back, and goes with the next message",
	async () => {
		const child = await blockedChild("esc-pause-agent-queued");
		try {
			const session = child.session();
			await session.sendCustomMessage(
				{ customType: "intercom", content: "note from the parent", display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);

			const taken = await child.source().pauseTurn!();

			assert.deepEqual([...taken.steering, ...taken.followUp], [], "another agent's message is not the reader's");
			await pause(RESTART_WINDOW_MS);
			assert.equal(child.source().isRunning?.(), false, "the held message does not restart the paused turn");
			assert.equal(child.inputs.length, 0);
			assert.equal(child.settled(), false);

			await child.source().resumeTurn!();
			await session.prompt("now carry on", { streamingBehavior: "steer" });
			const result = await child.run;
			assert.equal(result.status, "ok");
			const delivered = child.inputs.flat().join("\n");
			assert.ok(delivered.indexOf("now carry on") >= 0, "the reader's message continues it");
			assert.ok(
				delivered.indexOf("note from the parent") > delivered.indexOf("now carry on"),
				"the held message is delivered, not lost, after the reader's",
			);
		} finally {
			child.stop.abort("user");
			await child.run;
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a message from another agent waits in a subagent Esc paused, as the main chat holds it after Esc, and the reader's next message takes it along",
	async () => {
		const child = await blockedChild("esc-pause-agent-waits");
		try {
			await child.source().pauseTurn!();
			await child
				.session()
				.sendCustomMessage(
					{ customType: "intercom", content: "parent asks", display: true },
					{ triggerTurn: true },
				);
			await pause(RESTART_WINDOW_MS);
			assert.equal(child.source().isRunning?.(), false, "another agent's message does not continue it");
			assert.equal(child.inputs.length, 0);
			assert.equal(child.settled(), false);

			await child.source().resumeTurn!();
			await child.session().prompt("over to you", { streamingBehavior: "steer" });
			const result = await child.run;
			assert.equal(result.status, "ok");
			const delivered = child.inputs.flat().join("\n");
			assert.ok(delivered.indexOf("over to you") >= 0, "the reader's message continues it");
			assert.ok(
				delivered.indexOf("parent asks") > delivered.indexOf("over to you"),
				"the held message follows the reader's",
			);
		} finally {
			child.stop.abort("user");
			await child.run;
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a message that reaches a paused subagent without the reader continuing it waits, as a message sent before Esc but accepted after it waits in the main chat",
	async () => {
		const child = await blockedChild("esc-pause-plain-prompt");
		try {
			await child.source().pauseTurn!();
			// What its own extension or a message accepted after Esc sends: a plain prompt, not the reader's continue.
			await child.session().prompt("sent without the reader", { streamingBehavior: "steer" });
			await pause(RESTART_WINDOW_MS);
			assert.equal(child.source().isRunning?.(), false, "a plain prompt does not continue a paused subagent");
			assert.equal(child.inputs.length, 0);
			assert.deepEqual(child.source().getQueuedMessages?.()?.steering, ["sent without the reader"], "it is listed");

			await child.source().resumeTurn!();
			await child.session().prompt("the reader continues", { streamingBehavior: "steer" });
			const result = await child.run;
			assert.equal(result.status, "ok");
			const delivered = child.inputs.flat().join("\n");
			assert.ok(delivered.indexOf("the reader continues") >= 0);
			assert.ok(delivered.indexOf("sent without the reader") > delivered.indexOf("the reader continues"));
		} finally {
			child.stop.abort("user");
			await child.run;
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a paused subagent is still stopped when asked, and a stop is not undone by a later message",
	async () => {
		const child = await blockedChild("esc-pause-stop");
		try {
			await child.source().pauseTurn!();
			child.stop.abort("user");
			const result = await child.run;
			assert.notEqual(result.status, "ok", "a stop ends the paused child");
			assert.equal(child.inputs.length, 0);
		} finally {
			child.stop.abort("user");
			await child.run;
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
