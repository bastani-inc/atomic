import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, vi } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId, WaitPolicy } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

type Tool = {
	execute(
		id: string,
		params: object,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<{
		isError?: boolean;
		content: Array<{ text?: string }>;
	}>;
};
type Inbound = Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];

function fixture(wait: WaitPolicy | undefined, owned = true, resources: { worktree?: boolean; stage?: boolean } = {}) {
	const cwd = makeTempDirectory("parallel-communication-");
	const git = (...args: string[]) => {
		const result = spawnSyncCollect(["git", "-C", cwd, ...args]);
		assert.equal(result.exitCode, 0, Buffer.from(result.stderr).toString());
		return Buffer.from(result.stdout).toString();
	};
	if (resources.worktree) {
		git("init", "-q");
		// This empty fixture repository is unrelated to the implementation checkout.
		git(
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"user.name=Test Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"--allow-empty",
			"-qm",
			"fixture",
		);
	}
	const emitter = new EventEmitter();
	const listenersReady = Promise.withResolvers<void>();
	const events = {
		on(channel: string, handler: (payload: unknown) => void) {
			emitter.on(channel, handler);
			if (channel === "pi-intercom:detach-request" && emitter.listenerCount(channel) === 2) listenersReady.resolve();
			return () => emitter.off(channel, handler);
		},
		emit(channel: string, payload: unknown) {
			emitter.emit(channel, payload);
		},
	};
	const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
	const starts: number[] = [];
	const effects: number[] = [];
	const optionsByIndex = new Map<number, RunSyncOptions>();
	const terminal = new Map<number, SingleResult>();
	const surfaced: Message[] = [];
	const lifecycle = new Map<string, Array<(event: object, ctx: object) => void | Promise<void>>>();
	let inbound!: Inbound;
	let idle = false;
	const host = new AgentTaskHost({
		scope: resources.stage
			? { kind: "workflow-stage", sessionId: cwd, runId: cwd, stageId: "worker", stageAttemptId: "attempt-1" }
			: { kind: "session", sessionId: cwd },
		authorizeLaunch() {},
	});
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionId: () => cwd,
			getSessionFile: () => undefined,
			getLeafId: () => null,
			getBranch: () => [],
		},
		...(owned ? { getAgentTaskHost: () => host } : {}),
		isIdle: () => idle,
		isProjectTrusted: () => true,
		ui: { notify() {} },
	};
	const pi = {
		events,
		getSessionName: () => "parent",
		on(name: string, handler: (event: object, ctx: object) => void | Promise<void>) {
			const handlers = lifecycle.get(name) ?? [];
			handlers.push(handler);
			lifecycle.set(name, handlers);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		sendMessage(value: { details: { message: Message } }) {
			surfaced.push(value.details.message);
		},
	};
	intercomHeavy(pi as never, {
		captureInboundHandler: (handler) => {
			inbound = handler;
		},
	});
	const worker = {
		name: "worker",
		description: "deterministic communication worker",
		source: "project" as const,
		filePath: "worker.md",
		systemPrompt: "Work",
		systemPromptMode: "replace" as const,
		inheritProjectContext: false,
		inheritSkills: false,
	};
	const executor = createSubagentExecutor({
		pi: pi as never,
		state: {
			baseCwd: cwd,
			currentSessionId: cwd,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: { parallel: { concurrency: 2, maxTasks: 10 } },
		tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => cwd,
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker] }),
		runtime: {
			async runSync(runtimeCwd, agents, agent, task, options) {
				const index = options.index!;
				starts.push(index);
				optionsByIndex.set(index, options);
				const result = await runSync(runtimeCwd, agents, agent, task, {
					...options,
					testSession: { output: `effect-${index}`, promptGate: gates[index]!.promise, abortResolvesPrompt: true },
					onDetachedExit: (result) => {
						if (result.status === "ok") effects.push(index);
						terminal.set(index, result);
						options.onDetachedExit?.(result);
					},
				});
				if (result.status === "ok") effects.push(index);
				if (!result.detached) terminal.set(index, result);
				return result;
			},
		},
	});
	const batchSignal = new AbortController();
	let launch: ReturnType<typeof executor.execute>;
	async function start() {
		for (const handler of lifecycle.get("session_start") ?? [])
			await handler({ type: "session_start", reason: "startup" }, ctx);
		launch = executor.execute(
			"parallel",
			{
				tasks: [0, 1, 2].map((index) => ({ agent: "worker", task: `task-${index}` })),
				concurrency: 2,
				artifacts: false,
				...(resources.worktree ? { worktree: true } : {}),
				...(wait ? { wait } : {}),
			},
			batchSignal.signal,
			undefined,
			ctx as never,
		);
		// Event-driven readiness avoids a 1-second polling deadline during parallel transforms.
		await listenersReady.promise;
		assert.equal(starts.length, 2);
	}
	function snapshot() {
		const watched = host.watchOwnerTasks();
		assert.ok(watched.ok);
		const tasks = watched.value.snapshot.tasks;
		watched.value.dispose();
		return tasks;
	}
	function childTool(kind: "intercom" | "supervisor", index = 0) {
		const options = optionsByIndex.get(index)!;
		const waits = new ReplyWaiterRegistry();
		let registered!: Tool;
		const sender: SessionInfo = {
			id: `child-id-${index}`,
			name: options.intercomSessionName!,
			cwd,
			model: "test",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
		};
		const client = {
			sessionId: sender.id,
			supervisorSessionId: "parent-id",
			async listSessions() {
				return [];
			},
			async send(
				_to: string,
				outgoing: {
					messageId?: string;
					text: string;
					attachments?: Message["content"]["attachments"];
					expectsReply?: boolean;
					replyTo?: string;
				},
			) {
				const message: Message = {
					id: outgoing.messageId ?? `update-${index}`,
					timestamp: Date.now(),
					content: { text: outgoing.text, attachments: outgoing.attachments },
					expectsReply: outgoing.expectsReply,
					replyTo: outgoing.replyTo,
				};
				await inbound(ctx as never, sender, message);
				return { id: message.id, delivered: true };
			},
			async sendToSupervisor(to: string, outgoing: Parameters<typeof this.send>[1]) {
				return this.send(to, outgoing);
			},
		};
		const common = {
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			resolveSessionTarget: async (_client: object, target: string) =>
				target === options.orchestratorIntercomTarget ? "parent-id" : target,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waits.begin(from, replyTo, signal),
			hasReplyWaiter: () => waits.has(),
			childOrchestratorMetadata: {
				runId: options.runId,
				index,
				agent: "worker",
				sessionName: sender.name,
				orchestratorTarget: options.orchestratorIntercomTarget!,
			},
		};
		const childPi = {
			events,
			registerTool(tool: Tool) {
				registered = tool;
			},
			async appendEntry() {},
		};
		if (kind === "intercom")
			registerIntercomTool(
				childPi as never,
				{ ...common, confirmSend: false, replyTracker: new ReplyTracker() } as never,
			);
		else registerContactSupervisorTool(childPi as never, common as never);
		return {
			waits,
			execute(params: object) {
				return registered.execute("communication", params, options.signal, undefined, {
					sessionManager: { getSessionId: () => sender.id },
					hasUI: false,
				});
			},
			reply(replyTo: string, text = "Approved", from = "parent-id") {
				return routeIncomingReply(
					waits.pending(),
					{ ...sender, id: from, name: "parent" },
					{ id: "reply", replyTo, timestamp: Date.now(), content: { text } },
				);
			},
		};
	}
	return {
		git,
		start,
		starts,
		effects,
		terminal,
		surfaced,
		optionsByIndex,
		gates,
		childTool,
		snapshot,
		host,
		batchSignal,
		kill(taskId: TaskId) {
			return executor.execute(
				"kill",
				{ action: "kill", id: taskId },
				new AbortController().signal,
				undefined,
				ctx as never,
			);
		},
		get launch() {
			return launch;
		},
		setIdle() {
			idle = true;
		},
		async finish(index: number) {
			gates[index]!.resolve();
			await vi.waitFor(() => assert.ok(terminal.has(index)));
		},
		async close() {
			for (const gate of gates) gate.resolve();
			await host.close("session-close");
			await launch;
			for (const handler of lifecycle.get("session_shutdown") ?? [])
				await handler({ type: "session_shutdown" }, ctx);
			removeTempDirectory(cwd);
		},
	};
}

