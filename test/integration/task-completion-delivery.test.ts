import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { closeSessionTasks, getAgentTaskHost } from "../../packages/coding-agent/src/core/agent-session-tasks.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { TaskCompletionOutbox } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { Cleanup, OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	completionNoticeFromDetails,
	TaskCompletionMessage,
} from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

// RFC PR #2884: task settlement is separate from persisted model delivery.
test("completion intent precedes admission and retries a lost acknowledgement with the same identity", async () => {
	const session = SessionManager.inMemory();
	const completed = Promise.withResolvers<TaskResult>();
	let admissions = 0;
	let loseAck = true;
	const outbox = new TaskCompletionOutbox(
		session,
		() => true,
		async (envelope) => {
			admissions++;
			assert.equal(envelope.display, false);
			assert.ok(
				session
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "task-completion-intent"),
			);
			if (loseAck) {
				loseAck = false;
				throw new Error("lost acknowledgement");
			}
		},
	);
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: session.getSessionId() },
		authorizeLaunch() {},
		onTaskSettled: (ref, receipt) => outbox.record(ref.ownerId, receipt),
	});
	const started = await host.startAgentTask(
		{ kind: "agent", agent: "fake", task: " read " },
		"completion" as OperationId,
		() => ({ result: completed.promise, cleanup: completed.promise.then(() => ({ kind: "reaped" as const })) }),
	);
	assert.equal(started.ok, true);
	if (!started.ok) return;
	assert.equal((await host.observeAgentLaunch(started.value.taskId)).ok, true);
	assert.equal(outbox.pending.length, 0);
	completed.resolve({ kind: "failed", code: "fixture", message: "done" });
	await host.waitForTask(started.value.taskId);
	await outbox.flush();
	assert.equal(outbox.pending.length, 1);
	const id = outbox.pending[0]!.completionId;
	await outbox.flush();
	assert.equal(outbox.pending.length, 0);
	assert.equal(admissions, 2);
	assert.ok(
		session
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "task-completion-ack" &&
					JSON.stringify(entry.data).includes(id),
			),
	);
	await host.close("session-close");
});

// PR #2906: restored terminal intents must not wait for another task to settle.
test("restored completion intents begin delivery without a new settlement", async () => {
	const session = SessionManager.inMemory();
	const envelope = {
		completionId: "restored-completion",
		ownerId: "historical-owner",
		taskId: "historical-task",
		terminalSequence: 7,
		result: { kind: "completed" },
		display: false,
	};
	session.appendCustomEntry("task-completion-intent", envelope);
	session.appendCustomEntry("task-completion-intent", { ...envelope, completionId: "already-acked" });
	session.appendCustomEntry("task-completion-ack", { completionId: "already-acked" });
	const release = Promise.withResolvers<void>();
	const admitted: string[] = [];
	const outbox = new TaskCompletionOutbox(
		session,
		() => true,
		async (restored) => {
			admitted.push(restored.completionId);
			assert.deepEqual(restored, envelope);
			await release.promise;
		},
	);
	await vi.waitFor(() => assert.deepEqual(admitted, [envelope.completionId]));
	const concurrentFlush = outbox.flush();
	release.resolve();
	await concurrentFlush;
	assert.deepEqual(outbox.pending, []);
	new TaskCompletionOutbox(
		session,
		() => true,
		async (restored) => {
			admitted.push(restored.completionId);
		},
	);
	await Promise.resolve();
	assert.deepEqual(admitted, [envelope.completionId]);
});

test("restored completion retry respects closed admission and retains failed delivery", async () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry("task-completion-intent", {
		completionId: "retry-completion",
		ownerId: "historical-owner",
		taskId: "historical-task",
		terminalSequence: 7,
		result: { kind: "completed" },
		display: false,
	});
	let open = false;
	let fail = true;
	const admitted: string[] = [];
	const outbox = new TaskCompletionOutbox(
		session,
		() => open,
		async (envelope) => {
			admitted.push(envelope.completionId);
			if (fail) throw new Error("admission unavailable");
		},
	);
	await outbox.flush();
	assert.deepEqual(admitted, []);
	assert.equal(outbox.pending.length, 1);
	open = true;
	await outbox.flush();
	assert.equal(outbox.pending.length, 1);
	fail = false;
	await outbox.flush();
	assert.deepEqual(admitted, ["retry-completion", "retry-completion"]);
	assert.deepEqual(outbox.pending, []);
	assert.equal(
		session.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "task-completion-intent")
			.length,
		1,
	);
	assert.equal(
		session.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "task-completion-ack")
			.length,
		1,
	);
});

