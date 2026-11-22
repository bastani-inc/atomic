import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { IntercomClient } from "../../intercom/broker/client.js";
import { registerContactSupervisorTool } from "../../intercom/contact-supervisor-tool.js";
import { createIncomingMessageSender, type IncomingMessageSender } from "../../intercom/incoming-message-delivery.js";
import { registerIntercomTool } from "../../intercom/intercom-tool.js";
import { admittedIntercomMessageId } from "../../intercom/lifecycle.js";
import { routeIncomingReply } from "../../intercom/reply-routing.js";
import { ReplyTracker } from "../../intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../intercom/types.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionFactory } from "../src/core/extensions/types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import type { TaskResult } from "../src/core/tasks/contracts.js";
import { deriveSessionActivity } from "../src/extensions/herdr/activity.js";
import { createHerdrExtension } from "../src/extensions/herdr/index.js";
import { arg, FAKE_HERDR_CHILD_TIMEOUT_MS, FAKE_HERDR_WAIT_MS, fakeHerdr } from "./helpers/herdr.js";
import { createHarnessWithExtensions } from "./test-harness.js";

test("independent subagents keep Herdr working while the parent is settled or awaiting approval", () => {
	for (const openPromptCount of [0, 1]) {
		assert.deepEqual(
			deriveSessionActivity({
				agentRunning: false,
				tasksRunning: true,
				openPromptCount,
			}),
			{ state: "working", reason: "executing" },
		);
	}
});

test("Herdr observes overlapping owner tasks and reattaches without losing running subagents", async () => {
	const fake = await fakeHerdr();
	const runtime = createExtensionRuntime();

	const session = SessionManager.inMemory();
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: session.getSessionId() },
		authorizeLaunch() {},
	});
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true, timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const runner = new ExtensionRunner([extension], runtime, fake.dir, session, {} as never);
	runner.bindTaskHost(() => host);
	runner.setUIContext({ ...noOpUIContext }, "tui");
	let finishFirst!: (result: TaskResult) => void;
	let finishSecond!: (result: TaskResult) => void;
	try {
		await runner.emit({ type: "session_start" });
		await fake.waitFor(1);
		const first = await host.startAgentTask({ kind: "agent", agent: "first", task: "test" }, "first", () => ({
			result: new Promise<TaskResult>((resolve) => {
				finishFirst = resolve;
			}),
			cleanup: Promise.resolve({ kind: "reaped" }),
		}));
		assert.equal(first.ok, true);
		assert.equal(arg((await fake.waitFor(2))[1].args, "--state"), "working");
		const second = await host.startAgentTask({ kind: "agent", agent: "second", task: "test" }, "second", () => ({
			result: new Promise<TaskResult>((resolve) => {
				finishSecond = resolve;
			}),
			cleanup: Promise.resolve({ kind: "reaped" }),
		}));
		assert.equal(second.ok, true);
		finishFirst({ kind: "failed", code: "test", message: "test" });
		if (first.ok) await host.waitForTask(first.value.taskId);
		await runner.emit({ type: "agent_settled" });
		await runner.emit({ type: "session_shutdown", reason: "reload" });
		const beforeReload = (await fake.calls()).filter((call) => call.phase === "end");
		assert.equal(
			beforeReload.some((call) => call.args[1] === "release-agent"),
			false,
		);
		await runner.emit({ type: "session_start" });
		const reloadCalls = await fake.waitFor(beforeReload.length + 1);
		assert.equal(reloadCalls[beforeReload.length].args[1], "report-agent");
		assert.equal(arg(reloadCalls[beforeReload.length].args, "--state"), "working");
		for (const call of reloadCalls.slice(1).filter((call) => call.args[1] === "report-agent")) {
			assert.equal(arg(call.args, "--state"), "working", "no false idle while the second task is running");
		}
		finishSecond({ kind: "cancelled", cause: "user" });
		if (second.ok) await host.waitForTask(second.value.taskId);
		await vi.waitFor(
			async () => {
				const calls = (await fake.calls()).filter((call) => call.phase === "end");
				assert.ok(calls.length > reloadCalls.length);
				assert.equal(arg(calls.at(-1)!.args, "--state"), "idle");
			},
			{ timeout: FAKE_HERDR_WAIT_MS },
		);
	} finally {
		finishFirst?.({ kind: "cancelled", cause: "shutdown" });
		finishSecond?.({ kind: "cancelled", cause: "shutdown" });
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await host.close("session-close");
		await fake.dispose();
	}
});

