import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterAll, beforeAll, test, vi } from "vitest";
import type {
	ExtensionContext,
	ExtensionFactory,
	OrchestrationContext,
	ToolDefinition,
} from "../../packages/coding-agent/src/core/extensions/index.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { ModelSingleResponse } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../packages/intercom/foreground-detach-handoff.js";
import type { Attachment } from "../../packages/intercom/types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runAgentTask, taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { createDispatchCounter } from "../helpers/intercom-interrupt-probe.js";
import { toolContext } from "../helpers/tool-context.js";

const root = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "intercom-active-child-")));
brokerFixture.overrideAgentDir();
// Intercom's spawn module snapshots paths at import time. No ambient broker is used.
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { createHarness, getMessageText } = await import("../../packages/coding-agent/test/suite/harness.js");

beforeAll(async () => {
	const extensionDir = join(root, "packages/intercom");
	brokerFixture.trackBroker(
		spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
			stdio: "ignore",
		}),
	);
	await vi.waitFor(
		async () => {
			brokerFixture.assertRunning();
			const connected = await new Promise<boolean>((resolveConnected) => {
				const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
				socket.once("connect", () => {
					socket.destroy();
					resolveConnected(true);
				});
				socket.once("error", () => resolveConnected(false));
			});
			assert.ok(connected);
		},
		{ timeout: 10_000, interval: 20 },
	);
});
afterAll(() => brokerFixture.cleanup());

interface EndpointOptions {
	ui?: boolean;
	orchestrationContext?: OrchestrationContext;
	extensionFactory?: ExtensionFactory;
}

