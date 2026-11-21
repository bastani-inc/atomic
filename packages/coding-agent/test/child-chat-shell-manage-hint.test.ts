import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { bindOwnerTaskStore, type OwnerTaskStore } from "../src/core/tasks/owner-store.js";
import type { ChatMessageRenderOptions } from "../src/modes/interactive/components/chat-message-renderer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { EngineRenderService } from "../src/modes/interactive-engine/engine-render-service.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	parseInteractiveEngineCommand,
	parseInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.ts";
import { RemoteToolExecutionComponent } from "../src/modes/interactive-engine/remote-renderer.ts";

const transcripts = vi.hoisted(() => new Map<object, object>());
vi.mock("../src/core/tasks/supervisor.js", async (original) => ({
	...(await original<typeof import("../src/core/tasks/supervisor.js")>()),
	taskTranscriptSource: (lease: object) =>
		transcripts.has(lease)
			? { ok: true, value: { session: transcripts.get(lease) } }
			: { ok: false, error: { code: "TranscriptUnavailable" } },
}));

beforeAll(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

/**
 * The engine of a session whose subagent `agent-1` runs live, or was released and is drawn from its saved session, with
 * commands it, another subagent and the session launched.
 */
function engine(child: "live" | "released" = "live") {
	const lease = {};
	const chatSession =
		child === "live"
			? { getToolDefinition: () => undefined, extensionRunner: { resolveToolRenderers: () => undefined } }
			: undefined;
	transcripts.set(lease, { getSessionId: () => "child-session", getEntries: () => [], chatSession });
	const root = {
		sessionManager: { getCwd: () => "/root" },
		getToolDefinition: () => undefined,
		extensionRunner: { resolveToolRenderers: () => undefined },
	} as unknown as AgentSession;
	const records: Record<string, object> = {
		"agent-1": { execution: { kind: child === "live" ? "running" : "settled" } },
		"shell-own": { execution: { kind: "running" }, parentTaskId: "agent-1" },
		"shell-sibling": { execution: { kind: "running" }, parentTaskId: "agent-2" },
		"shell-main": { execution: { kind: "running" } },
	};
	bindOwnerTaskStore(root, {
		resolveTask: (id: string) =>
			id === "agent-1" ? { ok: true, value: lease } : { ok: false, error: { code: "UnknownTask" } },
		getTask: (id: string) => records[id],
		subscribe: () => () => {},
	} as unknown as OwnerTaskStore);
	const frames: string[][] = [];
	const service = new EngineRenderService((line) => {
		const event = parseInteractiveEngineMessage(line.trim());
		if (event?.type === "engine_custom_frame") frames.push(event.lines);
	});
	service.bindSession(root);
	let requestId = 0;
	const render = async (taskId: string, keptTaskAction?: "tasks" | "ownTasks" | "openWaited" | "none") => {
		const before = frames.length;
		service.handleLine(
			JSON.stringify({
				type: "engine_tool_render",
				componentId: `row-${taskId}`,
				requestId: ++requestId,
				width: 80,
				toolName: "bash",
				toolCallId: `call-${taskId}`,
				rendererTaskId: "agent-1",
				...(keptTaskAction === undefined ? {} : { keptTaskAction }),
				args: { command: "npm run build" },
				result: {
					content: [{ type: "text", text: `(no output)\n\nCommand is still running (task ${taskId}).` }],
					details: { observation: { kind: "yielded", taskId, waitId: "wait", reason: "budget" } },
					isError: false,
				},
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				imageWidthCells: 60,
			}),
		);
		await vi.waitFor(() => assert.ok(frames.length > before));
		return frames.at(-1)!.map((line) => stripTerminalSequences(line).trimEnd());
	};
	return {
		render,
		close: () => {
			service.dispose();
			transcripts.delete(lease);
		},
	};
}

const HINT = "   ⎿  Running in background · /tasks to manage";
const PLAIN = "   ⎿  Running in background";
const KEY_HINT = "   ⎿  Running in background · alt+w opens it";

test("the engine draws a subagent chat's background command with the /tasks hint exactly when its chat lists it", async () => {
	const e = engine();
	try {
		assert.ok((await e.render("shell-own", "ownTasks")).includes(HINT));
		assert.ok((await e.render("shell-own", "tasks")).includes(HINT));
		assert.ok((await e.render("shell-own", "openWaited")).includes(KEY_HINT));
		assert.ok((await e.render("shell-own", "none")).includes(PLAIN));
		// A host that says nothing, as an earlier version does, gets the rows it got before.
		assert.ok((await e.render("shell-own")).includes(PLAIN));
	} finally {
		e.close();
	}
});

test("a released subagent's chat drawn from its saved session gives the hint only to the commands its /tasks lists", async () => {
	const e = engine("released");
	try {
		assert.ok((await e.render("shell-own", "tasks")).includes(HINT));
		for (const other of ["shell-sibling", "shell-main"]) {
			const rows = await e.render(other, "none");
			assert.ok(rows.includes(PLAIN), rows.join("\n"));
		}
		// An earlier host's rows are drawn as before, from the session's own task records.
		for (const any of ["shell-own", "shell-sibling", "shell-main"]) {
			const rows = await e.render(any);
			assert.ok(rows.includes(HINT), rows.join("\n"));
		}
	} finally {
		e.close();
	}
});

test("a render command names what its chat offers only as one of its actions, and earlier commands still parse", () => {
	const command = {
		type: "engine_tool_render",
		componentId: "row",
		requestId: 1,
		width: 80,
		toolName: "bash",
		toolCallId: "call",
		args: {},
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		imageWidthCells: 60,
	};
	const offered = (value?: unknown) =>
		(
			parseInteractiveEngineCommand(
				JSON.stringify(value === undefined ? command : { ...command, keptTaskAction: value }),
			) as { keptTaskAction?: string } | undefined
		)?.keptTaskAction;
	assert.equal(offered(), undefined);
	for (const value of ["tasks", "ownTasks", "openWaited", "none"]) assert.equal(offered(value), value);
	for (const value of [true, 1, "manage", null, {}]) assert.equal(offered(value), undefined);
});

test("a row tells the engine what its chat lists when drawn, and a row rebuilt after the list changed never shows the earlier frame", () => {
	const commands: InteractiveEngineCommand[] = [];
	const runtime = {
		session: { sessionManager: { getSessionId: () => "session" } },
		onEngineMessage: () => () => {},
		sendEngineCommand: (command: InteractiveEngineCommand) => commands.push(command),
	} as unknown as IsolatedInteractiveRuntime;
	const listed = new Set(["shell-own"]);
	const result = {
		content: [{ type: "text" as const, text: "(no output)\n\nCommand is still running (task shell-own)." }],
		details: { observation: { kind: "yielded", taskId: "shell-own", waitId: "wait", reason: "budget" } },
		isError: false,
	};
	const rows: RemoteToolExecutionComponent[] = [];
	/** The row the chat builds for the call, as it builds one again when what the row depends on changed. */
	const build = (keptTaskAction?: (taskId: string) => "tasks" | undefined) => {
		const row = new RemoteToolExecutionComponent(
			"bash",
			"call-own",
			{ command: "npm run build" },
			{ rendererTaskId: "agent-1", ...(keptTaskAction === undefined ? {} : { keptTaskAction }) },
			runtime,
			() => {},
		);
		rows.push(row);
		row.updateResult(result);
		return row;
	};
	const lastCommand = () => commands.at(-1) as Extract<InteractiveEngineCommand, { type: "engine_tool_render" }>;
	try {
		const offer = (taskId: string) => (listed.has(taskId) ? ("tasks" as const) : undefined);
		const first = build(offer);
		first.render(80);
		const request = lastCommand();
		assert.equal(request.keptTaskAction, "tasks");
		first.receive({
			type: "engine_custom_frame",
			componentId: request.componentId,
			requestId: request.requestId,
			lines: [HINT],
		});
		assert.deepEqual(first.render(80), [HINT]);
		// Rebuilt while the list is the same, the row paints the frame it had until the engine answers.
		assert.deepEqual(build(offer).render(80), [HINT]);
		listed.clear();
		const rebuilt = build(offer);
		assert.notDeepEqual(rebuilt.render(80), [HINT]);
		assert.equal(lastCommand().keptTaskAction, "none");
		// A chat that does not decide what it offers sends nothing about it.
		build().render(80);
		assert.equal("keptTaskAction" in lastCommand(), false);
	} finally {
		for (const row of rows) row.dispose();
	}
});

test("with the isolated engine, a subagent chat's rows ask the engine with what that chat's /tasks lists", () => {
	const commands: InteractiveEngineCommand[] = [];
	const runtimeHost: IsolatedInteractiveRuntime = Object.create(IsolatedInteractiveRuntime.prototype, {
		session: { value: { sessionManager: { getSessionId: () => "session" } } },
		onEngineMessage: { value: () => () => {} },
		onGenerationEnded: { value: () => () => {} },
		sendEngineCommand: { value: (command: InteractiveEngineCommand) => commands.push(command) },
	});
	const chatMessageRenderOptions = Reflect.get(InteractiveMode.prototype, "chatMessageRenderOptions") as (
		this: object,
	) => ChatMessageRenderOptions;
	const options = chatMessageRenderOptions.call({
		runtimeHost,
		ui: { requestRender: () => {} },
		sessionManager: { getCwd: () => "/workspace" },
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getLatexRenderingEnabled: () => true,
		},
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
		hideThinkingBlock: false,
		hiddenThinkingLabel: "",
		toolOutputExpanded: false,
		outputPad: 1,
	});
	const row = options.createToolComponent?.(
		{
			role: "tool",
			kind: "tool",
			toolName: "bash",
			toolCallId: "call-own",
			args: { command: "npm run build" },
			result: {
				content: [{ type: "text", text: "(no output)\n\nCommand is still running (task shell-own)." }],
				details: { observation: { kind: "yielded", taskId: "shell-own", waitId: "wait", reason: "budget" } },
				isError: false,
			},
			isPartial: false,
		},
		{
			requestRender: () => {},
			expanded: false,
			outputPad: 1,
			showImages: false,
			keptTaskAction: (taskId) => (taskId === "shell-own" ? "tasks" : undefined),
		},
	);
	assert.ok(row instanceof RemoteToolExecutionComponent);
	try {
		row.render(80);
		const request = commands.findLast((command) => command.type === "engine_tool_render") as
			| Extract<InteractiveEngineCommand, { type: "engine_tool_render" }>
			| undefined;
		assert.equal(request?.keptTaskAction, "tasks");
	} finally {
		row.dispose();
	}
});