test.each(["need_decision", "interview_request"] as const)(
	"supervisor-only contact_supervisor %s round trip emits no user approval prompt and retains Herdr working",
	async (reason) => {
		const fake = await fakeHerdr();
		const waiters = new ReplyWaiterRegistry();
		const replies = new ReplyTracker();
		const delivered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<TaskResult>();
		const begin = Promise.withResolvers<void>();
		const cancellation = new AbortController();
		const prompts: string[] = [];
		const observePrompts: ExtensionFactory = (atomic) => {
			atomic.on("ui_prompt_start", () => {
				prompts.push("start");
			});
			atomic.on("ui_prompt_end", () => {
				prompts.push("end");
			});
		};
		const presence = {
			cwd: fake.dir,
			model: "test",
			pid: process.pid,
			startedAt: 1,
			lastActivity: 1,
			status: "thinking" as const,
		};
		const parent: SessionInfo = { ...presence, id: "parent", name: "supervisor" };
		const child: SessionInfo = { ...presence, id: "child", name: "worker" };
		let deliver!: IncomingMessageSender;
		// Only the broker transport is in-memory. Tool formatting, custom-message
		// admission, reply tracking/correlation, owner activity and reporting are real.
		const childClient = {
			sessionId: child.id,
			supervisorSessionId: parent.id,
			async sendToSupervisor(to: string, outgoing: Parameters<IntercomClient["sendToSupervisor"]>[1]) {
				assert.equal(to, parent.id);
				const message: Message = {
					id: outgoing.messageId!,
					timestamp: Date.now(),
					expectsReply: outgoing.expectsReply,
					content: { text: outgoing.text },
				};
				replies.recordIncomingMessage(child, message);
				await deliver({ from: child, message, channel: "supervisor", bodyText: message.content.text }, "trigger");
				delivered.resolve();
				return { id: message.id, delivered: true };
			},
		} as IntercomClient;
		const parentClient = {
			sessionId: parent.id,
			async send(to: string, outgoing: Parameters<IntercomClient["send"]>[1]) {
				assert.equal(to, child.id);
				const message: Message = {
					id: outgoing.messageId!,
					timestamp: Date.now(),
					replyTo: outgoing.replyTo,
					content: { text: outgoing.text },
				};
				return { id: message.id, delivered: routeIncomingReply(waiters.pending(), parent, message) };
			},
		} as IntercomClient;
		const supervisor = await createHarnessWithExtensions({
			responses: ["Considering the worker's question."],
			extensionFactories: [
				createHerdrExtension({ env: fake.env, enabled: () => true, timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS }),
				observePrompts,
				(atomic) => {
					deliver = createIncomingMessageSender({
						pi: atomic,
						currentGeneration: () => 1,
						canDeliver: () => true,
						queueTurnContext: (context) => replies.queueTurnContext(context),
					});
					atomic.on("agent_start", () => replies.beginTurn());
					// Mirror the Intercom lifecycle: a reply context binds when its message enters the model.
					atomic.on("message_start", (event, ctx) => {
						const id = admittedIntercomMessageId(event.message, ctx);
						if (id !== undefined) replies.admitTurnMessage(id);
					});
					atomic.on("agent_end", () => replies.endTurn());
					registerIntercomTool(atomic, {
						ensureConnected: async () => parentClient,
						syncPresenceIdentity() {},
						homeGroup: () => "default",
						setJoinedGroups() {},
						clearJoinedGroups() {},
						confirmSend: true,
						replyTracker: replies,
					});
				},
			],
		});
		const worker = await createHarnessWithExtensions({
			extensionFactories: [
				observePrompts,
				(atomic) =>
					registerContactSupervisorTool(atomic, {
						childOrchestratorMetadata: {
							orchestratorTarget: parent.id,
							runId: "supervisor-only",
							agent: "worker",
							index: "0",
						},
						ensureConnected: async () => childClient,
						syncPresenceIdentity() {},
						resolveSessionTarget: async () => parent.id,
						beginReplyWait: (from, replyTo, signal) => waiters.begin(from, replyTo, signal),
					}),
			],
		});
		let request: ReturnType<NonNullable<ReturnType<typeof worker.session.getToolDefinition>>["execute"]> | undefined;
		try {
			// Keep UI available: the absence of prompts must not rely on headless mode.
			await supervisor.session.bindExtensions({ mode: "tui", uiContext: { ...noOpUIContext } });
			await worker.session.bindExtensions({ mode: "tui", uiContext: { ...noOpUIContext } });
			await fake.waitFor(1);
			const host = supervisor.session.getAgentTaskHost();
			const contact = worker.session.getToolDefinition("contact_supervisor")!;
			const started = await host.startAgentTask(
				{ kind: "agent", agent: "worker", task: "Ask the supervisor" },
				"worker",
				() => {
					request = begin.promise.then(() =>
						contact.execute(
							"request",
							{
								reason,
								message: "Which implementation should I use?",
								...(reason === "interview_request"
									? {
											interview: {
												questions: [{ id: "choice", type: "text", question: "Which implementation?" }],
											},
										}
									: {}),
							},
							cancellation.signal,
							undefined,
							worker.session.extensionRunner.createContext(),
						),
					);
					return { result: request.then(() => finish.promise), cleanup: Promise.resolve({ kind: "reaped" }) };
				},
			);
			assert.ok(started.ok);
			// Establish active owner work before beginning the coordination round trip.
			await vi.waitFor(
				async () => {
					const calls = (await fake.calls()).filter((call) => call.phase === "end");
					assert.equal(arg(calls.at(-1)!.args, "--state"), "working");
				},
				{ timeout: FAKE_HERDR_WAIT_MS },
			);
			// The supervisor's turn on the question settles in its own time: the test waits for that, not for a second.
			const settled = Promise.withResolvers<void>();
			const unsubscribeSettled = supervisor.session.subscribe((event) => {
				if (event.type === "agent_settled") settled.resolve();
			});
			begin.resolve();
			await delivered.promise;
			assert.ok(request);
			assert.equal(waiters.pending().length, 1, "the child is waiting for its supervisor, not the user");
			await settled.promise;
			unsubscribeSettled();
			assert.equal(supervisor.eventsOfType("agent_settled").length, 1);
			const incoming = supervisor.session.messages.find(
				(message) => message.role === "custom" && message.customType === "intercom_message",
			);
			assert.ok(incoming, "the supervisor actually receives the question in its conversation");
			assert.match(String(incoming.content), /Which implementation/);
			await supervisor.session.extensionRunner.flushUIPromptNotifications(1_000);
			await worker.session.extensionRunner.flushUIPromptNotifications(1_000);
			assert.deepEqual(prompts, []);
			assert.equal(
				arg((await fake.waitFor(2)).at(-1)!.args, "--state"),
				"working",
				JSON.stringify(await fake.calls()),
			);

			const structuredReply = { responses: [{ id: "choice", value: "Use the existing implementation." }] };
			const answer =
				reason === "interview_request" ? JSON.stringify(structuredReply) : "Use the existing implementation.";
			const reply = supervisor.session.extensionRunner
				.getAllRegisteredTools()
				.find((tool) => tool.definition.name === "intercom")!.definition;
			const sent = await reply.execute(
				"reply",
				{ action: "reply", message: answer },
				undefined,
				undefined,
				supervisor.session.extensionRunner.createContext(),
			);
			assert.equal(sent.isError, false);
			const result = await request;
			assert.equal(result.isError, false);
			assert.match(JSON.stringify(result.content), /Use the existing implementation/);
			if (reason === "interview_request") assert.deepEqual(result.details, { structuredReply });
			assert.equal(waiters.pending().length, 0);
			assert.equal(replies.listPending().length, 0);
			await supervisor.session.extensionRunner.flushUIPromptNotifications(1_000);
			await worker.session.extensionRunner.flushUIPromptNotifications(1_000);
			assert.deepEqual(prompts, [], "a supervisor answer must not open a user approval prompt either");
			const watched = host.watchOwnerTasks();
			assert.ok(watched.ok);
			assert.equal(
				watched.value.snapshot.tasks.find((task) => task.ref.taskId === started.value.taskId)?.execution.kind,
				"running",
				"the answered child retains its owner task",
			);
			watched.value.dispose();
			assert.equal(arg((await fake.waitFor(2)).at(-1)!.args, "--state"), "working");
			finish.resolve({ kind: "cancelled", cause: "user" });
			await host.waitForTask(started.value.taskId);
			await vi.waitFor(
				async () => {
					const calls = (await fake.calls()).filter((call) => call.phase === "end");
					assert.equal(arg(calls.at(-1)!.args, "--state"), "idle");
				},
				{ timeout: FAKE_HERDR_WAIT_MS },
			);
			await supervisor.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			const reports = (await fake.calls()).filter((call) => call.phase === "end" && call.args[1] === "report-agent");
			assert.ok(reports.length > 2);
			assert.equal(arg(reports.at(-1)!.args, "--state"), "idle", "only owner task settlement makes Herdr idle");
			assert.ok(
				reports.slice(1, -1).every((call) => arg(call.args, "--state") === "working"),
				JSON.stringify(reports),
			);
			assert.doesNotMatch(JSON.stringify(reports), /Waiting for approval/);
		} finally {
			cancellation.abort();
			finish.resolve({ kind: "cancelled", cause: "shutdown" });
			begin.resolve();
			await request;
			await supervisor.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await supervisor.session.closeSessionTasks();
			supervisor.cleanup();
			worker.cleanup();
			await fake.dispose();
		}
	},
);