for (const wait of [undefined, { kind: "background" }, { kind: "foreground", budgetMs: 10000 }] as const) {
	for (const operation of ["ask", "need_decision", "interview_request"] as const) {
		test(`parallel ${wait?.kind ?? "default"} ${operation} keeps siblings running and resumes the same requester after its correlated reply`, async () => {
			const current = fixture(wait);
			try {
				await current.start();
				if (wait?.kind !== "foreground") {
					await current.launch;
					current.setIdle();
				}
				const child = current.childTool(operation === "ask" ? "intercom" : "supervisor");
				let returned = false;
				const execution = child
					.execute(
						operation === "ask"
							? {
									action: "ask",
									to: current.optionsByIndex.get(0)!.orchestratorIntercomTarget,
									message: "Keep  spacing\nraw",
								}
							: {
									reason: operation,
									message: "Keep  spacing\nraw",
									...(operation === "interview_request"
										? { interview: { questions: [{ id: "pick", type: "text", question: "Which?" }] } }
										: {}),
								},
					)
					.then((result) => {
						returned = true;
						return result;
					});
				await vi.waitFor(() => assert.ok(returned || child.waits.has()));
				assert.equal(returned, false, "requester must wait, not terminally hand off and stop its batch");
				await vi.waitFor(() => assert.equal(current.surfaced.length, 1));
				let observed = false;
				void current.launch.then(() => {
					observed = true;
				});
				await vi.waitFor(() =>
					assert.equal(observed, true, "parent observation must yield even with queued siblings"),
				);
				assert.deepEqual(current.starts, [0, 1]);
				assert.equal(current.terminal.size, 0, "yielding observations must not end executions");
				assert.ok(current.surfaced[0]!.content.text.includes("Keep  spacing\nraw"));
				assert.equal(child.reply("wrong-thread"), false);
				assert.equal(child.reply(current.surfaced[0]!.id, "wrong sender", "other-parent"), false);
				await current.finish(1);
				await vi.waitFor(() => assert.deepEqual(current.starts, [0, 1, 2]));
				await current.finish(2);
				assert.deepEqual(current.effects, [1, 2]);
				assert.equal(returned, false);
				assert.equal(child.reply(current.surfaced[0]!.id), true);
				assert.match((await execution).content[0]?.text ?? "", /Approved/);
				assert.equal(child.reply(current.surfaced[0]!.id), false);
				await current.finish(0);
				assert.deepEqual(current.effects, [1, 2, 0]);
				assert.deepEqual(current.starts, [0, 1, 2]);
				assert.equal(child.waits.has(), false);
				assert.equal(current.snapshot().length, 3);
				assert.ok(current.snapshot().every((task) => task.execution.kind === "settled"));
			} finally {
				await current.close();
			}
		});
	}
}