async function endpoint(name: string, child = false, tools: AgentTool[] = [], options: EndpointOptions = {}) {
	const ended = new AbortController();
	let context!: ExtensionContext;
	const harness = await createHarness({
		tools,
		orchestrationContext: options.orchestrationContext,
		fauxProvider: { provider: `faux-${name}` },
		// UI-capable parents must not spend the scripted conversation replies on summaries.
		settings: { sessionSummary: { enabled: false } },
		...(child
			? {
					subagentPolicy: {
						managementActions: "restricted" as const,
						fanoutAuthorized: false,
						inheritProjectContext: false,
						inheritSkills: false,
						depth: 1,
						executionEnded: ended.signal,
					},
				}
			: {}),
		extensionFactories: [
			(pi) => {
				intercomHeavy(pi);
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
			...(options.extensionFactory ? [options.extensionFactory] : []),
		],
	});
	harness.session.setSessionName(name);
	await harness.session.bindExtensions(
		options.ui ? { mode: "tui", uiContext: { ...noOpUIContext } } : { mode: "print" },
	);
	const tool = harness.session.extensionRunner
		.getAllRegisteredTools()
		.find((item) => item.definition.name === "intercom")?.definition;
	assert.ok(tool);
	let calls = 0;
	const execute = async (
		params: {
			action: string;
			to?: string;
			message?: string;
			replyTo?: string;
			group?: string;
			attachments?: Attachment[];
		},
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown> & { isError?: boolean }> =>
		(tool as ToolDefinition).execute(`${name}-${++calls}`, params, signal, undefined, toolContext(context));
	const status = await execute({ action: "status" });
	assert.notEqual(status.isError, true, JSON.stringify(status));
	const id = getMessageText(status).match(/Session ID: ([^\n]+)/)?.[1];
	assert.ok(id);
	return {
		...harness,
		ended,
		execute,
		id,
		async close() {
			ended.abort();
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		},
	};
}

// Amended contract: public asks are priority input that cancels the child's
// active cancellable tool; correlation and execution identity remain exact.
test("public same-group asks interrupt a busy child and correlate concurrent replies without changing its execution identity", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let activeSignal: AbortSignal | undefined;
	const working: AgentTool = {
		name: "working",
		label: "Working",
		description: "Hold child work",
		parameters: Type.Object({}),
		async execute(_id, _args, signal) {
			activeSignal = signal;
			started.resolve();
			await release.promise;
			return { content: [{ type: "text", text: "finished work" }], details: {} };
		},
	};
	const child = await endpoint("active-child", true, [working]);
	const peer = await endpoint("peer");
	const attachments: Attachment[] = [
		{ type: "snippet", name: "same", content: "  first\n", language: "ts" },
		{ type: "snippet", name: "same", content: "  first\n", language: "ts" },
	];
	const contexts: string[][] = [];
	let replyNumber = 0;
	const respond: FauxResponseFactory = async (context) => {
		contexts.push(context.messages.map(getMessageText));
		const reply = await child.execute({ action: "reply", message: `answer-${++replyNumber}` });
		assert.notEqual(reply.isError, true, JSON.stringify(reply));
		return fauxAssistantMessage(`handled-${replyNumber}`);
	};
	const dispatches = createDispatchCounter([
		() => fauxAssistantMessage(fauxToolCall("working", {}), { stopReason: "toolUse" }),
		respond,
		respond,
	]);
	child.setResponses(dispatches.steps(6));
	const execution = child.session.prompt("original child task");
	const asks = new AbortController();
	try {
		await started.promise;
		const first = peer.execute(
			{ action: "ask", to: child.id, message: "  FIRST-QUESTION\n", attachments },
			asks.signal,
		);
		await vi.waitFor(() =>
			assert.equal(
				child.session.messages.filter((message) => getMessageText(message).includes("FIRST-QUESTION")).length,
				1,
			),
		);
		const second = peer.execute({ action: "ask", to: child.id, message: "SECOND-QUESTION" }, asks.signal);
		await vi.waitFor(() =>
			assert.equal(
				child.session.messages.filter((message) => getMessageText(message).includes("SECOND-QUESTION")).length,
				1,
			),
		);
		await vi.waitFor(() => assert.equal(activeSignal?.aborted, true, "the priority ask cancels the active tool"));
		release.resolve();
		const [firstReply, secondReply] = await Promise.all([first, second]);
		await execution;
		assert.notEqual(firstReply.isError, true, JSON.stringify(firstReply));
		assert.notEqual(secondReply.isError, true, JSON.stringify(secondReply));
		assert.match(getMessageText(firstReply), /answer-1/);
		assert.match(getMessageText(secondReply), /answer-2/);
		assert.equal(dispatches.counts.valid, 3);
		assert.equal(
			child.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "original child task").length,
			1,
		);
		assert.equal(replyNumber, 2);
		assert.ok(contexts[0]!.some((text) => text.includes("  FIRST-QUESTION\n")));
		const received = child.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "intercom_message");
		assert.equal(received.length, 2);
		const details =
			received[0]?.type === "custom_message"
				? (received[0].details as { message: { content: { attachments: Attachment[] } } })
				: undefined;
		assert.deepEqual(details?.message.content.attachments, attachments);
		const pending = await child.execute({ action: "pending" });
		assert.equal(getMessageText(pending), "No unresolved inbound asks.");
	} finally {
		asks.abort();
		release.resolve();
		await execution;
		await Promise.all([peer.close(), child.close()]);
	}
});

