import assert from "node:assert/strict";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionAPI, ExtensionContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { admitActiveSessionInbound } from "../../packages/intercom/active-session-admission.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE_CHILD_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 20_000;
const INTERCOM_REPLAY_PLANNING_TIMEOUT_MS = 90_000;
const WAITING_OBSERVATION_MS = 300;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "worker",
	description: "worker agent",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/worker.md",
};

function answerPendingInput(): FauxResponseFactory {
	return (context) => {
		const pending: string[] = [];
		for (let index = context.messages.length - 1; index >= 0; index--) {
			const message = context.messages[index]!;
			if (message.role === "assistant") break;
			if (message.role !== "user") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			pending.unshift(text);
		}
		return fauxAssistantMessage(`answered: ${pending.join(" | ")}`);
	};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function within<T>(work: Promise<T>, failure: string, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(failure)), timeoutMs);
		work.finally(() => clearTimeout(timer)).then(resolve, reject);
	});
}

function assistantTexts(session: AgentSession): string[] {
	return session.messages
		.filter((message) => message.role === "assistant")
		.map((message) =>
			(message.content as Array<{ type: string; text?: string }>)
				.map((part) => part.text ?? `[${part.type}]`)
				.join(""),
		);
}

const wakes = [
	{
		wake: "a chat message",
		text: "chat message after Esc",
		send: (pi: ExtensionAPI, context: ExtensionContext, text: string) => {
			const admitted = admitActiveSessionInbound(context, () =>
				pi.sendMessage(
					{ customType: "intercom_message", content: text, display: true },
					{ triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: "intercom:chat-after-esc" },
				),
			);
			return admitted === false ? Promise.reject(new Error("not a subagent")) : admitted;
		},
	},
	{
		wake: "its own extension's interrupting message",
		text: "background work finished",
		send: (pi: ExtensionAPI, _context: ExtensionContext, text: string) =>
			Promise.resolve(
				pi.sendMessage(
					{ customType: "intercom_message", content: text, display: true },
					{ triggerTurn: true, deliverAs: "interrupt" },
				),
			),
	},
];

test.each(wakes)(
	"a resumed subagent interrupted with Esc while it replays an interrupted delivery waits until $wake starts its next turn, then answers it, its task and its held message (#5318)",
	async ({ text, send }) => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const child = await SessionManager.create(store, env.root);
		env.faux.setResponses([fauxAssistantMessage("Started.")]);
		const first = await runSingleInProcess(env.root, agent, "start", {
			...env.options("esc-replay", { sessionManager: child, resumeSession: true }),
		});
		assert.equal(first.status ?? "ok", "ok");
		await (await SessionManager.open(store, child.getSessionId())).appendCustomMessageEntry(
			"intercom_message",
			"a delivery saved before its owner stopped",
			true,
			{ message: { id: "interrupted-1" } },
			true,
			{ delivery: "steer" },
		);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-1" })], { stopReason: "toolUse" }),
			...Array.from({ length: 4 }, () => answerPendingInput()),
		]);

		const stop = new AbortController();
		const replayBlocked = Promise.withResolvers<void>();
		const transcript = Promise.withResolvers<{ source: TaskTranscriptSource; session: AgentSession }>();
		let pi: ExtensionAPI | undefined;
		let context: ExtensionContext | undefined;
		let startsAfterEsc = 0;
		let escPressed = false;
		let finished = false;
		const run = runSingleInProcess(env.root, agent, "the resumed task", {
			...env.options("esc-replay", {
				signal: stop.signal,
				sessionManager: await SessionManager.open(store, child.getSessionId()),
				resumeSession: true,
				resumeFollowUps: ["held message"],
				resourceLoaderInheritanceSnapshot: {
					extensionFactories: [
						(api: ExtensionAPI) => {
							pi = api;
							api.on("session_start", (_event, ctx) => {
								context = ctx;
							});
						},
					],
				},
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(source: TaskTranscriptSource) {
						const session = source.chatSession as AgentSession | undefined;
						if (session === undefined) return;
						session.subscribe((event) => {
							if (event.type === "agent_start" && escPressed) startsAfterEsc += 1;
							if (event.type === "tool_execution_start" && event.toolName === "block") replayBlocked.resolve();
						});
						transcript.resolve({ source, session });
					},
					onExecution() {},
				},
			}),
		});
		void run.finally(() => {
			finished = true;
		});
		try {
			const { source, session } = await within(transcript.promise, "the resumed child never opened its chat");
			await within(
				replayBlocked.promise,
				"the resumed child never replayed its interrupted delivery",
				INTERCOM_REPLAY_PLANNING_TIMEOUT_MS,
			);
			const pendingBeforeEsc = env.faux.getPendingResponseCount();
			escPressed = true;
			await source.interruptTurn!();
			await sleep(WAITING_OBSERVATION_MS);
			assert.equal(finished, false, "the interrupted child is still running");
			assert.equal(startsAfterEsc, 0, "no turn started after Esc before a message woke the child");
			assert.equal(env.faux.getPendingResponseCount(), pendingBeforeEsc, "no model call was made while it waited");
			assert.equal(session.isStreaming, false);

			await within(send(pi!, context!, text), "the waiting child never accepted the message");
			const result = await within(run, "the woken child never completed");

			assert.equal(result.status ?? "ok", "ok");
			assert.deepEqual(assistantTexts(session).slice(-3), [
				`answered: ${text}`,
				"answered: the resumed task",
				"answered: held message",
			]);
			assert.equal(env.faux.getPendingResponseCount(), 1, "only the spare response is left");
		} finally {
			stop.abort("user");
			await run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
