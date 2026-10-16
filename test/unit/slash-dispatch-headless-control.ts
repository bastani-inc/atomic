// @ts-nocheck
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { testRunId } from "../helpers/run-id.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";
import type { ChatSurfacePayload, ExtensionAPI, PiCommandContext, PiCommandOptions } from "./slash-dispatch-utils.js";
import {
	addFactoryStubs,
	assert,
	buildMockPi,
	installSlashDispatchTestHooks,
	join,
	makeInflightRun,
	mkdtemp,
	registerTestStageHandle,
	rm,
	runFactory,
	store,
	tmpdir,
	WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
	writeFile,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();
const MISSING_RUN_ID = testRunId("definitely-missing");

beforeEach(() => setDurableBackend(new InMemoryDurableBackend()));
afterEach(() => setDurableBackend(undefined));

describe("/workflow command in non-interactive (-p) mode (#1156 regressions)", () => {
	async function registerWorkflowCommand(): Promise<{
		handler: NonNullable<PiCommandOptions["handler"]>;
		sent: SentMessage[];
	}> {
		const { pi, commands, sent } = buildMockPi();
		await runFactory(pi);
		const cmd = commands.find((c) => c.name === "workflow");
		assert.ok(cmd, "expected /workflow command registration");
		return { handler: cmd.options.handler, sent };
	}

	type ExtensionEventHandler = Parameters<NonNullable<ExtensionAPI["on"]>>[1];
	type NotificationType = "info" | "warning" | "error";
	interface RecordedNotification {
		message: string;
		type?: NotificationType;
	}

	function commandCtx(hasUI: boolean | undefined): {
		ctx: PiCommandContext;
		messages: string[];
		notifications: RecordedNotification[];
		pickerCalls: string[];
	} {
		const messages: string[] = [];
		const notifications: RecordedNotification[] = [];
		const pickerCalls: string[] = [];
		const ctx: PiCommandContext = {
			...(hasUI === undefined ? {} : { hasUI }),
			ui: {
				notify: (msg: string, type?: NotificationType) => {
					messages.push(msg);
					notifications.push({ message: msg, type });
				},
				setEditorComponent: () => {
					pickerCalls.push("inline");
					throw new Error("inline form unsupported in test");
				},
				custom: async (factory) => {
					pickerCalls.push("overlay");
					const component = await factory({ requestRender: () => undefined }, {}, {}, () => undefined);
					component.dispose?.();
					return undefined;
				},
			},
		};
		return { ctx, messages, notifications, pickerCalls };
	}

	function headlessNoOpCtx(): PiCommandContext {
		return {
			hasUI: false,
			ui: { notify: () => undefined },
		};
	}

	function isHeadlessWorkflowCommandError(pattern: RegExp): (error: unknown) => boolean {
		return (error: unknown): boolean =>
			error instanceof Error && error.name === "WorkflowHeadlessCommandError" && pattern.test(error.message);
	}

	async function assertRejectsHeadlessCommand(
		action: () => Promise<void> | void,
		messagePattern: RegExp,
	): Promise<void> {
		await assert.rejects(async () => {
			await action();
		}, isHeadlessWorkflowCommandError(messagePattern));
	}

	function chatSurfacePayload(message: SentMessage): ChatSurfacePayload | undefined {
		const details = message.details;
		if (typeof details !== "object" || details === null || !("kind" in details)) {
			return undefined;
		}
		return details as ChatSurfacePayload;
	}

	function commandOutputMessages(sent: readonly SentMessage[]): SentMessage[] {
		return sent.filter((message) => message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE);
	}

	async function registerWorkflowCommandWithResource(
		fileName: string,
		source: string,
	): Promise<{
		handler: NonNullable<PiCommandOptions["handler"]>;
		sent: SentMessage[];
		cleanup: () => Promise<void>;
	}> {
		const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-slash-"));
		const filePath = join(dir, fileName);
		await writeFile(filePath, source, "utf8");

		const { pi, commands, sent } = buildMockPi();
		addFactoryStubs(pi);
		pi.disableAsyncDiscovery = false;
		pi.refreshWorkflowResources = async () => [{ path: filePath, enabled: true }];

		const events = new Map<string, ExtensionEventHandler[]>();
		pi.on = (event, handler) => {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
		};

		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);

		for (const startHandler of events.get("session_start") ?? []) {
			await startHandler({}, { ui: { notify: () => undefined } });
		}

		const cmd = commands.find((c) => c.name === "workflow");
		assert.ok(cmd, "expected /workflow command registration");
		return {
			handler: cmd.options.handler,
			sent,
			cleanup: () => rm(dir, { recursive: true, force: true }),
		};
	}

	test.sequential("/workflow quit <missing> rejects visibly in headless mode", async () => {
		const { handler } = await registerWorkflowCommand();

		await assertRejectsHeadlessCommand(
			() => handler(`quit ${MISSING_RUN_ID}`, headlessNoOpCtx()),
			new RegExp(`Run not found: ${MISSING_RUN_ID}`),
		);
	});

	test.sequential.each([
		["reload", "reload", /Reloaded workflow resources\./],
		["quit", "quit", /quit.*resume|resume.*quit/i],
		["pause", "pause", /paused and can be resumed/],
		["resume", "resume", /Resumed 1 stage\(s\)/],
	])("/workflow %s emits displayable success output in headless mode", async (_label, action, expected) => {
		const { handler, sent } = await registerWorkflowCommand();
		const runId = testRunId(`headless-control-${action}`);
		const stageId = `stage-${action}`;

		if (action !== "reload") {
			const stageStatus = action === "resume" ? "paused" : "running";
			store.recordRunStart({
				...makeInflightRun(runId),
				stages: [
					{
						id: stageId,
						name: "worker",
						status: stageStatus,
						parentIds: [],
						startedAt: Date.now(),
						toolEvents: [],
					},
				],
			});
			registerTestStageHandle(runId, stageId, stageStatus);
		}

		await handler(action === "reload" ? "reload" : `${action} ${runId}`, headlessNoOpCtx());

		const outputs = commandOutputMessages(sent);
		assert.ok(outputs.length > 0, `expected /workflow ${action} to emit command output`);
		const content = outputs.map((message) => message.content ?? "").join("\n");
		assert.match(content, expected);
		if (action !== "reload") assert.ok(content.includes(runId), `expected full run id ${runId} in ${action} output`);
	});

	test.sequential("/workflow pause --all emits displayable success output in headless mode", async () => {
		const { handler, sent } = await registerWorkflowCommand();
		const runId = testRunId(`headless-pause-all-${Date.now()}`);
		const stageId = "stage-pause-all";
		store.recordRunStart({
			...makeInflightRun(runId),
			stages: [
				{
					id: stageId,
					name: "worker",
					status: "running",
					parentIds: [],
					startedAt: Date.now(),
					toolEvents: [],
				},
			],
		});
		registerTestStageHandle(runId, stageId);

		await handler("pause --all", headlessNoOpCtx());

		const content = commandOutputMessages(sent)
			.map((message) => message.content ?? "")
			.join("\n");
		assert.match(content, /Paused 1 run\(s\)\./);
	});

	test.sequential("/workflow quit --all emits displayable resumable success output in headless mode", async () => {
		const { handler, sent } = await registerWorkflowCommand();
		const runId = testRunId(`headless-quit-all-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		registerTestStageHandle(runId, "quit-stage");

		await handler("quit --all", headlessNoOpCtx());

		const content = commandOutputMessages(sent)
			.map((message) => message.content ?? "")
			.join("\n");
		assert.match(content, /quit.*resume|resume.*quit/i);
	});

	test.sequential("headless workflow failure remains visible through run status after acceptance", async () => {
		const resource = await registerWorkflowCommandWithResource(
			"terminal-failure.ts",
			`import { workflow } from "@bastani/atomic/workflows";

export default workflow({
  name: "terminal-failure",
  description: "Fails after dispatch",
  inputs: {},
  outputs: {},
  run: async () => {
    throw new Error("terminal boom");
  },
});
`,
		);

		try {
			await resource.handler("terminal-failure", headlessNoOpCtx());
			const accepted = resource.sent.find((message) => chatSurfacePayload(message)?.kind === "detail");
			const runId = chatSurfacePayload(accepted).detail.runId;
			await vi.waitFor(async () => {
				await resource.handler(`status ${runId}`, headlessNoOpCtx());
				const detail = chatSurfacePayload(resource.sent.at(-1));
				assert.equal(detail.detail.status, "failed");
				assert.match(JSON.stringify(detail), /terminal boom/);
			});
		} finally {
			await resource.cleanup();
		}
	}, 15_000);

	test.sequential("headless workflow acceptance and eventual success emit printable run details", async () => {
		const resource = await registerWorkflowCommandWithResource(
			"headless-terminal-success.ts",
			`import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export default workflow({
  name: "headless-terminal-success",
  description: "Completes without user input",
  inputs: {},
  outputs: {
    ok: Type.Optional(Type.Any()),
    value: Type.Optional(Type.Any()),
  },
  run: async (ctx) => {
    await ctx.stage("terminal-stage").prompt("finish");
    return { ok: true, value: "terminal" };
  },
});
`,
		);

		try {
			await resource.handler("headless-terminal-success", headlessNoOpCtx());
			const accepted = resource.sent.find((message) => chatSurfacePayload(message)?.kind === "detail");
			const runId = chatSurfacePayload(accepted).detail.runId;
			await vi.waitFor(async () => {
				await resource.handler(`status ${runId}`, headlessNoOpCtx());
				assert.equal(chatSurfacePayload(resource.sent.at(-1)).detail.status, "completed");
			});

			assert.equal(
				resource.sent.some((message) => chatSurfacePayload(message)?.kind === "dispatch"),
				false,
				"headless success must not emit an interactive dispatch surface",
			);

			const detailMessage = resource.sent.findLast((message) => chatSurfacePayload(message)?.kind === "detail");
			assert.ok(detailMessage, "expected a terminal run detail chat surface");
			const detailPayload = chatSurfacePayload(detailMessage);
			assert.ok(detailPayload?.kind === "detail", "expected terminal run detail payload");
			assert.equal(detailPayload.detail.status, "completed");
			assert.deepEqual(detailPayload.detail.result, {
				ok: true,
				value: "terminal",
			});
			assert.ok(detailPayload.detail.stages.length > 0, "expected completed stage details");
			assert.equal(
				detailPayload.detail.stages.some((stage) => stage.status === "completed"),
				true,
			);
			// Background completion may publish a lifecycle notice; the accepted run
			// and its eventual terminal detail remain independently inspectable.
			assert.equal(detailMessage.display, true, "terminal detail must be displayable for print mode");
			assert.equal(typeof detailMessage.content, "string");

			const printableDetail = detailMessage.content ?? "";
			assert.match(printableDetail, /headless-terminal-success/);
			assert.match(printableDetail, /completed/);
			assert.match(printableDetail, /STAGES/);
			assert.match(printableDetail, /terminal-stage/);
			assert.match(printableDetail, /"value":"terminal"/);
		} finally {
			await resource.cleanup();
		}
	}, 15_000);

	test.sequential("/workflow unknown workflow remains notify-and-handled with an interactive UI", async () => {
		const { handler } = await registerWorkflowCommand();
		const { ctx, notifications } = commandCtx(true);

		await assert.doesNotReject(async () => {
			await handler("ghost-workflow", ctx);
		});

		const error = notifications.find((entry) => entry.type === "error");
		assert.ok(error, "expected interactive errors to be reported via notify('error')");
		assert.match(error.message, /Workflow not found: ghost-workflow/);
	});

	test.sequential("/workflow still uses picker-capable path when a UI is available", async () => {
		const { handler } = await registerWorkflowCommand();
		const { ctx, pickerCalls } = commandCtx(true);

		await handler("fan-out-and-synthesize", ctx);

		assert.ok(pickerCalls.length > 0, "expected interactive picker path to be attempted");
	});

	test.sequential("/workflow prefers host-native input form over callable isolated editor stub and Escape cancellation does not dispatch", async () => {
		const { handler, sent } = await registerWorkflowCommand();
		const calls: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				notify: () => undefined,
				hostInputForm: async () => {
					calls.push("host");
					return undefined;
				},
				setEditorComponent: () => {
					calls.push("inline-noop");
				},
				getEditorComponent: () => undefined,
				custom: async () => {
					calls.push("remote-custom");
					return undefined;
				},
			},
		} as PiCommandContext;

		await handler("fan-out-and-synthesize", ctx);

		assert.deepEqual(calls, ["host"]);
		assert.equal(
			sent.some((message) => chatSurfacePayload(message)?.kind === "dispatch"),
			false,
			"cancelled host form must not dispatch the workflow",
		);
	});

	test.sequential("/workflow proceeds when hasUI is unset (degraded runtimes)", async () => {
		const { handler, sent } = await registerWorkflowCommand();
		const { ctx, messages } = commandCtx(undefined);

		await handler("list", ctx);

		assert.equal(messages.length, 0);
		assert.ok(sent.length > 0, "expected /workflow list to emit a chat surface");
	});
});