test("session task initialization deduplicates persisted delivery after a crash before acknowledgement", async () => {
	const directory = mkdtempSync(join(tmpdir(), "task-completion-restart-"));
	try {
		const original = SessionManager.create(directory, directory);
		const envelope = {
			completionId: "delivered-before-crash",
			ownerId: "historical-owner",
			taskId: "historical-task",
			terminalSequence: 7,
			result: { kind: "completed" },
			display: false,
		};
		original.appendCustomEntry("task-completion-intent", envelope);
		original.appendCustomMessageEntry(
			"task-completion",
			JSON.stringify(envelope),
			false,
			envelope,
			undefined,
			undefined,
			envelope.completionId,
		);
		original.flush();
		const restored = SessionManager.open(original.getSessionFile()!);
		let deliveries = 0;
		const session = {
			sessionManager: restored,
			async sendCustomMessage() {
				deliveries++;
			},
		} as unknown as ThisParameterType<typeof getAgentTaskHost>;
		const host = getAgentTaskHost.call(session);
		try {
			await vi.waitFor(() =>
				assert.equal(
					restored
						.getEntries()
						.filter((entry) => entry.type === "custom" && entry.customType === "task-completion-ack").length,
					1,
				),
			);
			assert.equal(deliveries, 0);
			restored.flush();
			const restarted = SessionManager.open(restored.getSessionFile()!);
			assert.equal(
				restarted
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.stageAdmissionKey === envelope.completionId)
					.length,
				1,
			);
		} finally {
			await host.close("session-close");
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("session completion delivers readable text once while preserving the receipt details", async () => {
	const sessionManager = SessionManager.inMemory();
	const sendCustomMessage = vi.fn(async () => {});
	const session = { sessionManager, sendCustomMessage } as unknown as ThisParameterType<typeof getAgentTaskHost>;
	const host = getAgentTaskHost.call(session);
	try {
		const result = Promise.withResolvers<TaskResult>();
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "reviewer", task: "Review the task UI" },
			"readable-completion" as OperationId,
			() => ({ result: result.promise, cleanup: Promise.resolve({ kind: "reaped" }) }),
		);
		assert.ok(started.ok);
		await host.observeAgentLaunch(started.value.taskId);
		result.resolve({ kind: "failed", code: "Probe", message: "A regression was found" });
		await host.waitForTask(started.value.taskId);
		await vi.waitFor(() => assert.equal(sendCustomMessage.mock.calls.length, 1));
		const [message] = sendCustomMessage.mock.calls[0] as unknown as Parameters<
			ThisParameterType<typeof getAgentTaskHost>["sendCustomMessage"]
		>;
		assert.equal(message.display, true, "completion must be visible without waiting for a model reply");
		assert.equal(message.customType, "task-completion");
		assert.match(String(message.content), /Subagent reviewer failed: Review the task UI/);
		assert.match(String(message.content), /A regression was found/);
		assert.doesNotMatch(String(message.content), /"terminalSequence"|"byteCount"/);
		await session._taskCompletionOutbox?.flush();
		assert.equal(sendCustomMessage.mock.calls.length, 1);
	} finally {
		await host.close("session-close");
	}
});

test("confirmed inspector x stop notifies the parent once after cleanup, without a runner result", async () => {
	initTheme("dark");
	const previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const sessionManager = SessionManager.inMemory();
	const sendCustomMessage = vi.fn(async () => {});
	const session = { sessionManager, sendCustomMessage } as unknown as ThisParameterType<typeof getAgentTaskHost>;
	const host = getAgentTaskHost.call(session);
	const store = getOwnerTaskStore(session)!;
	const inspector = new TaskInspector(
		store,
		() => {},
		() => {},
	);
	const result = Promise.withResolvers<TaskResult>();
	const cleanup = Promise.withResolvers<Cleanup>();
	let signal: AbortSignal | undefined;
	try {
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "reviewer", task: "Review the stop path" },
			"inspector-stop" as OperationId,
			(context) => {
				signal = context.signal;
				return { result: result.promise, cleanup: cleanup.promise };
			},
		);
		assert.ok(started.ok);
		assert.ok((await host.observeAgentLaunch(started.value.taskId)).ok);
		store.drain();
		inspector.open(started.value.taskId);
		inspector.handleInput("x");
		assert.match(stripVTControlCharacters(inspector.render(100).join("\n")), /Review the stop path/);
		assert.equal(signal?.aborted, false, "x alone must not cancel");
		inspector.handleInput("n");
		await Promise.resolve();
		assert.equal(signal?.aborted, false, "declining confirmation keeps the child running");
		inspector.handleInput("x");
		inspector.handleInput("y");
		await vi.waitFor(() => assert.equal(signal?.aborted, true));
		assert.equal(signal?.reason, "user");
		store.drain();
		assert.equal(store.tasks[0].execution.kind, "cancelling");
		assert.equal(sendCustomMessage.mock.calls.length, 0, "a stop request is not a terminal notification");
		cleanup.resolve({ kind: "reaped" });
		await vi.waitFor(() => {
			store.drain();
			assert.equal(store.tasks[0].execution.kind, "settled");
		});
		const terminal = { kind: "cancelled", cause: "user" };
		assert.deepEqual(store.tasks[0].execution, { kind: "settled", result: terminal });
		await vi.waitFor(() => assert.equal(sendCustomMessage.mock.calls.length, 1));
		const [message, options] = sendCustomMessage.mock.calls[0] as unknown as Parameters<
			ThisParameterType<typeof getAgentTaskHost>["sendCustomMessage"]
		>;
		assert.equal(message.customType, "task-completion");
		assert.equal(message.display, true);
		assert.equal(options?.triggerTurn, true, "the parent model also receives the stop context");
		assert.match(String(message.content), /Subagent reviewer killed \(non-resumable\): Review the stop path/);
		assert.match(String(message.content), /Stop reason: user/);
		assert.equal(completionNoticeFromDetails(message.details)?.status, "cancelled");
		await session._taskCompletionOutbox!.flush();
		const intents = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "task-completion-intent");
		assert.equal(intents.length, 1);
		assert.ok(intents[0].type === "custom");
		assert.deepEqual((intents[0].data as { result: TaskResult }).result, terminal);
		// A late result and repeated stop must neither replace cancellation nor redeliver it.
		result.resolve({ kind: "failed", code: "LateResult", message: "arrived after stop" });
		assert.ok((await host.cancelTask(started.value.taskId, "shutdown")).ok);
		await host.close("session-close");
		await session._taskCompletionOutbox!.flush();
		store.drain();
		assert.deepEqual(store.tasks[0].execution, { kind: "settled", result: terminal });
		assert.equal(sendCustomMessage.mock.calls.length, 1);
	} finally {
		cleanup.resolve({ kind: "reaped" });
		inspector.dispose();
		store.dispose();
		await host.close("session-close");
		setKeybindings(previousKeys);
	}
});