test("public Intercom keeps exact-ID group restrictions and terminal-child ask rejection", async () => {
	const child = await endpoint("group-child", true);
	const peer = await endpoint("group-peer");
	try {
		assert.notEqual((await child.execute({ action: "join", group: "isolated-child" })).isError, true);
		assert.notEqual((await child.execute({ action: "leave", group: "default" })).isError, true);
		const forbidden = await peer.execute({ action: "send", to: child.id, message: "CROSS-GROUP-MUST-NOT-ARRIVE" });
		assert.equal(forbidden.isError, true);
		assert.match(getMessageText(forbidden), /different intercom group|not found/i);
		assert.equal(
			child.session.messages.some((message) => getMessageText(message).includes("CROSS-GROUP-MUST-NOT-ARRIVE")),
			false,
		);
		assert.notEqual((await peer.execute({ action: "join", group: "isolated-child" })).isError, true);
		child.setResponses([fauxAssistantMessage("finished")]);
		await child.session.prompt("original task");
		child.ended.abort();
		const terminal = await peer.execute({ action: "ask", to: child.id, message: "DO-NOT-REOPEN" });
		assert.equal(terminal.isError, true);
		assert.match(getMessageText(terminal), /terminal.*cannot reply/);
		const late = await peer.execute({ action: "send", to: child.id, message: "DO-NOT-REOPEN" });
		assert.notEqual(late.isError, true, "send transport semantics are not model acceptance");
		await new Promise<void>((resolveDone) => setImmediate(resolveDone));
		assert.equal(child.eventsOfType("agent_start").length, 1);
		assert.equal(
			child.session.messages.some((message) => getMessageText(message).includes("DO-NOT-REOPEN")),
			false,
		);
	} finally {
		await Promise.all([peer.close(), child.close()]);
	}
});

test("a child sealed at task settlement refuses a racing ask with a child-specific exact-thread error", async () => {
	const child = await endpoint("closing-child", true);
	const peer = await endpoint("closing-peer");
	try {
		child.setResponses([fauxAssistantMessage("finished")]);
		await child.session.prompt("original task");
		assert.equal(child.ended.signal.aborted, false, "probe the gap before the runner publishes terminal capability");
		const result = await peer.execute({ action: "ask", to: child.id, message: "racing ask" });
		assert.equal(result.isError, true);
		assert.match(getMessageText(result), /Subagent.*cannot accept messages/);
		assert.doesNotMatch(getMessageText(result), /workflow stage/);
		assert.equal(child.eventsOfType("agent_start").length, 1);
	} finally {
		await Promise.all([peer.close(), child.close()]);
	}
});

// Manual 477d: a peer's parent-addressed send was queued until the child settled.
// Use the public broker handler, native parent event writer, and real subagent
// foreground observation. A direct incoming-message sender misses the idle queue.
async function observingParent(
	name: string,
	mode: "foreground" | "wait" | "background" = "foreground",
	options: EndpointOptions = {},
	runChild: typeof runSync = runSync,
) {
	const started = Promise.withResolvers<void>();
	const observing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let host!: AgentTaskHost;
	let intercomEvents: Parameters<typeof runSync>[4]["intercomEvents"];
	let signal: AbortSignal | undefined;
	let observation: ModelSingleResponse | undefined;
	let starts = 0;
	const tool: AgentTool = {
		name: "subagent",
		label: "Subagent",
		description: "Observe a real foreground subagent",
		parameters: Type.Object({}),
		async execute() {
			const launched = await runAgentTask({
				host,
				cwd: parent.tempDir,
				agents: [
					{
						name: "held-worker",
						description: "Held child",
						source: "project",
						filePath: "held-worker.md",
						systemPrompt: "Intercom orchestration channel:\nCoordinate.",
						systemPromptMode: "replace",
						inheritProjectContext: false,
						inheritSkills: false,
					},
				],
				agent: "held-worker",
				task: "original child task",
				wait: mode === "foreground" ? { kind: "foreground", budgetMs: 60_000 } : { kind: "background" },
				options: { runId: name, intercomSessionName: `${name}-child`, allowIntercomDetach: true, intercomEvents },
				runtime: {
					runSync: (cwd, agents, agent, task, runOptions) => {
						starts++;
						signal = runOptions.signal;
						const execution = runChild(cwd, agents, agent, task, {
							...runOptions,
							testSession: { promptGate: release.promise, output: "child completed" },
						});
						started.resolve();
						if (mode !== "wait") observing.resolve();
						return execution;
					},
				},
			});
			if (mode === "wait") {
				assert.equal(launched.kind, "admitted");
				if (launched.kind !== "admitted") throw new Error("Child admission failed");
				const pending = host.waitForTask(launched.observation.taskId, 60_000);
				observing.resolve();
				const waited = await pending;
				assert.ok(waited.ok);
				observation = { kind: "admitted", observation: waited.value };
			} else observation = launched;
			return taskToolResult(observation, host);
		},
	};
	const parent = await endpoint(name, false, [tool], {
		...options,
		extensionFactory: (pi) => {
			intercomEvents = pi.events;
			return options.extensionFactory?.(pi);
		},
	});
	host = parent.session.getAgentTaskHost();
	return {
		...parent,
		host,
		started: started.promise,
		observing: observing.promise,
		release: release.resolve,
		get observation() {
			return observation;
		},
		get signal() {
			return signal;
		},
		get starts() {
			return starts;
		},
	};
}

