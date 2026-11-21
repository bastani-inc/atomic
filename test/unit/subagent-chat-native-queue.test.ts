import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TranscriptContext } from "@bastani/atomic-ai";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";

/** A live child loads its real resources; that load is the structural cost of these tests. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
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

type ContextMessage = TranscriptContext["messages"][number];

function text(message: ContextMessage): string {
	if (message.role === "system") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** What a request sent after the model's last reply, as `role:text`: what the model received since it last spoke. */
function tail(context: TranscriptContext): string[] {
	const messages = context.messages;
	let last = messages.length - 1;
	while (last >= 0 && messages[last]!.role !== "assistant") last--;
	return messages.slice(last + 1).flatMap((message) => {
		if (message.role === "system") return [];
		return [`${message.role === "toolResult" ? "tool" : message.role}:${text(message)}`];
	});
}

type Reply = ReturnType<typeof fauxAssistantMessage>;

/** Runs a live child whose model answers with `responses`, recording every request it makes. */
function launchChild(
	env: Awaited<ReturnType<typeof liveChildEnvironment>>,
	runId: string,
	responses: ReadonlyArray<Reply | (() => Promise<Reply>)>,
) {
	const requests: TranscriptContext[] = [];
	env.faux.setResponses(
		responses.map((response) => (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return typeof response === "function" ? response() : response;
		}),
	);
	let source: TaskTranscriptSource | undefined;
	const stop = new AbortController();
	const hooks: TaskExecutionHooks = {
		signal: stop.signal,
		reportActivity() {},
		bindTranscript(bound) {
			source = bound;
		},
		onExecution() {},
	};
	let settled = false;
	const result = runSingleInProcess(env.root, agent(), "start the work", {
		...env.options(runId, { signal: stop.signal, taskExecution: hooks }),
	}).finally(() => {
		settled = true;
	});
	cleanups.push(() => stop.abort("user"));
	return { requests, result, stop, settled: () => settled, source: () => source };
}

function answer(env: Awaited<ReturnType<typeof liveChildEnvironment>>, index: number, output: string): void {
	env.answers[index]!({ content: [{ type: "text", text: output }], details: undefined });
}

