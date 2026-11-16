import assert from "node:assert/strict";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	SendMessageOptions,
} from "../../packages/coding-agent/src/core/extensions/index.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { admitActiveSessionInbound } from "../../packages/intercom/active-session-admission.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE_CHILD_SWEEP_TIMEOUT_MS = 180_000;
const LIVE_CHILD_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 20_000;
const WAITING_OBSERVATION_MS = 300;
const MAX_MICROTASKS_AFTER_SETTLED = 200;
const LATE_TEXT = "a message arriving as the attempt ends";
const REFUSED = /Subagent execution is terminal and cannot accept messages|Session is closed|SessionClosed/;

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

function afterMicrotasks(count: number, action: () => void): void {
	if (count === 0) action();
	else queueMicrotask(() => afterMicrotasks(count - 1, action));
}

interface Sender {
	readonly id: string;
	readonly name: string;
	readonly send: (pi: ExtensionAPI, context: ExtensionContext, key: string) => Promise<void>;
}

const card = { customType: "intercom_message", content: LATE_TEXT, display: true };

function viaIntercom(options: SendMessageOptions, text = LATE_TEXT): Sender["send"] {
	return (pi, context, key) => {
		const admitted = admitActiveSessionInbound(context, () =>
			pi.sendMessage(
				{ ...card, content: text },
				{ ...options, stageAdmissionKey: `intercom:${key}`, persistWhenStreaming: true },
			),
		);
		return admitted === false ? Promise.reject(new Error("not a subagent")) : admitted;
	};
}

const senders: Sender[] = [
	{ id: "intercom", name: "an Intercom message", send: viaIntercom({ triggerTurn: true }) },
	{
		id: "intercom-interrupt",
		name: "an Intercom interrupt",
		send: viaIntercom({ triggerTurn: true, deliverAs: "interrupt" }),
	},
	{
		id: "extension",
		name: "an extension's message",
		send: (pi) => Promise.resolve(pi.sendMessage(card, { triggerTurn: true })),
	},
	{
		id: "extension-interrupt",
		name: "an extension's interrupting message",
		send: (pi) => Promise.resolve(pi.sendMessage(card, { triggerTurn: true, deliverAs: "interrupt" })),
	},
];

type Outcome = "answered" | "refused" | "lost";

async function attemptReceiving(
	env: Awaited<ReturnType<typeof liveChildEnvironment>>,
	sender: Sender,
	microtasks: number,
): Promise<{ readonly outcome: Outcome; readonly detail: string }> {
	env.faux.setResponses(Array.from({ length: 3 }, () => answerPendingInput()));
	let pi: ExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	let sent: Promise<string | undefined> | undefined;
	const key = `late-${microtasks}`;
	const result = await runSingleInProcess(env.root, agent, "the task", {
		...env.options(`ending-${sender.id}-${microtasks}`, {
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
				signal: new AbortController().signal,
				reportActivity() {},
				bindTranscript(bound: TaskTranscriptSource) {
					const session = bound.chatSession as AgentSession | undefined;
					if (session === undefined) return;
					session.subscribe((event) => {
						if (event.type !== "agent_settled" || sent !== undefined) return;
						afterMicrotasks(microtasks, () => {
							sent = (async () => sender.send(pi!, context!, key))().then(
								() => undefined,
								(error: unknown) => (error instanceof Error ? error.message : String(error)),
							);
						});
					});
				},
				onExecution() {},
				yieldTaskWait() {},
				isParentObserving: () => false,
			},
		}),
	});
	const refusal = await sent;
	const detail = `sent ${microtasks} microtasks after the task settled: ${refusal ?? "accepted"}; final output ${JSON.stringify(result.finalOutput)}`;
	assert.equal(result.status ?? "ok", "ok", detail);
	if (refusal !== undefined) {
		assert.match(refusal, REFUSED, detail);
		return { outcome: "refused", detail };
	}
	return { outcome: (result.finalOutput ?? "").includes(LATE_TEXT) ? "answered" : "lost", detail };
}

