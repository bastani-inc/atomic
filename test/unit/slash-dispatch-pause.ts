// @ts-nocheck
import { describe, test } from "vitest";
import { testRunId } from "../helpers/run-id.js";
import type { PiCommandContext } from "./slash-dispatch-utils.js";
import {
	addFactoryStubs,
	assert,
	buildCtx,
	buildMockPi,
	cancellationRegistry,
	installSlashDispatchTestHooks,
	join,
	makeInflightRun,
	mkdtemp,
	recordTerminalRun,
	registerTestStageHandle,
	registerWorkflowCommand,
	rm,
	store,
	tmpdir,
	writeWorkflowFixture,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("/workflow run-control chat commands", () => {
	test.sequential.each([["completed"], ["failed"], ["killed"]] as const)(
		"top-level /workflow quit <id> leaves %s terminal runs unchanged",
		async (status) => {
			const runId =
				status === "completed"
					? "a1b2c3d4-3333-4333-8333-333333333333"
					: status === "failed"
						? "a1b2c3d4-4444-4444-8444-444444444444"
						: "a1b2c3d4-5555-4555-8555-555555555555";
			recordTerminalRun(runId, status);

			const { workflowCmd } = await registerWorkflowCommand();
			const msgs: string[] = [];
			const ctx: PiCommandContext = {
				ui: {
					notify: (message: string) => {
						msgs.push(message);
					},
				},
			};

			await workflowCmd.options.handler(`quit ${runId}`, ctx);

			const joined = msgs.join("\n");
			assert.ok(joined.includes(`Run ${runId} already ended.`));
			assert.doesNotMatch(joined, /Run not found/);
			assert.equal(store.runs().find((r) => r.id === runId)?.status, status);
		},
	);

	test.sequential("/workflow connect no-custom-UI fallback includes older retained terminal runs", async () => {
		const oldEndedAt = Date.now() - 2 * 60 * 60 * 1000;
		recordTerminalRun("old-connect-terminal-run", "completed", {
			name: "old-connect-terminal",
			startedAt: oldEndedAt - 5_000,
			endedAt: oldEndedAt,
		});

		const { workflowCmd } = await registerWorkflowCommand();
		const { ctx, messages } = buildCtx();

		await workflowCmd.options.handler("connect", ctx);

		const joined = messages.join("\n");
		assert.match(joined, /old-connect-terminal/);
		assert.match(joined, /Picker requires an interactive UI surface/);
	});

	test.sequential("/workflow attach no-custom-UI fallback includes older retained terminal runs", async () => {
		const oldEndedAt = Date.now() - 2 * 60 * 60 * 1000;
		recordTerminalRun("old-attach-terminal-run", "failed", {
			name: "old-attach-terminal",
			startedAt: oldEndedAt - 5_000,
			endedAt: oldEndedAt,
		});

		const { workflowCmd } = await registerWorkflowCommand();
		const { ctx, messages } = buildCtx();

		await workflowCmd.options.handler("attach", ctx);

		const joined = messages.join("\n");
		assert.match(joined, /old-attach-terminal/);
		assert.match(joined, /Picker requires an interactive UI surface/);
	});

	test.sequential("top-level /workflow quit <id> pauses and preserves resumability without confirmation", async () => {
		const runId = testRunId(`quit-chat-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		registerTestStageHandle(runId, "quit-stage");
		const controller = new AbortController();
		cancellationRegistry.register(runId, controller);

		const { pi, commands, sent } = buildMockPi();
		addFactoryStubs(pi);

		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);

		const workflowCmd = commands.find((c) => c.name === "workflow")!;
		const msgs: string[] = [];
		let confirmCalls = 0;
		const ctx: PiCommandContext = {
			ui: {
				notify: (message: string) => {
					msgs.push(message);
				},
				confirm: async () => {
					confirmCalls++;
					return false;
				},
			},
		};

		await workflowCmd.options.handler(`quit ${runId}`, ctx);

		const run = store.runs().find((r) => r.id === runId);
		assert.equal(confirmCalls, 0);
		assert.equal(run?.status, "paused");
		assert.equal(run?.endedAt, undefined);
		assert.equal(run?.exitReason, "quit");
		assert.equal(run?.resumable, true);
		assert.equal(controller.signal.aborted, false);
		assert.equal(
			msgs.some((message) => /quit.*resume|resume.*quit/i.test(message)),
			true,
		);
		assert.equal(
			sent.some((message) => (message.details as { kind?: string } | undefined)?.kind === "killed"),
			false,
		);
	});

	test.sequential("top-level /workflow quit without a controllable stage reports that the run remains active", async () => {
		const runId = testRunId(`quit-no-control-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		const { workflowCmd } = await registerWorkflowCommand();
		const { ctx, messages } = buildCtx();

		await workflowCmd.options.handler(`quit ${runId}`, ctx);

		assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
		assert.match(messages.join("\n"), /no controllable stages.*remains active/i);
		assert.doesNotMatch(messages.join("\n"), /Run not found/i);
	});

	test.sequential("top-level /workflow quit --all reports mixed no-controller failures", async () => {
		const controllable = `quit-slash-mixed-ok-${Date.now()}`;
		const noController = `quit-slash-mixed-no-controller-${Date.now()}`;
		store.recordRunStart(makeInflightRun(controllable));
		store.recordRunStart(makeInflightRun(noController));
		registerTestStageHandle(controllable, "quit-stage");
		const { workflowCmd } = await registerWorkflowCommand();
		const messages: string[] = [];
		const levels: string[] = [];
		const ctx = {
			ui: {
				notify(message: string, level: string) {
					messages.push(message);
					levels.push(level);
				},
			},
		};

		await workflowCmd.options.handler("quit --all", ctx);

		const output = messages.join("\n");
		assert.match(output, /Quit 1 run\(s\)/);
		assert.ok(output.indexOf(controllable) < output.indexOf(noController));
		assert.match(output, new RegExp(noController));
		assert.deepEqual(levels, ["info"]);
		assert.match(output, /no_active_stages|no controllable stages/i);
		assert.equal(store.runs().find((run) => run.id === controllable)?.status, "paused");
		assert.equal(store.runs().find((run) => run.id === noController)?.status, "running");
	});

	test.sequential("top-level /workflow pause --all reports a run whose pause throws alongside a paused run (#3377)", async () => {
		const pausable = testRunId(`pause-slash-mixed-ok-${Date.now()}`);
		const refusing = testRunId(`pause-slash-mixed-refusing-${Date.now()}`);
		store.recordRunStart(makeInflightRun(pausable));
		store.recordRunStart(makeInflightRun(refusing));
		registerTestStageHandle(pausable, "pause-stage");
		registerTestStageHandle(refusing, "pause-stage", "running", {
			pause: async () => {
				throw new Error("stage refused to pause");
			},
		});
		const { workflowCmd } = await registerWorkflowCommand();
		const messages: string[] = [];
		const levels: string[] = [];
		const ctx = {
			ui: {
				notify(message: string, level: string) {
					messages.push(message);
					levels.push(level);
				},
			},
		};

		await workflowCmd.options.handler("pause --all", ctx);

		const output = messages.join("\n");
		assert.match(output, /Paused 1 run\(s\)/);
		assert.match(output, /failed to pause 1 run\(s\)/);
		assert.match(output, new RegExp(`${refusing}: pause_failed \\(stage refused to pause\\)`));
		assert.deepEqual(levels, ["info"]);
	});

	test.sequential("top-level /workflow pause --all reports an error naming the run when every pause throws (#3377)", async () => {
		const refusing = testRunId(`pause-slash-refusing-${Date.now()}`);
		store.recordRunStart(makeInflightRun(refusing));
		registerTestStageHandle(refusing, "pause-stage", "running", {
			pause: async () => {
				throw new Error("stage refused to pause");
			},
		});
		const { workflowCmd } = await registerWorkflowCommand();
		const messages: string[] = [];
		const levels: string[] = [];
		const ctx = {
			ui: {
				notify(message: string, level: string) {
					messages.push(message);
					levels.push(level);
				},
			},
		};

		await workflowCmd.options.handler("pause --all", ctx);

		const output = messages.join("\n");
		assert.match(output, /failed to pause 1 run\(s\)/);
		assert.match(output, new RegExp(`${refusing}: pause_failed \\(stage refused to pause\\)`));
		assert.doesNotMatch(output, /No in-flight runs/);
		assert.deepEqual(levels, ["error"]);
	});

	test.sequential("top-level /workflow pause --all does not report an already paused run as a failure (#3377)", async () => {
		const alreadyPaused = testRunId(`pause-slash-already-paused-${Date.now()}`);
		const pausable = testRunId(`pause-slash-newly-paused-${Date.now()}`);
		store.recordRunStart(makeInflightRun(alreadyPaused));
		store.recordRunPaused(alreadyPaused);
		store.recordRunStart(makeInflightRun(pausable));
		registerTestStageHandle(pausable, "pause-stage");
		const { workflowCmd } = await registerWorkflowCommand();
		const messages: string[] = [];
		const levels: string[] = [];
		const ctx = {
			ui: {
				notify(message: string, level: string) {
					messages.push(message);
					levels.push(level);
				},
			},
		};

		await workflowCmd.options.handler("pause --all", ctx);

		assert.doesNotMatch(messages.join("\n"), /failed to pause/);
		assert.match(messages[0]!, /Paused 1 run\(s\)/);
		assert.deepEqual(levels, ["info"]);
	});

	test.sequential("top-level /workflow pause --all reports an error when it stopped nothing beside an already paused run (#3377)", async () => {
		const alreadyPaused = testRunId(`pause-slash-paused-beside-stuck-${Date.now()}`);
		const noController = testRunId(`pause-slash-stuck-beside-paused-${Date.now()}`);
		store.recordRunStart(makeInflightRun(alreadyPaused));
		store.recordRunPaused(alreadyPaused);
		store.recordRunStart(makeInflightRun(noController));
		const { workflowCmd } = await registerWorkflowCommand();
		const messages: string[] = [];
		const levels: string[] = [];
		const ctx = {
			ui: {
				notify(message: string, level: string) {
					messages.push(message);
					levels.push(level);
				},
			},
		};

		await workflowCmd.options.handler("pause --all", ctx);

		const output = messages.join("\n");
		assert.match(output, /failed to pause 1 run\(s\)/);
		assert.match(output, new RegExp(`${noController}: no_active_stages`));
		assert.doesNotMatch(output, /Paused \d+ run\(s\)/);
		assert.deepEqual(levels, ["error"]);
		assert.equal(store.runs().find((run) => run.id === noController)?.status, "running");
	});

	test.sequential("top-level /workflow quit --all reports info when it quits an already paused run beside a stuck run (#3377)", async () => {
		const alreadyPaused = testRunId(`quit-slash-paused-beside-stuck-${Date.now()}`);
		const noController = testRunId(`quit-slash-stuck-beside-paused-${Date.now()}`);
		store.recordRunStart(makeInflightRun(alreadyPaused));
		store.recordRunPaused(alreadyPaused);
		store.recordRunStart(makeInflightRun(noController));
		const { workflowCmd } = await registerWorkflowCommand();
		const messages: string[] = [];
		const levels: string[] = [];
		const ctx = {
			ui: {
				notify(message: string, level: string) {
					messages.push(message);
					levels.push(level);
				},
			},
		};

		await workflowCmd.options.handler("quit --all", ctx);

		const output = messages.join("\n");
		assert.match(output, /Quit 1 run\(s\)/);
		assert.match(output, new RegExp(`${noController}: no_active_stages`));
		assert.deepEqual(levels, ["info"]);
		assert.equal(store.runs().find((run) => run.id === alreadyPaused)?.exitReason, "quit");
		assert.equal(store.runs().find((run) => run.id === noController)?.status, "running");
	});

	test.sequential("top-level /workflow pause --all treats only already paused runs as a benign no-op (#3377)", async () => {
		const alreadyPaused = testRunId(`pause-slash-only-paused-${Date.now()}`);
		store.recordRunStart(makeInflightRun(alreadyPaused));
		store.recordRunPaused(alreadyPaused);
		const { workflowCmd } = await registerWorkflowCommand();
		const messages: string[] = [];
		const levels: string[] = [];
		const ctx = {
			ui: {
				notify(message: string, level: string) {
					messages.push(message);
					levels.push(level);
				},
			},
		};

		await workflowCmd.options.handler("pause --all", ctx);

		assert.match(messages.join("\n"), /already paused/);
		assert.doesNotMatch(messages.join("\n"), /failed to pause|No in-flight runs/);
		assert.deepEqual(levels, ["info"]);
	});

	test.sequential.each([
		["-y <id>", "-y"],
		["--yes <id>", "--yes"],
		["<id> -y", "-y"],
		["<id> --yes", "--yes"],
		["--all -y", "-y"],
		["--all --yes", "--yes"],
		["-y --all", "-y"],
		["--yes --all", "--yes"],
	])(
		"top-level /workflow quit %s rejects yes compatibility as an ordinary unsupported target",
		async (argsTemplate, unsupportedToken) => {
			const runId = testRunId(`quit-unsupported-confirmation-${unsupportedToken}-${Date.now()}`);
			store.recordRunStart(makeInflightRun(runId));
			registerTestStageHandle(runId, "quit-stage");
			const { workflowCmd } = await registerWorkflowCommand();
			const { ctx, messages } = buildCtx();

			await workflowCmd.options.handler(`quit ${argsTemplate.replace("<id>", runId)}`, ctx);

			const run = store.runs().find((candidate) => candidate.id === runId);
			assert.equal(run?.status, "running");
			assert.equal(run?.exitReason, undefined);
			assert.match(messages.join("\n"), /Run id must be a full 36-character UUID/);
		},
	);

	test.sequential("top-level /workflow quit without an id defaults to the active run", async () => {
		const runId = testRunId(`quit-active-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		registerTestStageHandle(runId, "quit-stage");
		const { workflowCmd } = await registerWorkflowCommand();
		const { ctx, messages } = buildCtx();

		await workflowCmd.options.handler("quit", ctx);

		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(run?.status, "paused");
		assert.equal(run?.endedAt, undefined);
		assert.equal(run?.resumable, true);
		assert.equal(
			messages.some((message) => /resume/i.test(message)),
			true,
		);
	});

	test.sequential("removed /workflow kill is not a compatibility alias for quit", async () => {
		const runId = testRunId(`removed-kill-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		const { workflowCmd } = await registerWorkflowCommand();
		const { ctx, messages } = buildCtx();

		await workflowCmd.options.handler(`kill ${runId}`, ctx);

		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(run?.status, "running");
		assert.equal(run?.endedAt, undefined);
		assert.equal(run?.exitReason, undefined);
		assert.equal(
			messages.some((message) => /killed and retained/i.test(message)),
			false,
		);
	});

	test.sequential("top-level /workflow pause defaults to the active run", async () => {
		const runId = testRunId(`pause-active-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const { pi, commands } = buildMockPi();
		addFactoryStubs(pi);

		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);

		const workflowCmd = commands.find((c) => c.name === "workflow")!;
		const msgs: string[] = [];
		const ctx: PiCommandContext = {
			ui: {
				notify: (message: string) => {
					msgs.push(message);
				},
				confirm: async () => false,
			},
		};

		await workflowCmd.options.handler("pause", ctx);

		const run = store.runs().find((r) => r.id === runId);
		assert.equal(run?.status, "running");
		assert.equal(
			msgs.some((m) => m.includes("No active stages to pause")),
			true,
		);
	});

	test.sequential("top-level /workflow pause <id> reports no active stages without confirmation", async () => {
		const runId = testRunId(`pause-chat-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const { pi, commands } = buildMockPi();
		addFactoryStubs(pi);

		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);

		const workflowCmd = commands.find((c) => c.name === "workflow")!;
		const msgs: string[] = [];
		let confirmCalls = 0;
		const ctx: PiCommandContext = {
			ui: {
				notify: (message: string) => {
					msgs.push(message);
				},
				confirm: async () => {
					confirmCalls++;
					return false;
				},
			},
		};

		await workflowCmd.options.handler(`pause ${runId}`, ctx);

		const run = store.runs().find((r) => r.id === runId);
		assert.equal(confirmCalls, 0);
		assert.equal(run?.status, "running");
		assert.equal(
			msgs.some((m) => m.includes("No active stages to pause")),
			true,
		);
	});

	test.sequential("removed /workflow interrupt cannot control a live run", async () => {
		const runId = testRunId("removed-interrupt");
		store.recordRunStart(makeInflightRun(runId));
		registerTestStageHandle(runId, "worker");
		const { workflowCmd } = await registerWorkflowCommand();
		const { ctx, messages } = buildCtx();
		await workflowCmd.options.handler(`interrupt ${runId}`, ctx);
		assert.match(messages.join("\n"), /Workflow not found: interrupt/);
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
	});

	test.sequential.each([
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	])("pause confirmation and extra-token handling: all=%s confirmed=%s", async (all, confirmed) => {
		const runId = testRunId(`pause-confirm-${all}-${confirmed}`);
		store.recordRunStart(makeInflightRun(runId));
		registerTestStageHandle(runId, "worker");
		const { handleRunControlCommand } = await import(
			"../../packages/workflows/src/extension/workflow-run-control-command.js"
		);
		const { ctx, messages } = buildCtx();
		const confirmations: string[] = [];
		ctx.ui.confirm = async (title) => {
			confirmations.push(title);
			return confirmed;
		};
		ctx.ui.custom = async () => {
			throw new Error("pause must not open a stage picker");
		};
		const target = all ? "--all" : runId;
		await handleRunControlCommand(
			"pause",
			[target, "nonexistent-stage", "extra-token"],
			ctx,
			{ info: (message) => messages.push(message), error: (message) => messages.push(message) },
			{} as never,
		);
		assert.equal(confirmations.length, 1);
		assert.match(confirmations[0], all ? /Pause all 1 in-flight workflow runs/ : /Pause workflow run/);
		assert.equal(store.runs().find((run) => run.id === runId)?.status, confirmed ? "paused" : "running");
		assert.match(messages.join("\n"), confirmed ? /paused/i : /Cancelled/);
	});

	test.sequential.each(["", "-y", "--yes"])(
		"top-level pause %s implicitly confirms and ignores extra stage tokens",
		async (flag) => {
			const runId = testRunId(`pause-yes-${flag}`);
			store.recordRunStart(makeInflightRun(runId));
			registerTestStageHandle(runId, "worker");
			const { workflowCmd } = await registerWorkflowCommand();
			const { ctx } = buildCtx();
			ctx.ui.confirm = async () => {
				throw new Error("confirmation was bypassed");
			};
			await workflowCmd.options.handler(`pause ${flag} ${runId} nonexistent-stage extra-token`, ctx);
			assert.equal(store.runs().find((run) => run.id === runId)?.status, "paused");
		},
	);

	test.sequential("top-level /workflow reload stays available while workflows are in flight", async () => {
		const runId = testRunId(`reload-slash-inflight-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const { pi, commands } = buildMockPi();
		addFactoryStubs(pi);

		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);

		const workflowCmd = commands.find((c) => c.name === "workflow")!;
		const { ctx, messages } = buildCtx();

		await workflowCmd.options.handler("reload", ctx);

		assert.equal(
			messages.some((message) => message.includes("Reloaded workflow resources")),
			true,
		);
		assert.equal(store.runs().find((run) => run.id === runId)?.endedAt, undefined);
	});

	test.sequential("top-level /workflow reload reports reload failures", async () => {
		const { pi, commands } = buildMockPi();
		addFactoryStubs(pi);
		pi.getWorkflowResources = () => {
			throw new Error("package loader unavailable");
		};

		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);

		const workflowCmd = commands.find((c) => c.name === "workflow")!;
		const { ctx, messages } = buildCtx();

		await workflowCmd.options.handler("reload", ctx);

		assert.equal(
			messages.some((message) => message.includes("current registry was retained: package loader unavailable")),
			true,
		);
	});

	test.sequential("top-level /workflow reload refreshes package workflow resources before discovery", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-refresh-"));
		try {
			const existingWorkflow = join(dir, "existing.ts");
			const addedWorkflow = join(dir, "added.ts");
			await writeWorkflowFixture(existingWorkflow, "refresh-existing");
			await writeWorkflowFixture(addedWorkflow, "refresh-added");

			const { pi, commands } = buildMockPi();
			addFactoryStubs(pi);
			let refreshCalls = 0;
			pi.getWorkflowResources = () => [{ path: existingWorkflow, enabled: true }];
			pi.refreshWorkflowResources = async () => {
				refreshCalls += 1;
				return [
					{ path: existingWorkflow, enabled: true },
					{ path: addedWorkflow, enabled: true },
				];
			};

			const factoryModule = await import("../../packages/workflows/src/extension/index.js");
			factoryModule.default(pi);

			const workflowCmd = commands.find((c) => c.name === "workflow")!;
			const { ctx, messages } = buildCtx();

			await workflowCmd.options.handler("reload", ctx);

			assert.equal(refreshCalls, 1);
			assert.equal(
				messages.some((message) => message.includes("Reloaded workflow resources.")),
				true,
			);
			const completions = (await workflowCmd.options.getArgumentCompletions?.("refresh-add")) ?? [];
			assert.equal(
				completions?.some((completion) => completion.label === "refresh-added"),
				true,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test.sequential("top-level /workflow reload falls back to getWorkflowResources when refresh is unavailable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-refresh-fallback-"));
		try {
			const fallbackWorkflow = join(dir, "fallback.ts");
			await writeWorkflowFixture(fallbackWorkflow, "refresh-fallback");

			const { pi, commands } = buildMockPi();
			addFactoryStubs(pi);
			let getCalls = 0;
			pi.getWorkflowResources = () => {
				getCalls += 1;
				return [{ path: fallbackWorkflow, enabled: true }];
			};

			const factoryModule = await import("../../packages/workflows/src/extension/index.js");
			factoryModule.default(pi);

			const workflowCmd = commands.find((c) => c.name === "workflow")!;
			const { ctx, messages } = buildCtx();

			await workflowCmd.options.handler("reload", ctx);

			assert.equal(getCalls, 1);
			assert.equal(
				messages.some((message) => message.includes("Reloaded workflow resources.")),
				true,
			);
			const completions = (await workflowCmd.options.getArgumentCompletions?.("refresh-fall")) ?? [];
			assert.equal(
				completions?.some((completion) => completion.label === "refresh-fallback"),
				true,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test.sequential("exact slash status recognizes a live task tail", async () => {
		const { TASK_RESULT_CHECKPOINT_CONTROL_PREFIX } = await import(
			"../../packages/workflows/src/durable/stage-primitive.js"
		);
		const { IMPOSSIBLE_ROOT_LIVENESS_MESSAGE } = await import("../../packages/workflows/src/engine/run-liveness.js");
		const { toolControlRegistry } = await import("../../packages/workflows/src/engine/run-tool-control-registry.js");
		const runId = testRunId("slash-status-task-tail");
		store.recordRunStart({
			...makeInflightRun(runId),
			startedAt: 0,
			budget: { maxDurationMs: 10, warnAtPercent: 80 },
			stages: [
				{
					id: "review",
					name: "review",
					status: "completed",
					parentIds: [],
					toolEvents: [],
				},
			],
		});
		toolControlRegistry.register({
			runId,
			nodeId: `${TASK_RESULT_CHECKPOINT_CONTROL_PREFIX}stage:task:review:1`,
			name: "review",
			controller: new AbortController(),
			settled: new Promise(() => {}),
		});
		const { workflowCmd, sent } = await registerWorkflowCommand();
		const { ctx } = buildCtx();
		await workflowCmd.options.handler(`status ${runId}`, ctx);
		const payload = JSON.stringify(sent);
		assert.doesNotMatch(payload, new RegExp(IMPOSSIBLE_ROOT_LIVENESS_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(payload, new RegExp(runId));
	});
});

// ---------------------------------------------------------------------------
// resume regression: /workflow resume opens overlay + no legacy message
// ---------------------------------------------------------------------------
