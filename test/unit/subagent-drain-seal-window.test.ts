import assert from "node:assert/strict";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	SendMessageOptions,
} from "../../packages/coding-agent/src/core/extensions/index.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { untilStarted, waitForCiTurn, waitTool } from "../../packages/coding-agent/test/helpers/detached-tools.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
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
const MAX_MICROTASKS_AFTER_LATE_END = 64;
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

interface Receiver {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly session: AgentSession;
}

interface Sender {
	readonly id: string;
	readonly name: string;
	readonly send: (receiver: Receiver, key: string) => Promise<unknown>;
}

const card = { customType: "intercom_message", content: LATE_TEXT, display: true };

function viaIntercom(options: SendMessageOptions, text = LATE_TEXT): Sender["send"] {
	return ({ pi: atomic, context }, key) => {
		const admitted = admitActiveSessionInbound(context, () =>
			atomic.sendMessage(
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
		send: ({ pi: atomic }) => Promise.resolve(atomic.sendMessage(card, { triggerTurn: true })),
	},
	{
		id: "extension-interrupt",
		name: "an extension's interrupting message",
		send: ({ pi: atomic }) =>
			Promise.resolve(atomic.sendMessage(card, { triggerTurn: true, deliverAs: "interrupt" })),
	},
	{ id: "steer", name: "a steering message", send: ({ session }) => session.steer(LATE_TEXT) },
	{ id: "follow-up", name: "a follow-up message", send: ({ session }) => session.followUp(LATE_TEXT) },
	{ id: "user-message", name: "a user message", send: ({ session }) => session.sendUserMessage(LATE_TEXT) },
	{
		id: "user-message-steer",
		name: "a user message delivered as steering",
		send: ({ session }) => session.sendUserMessage(LATE_TEXT, { deliverAs: "steer" }),
	},
];

const promptSenders: Sender[] = [
	...senders.filter(({ id }) => id === "user-message" || id === "user-message-steer"),
	{ id: "prompt", name: "a prompt", send: ({ session }) => session.prompt(LATE_TEXT) },
	{
		id: "prompt-steer",
		name: "a prompt delivered as steering",
		send: ({ session }) => session.prompt(LATE_TEXT, { streamingBehavior: "steer" }),
	},
];

type Outcome = "answered" | "refused" | "lost";

async function attemptReceiving(
	env: Awaited<ReturnType<typeof liveChildEnvironment>>,
	sender: Sender,
	microtasks: number,
): Promise<{ readonly outcome: Outcome; readonly detail: string }> {
	env.faux.setResponses(Array.from({ length: 3 }, () => answerPendingInput()));
	let atomic: ExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	let sent: Promise<string | undefined> | undefined;
	const key = `late-${microtasks}`;
	const result = await runSingleInProcess(env.root, agent, "the task", {
		...env.options(`ending-${sender.id}-${microtasks}`, {
			resourceLoaderInheritanceSnapshot: {
				extensionFactories: [
					(api: ExtensionAPI) => {
						atomic = api;
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
							sent = (async () => sender.send({ pi: atomic!, context: context!, session }, key))().then(
								() => undefined,
								(error: unknown) => (error instanceof Error ? error.message : String(error)),
							);
						});
					});
				},
				onExecution() {},
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
		let lateSent: Promise<unknown> | undefined;
		let atomic: ExtensionAPI | undefined;
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
							atomic = api;
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
								lateSent = senders[0]!.send({ pi: atomic!, context: context!, session }, "late-esc");
							});
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
			const { source, session } = await within(transcript.promise, "the child never opened its chat");
			await within(lateTurnBlocked.promise, "the child never answered the message that arrived as it ended");
			await within(lateSent!, "the message that arrived as the child ended was not accepted");
			escPressed = true;
			await source.interruptTurn!();
			await sleep(WAITING_OBSERVATION_MS);
			assert.equal(finished, false, "the interrupted child is still running");
			assert.equal(startsAfterEsc, 0, "no turn started after Esc before a message woke the child");

			await within(
				viaIntercom({ triggerTurn: true }, "the next message")(
					{ pi: atomic!, context: context!, session },
					"after-esc",
				),
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

test(
	"a user message sent as the turn that answers a late message settles is answered before the subagent completes (#5318)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses(Array.from({ length: 4 }, () => answerPendingInput()));
		let atomic: ExtensionAPI | undefined;
		let context: ExtensionContext | undefined;
		let settledTurns = 0;
		let lateSent: Promise<unknown> | undefined;
		let settlingSent: Promise<unknown> | undefined;
		const result = await runSingleInProcess(env.root, agent, "the task", {
			...env.options("settling-prompt", {
				resourceLoaderInheritanceSnapshot: {
					extensionFactories: [
						(api: ExtensionAPI) => {
							atomic = api;
							api.on("session_start", (_event, ctx) => {
								context = ctx;
							});
						},
					],
				},
				taskExecution: {
					signal: new AbortController().signal,
					reportActivity() {},
					bindTranscript(source: TaskTranscriptSource) {
						const session = source.chatSession as AgentSession | undefined;
						if (session === undefined) return;
						session.subscribe((event) => {
							if (event.type !== "agent_settled") return;
							settledTurns += 1;
							if (settledTurns === 1)
								onceDrained(session, () => {
									lateSent = senders[0]!.send({ pi: atomic!, context: context!, session }, "late-settling");
								});
							else if (settledTurns === 2) settlingSent = session.sendUserMessage("a prompt sent as it settles");
						});
					},
					onExecution() {},
				},
			}),
		});
		await lateSent;
		const settling = await (settlingSent ?? Promise.reject(new Error("the late message never settled a turn"))).then(
			() => "accepted",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		assert.equal(result.status ?? "ok", "ok");
		assert.equal(settling, "accepted");
		assert.equal(result.finalOutput, "answered: a prompt sent as it settles");
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test.each(promptSenders)(
	"$name sent after a late turn ends is answered or refused throughout settlement (#5318)",
	async (sender) => {
		const env = await liveChildEnvironment(cleanups);
		const outcomes: Outcome[] = [];
		const lost: string[] = [];
		for (let microtasks = 0; microtasks <= MAX_MICROTASKS_AFTER_LATE_END; microtasks++) {
			env.faux.setResponses(Array.from({ length: 5 }, () => answerPendingInput()));
			let atomic: ExtensionAPI | undefined;
			let context: ExtensionContext | undefined;
			let session: AgentSession | undefined;
			let endedTurns = 0;
			let lateSent: Promise<unknown> | undefined;
			let sent: Promise<string | undefined> | undefined;
			const delivery = Promise.withResolvers<void>();
			const key = `late-end-${sender.id}-${microtasks}`;
			const result = await runSingleInProcess(env.root, agent, "the task", {
				...env.options(key, {
					resourceLoaderInheritanceSnapshot: {
						extensionFactories: [
							(api: ExtensionAPI) => {
								atomic = api;
								api.on("session_start", (_event, ctx) => {
									context = ctx;
								});
							},
						],
					},
					taskExecution: {
						signal: new AbortController().signal,
						reportActivity() {},
						bindTranscript(source: TaskTranscriptSource) {
							session ??= source.chatSession as AgentSession | undefined;
							if (session === undefined) return;
							session.subscribe((event) => {
								if (event.type === "agent_end") {
									endedTurns += 1;
									if (endedTurns === 2)
										afterMicrotasks(microtasks, () => {
											sent = sender.send({ pi: atomic!, context: context!, session: session! }, key).then(
												() => undefined,
												(error: unknown) => (error instanceof Error ? error.message : String(error)),
											);
											delivery.resolve();
										});
								}
								if (event.type === "agent_settled" && lateSent === undefined)
									onceDrained(session!, () => {
										lateSent = viaIntercom({ triggerTurn: true }, "first late")(
											{ pi: atomic!, context: context!, session: session! },
											`first-${key}`,
										);
									});
							});
						},
						onExecution() {},
					},
				}),
			});
			await lateSent;
			await within(delivery.promise, "the late turn never ended");
			assert.ok(sent, `the message was sent ${microtasks} microtasks after the late turn ended`);
			const refusal = await sent;
			const detail = `${sender.id} sent ${microtasks} microtasks after the late turn ended: ${refusal ?? "accepted"}; final output ${JSON.stringify(result.finalOutput)}`;
			assert.equal(result.status ?? "ok", "ok", detail);
			if (refusal !== undefined) {
				assert.match(refusal, REFUSED, detail);
				outcomes.push("refused");
			} else if (assistantTexts(session!).some((text) => text.includes(LATE_TEXT))) outcomes.push("answered");
			else {
				outcomes.push("lost");
				lost.push(detail);
			}
		}
		assert.deepEqual(lost, [], "no accepted input went unanswered while the late turn settled");
		assert.ok(outcomes.includes("answered"), "the sweep includes an answered message");
		assert.ok(outcomes.includes("refused"), "the sweep includes a refused message");
	},
	LIVE_CHILD_SWEEP_TIMEOUT_MS,
);

const BATCH_SECOND_TEXT = "the other message in the released batch";
const releaseSenders: Array<
	Sender & { readonly cardType?: string; readonly texts?: readonly string[]; readonly excludeFromContext?: boolean }
> = [
	...senders
		.filter(({ id }) => id === "intercom" || id === "extension" || id === "user-message" || id === "steer")
		.map((sender) => ({
			...sender,
			cardType: sender.id === "intercom" || sender.id === "extension" ? card.customType : undefined,
		})),
	...[false, true].flatMap((batch) =>
		([undefined, "followUp"] as const).map((deliverAs) => ({
			id: `excluded-${batch ? "batch" : "single"}-${deliverAs ?? "default"}`,
			name: `an extension's context-excluded ${batch ? "batch" : "message"} with ${deliverAs ?? "default"} delivery`,
			cardType: card.customType,
			excludeFromContext: true,
			texts: batch ? [LATE_TEXT, BATCH_SECOND_TEXT] : [LATE_TEXT],
			send: ({ pi: atomic }: Receiver) =>
				Promise.resolve(
					batch
						? atomic.sendMessages([card, { ...card, content: BATCH_SECOND_TEXT }], {
								triggerTurn: true,
								excludeFromContext: true,
								deliverAs,
							})
						: atomic.sendMessage(card, { triggerTurn: true, excludeFromContext: true, deliverAs }),
				),
		})),
	),
	{
		id: "subagent-notify",
		name: "a background grandchild's completion notice",
		cardType: "subagent-notify",
		send: ({ pi: atomic }, key) =>
			Promise.resolve(
				atomic.sendMessage(
					{ ...card, customType: "subagent-notify" },
					{ triggerTurn: true, stageAdmissionKey: `subagent:${key}` },
				),
			),
	},
	{
		id: "extension-batch",
		name: "an extension's batch of messages",
		cardType: card.customType,
		texts: [LATE_TEXT, BATCH_SECOND_TEXT],
		send: ({ pi: atomic }, key) =>
			Promise.resolve(
				atomic.sendMessages([card, { ...card, content: BATCH_SECOND_TEXT }], {
					triggerTurn: true,
					stageAdmissionKey: `batch:${key}`,
				}),
			),
	},
];

test.each(releaseSenders)(
	"$name sent while a subagent is being released is saved and respects context delivery on wake (#5318)",
	async (sender) => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const childSession = await SessionManager.create(store, env.root);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "ci-1" }, { id: "ci-1" })], {
				stopReason: "toolUse",
			}),
		]);
		let atomic: ExtensionAPI | undefined;
		let context: ExtensionContext | undefined;
		let session: AgentSession | undefined;
		let outcome = "never sent";
		try {
			const released = await runSingleInProcess(env.root, agent, "watch CI", {
				...env.options(`releasing-${sender.id}`, {
					sessionManager: childSession,
					resumeSession: true,
					releaseWhenWaiting: { afterMs: 0 },
					resourceLoaderInheritanceSnapshot: {
						extensionFactories: [
							(api: ExtensionAPI) => {
								atomic = api;
								api.on("session_start", (_event, ctx) => {
									context = ctx;
								});
							},
						],
					},
					onBeforeRelease: async () => {
						outcome = await outcomeOf(
							sender.send({ pi: atomic!, context: context!, session: session! }, "release-wake"),
						);
					},
					taskExecution: childHooks(new AbortController().signal, (opened) => {
						session ??= opened;
					}),
				}),
			});
			assert.deepEqual(
				released.released?.waitingOn.map((call) => call.toolCallId),
				["ci-1"],
			);
			assert.equal(outcome, "accepted", "a releasing child is not terminal");
			const saved = await SessionManager.open(store, childSession.getSessionId());
			const expectedTexts = sender.texts ?? [LATE_TEXT];
			if (sender.cardType !== undefined) {
				for (const text of expectedTexts)
					assert.equal(
						saved
							.getEntries()
							.filter(
								(entry) =>
									entry.type === "custom_message" &&
									entry.customType === sender.cardType &&
									entry.display &&
									entry.content === text,
							).length,
						1,
						`the message's card is saved once before release: ${text}`,
					);
			} else assert.deepEqual(released.pendingMessages, expectedTexts, "input is kept for the wake");

			const receivedContexts: string[] = [];
			env.faux.setResponses(
				Array.from({ length: 4 }, () => (context, options, state, model) => {
					receivedContexts.push(JSON.stringify(context.messages));
					return answerPendingInput()(context, options, state, model);
				}),
			);
			let wokenSession: AgentSession | undefined;
			const woken = await runSingleInProcess(env.root, agent, "Resume: deploy now.", {
				...env.options(`releasing-${sender.id}`, {
					sessionManager: saved,
					resumeSession: true,
					resumeToolResults: [
						{
							toolCallId: "ci-1",
							toolName: "wait_for_ci",
							result: { content: [{ type: "text", text: "green" }], details: undefined },
							isError: false,
						},
					],
					resumeFollowUps: [...(released.pendingMessages ?? [])],
					resumeTaskLiteral: true,
					taskExecution: childHooks(new AbortController().signal, (opened) => {
						wokenSession ??= opened;
					}),
				}),
			});
			assert.equal(woken.status ?? "ok", "ok");
			assert.ok(receivedContexts.length > 0, "the woken model received context");
			for (const text of expectedTexts) {
				if (sender.excludeFromContext) {
					for (const context of receivedContexts)
						assert.equal(context.includes(text), false, `excluded text never reaches the model: ${text}`);
				} else {
					assert.equal(
						assistantTexts(wokenSession!).join("\n").split(text).length - 1,
						1,
						`the woken child answers the message once: ${text}`,
					);
				}
			}
			if (sender.cardType !== undefined) {
				const afterWake = await SessionManager.open(store, childSession.getSessionId());
				for (const text of expectedTexts)
					assert.equal(
						afterWake
							.getEntries()
							.filter(
								(entry) =>
									entry.type === "custom_message" &&
									entry.customType === sender.cardType &&
									entry.display &&
									entry.content === text,
							).length,
						1,
						`the wake never duplicates the saved card: ${text}`,
					);
			}
		} finally {
			env.answers[0]?.({ content: [{ type: "text", text: "green" }], details: undefined });
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test("a subagent session refuses a prompt, user message, steering or follow-up message once its admission is sealed, never dropping it (#5318)", async () => {
	const ended = new AbortController();
	const harness = await createHarness({
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			depth: 1,
			executionEnded: ended.signal,
		},
	});
	try {
		harness.setResponses([fauxAssistantMessage("finished"), fauxAssistantMessage("never requested")]);
		await harness.session.prompt("the task");
		const late: Array<[string, () => Promise<unknown>]> = [
			["prompt", () => harness.session.prompt("a late prompt")],
			["user message", () => harness.session.sendUserMessage("a late user message")],
			["steering message", () => harness.session.steer("a late steering message")],
			["follow-up message", () => harness.session.followUp("a late follow-up message")],
		];
		for (const [name, send] of late)
			await assert.rejects(
				send(),
				/Subagent execution is terminal and cannot accept messages/,
				`the ${name} is refused`,
			);
		assert.equal(harness.eventsOfType("agent_start").length, 1, "no late input started a turn");
		assert.deepEqual(harness.session.getSteeringMessages(), []);
		assert.deepEqual(harness.session.getFollowUpMessages(), []);
	} finally {
		ended.abort();
		await harness.cleanup();
	}
});

test("a standalone subagent session seals admission after its last deferred user message settles (#5318)", async () => {
	const ended = new AbortController();
	const harness = await createHarness({
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			depth: 1,
			executionEnded: ended.signal,
		},
	});
	let deferred = false;
	harness.session.subscribe((event) => {
		if (event.type !== "agent_settled" || deferred) return;
		deferred = true;
		void harness.session.sendUserMessage("deferred one");
		void harness.session.sendUserMessage("deferred two");
	});
	try {
		harness.setResponses(Array.from({ length: 4 }, () => answerPendingInput()));
		await harness.session.prompt("the task");
		assert.deepEqual(assistantTexts(harness.session), [
			"answered: the task",
			"answered: deferred one",
			"answered: deferred two",
		]);
		await assert.rejects(harness.session.steer("too late"), REFUSED);
	} finally {
		ended.abort();
		await harness.cleanup();
	}
});