function incomingCards(parent: Awaited<ReturnType<typeof endpoint>>) {
	return parent.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "intercom_message");
}

function ownerSnapshot(parent: Awaited<ReturnType<typeof observingParent>>) {
	const watched = parent.host.watchOwnerTasks();
	assert.ok(watched.ok);
	try {
		return watched.value.snapshot;
	} finally {
		watched.value.dispose();
	}
}

for (const scope of ["interactive", "headless", "workflow-stage"] as const) {
	for (const mode of ["foreground", "wait"] as const) {
		for (const action of ["send", "ask"] as const) {
			test(`public parent ${action} releases ${scope} ${mode} subagent observation before its held child settles`, async () => {
				const boundary = scope === "workflow-stage" ? new WorkflowStageAdmissionBoundary() : undefined;
				const parent = await observingParent(`parent-${scope}-${mode}-${action}`, mode, {
					ui: scope === "interactive",
					...(boundary
						? {
								orchestrationContext: {
									kind: "workflow-stage" as const,
									workflowRunId: "detach-run",
									workflowStageId: `${mode}-${action}`,
									workflowStageName: "waiting-parent",
									constraints: { disableWorkflowTool: true },
									messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
								},
							}
						: {}),
				});
				const peer = await endpoint(`peer-${scope}-${mode}-${action}`);
				const contexts: string[][] = [];
				let askId: string | undefined;
				const respond: FauxResponseFactory = async (context) => {
					contexts.push(context.messages.map(getMessageText));
					if (action === "ask") {
						const card = incomingCards(parent)[0];
						assert.ok(card?.type === "custom_message");
						askId = (card.details as { message: { id: string } }).message.id;
						assert.match(getMessageText(await parent.execute({ action: "pending" })), new RegExp(askId));
						const reply = await parent.execute({ action: "reply", replyTo: askId, message: "PARENT-ANSWER" });
						assert.notEqual(reply.isError, true, JSON.stringify(reply));
					}
					return fauxAssistantMessage("handled parent input");
				};
				const dispatches = createDispatchCounter([
					() => fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" }),
					respond,
				]);
				parent.setResponses(dispatches.steps(5));
				const turn = parent.session.prompt("Launch a foreground child");
				const asks = new AbortController();
				try {
					await parent.started;
					await parent.observing;
					const delivered = peer.execute({ action, to: parent.id, message: "PARENT-ONLY" }, asks.signal);
					if (action === "send") assert.notEqual((await delivered).isError, true);
					await vi.waitFor(() => assert.ok(parent.observation, "parent must yield before the held child settles"));
					const observation = parent.observation;
					assert.ok(observation?.kind === "admitted" && observation.observation.kind === "yielded");
					assert.equal(observation.observation.reason, "intercom-coordination");
					await turn;
					assert.equal(parent.session.agent.state.errorMessage, undefined);
					assert.equal(dispatches.counts.valid, 2);
					const toolResult = parent.session.messages.find(
						(message) => message.role === "toolResult" && message.toolName === "subagent",
					);
					assert.ok(toolResult?.role === "toolResult");
					assert.deepEqual(
						(toolResult.details as { taskResponse: ModelSingleResponse }).taskResponse,
						observation,
					);
					const result = await delivered;
					assert.notEqual(result.isError, true, JSON.stringify(result));
					if (action === "ask") {
						assert.match(getMessageText(result), /PARENT-ANSWER/);
						assert.ok(
							parent.sessionManager
								.getEntries()
								.some(
									(entry) =>
										entry.type === "custom" &&
										entry.customType === "intercom_sent" &&
										(entry.data as { message: { replyTo?: string } }).message.replyTo === askId,
								),
						);
						assert.equal(
							getMessageText(await parent.execute({ action: "pending" })),
							"No unresolved inbound asks.",
						);
					}
					assert.equal(parent.signal?.aborted, false);
					assert.equal(parent.starts, 1);
					assert.equal(incomingCards(parent).length, 1);
					assert.ok(
						contexts[0]?.some((text) => text.includes("PARENT-ONLY")),
						"input must precede the parent's next model request",
					);
					const watched = parent.host.watchOwnerTasks();
					assert.ok(watched.ok);
					try {
						assert.equal(watched.value.snapshot.tasks[0].ref.taskId, observation.observation.taskId);
						assert.equal(watched.value.snapshot.tasks[0].execution.kind, "running");
						assert.equal(watched.value.snapshot.state, "open");
					} finally {
						watched.value.dispose();
					}
				} finally {
					asks.abort();
					parent.session.pauseQueuedMessages();
					parent.release();
					await turn;
					await parent.host.close("session-close");
					await boundary?.close();
					await Promise.all([peer.close(), parent.close()]);
				}
			});
		}
	}
}

