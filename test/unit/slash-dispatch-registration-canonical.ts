// @ts-nocheck
import { describe, test } from "vitest";
import type { ExtensionAPI, PiCommandContext, PiCommandOptions, StageControlHandle } from "./slash-dispatch-utils.js";
import {
	addFactoryStubs,
	assert,
	buildCtx,
	buildMockPi,
	installSlashDispatchTestHooks,
	runFactory,
	stageControlRegistry,
	store,
	WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("/workflow <name> --help prints schema without dispatching", () => {
	test.sequential("--help token short-circuits to the schema printer", async () => {
		const { pi, commands, sent } = buildMockPi();
		await runFactory(pi);

		const workflowCmd = commands.find((c) => c.name === "workflow");
		const { ctx, messages } = buildCtx();

		await workflowCmd!.options.handler("fan-out-and-synthesize --help", ctx);

		// Schema printer prints the pretty themed header or the plain text header.
		assert.ok(
			messages.some((m) => /INPUTS FOR FAN-OUT-AND-SYNTHESIZE|Inputs for "fan-out-and-synthesize":/.test(m)),
			`expected schema header in messages; got: ${JSON.stringify(messages)}`,
		);
		assert.equal(
			sent.some((message) => message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE),
			false,
			"interactive help output should continue using ctx.ui.notify",
		);
		// Should NOT have a run completion/failure line
		assert.equal(
			messages.some((m) => m.includes("started") || m.includes("completed (runId:")),
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// Canonical registerCommand shape — opts.handler, no opts.execute
// ---------------------------------------------------------------------------

interface RawRegisteredCommand {
	name: string;
	options: PiCommandOptions;
}

function buildRawMockPi(): {
	pi: ExtensionAPI;
	commands: RawRegisteredCommand[];
	sent: SentMessage[];
} {
	const commands: RawRegisteredCommand[] = [];
	const sent: SentMessage[] = [];
	const pi: ExtensionAPI = {
		registerCommand: (name: string, options: PiCommandOptions) => {
			commands.push({ name, options });
		},
		sendMessage: (msg: SentMessage) => {
			sent.push(msg);
		},
	};
	return { pi, commands, sent };
}

describe("canonical registerCommand — opts.handler shape", () => {
	async function runFactoryRaw(): Promise<{
		commands: RawRegisteredCommand[];
		sent: SentMessage[];
	}> {
		const { pi, commands, sent } = buildRawMockPi();
		await runFactory(pi);
		return { commands, sent };
	}

	test.sequential("registerCommand receives string name 'workflow'", async () => {
		const { commands } = await runFactoryRaw();
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("workflow"));
	});

	test.sequential("registerCommand does not receive per-workflow alias names", async () => {
		const { commands } = await runFactoryRaw();
		const names = commands.map((c) => c.name);
		assert.equal(
			names.some((n) => n.startsWith("workflow:")),
			false,
		);
	});

	test.sequential("opts passed to registerCommand have 'handler' (function)", async () => {
		const { commands } = await runFactoryRaw();
		for (const { name, options } of commands) {
			assert.equal(typeof options.handler, "function", `${name}: handler should be function`);
		}
	});

	test.sequential("opts passed to registerCommand do NOT have 'execute' property", async () => {
		const { commands } = await runFactoryRaw();
		for (const { name, options } of commands) {
			assert.equal(Object.hasOwn(options, "execute"), false, `${name}: opts must not have execute — use handler`);
		}
	});

	test.sequential("opts have 'description' string", async () => {
		const { commands } = await runFactoryRaw();
		for (const { name, options } of commands) {
			assert.equal(typeof options.description, "string", `${name}: description should be string`);
		}
	});

	test.sequential("handler for 'workflow' is callable — does not throw synchronously", async () => {
		const { commands, sent } = await runFactoryRaw();
		const workflowCmd = commands.find((c) => c.name === "workflow");
		assert.notEqual(workflowCmd, undefined);
		const msgs: string[] = [];
		const ctx: PiCommandContext = {
			ui: {
				notify(message: string) {
					msgs.push(message);
				},
			},
		};
		await workflowCmd!.options.handler("list", ctx);
		// `/workflow list` now routes through `emitChatSurface` → pi.sendMessage,
		// so the catalogue payload lands in `sent` rather than `msgs`. Either
		// path counts as the handler having produced output.
		assert.ok(msgs.length > 0 || sent.length > 0);
		if (sent.length > 0) {
			const listPayload = sent.find((m) => (m.details as { kind?: string } | undefined)?.kind === "list");
			assert.ok(listPayload, "expected a chat-surface list message to be sent");
		}
	});
});

// ---------------------------------------------------------------------------
// resume regression: /workflow resume opens overlay + no legacy message
// ---------------------------------------------------------------------------

function makeInflightRun(id: string) {
	return {
		id,
		name: "test-wf",
		inputs: {},
		status: "running" as const,
		stages: [],
		startedAt: Date.now(),
	};
}

async function _registerWorkflowCommand() {
	const { pi, commands, sent } = buildMockPi();
	addFactoryStubs(pi);
	const factoryModule = await import("../../packages/workflows/src/extension/index.js");
	factoryModule.default(pi);
	const workflowCmd = commands.find((c) => c.name === "workflow");
	assert.notEqual(workflowCmd, undefined);
	return { pi, commands, sent, workflowCmd: workflowCmd! };
}

function _recordTerminalRun(
	id: string,
	status: "completed" | "failed" | "killed",
	overrides: { name?: string; startedAt?: number; endedAt?: number } = {},
): void {
	store.recordRunStart({
		...makeInflightRun(id),
		name: overrides.name ?? "terminal-wf",
		startedAt: overrides.startedAt ?? Date.now() - 10_000,
	});
	const completed = status === "completed";
	store.recordRunEnd(id, status, completed ? { ok: true } : undefined, completed ? undefined : status);
	if (overrides.endedAt !== undefined) {
		const run = store.runs().find((r) => r.id === id);
		if (run) {
			run.endedAt = overrides.endedAt;
			run.durationMs = run.endedAt - run.startedAt;
		}
	}
}

function _registerTestStageHandle(
	runId: string,
	stageId: string,
	status: StageControlHandle["status"] = "running",
): void {
	const handle: StageControlHandle = {
		runId,
		stageId,
		stageName: "worker",
		status,
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached(): Promise<void> {},
		async prompt(): Promise<void> {},
		async steer(): Promise<void> {},
		async followUp(): Promise<void> {},
		async pause(): Promise<void> {},
		async resume(): Promise<void> {},
		subscribe: () => () => {},
	};
	stageControlRegistry.register(handle);
}