test("a steering hook's custom message wakes an interrupted subagent before the hook completes (#5318)", async () => {
	const ended = new AbortController();
	const tool = waitTool({ rejectOnAbort: true });
	const nestedStarted = Promise.withResolvers<void>();
	const nestedSettled = Promise.withResolvers<void>();
	let wakeRequested = false;
	let steering: Promise<unknown> | undefined;
	const harness = await createHarness({
		customTools: [tool.definition],
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			depth: 1,
			executionEnded: ended.signal,
			taskPending: () => true,
		},
		extensionFactories: [
			(atomic) => {
				atomic.on("input", async (event) => {
					if (event.text !== "outer steering") return;
					wakeRequested = true;
					await atomic.sendMessage(
						{ customType: "intercom_message", content: "nested after Esc", display: true },
						{ triggerTurn: true, persistWhenStreaming: true },
					);
					await nestedStarted.promise;
				});
			},
		],
	});
	const session = harness.session;
	session.subscribe((event) => {
		if (!wakeRequested) return;
		if (event.type === "agent_start") nestedStarted.resolve();
		if (event.type === "agent_settled") nestedSettled.resolve();
	});
	try {
		harness.setResponses([waitForCiTurn("initial")]);
		const initial = session.prompt("the task");
		await untilStarted(tool);
		await session.interruptTurn();
		await initial;
		harness.setResponses(Array.from({ length: 3 }, () => answerPendingInput()));
		steering = session.steer("outer steering");
		await within(steering, "the steering hook's message never started its turn");
		await within(nestedSettled.promise, "the nested message's turn never settled");
		assert.ok(assistantTexts(session).some((text) => text.includes("nested after Esc")));
	} finally {
		nestedStarted.resolve();
		harness.session.pauseQueuedMessages();
		ended.abort();
		await steering?.catch(() => undefined);
		await harness.cleanup();
	}
});