test("public foreground child send receives first refusal before the parent's protected event writer", async () => {
	const releaseHook = Promise.withResolvers<void>();
	const parent = await observingParent("handshake-parent", "foreground", {
		ui: true,
		extensionFactory: (pi) => {
			pi.on("tool_execution_start", () => releaseHook.promise);
		},
	});
	// Represent the held runSync child's registered Intercom identity at the real broker.
	const child = await endpoint("handshake-parent-child", true);
	parent.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("handled child input"),
	]);
	const turn = parent.session.prompt("original parent task");
	try {
		await parent.started;
		await parent.observing;
		const original = ownerSnapshot(parent).tasks[0].ref;
		const sent = await child.execute({ action: "send", to: parent.id, message: "CHILD-HANDSHAKE" });
		assert.notEqual(sent.isError, true);
		await vi.waitFor(() => assert.ok(parent.observation, "exact child must yield before SDK writer admission"));
		assert.ok(parent.observation?.kind === "admitted" && parent.observation.observation.kind === "yielded");
		assert.equal(parent.observation.observation.reason, "intercom-coordination");
		assert.equal(incomingCards(parent).length, 0, "first refusal must not bypass protected persistence");
		assert.equal(parent.signal?.aborted, false);
		assert.deepEqual(ownerSnapshot(parent).tasks[0].ref, original);
		assert.equal(ownerSnapshot(parent).tasks[0].execution.kind, "running");
		releaseHook.resolve();
		await turn;
		await vi.waitFor(() => assert.equal(incomingCards(parent).length, 1));
		assert.equal(parent.starts, 1);
	} finally {
		releaseHook.resolve();
		parent.release();
		parent.session.pauseQueuedMessages();
		await turn;
		await parent.host.close("session-close");
		await Promise.all([parent.close(), child.close()]);
	}
});