test(
	"a subagent chat's steers and follow-ups wait in the child's own queue and reach its model as typed, one per turn boundary, steers first",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const child = launchChild(env, "native-queue-order", [
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "one" }, { id: "wait-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "two" }, { id: "wait-2" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("steers handled"),
			fauxAssistantMessage("follow-up handled"),
		]);
		await until(() => env.answers.length === 1, LIVE_CHILD_START_WAIT_MS);
		const source = child.source()!;
		const updates: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];
		cleanups.push(
			source.subscribe!((event: AgentSessionEvent) => {
				if (event.type === "queue_update") updates.push({ steering: event.steering, followUp: event.followUp });
			}),
		);

		const queuedOnly = { delivered: true, startedTurn: false };
		assert.deepEqual(await source.queueMessage!("steer alpha", "steer"), queuedOnly);
		assert.deepEqual(await source.queueMessage!("steer beta", "steer"), queuedOnly);
		assert.deepEqual(await source.queueMessage!("follow gamma", "followUp"), queuedOnly);

		const queued = { steering: ["steer alpha", "steer beta"], followUp: ["follow gamma"] };
		assert.deepEqual(source.getQueuedMessages!(), queued, "the chat reads them as the session's own queue");
		assert.deepEqual(updates.at(-1), queued, "a queue_update lists them for the chat's queued rows");
		assert.equal(child.requests.length, 1, "nothing reaches the model while the tool runs");

		answer(env, 0, "round one");
		await until(() => env.answers.length === 2);
		answer(env, 1, "round two");
		const result = await child.result;
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "follow-up handled");
		assert.deepEqual(
			child.requests.slice(1).map(tail),
			[["tool:round one", "user:steer alpha"], ["tool:round two", "user:steer beta"], ["user:follow gamma"]],
			"each message arrives raw at its own boundary: steers after the tool results, the follow-up once the agent would stop",
		);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"clearing a running subagent's queue gives its typed messages back in order, none of them reaches its model, and another agent's message stays",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const child = launchChild(env, "native-queue-clear", [
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "one" }, { id: "wait-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished without them"),
		]);
		await until(() => env.answers.length === 1, LIVE_CHILD_START_WAIT_MS);
		const source = child.source()!;
		await source.queueMessage!("first steer", "steer");
		// Another agent's Intercom message arrives as Intercom delivers it: a saved message that starts a turn.
		await (source.chatSession as AgentSession).sendCustomMessage(
			{ customType: "intercom_message", content: "a peer's note", display: true },
			{ triggerTurn: true, persistWhenStreaming: true },
		);
		await source.queueMessage!("a follow-up", "followUp");
		await source.queueMessage!("second steer", "steer");

		assert.deepEqual(await source.clearQueue!(), {
			steering: ["first steer", "second steer"],
			followUp: ["a follow-up"],
		});
		assert.deepEqual(source.getQueuedMessages!(), { steering: [], followUp: [] });

		answer(env, 0, "round one");
		const result = await child.result;
		assert.equal(result.status, "ok");
		assert.deepEqual(child.requests.slice(1).map(tail), [["tool:round one", "user:a peer's note"]]);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a subagent stopped with messages typed into its chat still queued keeps them, steers first, for its resume",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const child = launchChild(env, "native-queue-stopped", [
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-1" })], { stopReason: "toolUse" }),
		]);
		await until(() => env.blockStarted(), LIVE_CHILD_START_WAIT_MS);
		const source = child.source()!;
		await source.queueMessage!("a later follow-up", "followUp");
		await source.queueMessage!("a steer", "steer");
		// A run-control pause or quit stops the child's run this way.
		child.stop.abort("pause");
		const result = await child.result;
		assert.equal(result.status, "interrupted");
		assert.deepEqual(result.pendingMessages, ["a steer", "a later follow-up"]);
		assert.equal(child.requests.length, 1, "neither reached the model");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test.each(["as its run settles", "just after its run settled"] as const)(
	"a message typed into a subagent's chat %s is answered before the subagent ends, or given back: never lost",
	async (when) => {
		const env = await liveChildEnvironment(cleanups);
		const firstAnswer = Promise.withResolvers<void>();
		const child = launchChild(env, `native-queue-settle-${when === "as its run settles" ? "during" : "after"}`, [
			() => firstAnswer.promise.then(() => fauxAssistantMessage("first answer")),
			fauxAssistantMessage("answered the late message"),
		]);
		await until(() => child.requests.length === 1, LIVE_CHILD_START_WAIT_MS);
		const source = child.source()!;
		const sent = Promise.withResolvers<Awaited<ReturnType<NonNullable<TaskTranscriptSource["queueMessage"]>>>>();
		const unsubscribe = source.subscribe!((event: AgentSessionEvent) => {
			if (event.type !== "agent_settled") return;
			unsubscribe();
			const send = () => source.queueMessage!("one more thing", "steer").then(sent.resolve, sent.reject);
			if (when === "as its run settles") void send();
			else setTimeout(send, 0);
		});
		cleanups.push(unsubscribe);
		firstAnswer.resolve();
		const delivery = await sent.promise;
		const result = await child.result;
		assert.equal(result.status, "ok");
		const answered = child.requests.some((request) => tail(request).at(-1) === "user:one more thing");
		if (delivery.delivered) {
			assert.ok(answered, "an accepted message reaches the model before the subagent ends");
			assert.equal(result.finalOutput, "answered the late message");
		} else {
			assert.equal(answered, false, "a refused message never reaches the model");
			assert.equal(delivery.reason, "ended", "the subagent had ended: its task view resumes it with the message");
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test.each(["steer", "followUp"] as const)(
	"a subagent whose turn was interrupted takes a %s typed into its chat as the first message of its next turn",
	async (lane) => {
		const env = await liveChildEnvironment(cleanups);
		const child = launchChild(env, `native-queue-interrupted-${lane}`, [
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("continued as asked"),
		]);
		await until(() => env.blockStarted(), LIVE_CHILD_START_WAIT_MS);
		const source = child.source()!;
		const sessionId = source.getSessionId();
		await source.interruptTurn!();
		// The interrupted turn has wound down completely: the child is idle, waiting for its next message.
		const session = source.chatSession as AgentSession;
		await until(() => !session.isStreaming && session._activePromptCount === 0);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		assert.equal(child.settled(), false, "the interrupted child waits for its next message");

		assert.deepEqual(await source.queueMessage!("carry on with the plan", lane), {
			delivered: true,
			startedTurn: true,
		});
		const result = await child.result;
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "continued as asked");
		assert.equal(source.getSessionId(), sessionId, "the same session continued");
		assert.equal(child.requests.length, 2, "one request answers the message; none continues without it");
		assert.deepEqual(tail(child.requests[1]!).at(-1), "user:carry on with the plan");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a subagent whose turn fails before it starts the steer typed into its chat still reads that steer and its follow-up, and finishes",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const child = launchChild(env, "native-queue-failed-turn", [
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "one" }, { id: "wait-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("steer handled"),
			fauxAssistantMessage("follow-up handled"),
		]);
		await until(() => env.answers.length === 1, LIVE_CHILD_START_WAIT_MS);
		const source = child.source()!;
		await source.queueMessage!("child steer", "steer");
		await source.queueMessage!("child fu", "followUp");
		// The preparation of the turn after the tool fails once, as a cancelled compaction before that request fails it.
		const agent = (source.chatSession as AgentSession).agent;
		const prepare = agent.prepareNextTurnWithContext;
		let failed = false;
		agent.prepareNextTurnWithContext = async (context, signal) => {
			if (!failed) {
				failed = true;
				throw new Error("compaction cancelled before the next request");
			}
			return prepare?.(context, signal);
		};

		answer(env, 0, "round one");
		const result = await child.result;

		assert.ok(failed);
		assert.equal(result.status, "ok", result.error);
		assert.equal(result.finalOutput, "follow-up handled");
		assert.deepEqual(
			child.requests
				.slice(1)
				.flatMap(tail)
				.filter((line) => line.startsWith("user:")),
			["user:child steer", "user:child fu"],
			"both reach the model, in order, once",
		);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a subagent's chat names the file its session is kept in, for a host that loses its engine to read",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const child = launchChild(env, "native-queue-session-file", [
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "one" }, { id: "wait-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await until(() => env.answers.length === 1, LIVE_CHILD_START_WAIT_MS);
		const source = child.source()!;
		const file = source.getSessionFile?.();
		assert.ok(file !== undefined, "the subagent's transcript names its session file");
		const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as { type?: string; id?: string };
		assert.equal(header.type, "session");
		assert.equal(header.id, source.getSessionId(), "the file is the subagent's own session");
		answer(env, 0, "round one");
		assert.equal((await child.result).status, "ok");
	},
	LIVE_CHILD_TIMEOUT_MS,
);