for (const wait of [undefined, { kind: "background" }, { kind: "foreground", budgetMs: 10000 }] as const) {
	for (const operation of ["send", "progress_update"] as const) {
		test(`parallel ${wait?.kind ?? "default"} ${operation} never waits for a reply or discards queued siblings`, async () => {
			const current = fixture(wait);
			try {
				await current.start();
				if (wait?.kind !== "foreground") {
					await current.launch;
					current.setIdle();
				}
				const child = current.childTool(operation === "send" ? "intercom" : "supervisor");
				const result = await child.execute(
					operation === "send"
						? { action: "send", to: current.optionsByIndex.get(0)!.orchestratorIntercomTarget, message: "Update" }
						: { reason: "progress_update", message: "Update" },
				);
				assert.equal(result.isError, false);
				assert.equal(child.waits.has(), false);
				let observed = false;
				void current.launch.then(() => {
					observed = true;
				});
				await vi.waitFor(() => assert.equal(observed, true));
				assert.deepEqual(current.starts, [0, 1]);
				assert.equal(current.terminal.size, 0);
				await current.finish(0);
				await vi.waitFor(() => assert.deepEqual(current.starts, [0, 1, 2]));
				await current.finish(2);
				await current.finish(1);
				assert.deepEqual(current.effects, [0, 2, 1]);
				assert.equal(current.surfaced.length, 1);
			} finally {
				await current.close();
			}
		});
	}
}

test("parallel parent questions preserve empty text, omitted decision notes and ordered duplicate attachments", async () => {
	const current = fixture({ kind: "background" });
	try {
		await current.start();
		await current.launch;
		current.setIdle();
		const attachments = [
			{ type: "context", name: "same", content: " first\n" },
			{ type: "context", name: "same", content: "second  " },
		];
		for (const kind of ["intercom", "supervisor"] as const) {
			const child = current.childTool(kind);
			let returned = false;
			const execution = child
				.execute(
					kind === "intercom"
						? { action: "ask", to: "parent-id", message: "", attachments }
						: { reason: "need_decision" },
				)
				.then((result) => {
					returned = true;
					return result;
				});
			await vi.waitFor(() => assert.ok(returned || child.waits.has()));
			assert.equal(returned, false, "previously accepted parent questions must still be admitted");
			await vi.waitFor(() => assert.equal(current.surfaced.length, kind === "intercom" ? 1 : 2));
			const message = current.surfaced.at(-1)!;
			if (kind === "intercom") {
				assert.equal(message.content.text, "");
				assert.deepEqual(message.content.attachments, attachments);
			}
			assert.equal(child.reply(message.id), true);
			assert.equal((await execution).isError, false);
		}
	} finally {
		await current.close();
	}
});