test("public parent input waits for its event writer, then yields only that owner's observation", async () => {
	const hookEntered = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	let hookDone = false;
	const parent = await observingParent("writer-parent", "foreground", {
		ui: true,
		extensionFactory: (pi) => {
			pi.on("tool_execution_start", async () => {
				hookEntered.resolve();
				await releaseHook.promise;
				await pi.sendMessage(
					{ customType: "writer-note", content: "local hook write", display: true },
					{ triggerTurn: false },
				);
				hookDone = true;
			});
		},
	});
	const other = await observingParent("other-owner", "foreground", { ui: true });
	const peer = await endpoint("writer-peer");
	for (const h of [parent, other])
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
	const turn = parent.session.prompt("original parent task");
	const otherTurn = other.session.prompt("unrelated parent task");
	try {
		await Promise.all([parent.started, other.started, hookEntered.promise]);
		const sent = await peer.execute({ action: "send", to: parent.id, message: "WRITER-INPUT" });
		assert.notEqual(sent.isError, true);
		assert.equal(parent.observation, undefined);
		assert.equal(incomingCards(parent).length, 0, "protected input must not overtake the assistant tool-call writer");
		releaseHook.resolve();
		await vi.waitFor(() => assert.ok(parent.observation, "admission must not cycle behind an event-hook write"));
		await turn;
		assert.equal(hookDone, true);
		assert.equal(incomingCards(parent).length, 1);
		assert.equal(other.observation, undefined);
		assert.equal(ownerSnapshot(other).tasks[0].observation.kind, "foreground");
		assert.equal(parent.signal?.aborted, false);
		assert.equal(other.signal?.aborted, false);
		const entries = parent.sessionManager.getEntries();
		const call = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
		const input = entries.findIndex(
			(entry) => entry.type === "custom_message" && entry.customType === "intercom_message",
		);
		assert.ok(call >= 0 && input > call);
	} finally {
		releaseHook.resolve();
		for (const h of [parent, other]) {
			h.session.pauseQueuedMessages();
			h.release();
		}
		await Promise.all([turn, otherTurn]);
		await Promise.all([parent.host.close("session-close"), other.host.close("session-close")]);
		await Promise.all([parent.close(), other.close(), peer.close()]);
	}
});

for (const winner of ["admission", "completion"] as const) {
	test(`public parent input and foreground completion race preserves ${winner} and terminal ordering`, async () => {
		const releaseWriter = Promise.withResolvers<void>();
		const parent = await observingParent(`race-${winner}`, "foreground", {
			ui: true,
			extensionFactory: (pi) => {
				pi.on("tool_execution_start", () => releaseWriter.promise);
			},
		});
		const peer = await endpoint(`race-peer-${winner}`);
		const sdkWrites = vi.spyOn(parent.session, "sendCustomMessage");
		const unsubscribe = parent.session.subscribe((event) => {
			if (
				winner === "admission" &&
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "intercom_message"
			)
				parent.release();
		});
		parent.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled race"),
			fauxAssistantMessage("handled completion"),
		]);
		const turn = parent.session.prompt("original racing task");
		try {
			await parent.started;
			assert.notEqual(
				(await peer.execute({ action: "send", to: parent.id, message: "RACING-INPUT" })).isError,
				true,
			);
			await vi.waitFor(() =>
				assert.ok(
					sdkWrites.mock.calls.some(([message]) => message.customType === "intercom_message"),
					"public inbound must reach the real SDK before releasing either barrier",
				),
			);
			assert.equal(incomingCards(parent).length, 0);
			if (winner === "completion") {
				parent.release();
				await vi.waitFor(() =>
					assert.equal(parent.observation?.kind === "admitted" && parent.observation.observation.kind, "settled"),
				);
			}
			releaseWriter.resolve();
			await turn;
			await vi.waitFor(() => assert.equal(ownerSnapshot(parent).tasks[0].execution.kind, "settled"));
			await vi.waitFor(() =>
				assert.equal(
					parent.sessionManager
						.getEntries()
						.filter((entry) => entry.type === "custom_message" && entry.customType === "task-completion").length,
					1,
				),
			);
			assert.ok(parent.observation?.kind === "admitted");
			assert.equal(parent.observation.observation.kind, winner === "admission" ? "yielded" : "settled");
			if (parent.observation.observation.kind === "yielded")
				assert.equal(parent.observation.observation.reason, "intercom-coordination");
			assert.equal(parent.starts, 1);
			assert.equal(incomingCards(parent).length, 1);
			const cards = parent.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
			assert.ok(
				cards.findIndex((entry) => entry.customType === "intercom_message") <
					cards.findIndex((entry) => entry.customType === "task-completion"),
			);
			assert.equal(ownerSnapshot(parent).tasks[0].ref.taskId, parent.observation.observation.taskId);
		} finally {
			sdkWrites.mockRestore();
			unsubscribe();
			releaseWriter.resolve();
			parent.release();
			parent.session.pauseQueuedMessages();
			await turn;
			await parent.host.close("session-close");
			await Promise.all([parent.close(), peer.close()]);
		}
	});
}