function assistantTexts(session: AgentSession): string[] {
	return session.messages
		.filter((message) => message.role === "assistant")
		.map((message) =>
			(message.content as Array<{ type: string; text?: string }>)
				.map((part) => part.text ?? `[${part.type}]`)
				.join(""),
		);
}

function childHooks(stop: AbortSignal, onSession: (session: AgentSession) => void) {
	return {
		signal: stop,
		reportActivity() {},
		bindTranscript(source: TaskTranscriptSource) {
			const session = source.chatSession as AgentSession | undefined;
			if (session !== undefined) onSession(session);
		},
		onExecution() {},
	};
}

const outcomeOf = (work: Promise<unknown>) =>
	work.then(
		() => "accepted",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);

test.each([
	{
		name: "a prompt queued as steering",
		send: (session: AgentSession) => session.prompt("second", { streamingBehavior: "steer" }),
	},
	{
		name: "a user message delivered as steering",
		send: (session: AgentSession) => session.sendUserMessage("second", { deliverAs: "steer" }),
	},
])(
	"$name still in an extension's input hook when a subagent's late turn settles is answered or refused, never dropped (#5318)",
	async ({ send }) => {
		const env = await liveChildEnvironment(cleanups);
		const hookEntered = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();
		const lateStarted = Promise.withResolvers<void>();
		const lateRelease = Promise.withResolvers<void>();
		env.faux.setResponses([
			answerPendingInput(),
			async (context, options, state, model) => {
				lateStarted.resolve();
				await lateRelease.promise;
				return answerPendingInput()(context, options, state, model);
			},
			answerPendingInput(),
			answerPendingInput(),
		]);
		const stop = new AbortController();
		const opened = Promise.withResolvers<AgentSession>();
		let late: Promise<string> | undefined;
		let settledTurns = 0;
		const run = runSingleInProcess(env.root, agent, "the task", {
			...env.options("hook-as-late-turn-settles", {
				signal: stop.signal,
				resourceLoaderInheritanceSnapshot: {
					extensionFactories: [
						(api: ExtensionAPI) => {
							api.on("input", async (event) => {
								if (event.text !== "second") return;
								hookEntered.resolve();
								await hookRelease.promise;
							});
						},
					],
				},
				taskExecution: childHooks(stop.signal, (session) => {
					opened.resolve(session);
					session.subscribe((event) => {
						if (event.type !== "agent_settled" || ++settledTurns !== 1) return;
						onceDrained(session, () => {
							late = outcomeOf(session.sendUserMessage("first late"));
						});
					});
				}),
			}),
		});
		try {
			const session = await within(opened.promise, "the child never opened its chat");
			await within(lateStarted.promise, "the late message never started a turn");
			const second = outcomeOf(send(session));
			await within(hookEntered.promise, "the second message never reached its input hook");
			lateRelease.resolve();
			assert.equal(await within(late!, "the late message never settled"), "accepted");
			hookRelease.resolve();
			const result = await within(run, "the child never completed");
			const outcome = await within(second, "the second message never settled");

			assert.equal(result.status ?? "ok", "ok");
			assert.ok(
				(outcome === "accepted" && (result.finalOutput ?? "").includes("second")) || REFUSED.test(outcome),
				`the second message was ${outcome}; final output ${JSON.stringify(result.finalOutput)}`,
			);
		} finally {
			lateRelease.resolve();
			hookRelease.resolve();
			stop.abort("user");
			await run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a steering message whose input hook sends a user message as the subagent ends is answered after it, without waiting on itself (#5318)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses(Array.from({ length: 4 }, () => answerPendingInput()));
		const stop = new AbortController();
		let session: AgentSession | undefined;
		let steering: Promise<string> | undefined;
		let settledTurns = 0;
		const run = runSingleInProcess(env.root, agent, "the task", {
			...env.options("steer-hook-nested", {
				signal: stop.signal,
				resourceLoaderInheritanceSnapshot: {
					extensionFactories: [
						(api: ExtensionAPI) => {
							api.on("input", async (event) => {
								if (event.text === "outer steering") await session?.sendUserMessage("nested chat");
							});
						},
					],
				},
				taskExecution: childHooks(stop.signal, (bound) => {
					session ??= bound;
					bound.subscribe((event) => {
						if (event.type !== "agent_settled" || ++settledTurns !== 1) return;
						onceDrained(bound, () => {
							steering = outcomeOf(bound.steer("outer steering"));
						});
					});
				}),
			}),
		});
		try {
			const result = await within(run, "the child never completed");
			const outcome = await within(steering!, "the steering message never settled");

			assert.equal(result.status ?? "ok", "ok");
			assert.equal(outcome, "accepted");
			const answered = assistantTexts(session!);
			assert.ok(
				answered.some((text) => text.includes("nested chat")),
				`the nested user message is answered: ${answered.join(" / ")}`,
			);
			assert.match(result.finalOutput ?? "", /outer steering/);
		} finally {
			stop.abort("user");
			await run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test("a subagent session's steering message whose input hook sends a user message is queued, not left waiting on itself (#5318)", async () => {
	const ended = new AbortController();
	let session: AgentSession | undefined;
	const harness = await createHarness({
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			depth: 1,
			executionEnded: ended.signal,
			taskPending: () => true,
		},
		extensionFactories: [
			(atomic) => {
				atomic.on("input", async (event) => {
					if (event.text === "outer steering") await session?.sendUserMessage("nested chat");
				});
			},
		],
	});
	session = harness.session;
	try {
		harness.setResponses(Array.from({ length: 3 }, () => answerPendingInput()));
		const outcome = await within(
			outcomeOf(harness.session.steer("outer steering")),
			"the steering message waited on its own input hook",
		);
		assert.equal(outcome, "accepted");
		assert.deepEqual(harness.session.getSteeringMessages(), ["outer steering"]);
		assert.ok(assistantTexts(harness.session).some((text) => text.includes("nested chat")));
	} finally {
		harness.session.pauseQueuedMessages();
		ended.abort();
		await harness.cleanup();
	}
});

test(
	"every user message an extension sends as a subagent's late turn settles is answered, and the late turn still settles cleanly (#5318)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses(Array.from({ length: 5 }, () => answerPendingInput()));
		const stop = new AbortController();
		let atomic: ExtensionAPI | undefined;
		let session: AgentSession | undefined;
		let late: Promise<string> | undefined;
		let settledTurns = 0;
		const run = runSingleInProcess(env.root, agent, "the task", {
			...env.options("two-settling-prompts", {
				signal: stop.signal,
				resourceLoaderInheritanceSnapshot: {
					extensionFactories: [
						(api: ExtensionAPI) => {
							atomic = api;
						},
					],
				},
				taskExecution: childHooks(stop.signal, (bound) => {
					session ??= bound;
					bound.subscribe((event) => {
						if (event.type !== "agent_settled") return;
						settledTurns += 1;
						if (settledTurns === 1)
							onceDrained(bound, () => {
								late = outcomeOf(bound.sendUserMessage("late"));
							});
						else if (settledTurns === 2) {
							atomic!.sendUserMessage("deferred one");
							atomic!.sendUserMessage("deferred two");
						}
					});
				}),
			}),
		});
		try {
			const result = await within(run, "the child never completed");

			assert.equal(result.status ?? "ok", "ok");
			assert.equal(await within(late!, "the late message never settled"), "accepted");
			const answered = assistantTexts(session!).join(" / ");
			for (const text of ["late", "deferred one", "deferred two"])
				assert.ok(answered.includes(`answered: ${text}`), `${text} is answered: ${answered}`);
		} finally {
			stop.abort("user");
			await run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