for (const wait of [{ kind: "background" }, { kind: "foreground", budgetMs: 10000 }] as const) {
	for (const replyFirst of [false, true]) {
		test(`parallel ${wait.kind} targeted cancellation stays isolated when replyFirst=${replyFirst}`, async () => {
			const current = fixture(wait);
			try {
				await current.start();
				if (wait.kind === "background") {
					await current.launch;
					current.setIdle();
				}
				const child = current.childTool("supervisor");
				const execution = child.execute({ reason: "need_decision", message: "Choose" });
				await vi.waitFor(() => assert.equal(current.surfaced.length, 1));
				const question = current.surfaced[0]!.id;
				const ids = current.snapshot().map((task) => task.ref.taskId);
				if (replyFirst) assert.equal(child.reply(question), true);
				assert.notEqual((await current.kill(ids[0]!)).isError, true);
				assert.equal((await execution).isError, !replyFirst);
				assert.equal(child.reply(question), false, "late/duplicate replies cannot revive a killed child");
				assert.equal(child.waits.has(), false);
				await vi.waitFor(() => assert.equal(current.terminal.get(0)?.status, "killed"));
				assert.equal(current.terminal.has(1), false);
				await vi.waitFor(() => assert.deepEqual(current.starts, [0, 1, 2]));
				await current.finish(1);
				await current.finish(2);
				assert.deepEqual(current.effects, [1, 2]);
				assert.deepEqual(
					current.snapshot().map((task) => task.ref.taskId),
					ids,
				);
			} finally {
				await current.close();
			}
		});
	}
	for (const cause of ["session-close", "stage-close"] as const) {
		test(`parallel ${wait.kind} ${cause} cancels active and queued tasks and pending reply waiters`, async () => {
			const current = fixture(wait);
			try {
				await current.start();
				if (wait.kind === "background") {
					await current.launch;
					current.setIdle();
				}
				const child = current.childTool("intercom");
				const execution = child.execute({ action: "ask", to: "parent-id", message: "Choose" });
				await vi.waitFor(() => assert.equal(current.surfaced.length, 1));
				const closed = await current.host.close(cause);
				assert.ok(closed.ok);
				assert.equal((await execution).isError, true);
				assert.equal(child.waits.has(), false);
				assert.equal(child.reply(current.surfaced[0]!.id), false);
				assert.deepEqual(current.starts, [0, 1]);
				assert.deepEqual(current.effects, []);
				assert.equal(current.terminal.get(0)?.status, "interrupted");
				assert.equal(current.terminal.get(1)?.status, "interrupted");
			} finally {
				await current.close();
			}
		});
	}
}

test("unbound parallel Intercom yield keeps execution concurrency and queued siblings", async () => {
	const current = fixture(undefined, false);
	try {
		await current.start();
		const child = current.childTool("intercom");
		const execution = child.execute({ action: "ask", to: "parent-id", message: "Choose" });
		await vi.waitFor(() => assert.equal(current.surfaced.length, 1));
		await current.launch;
		assert.deepEqual(current.starts, [0, 1], "observation yield must not spend another execution slot");
		await current.finish(1);
		await vi.waitFor(() => assert.deepEqual(current.starts, [0, 1, 2]));
		await current.finish(2);
		assert.equal(child.reply(current.surfaced[0]!.id), true);
		assert.equal((await execution).isError, false);
		await current.finish(0);
		assert.deepEqual(current.effects, [1, 2, 0]);
	} finally {
		await current.close();
	}
});

for (const replyFirst of [false, true]) {
	test(`explicit unbound batch abort still stops all siblings after Intercom yield, replyFirst=${replyFirst}`, async () => {
		const current = fixture(undefined, false);
		try {
			await current.start();
			const child = current.childTool("supervisor");
			const execution = child.execute({ reason: "need_decision", message: "Choose" });
			await vi.waitFor(() => assert.equal(current.surfaced.length, 1));
			await current.launch;
			if (replyFirst) assert.equal(child.reply(current.surfaced[0]!.id), true);
			current.batchSignal.abort();
			assert.equal((await execution).isError, !replyFirst);
			assert.equal(child.waits.has(), false);
			assert.equal(child.reply(current.surfaced[0]!.id), false);
			await vi.waitFor(() => assert.equal(current.terminal.size, 3));
			assert.ok([...current.terminal.values()].every((result) => result.status === "interrupted"));
			assert.deepEqual(current.effects, []);
		} finally {
			await current.close();
		}
	});
}