for (const ui of [true, false]) {
	for (const action of ["send", "ask"] as const) {
		test(`public ${action} preserves ${ui ? "interactive idle queue" : "unrelated headless refusal"} when the child is background`, async () => {
			const workStarted = Promise.withResolvers<void>();
			const releaseWork = Promise.withResolvers<void>();
			const inboundProbe = Promise.withResolvers<void>();
			let workSignal: AbortSignal | undefined;
			let busy = true;
			const parent = await observingParent(`background-${ui}-${action}`, "background", {
				ui,
				extensionFactory: (pi) => {
					// Synchronize on the real broker handler's busy-parent probe, not a
					// sleep or a send receipt that could precede recipient processing.
					const off = pi.events.on(INTERCOM_DETACH_REQUEST_EVENT, () => inboundProbe.resolve());
					pi.on("session_shutdown", off);
					pi.registerTool({
						name: "working",
						label: "Working",
						description: "Unrelated parent work",
						parameters: Type.Object({}),
						async execute(_id, _args, signal) {
							workSignal = signal;
							workStarted.resolve();
							await releaseWork.promise;
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					});
				},
			});
			const peer = await endpoint(`background-peer-${ui}-${action}`);
			const receivedWhileBusy: boolean[] = [];
			const unsubscribe = parent.session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === "intercom_message"
				)
					receivedWhileBusy.push(busy);
			});
			const replies: Array<Awaited<ReturnType<typeof parent.execute>>> = [];
			const respond: FauxResponseFactory = async (context) => {
				if (
					action === "ask" &&
					context.messages.some((message) => getMessageText(message).includes("BACKGROUND-INPUT"))
				) {
					replies.push(await parent.execute({ action: "reply", message: "BACKGROUND-ANSWER" }));
				}
				return fauxAssistantMessage("done");
			};
			parent.setResponses([
				fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("working", {}), { stopReason: "toolUse" }),
				respond,
				respond,
			]);
			const turn = parent.session.prompt("background child and unrelated work");
			const asks = new AbortController();
			try {
				await workStarted.promise;
				const result = peer.execute({ action, to: parent.id, message: "BACKGROUND-INPUT" }, asks.signal);
				if (action === "send") assert.notEqual((await result).isError, true);
				if (ui) await inboundProbe.promise;
				if (!ui) {
					if (action === "ask") {
						assert.equal((await result).isError, true);
						assert.match(getMessageText(await result), /busy in non-interactive mode/);
					} else
						await vi.waitFor(() =>
							assert.ok(
								peer.session.messages.some((message) =>
									getMessageText(message).includes("Intercom delivery failed"),
								),
							),
						);
				}
				assert.equal(incomingCards(parent).length, 0);
				assert.equal(parent.signal?.aborted, false);
				assert.equal(workSignal?.aborted, false);
				assert.deepEqual(ownerSnapshot(parent).tasks[0].observation, { kind: "background", reason: "explicit" });
				busy = false;
				releaseWork.resolve();
				await turn;
				if (ui) {
					await vi.waitFor(() => assert.equal(incomingCards(parent).length, 1));
					assert.deepEqual(receivedWhileBusy, [false]);
					if (action === "ask") {
						await vi.waitFor(() => assert.equal(replies.length, 1, JSON.stringify(parent.session.messages)));
						assert.notEqual(replies[0]?.isError, true, JSON.stringify(replies));
						assert.match(getMessageText(await result), /BACKGROUND-ANSWER/);
					}
				} else assert.equal(incomingCards(parent).length, 0);
				assert.equal(ownerSnapshot(parent).tasks[0].execution.kind, "running");
				assert.equal(parent.starts, 1);
			} finally {
				asks.abort();
				unsubscribe();
				releaseWork.resolve();
				parent.release();
				parent.session.pauseQueuedMessages();
				await turn;
				await parent.host.close("session-close");
				await Promise.all([parent.close(), peer.close()]);
			}
		});
	}
}