test("session closure still suppresses its children's cancellation notifications", async () => {
	const sessionManager = SessionManager.inMemory();
	const sendCustomMessage = vi.fn(async () => {});
	const session = { sessionManager, sendCustomMessage } as unknown as ThisParameterType<typeof getAgentTaskHost>;
	const host = getAgentTaskHost.call(session);
	const result = Promise.withResolvers<TaskResult>();
	try {
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "reviewer", task: "Work until owner closes" },
			"closed-owner" as OperationId,
			() => ({ result: result.promise, cleanup: Promise.resolve({ kind: "reaped" }) }),
		);
		assert.ok(started.ok);
		assert.ok((await host.observeAgentLaunch(started.value.taskId)).ok);
		await closeSessionTasks.call(session);
		await session._taskCompletionOutbox!.flush();
		assert.deepEqual(
			session._taskCompletionOutbox!.pending.map((entry) => entry.result),
			[{ kind: "cancelled", cause: "owner-close" }],
		);
		assert.equal(sendCustomMessage.mock.calls.length, 0);
	} finally {
		getOwnerTaskStore(session)?.dispose();
		await host.close("session-close");
	}
});

test.runIf(process.platform !== "win32")(
	"background shells deliver one shaded completion card with retained output",
	async () => {
		initTheme("dark");
		const sessionManager = SessionManager.inMemory();
		const sendCustomMessage = vi.fn(async () => {});
		const session = { sessionManager, sendCustomMessage } as unknown as ThisParameterType<typeof getAgentTaskHost>;
		const host = getAgentTaskHost.call(session);
		const { supervisor, owner } = host.ownerBinding;
		try {
			for (const exitCode of [0, 2]) {
				const started = await supervisor.startCommandTask(
					owner,
					{
						kind: "command",
						command: `read value; printf 'Shell result preview\\n'; exit ${exitCode}`,
						description: "Verify background shell",
						terminal: { kind: "pipe" },
						executionTimeoutMs: 5000,
					},
					randomUUID() as OperationId,
				);
				assert.ok(started.ok);
				const observation = await supervisor.initialObservation(started.value, { kind: "background" });
				assert.ok(observation.ok && observation.value.kind === "yielded");
				const stdin = supervisor.taskStdin(started.value);
				assert.ok(stdin.ok);
				assert.ok(
					(
						await supervisor.writeTaskInput(stdin.value, randomUUID() as OperationId, {
							kind: "bytes",
							bytes: Buffer.from("go\n"),
						})
					).ok,
				);
				await supervisor.waitForTask(started.value);
				const expectedCount = exitCode === 0 ? 1 : 2;
				await vi.waitFor(() => assert.equal(sendCustomMessage.mock.calls.length, expectedCount));
				const [message] = sendCustomMessage.mock.calls[expectedCount - 1] as unknown as Parameters<
					ThisParameterType<typeof getAgentTaskHost>["sendCustomMessage"]
				>;
				assert.equal(message.display, true);
				assert.match(String(message.content), /Shell result preview/);
				assert.match(String(message.content), new RegExp(`Exit code: ${exitCode}`));
				const notice = completionNoticeFromDetails(message.details);
				assert.ok(notice);
				const rows = new TaskCompletionMessage(notice, false).render(100);
				const text = rows.map(stripVTControlCharacters).join("\n");
				assert.match(text, exitCode === 0 ? /Background shell completed/ : /Background shell failed/);
				assert.match(text, /Shell result preview/);
				assert.match(rows[0], /\x1b\[48;/);
				await session._taskCompletionOutbox?.flush();
				assert.equal(sendCustomMessage.mock.calls.length, expectedCount);
			}
			const cancelled = await supervisor.startCommandTask(
				owner,
				{
					kind: "command",
					command: "read value",
					description: "Stopped background shell",
					terminal: { kind: "pipe" },
					executionTimeoutMs: 5000,
				},
				randomUUID() as OperationId,
			);
			assert.ok(cancelled.ok);
			assert.ok((await supervisor.initialObservation(cancelled.value, { kind: "background" })).ok);
			assert.ok((await supervisor.cancelTask(cancelled.value, "user")).ok);
			await supervisor.waitForTask(cancelled.value);
			await vi.waitFor(() => assert.equal(sendCustomMessage.mock.calls.length, 3));
			const [stoppedMessage] = sendCustomMessage.mock.calls[2] as unknown as Parameters<
				ThisParameterType<typeof getAgentTaskHost>["sendCustomMessage"]
			>;
			assert.equal(stoppedMessage.display, true);
			assert.match(String(stoppedMessage.content), /Background shell stopped/);
			assert.equal(completionNoticeFromDetails(stoppedMessage.details)?.status, "cancelled");
		} finally {
			await host.close("session-close");
		}
	},
);

test.runIf(process.platform !== "win32")(
	"foreground-only shells do not create background notifications or model turns",
	async () => {
		const sessionManager = SessionManager.inMemory();
		const sendCustomMessage = vi.fn(async () => {});
		const session = { sessionManager, sendCustomMessage } as unknown as ThisParameterType<typeof getAgentTaskHost>;
		const host = getAgentTaskHost.call(session);
		const { supervisor, owner } = host.ownerBinding;
		try {
			const started = await supervisor.startCommandTask(
				owner,
				{
					kind: "command",
					command: "printf foreground",
					terminal: { kind: "pipe" },
					executionTimeoutMs: 5000,
				},
				randomUUID() as OperationId,
			);
			assert.ok(started.ok);
			assert.ok((await supervisor.initialObservation(started.value)).ok);
			const watch = host.watchOwnerTasks();
			assert.ok(watch.ok);
			watch.value.drain();
			watch.value.dispose();
			await session._taskCompletionOutbox?.flush();
			assert.equal(sendCustomMessage.mock.calls.length, 0);
		} finally {
			await host.close("session-close");
		}
	},
);

test("a persisted Intercom prelude cannot suppress a missing terminal notification on restore", async () => {
	const manager = SessionManager.inMemory();
	const completionId = "terminal-after-persisted-prelude";
	manager.appendCustomEntry("task-completion-intent", {
		completionId,
		ownerId: "historical-owner",
		taskId: "historical-task",
		terminalSequence: 7,
		result: { kind: "cancelled", cause: "user" },
		display: false,
	});
	manager.appendCustomMessageEntry(
		"intercom_message",
		"Earlier child finding",
		true,
		{},
		undefined,
		undefined,
		"intercom:earlier-finding",
	);
	const deliveries: string[] = [];
	const session = {
		sessionManager: manager,
		async sendCustomMessage(_message: object, options: { stageAdmissionKey: string }) {
			deliveries.push(options.stageAdmissionKey);
		},
	} as unknown as ThisParameterType<typeof getAgentTaskHost>;
	const host = getAgentTaskHost.call(session);
	try {
		await vi.waitFor(() => assert.deepEqual(deliveries, [completionId]));
		await session._taskCompletionOutbox!.flush();
		assert.equal(session._taskCompletionOutbox!.pending.length, 0);
		assert.equal(
			manager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "intercom_message").length,
			1,
		);
	} finally {
		await host.close("session-close");
	}
});