test("foreground admission does not execute a queued child cancelled before capacity is available", async () => {
	const current = fixture({ kind: "foreground", budgetMs: 10000 });
	try {
		await current.start();
		const child = current.childTool("intercom");
		assert.equal((await child.execute({ action: "send", to: "parent-id", message: "Update" })).isError, false);
		await current.launch;
		const queued = current.snapshot()[2]!;
		assert.equal(queued.execution.kind, "queued");
		assert.equal(current.optionsByIndex.has(2), false, "native admission must not invoke queued child execution");
		assert.deepEqual(current.starts, [0, 1]);
		assert.notEqual((await current.kill(queued.ref.taskId)).isError, true);
		await current.finish(0);
		await current.finish(1);
		await current.host.waitForTask(queued.ref.taskId);
		const terminal = current.snapshot()[2]!;
		assert.equal(terminal.execution.kind, "settled");
		if (terminal.execution.kind === "settled") assert.equal(terminal.execution.result.kind, "cancelled");
		assert.deepEqual(current.starts, [0, 1]);
		assert.deepEqual(current.effects, [0, 1]);
	} finally {
		await current.close();
	}
});

for (const wait of [undefined, { kind: "background" }, { kind: "foreground", budgetMs: 10000 }] as const) {
	for (const stop of ["queued", "session-close", "stage-close"] as const) {
		test(`parallel ${wait?.kind ?? "default"} ${stop} releases yielded worktrees without starting cancelled children`, async () => {
			const current = fixture(wait, true, { worktree: true, stage: stop === "stage-close" });
			const originalWorktrees = current.git("worktree", "list", "--porcelain");
			const originalBranches = current.git("branch", "--format=%(refname)");
			try {
				await current.start();
				const child = current.childTool("intercom");
				assert.equal((await child.execute({ action: "send", to: "parent-id", message: "yield" })).isError, false);
				const response = (await current.launch).details?.taskResponse;
				assert.equal(response?.kind, "parallel");
				if (response?.kind !== "parallel") assert.fail("parallel observation required");
				assert.equal(response.slots.length, 3);
				assert.ok(
					response.slots.every(
						({ outcome }) => outcome.kind === "admitted" && outcome.observation.kind === "yielded",
					),
				);
				const worktrees = current.git("worktree", "list", "--porcelain");
				assert.equal(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 4);
				const queued = current.snapshot()[2]!;
				assert.equal(queued.execution.kind, "queued");
				if (stop === "queued") {
					assert.notEqual((await current.kill(queued.ref.taskId)).isError, true);
					assert.equal(
						current.git("worktree", "list", "--porcelain"),
						worktrees,
						"live siblings still own their worktrees",
					);
					await current.finish(0);
					assert.equal(
						current.git("worktree", "list", "--porcelain"),
						worktrees,
						"last live sibling prevents batch cleanup",
					);
					assert.equal(current.optionsByIndex.get(1)!.signal?.aborted, false);
					await current.finish(1);
					await vi.waitFor(() =>
						assert.ok(
							current
								.snapshot()
								.every((task) => task.execution.kind === "settled" && task.cleanup.kind === "reaped"),
						),
					);
					assert.deepEqual(current.effects, [0, 1]);
				} else {
					const closed = await current.host.close(stop);
					assert.ok(closed.ok);
					assert.equal(closed.value.tasks.length, 3);
					assert.ok(
						closed.value.tasks.every(
							(task) =>
								task.execution.kind === "settled" &&
								task.execution.result.kind === "cancelled" &&
								task.cleanup.kind === "reaped",
						),
					);
					assert.deepEqual(current.effects, []);
				}
				assert.deepEqual(
					current.starts,
					[0, 1],
					"cancelled queued child must never execute, even after capacity opens",
				);
				await vi.waitFor(() =>
					assert.equal(
						current.git("worktree", "list", "--porcelain"),
						originalWorktrees,
						"all clean child worktrees must be removed",
					),
				);
				assert.equal(
					current.git("branch", "--format=%(refname)"),
					originalBranches,
					"child branches must be removed too",
				);
			} finally {
				await current.close();
			}
		});
	}
}