test("simultaneous public parent send and child priority interrupt preserve the original owned execution", async () => {
	const working = Promise.withResolvers<void>();
	const releaseChild = Promise.withResolvers<void>();
	let activeSignal: AbortSignal | undefined;
	const child = await endpoint("simultaneous-child", true, [
		{
			name: "working",
			label: "Working",
			description: "Hold native child tool after cancellation",
			parameters: Type.Object({}),
			async execute(_id, _args, signal) {
				activeSignal = signal;
				working.resolve();
				await releaseChild.promise;
				return { content: [{ type: "text", text: "child tool finished" }], details: {} };
			},
		},
	]);
	const childContexts: string[][] = [];
	const childDispatches = createDispatchCounter([
		() => fauxAssistantMessage(fauxToolCall("working", {}), { stopReason: "toolUse" }),
		(context) => {
			childContexts.push(context.messages.map(getMessageText));
			return fauxAssistantMessage("child handled interrupt");
		},
	]);
	child.setResponses(childDispatches.steps(5));
	// Native child model/tool execution substitutes only the deterministic child
	// fixture; the parent still uses runAgentTask and its actual owner observation.
	const parent = await observingParent(
		"simultaneous-parent",
		"foreground",
		{ ui: true },
		async (_cwd, _agents, agent, task, options) => {
			options.taskExecution?.bindTranscript?.(child.sessionManager);
			await child.session.prompt(task);
			return {
				agent,
				task,
				status: "ok",
				finalOutput: "child handled interrupt",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			};
		},
	);
	const peer = await endpoint("simultaneous-peer");
	parent.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("parent handled input"),
	]);
	const turn = parent.session.prompt("original parent task");
	try {
		await working.promise;
		const original = ownerSnapshot(parent).tasks[0].ref;
		const sent = await Promise.all([
			peer.execute({ action: "send", to: parent.id, message: "PARENT-ONLY" }),
			peer.execute({ action: "send", to: child.id, message: "CHILD-ONLY" }),
		]);
		assert.ok(sent.every((result) => result.isError !== true));
		await vi.waitFor(() => {
			assert.ok(parent.observation);
			assert.equal(activeSignal?.aborted, true);
		});
		await turn;
		assert.ok(parent.observation?.kind === "admitted" && parent.observation.observation.kind === "yielded");
		assert.equal(parent.observation.observation.reason, "intercom-coordination");
		assert.equal(parent.signal?.aborted, false, "child tool cancellation must not cancel its owner task");
		assert.equal(ownerSnapshot(parent).tasks[0].execution.kind, "running");
		assert.deepEqual(ownerSnapshot(parent).tasks[0].ref, original);
		releaseChild.resolve();
		const settled = await parent.host.waitForTask(original.taskId);
		assert.ok(settled.ok && settled.value.kind === "settled" && settled.value.result.kind === "completed");
		assert.equal(parent.starts, 1);
		assert.equal(childContexts.length, 1);
		assert.equal(incomingCards(parent).length, 1);
		assert.equal(incomingCards(child).length, 1);
		assert.ok(childContexts[0]?.some((text) => text.includes("CHILD-ONLY")));
		assert.equal(
			childContexts[0]?.some((text) => text.includes("PARENT-ONLY")),
			false,
		);
		assert.equal(
			child.session.messages.filter(
				(message) => message.role === "user" && getMessageText(message) === "original child task",
			).length,
			1,
		);
	} finally {
		releaseChild.resolve();
		parent.release();
		parent.session.pauseQueuedMessages();
		await turn;
		await parent.host.close("session-close");
		await Promise.all([child.close(), parent.close(), peer.close()]);
	}
});