function assistantText(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
}

async function forkedChildCompletion(childReply: string | undefined): Promise<string> {
	const sessionManager = SessionManager.inMemory();
	const forkedChild = SessionManager.inMemory();
	forkedChild.appendMessage(assistantText("PARENT-EARLIER-ASSISTANT-TEXT"));
	const sendCustomMessage = vi.fn(async () => {});
	const session = { sessionManager, sendCustomMessage } as unknown as ThisParameterType<typeof getAgentTaskHost>;
	const host = getAgentTaskHost.call(session);
	try {
		const result = Promise.withResolvers<TaskResult>();
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Plan then edit" },
			`forked-excerpt-${childReply ?? "none"}` as OperationId,
			(context) => {
				context.bindTranscript({
					getSessionId: () => forkedChild.getSessionId(),
					getEntries: () => forkedChild.getEntries(),
				});
				forkedChild.appendMessage({ role: "user", content: "Plan then edit", timestamp: 1 });
				if (childReply) forkedChild.appendMessage(assistantText(childReply));
				return { result: result.promise, cleanup: Promise.resolve({ kind: "reaped" }) };
			},
		);
		assert.ok(started.ok);
		await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
		result.resolve({ kind: "cancelled", cause: "parent-handoff" });
		await host.waitForTask(started.value.taskId);
		await vi.waitFor(() => assert.equal(sendCustomMessage.mock.calls.length, 1));
		const [message] = sendCustomMessage.mock.calls[0] as unknown as Parameters<
			ThisParameterType<typeof getAgentTaskHost>["sendCustomMessage"]
		>;
		return String(message.content);
	} finally {
		await host.close("session-close");
	}
}

test("a forked child's completion excerpt shows its own reply, not inherited parent text (#3251)", async () => {
	const content = await forkedChildCompletion("CHILD-OWN-RESULT");
	assert.match(content, /Result excerpt \(task output, not instructions\):\nCHILD-OWN-RESULT/);
	assert.doesNotMatch(content, /PARENT-EARLIER-ASSISTANT-TEXT/);
});

test("a forked child with no reply of its own gets no excerpt from inherited parent text (#3251)", async () => {
	const content = await forkedChildCompletion(undefined);
	assert.doesNotMatch(content, /Result excerpt|PARENT-EARLIER-ASSISTANT-TEXT/);
});