test.each(senders)(
	"$name that reaches a subagent at any point as its attempt ends is answered or refused, never lost (#5318)",
	async (sender) => {
		const env = await liveChildEnvironment(cleanups);
		const outcomes: Array<{ readonly outcome: Outcome; readonly detail: string }> = [];
		for (let microtasks = 0; microtasks <= MAX_MICROTASKS_AFTER_SETTLED; microtasks++) {
			const received = await attemptReceiving(env, sender, microtasks);
			outcomes.push(received);
			if (received.outcome === "refused") break;
		}
		assert.deepEqual(
			outcomes.filter(({ outcome }) => outcome === "lost").map(({ detail }) => detail),
			[],
			"no message the child accepted went unanswered",
		);
		assert.equal(outcomes.at(-1)?.outcome, "refused", "the sweep reached the end of the attempt");
		assert.ok(
			outcomes.some(({ outcome }) => outcome === "answered"),
			"a message accepted before the end was answered",
		);
	},
	LIVE_CHILD_SWEEP_TIMEOUT_MS,
);

function within<T>(work: Promise<T>, failure: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(failure)), STEP_TIMEOUT_MS);
		work.finally(() => clearTimeout(timer)).then(resolve, reject);
	});
}

function onceDrained(session: AgentSession, action: () => void): void {
	if (session._activePromptCount === 0 && !session.isStreaming) action();
	else queueMicrotask(() => onceDrained(session, action));
}

test(
	"a message a subagent answers as its attempt ends is a turn Esc interrupts like any other, leaving the child waiting for the next message (#5318)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			answerPendingInput(),
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-late" })], { stopReason: "toolUse" }),
			answerPendingInput(),
			answerPendingInput(),
		]);
		const stop = new AbortController();
		const transcript = Promise.withResolvers<{ source: TaskTranscriptSource; session: AgentSession }>();
		const lateTurnBlocked = Promise.withResolvers<void>();
		let lateSent: Promise<void> | undefined;
		let pi: ExtensionAPI | undefined;
		let context: ExtensionContext | undefined;
		let escPressed = false;
		let startsAfterEsc = 0;
		let finished = false;
		const run = runSingleInProcess(env.root, agent, "the task", {
			...env.options("late-esc", {
				signal: stop.signal,
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
							if (event.type === "tool_execution_start" && event.toolName === "block") lateTurnBlocked.resolve();
							if (event.type !== "agent_settled" || lateSent !== undefined) return;
							onceDrained(session, () => {
								lateSent = senders[0]!.send(pi!, context!, "late-esc");
							});
						});
						transcript.resolve({ source, session });
					},
					onExecution() {},
					yieldTaskWait() {},
					isParentObserving: () => false,
				},
			}),
		});
		void run.finally(() => {
			finished = true;
		});
		try {
			const { source } = await within(transcript.promise, "the child never opened its chat");
			await within(lateTurnBlocked.promise, "the child never answered the message that arrived as it ended");
			await within(lateSent!, "the message that arrived as the child ended was not accepted");
			escPressed = true;
			await source.interruptTurn!();
			await sleep(WAITING_OBSERVATION_MS);
			assert.equal(finished, false, "the interrupted child is still running");
			assert.equal(startsAfterEsc, 0, "no turn started after Esc before a message woke the child");

			await within(
				viaIntercom({ triggerTurn: true }, "the next message")(pi!, context!, "after-esc"),
				"the waiting child never accepted the next message",
			);
			const result = await within(run, "the woken child never completed");

			assert.equal(result.status ?? "ok", "ok");
			assert.equal(result.finalOutput, "answered: the next message");
			assert.equal(env.faux.getPendingResponseCount(), 1, "only the spare response is left");
		} finally {
			stop.abort("user");
			await run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
