/**
 * The model column of a subagent's row follows the model it runs on now, on both hosts: drawn in process, and drawn by
 * the isolated engine and shipped to the host as engine messages. A real supervising session launches a real subagent
 * through the `subagent` tool on a scripted model; the child's first model fails as a missing model, its session falls
 * back to the next model of its agent's `fallbackModels`, and it is later resumed on the model its session saved.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import type { Component, TUI } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import { ENV_AGENT_DIR, getEnvNames } from "../../packages/coding-agent/src/config.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { getOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	ModelRuntime,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { initTheme, type Theme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.js";
import { bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.js";
import {
	showEngineTaskInspector,
	showTaskInspector,
} from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { makeTempDirectory } from "../helpers/runtime.js";

/** A real parent and child session each load their resources; that load is the structural cost of these tests. */
const LIVE_TIMEOUT_MS = 180_000;
const WAIT = { timeout: 60_000, interval: 20 };
const WIDTH = 160;
const ROWS = 30;
const PROVIDER = "faux-panel-model";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
	clearSubagentControls();
});

/** The scripted world: a supervisor on `main`, a child whose `primary` model is missing and whose fallback answers. */
async function supervisor() {
	initTheme("dark");
	// Real child sessions, not the scripted stand-in tests otherwise get.
	vi.stubEnv("NODE_ENV", "production");
	const root = makeTempDirectory("atomic-panel-model-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const names = getEnvNames(ENV_AGENT_DIR);
	const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	for (const name of names) process.env[name] = agentDir;
	mkdirSync(join(root, ".atomic", "agents"), { recursive: true });
	writeFileSync(
		join(root, ".atomic", "agents", "modeler.md"),
		[
			"---",
			"name: modeler",
			"description: Reads a template and does what it says",
			`model: ${PROVIDER}/primary`,
			"thinking: high",
			`fallbackModels: ${PROVIDER}/backup:low`,
			"---",
			"",
			"Do the task.",
			"",
		].join("\n"),
	);
	const gates = {
		primary: Promise.withResolvers<void>(),
		backup: Promise.withResolvers<void>(),
		resumed: Promise.withResolvers<void>(),
	};
	const childRequests: string[] = [];
	let childId: string | undefined;
	const respond: FauxResponseFactory = async (context, _options, _state, model) => {
		if (model.id === "primary") {
			childRequests.push("primary");
			await gates.primary.promise;
			// A missing model falls back at once; an overloaded one is retried on the same model first (#4994).
			return fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "404 Not Found: the model primary is unavailable",
			});
		}
		if (model.id === "backup") {
			const resumed = JSON.stringify(context.messages).includes("Carry on with the template");
			childRequests.push(resumed ? "backup-resumed" : "backup");
			await (resumed ? gates.resumed : gates.backup).promise;
			return fauxAssistantMessage(resumed ? "resumed" : "done");
		}
		const last = context.messages.at(-1);
		const prompt = last?.role === "user" ? JSON.stringify(last.content) : "";
		if (prompt.includes("LAUNCH"))
			return fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						agent: "modeler",
						task: "Read the template and do what it says",
						wait: { kind: "background" },
					}),
				],
				{ stopReason: "toolUse" },
			);
		if (prompt.includes("RESUME") && childId !== undefined)
			return fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						action: "resume",
						id: childId,
						message: "Carry on with the template",
						wait: { kind: "background" },
					}),
				],
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage("ok");
	};
	const faux = registerFauxProvider({
		provider: PROVIDER,
		models: [{ id: "main" }, { id: "primary", reasoning: true }, { id: "backup", reasoning: true }],
	});
	faux.setResponses(Array.from({ length: 200 }, () => respond));
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(PROVIDER, {
		baseUrl: faux.getModel("main")!.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime,
		model: faux.getModel("main"),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, sessionSummary: { enabled: false } }),
		builtins: { mcp: false, "web-access": false },
	});
	session.subscribe((event) => {
		if (event.type !== "tool_execution_end" || event.toolName !== "subagent") return;
		const details = (event.result as { details?: { taskRecords?: Array<{ launchOperationId?: unknown }> } }).details;
		const launched = details?.taskRecords?.[0]?.launchOperationId;
		if (childId === undefined && typeof launched === "string") childId = launched;
	});
	cleanups.push(async () => {
		for (const gate of Object.values(gates)) gate.resolve();
		await session.dispose();
		faux.unregister();
		for (const name of names) {
			if (previous[name] === undefined) delete process.env[name];
			else process.env[name] = previous[name];
		}
		vi.unstubAllEnvs();
		// The child's Intercom spawns a detached broker for this agent dir that holds its SQLite files open, so Windows
		// cannot delete them until it exits.
		await removeTempRootReleasingBroker(root, agentDir);
	});
	return { session, gates, childRequests, childId: () => childId };
}

const fakeTui = { terminal: { rows: ROWS, columns: WIDTH }, requestRender() {} } as unknown as TUI;

interface Host {
	/** The agent panel's rows below the prompt, as the reader sees them. */
	panel(): string[];
	/** Opens `/tasks`, which hides the panel while it is open. */
	openTasks(): Promise<TasksView>;
}

interface TasksView {
	/** Waits until the open list's row of the child matches. */
	row(pattern: RegExp): Promise<void>;
	close(): Promise<void>;
}

type MountedView = Component & { handleInput?(data: string): void };
type ViewFactory = (tui: TUI, theme: Theme, keys: unknown, done: () => void) => MountedView;

/** A UI whose `custom` mounts the view the reader would see, and keeps it to draw and type into. */
function customMount() {
	let view: MountedView | undefined;
	return {
		view: () => view,
		custom: ((factory: ViewFactory) =>
			new Promise<void>((resolve) => {
				view = factory(fakeTui, theme, new KeybindingsManager(), () => {
					view = undefined;
					resolve();
				});
			})) as ExtensionUIContext["custom"],
	};
}

async function openTasksView(
	open: () => Promise<unknown>,
	view: () => MountedView | undefined,
	draw: (view: MountedView) => string[],
): Promise<TasksView> {
	const closed = open();
	await vi.waitFor(() => assert.ok(view(), "/tasks is open"), WAIT);
	return {
		row: (pattern) =>
			vi.waitFor(() => {
				const shown = view();
				assert.ok(shown, "/tasks is open");
				assert.match(modelerRow(draw(shown)), pattern);
			}, WAIT),
		async close() {
			view()?.handleInput?.("\u001b");
			await closed;
		},
	};
}

/** Opens `/tasks`, waits until its row of the child matches, and closes it again. */
async function tasksRow(host: Host, pattern: RegExp): Promise<void> {
	const tasks = await host.openTasks();
	try {
		await tasks.row(pattern);
	} finally {
		await tasks.close();
	}
}

/** The interactive mode's own binding: the panel and `/tasks` are drawn where the session runs. */
function inProcessHost(session: AgentSession): Host {
	let widget: Component | undefined;
	const unbind = bindAgentPanel(session, {
		setWidget(_key, content) {
			widget = typeof content === "function" ? content(fakeTui, theme) : undefined;
		},
		requestRender() {},
	} as Pick<ExtensionUIContext, "setWidget" | "requestRender"> as ExtensionUIContext);
	cleanups.push(unbind);
	const store = getOwnerTaskStore(session);
	assert.ok(store);
	const mount = customMount();
	const draw = (view: Component) => view.render(WIDTH).map((line) => stripVTControlCharacters(line));
	return {
		panel: () => (widget === undefined ? [] : draw(widget)),
		openTasks: () => openTasksView(() => showTaskInspector({ custom: mount.custom }, store), mount.view, draw),
	};
}

/**
 * The isolated engine: its panel bridge and `/tasks` draw in the engine through its RPC UI context and custom UI
 * service; the host mounts the remote components and paints only the frames the engine sends.
 */
function engineHost(session: AgentSession): Host {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) for (const listener of [...listeners]) listener(message);
	}, new KeybindingsManager());
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: () => () => {},
		onEngineMessage(listener) {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener) >>> 0, 1);
		},
		sendEngineCommand: (command) => service.handleLine(serializeInteractiveEngineFrame(command)),
	};
	const widgets = new Map<string, Component>();
	const mount = customMount();
	const hostUi = {
		custom: mount.custom,
		requestRender() {},
		setWidget(key: string, content: unknown) {
			if (typeof content === "function") widgets.set(key, content(fakeTui, theme));
			else widgets.delete(key);
		},
		onWidgetRelease: () => () => {},
	};
	const controller = new RemoteComponentController(runtime, hostUi as never, {
		isFullscreen: () => false,
		onRendererReplaced: () => () => {},
	});
	const engineUi = createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
		customUi: service,
	});
	const unbind = bindAgentPanel(session, engineUi);
	cleanups.push(() => {
		unbind();
		controller.dispose();
		service.dispose();
	});
	/** The host's frame: a render asks the engine for a new one, and the host paints the one it has. */
	const draw = (component: Component) => {
		component.render(WIDTH);
		return component.render(WIDTH).map((line) => stripVTControlCharacters(line));
	};
	return {
		panel: () => {
			const widget = widgets.get("atomic.agent-panel");
			return widget === undefined ? [] : draw(widget);
		},
		openTasks: () =>
			openTasksView(
				() => showEngineTaskInspector(session, { custom: service.custom.bind(service) }),
				mount.view,
				draw,
			),
	};
}

/** The child's row, or every line drawn when there is none, so a failure shows what the reader saw. */
function modelerRow(lines: readonly string[]): string {
	return lines.find((line) => /modeler/.test(line)) ?? `(no modeler row in ${JSON.stringify(lines)})`;
}

for (const [hostName, mount] of [
	["in process", inProcessHost],
	["the isolated engine", engineHost],
] as const) {
	test(
		`${hostName}: a subagent's panel and /tasks rows follow it from its first model to its fallback, and its resume, with each model's level`,
		async () => {
			const { session, gates, childRequests, childId } = await supervisor();
			await session.prompt("LAUNCH", { streamingBehavior: "followUp" });
			await vi.waitFor(() => assert.deepEqual(childRequests, ["primary"]), WAIT);
			const host = mount(session);
			const primary = /modeler {2}faux-panel-model\/primary high {2}Read the template and do what it says/;
			await vi.waitFor(() => assert.match(modelerRow(host.panel()), primary), WAIT);

			// The first model is missing: the child's session falls back to `backup` at its own level. An open /tasks
			// follows it there, and so does the panel once /tasks closes.
			const tasks = await host.openTasks();
			try {
				await tasks.row(/◯ modeler +faux-panel-model\/primary high {2}Read the template/);
				gates.primary.resolve();
				await vi.waitFor(() => assert.deepEqual(childRequests, ["primary", "backup"]), WAIT);
				// The open list keeps its model column as wide as it was, so the task does not move under the reader.
				await tasks.row(/◯ modeler +faux-panel-model\/backup low {4}Read the template/);
			} finally {
				await tasks.close();
			}
			const backup = /modeler {2}faux-panel-model\/backup low {2}Read the template and do what it says/;
			await vi.waitFor(() => assert.match(modelerRow(host.panel()), backup), WAIT);
			assert.doesNotMatch(host.panel().join("\n"), /primary/, "nothing still names the model it left");

			// It finishes: the panel lets it go, and /tasks keeps the model its last turn ran on.
			gates.backup.resolve();
			await vi.waitFor(() => assert.match(modelerRow(host.panel()), /^\(no modeler row/), WAIT);
			await tasksRow(host, /● modeler +faux-panel-model\/backup low {2,}Read the template/);

			// Resumed, it runs on the model its session saved, not the one its agent names: so does its row.
			assert.ok(childId());
			await session.prompt("RESUME", { streamingBehavior: "followUp" });
			await vi.waitFor(() => assert.ok(childRequests.includes("backup-resumed")), WAIT);
			// The resumed run's row reads its message as its task.
			await vi.waitFor(
				() =>
					assert.match(
						modelerRow(host.panel()),
						/modeler {2}faux-panel-model\/backup low {2}Carry on with the template/,
					),
				WAIT,
			);
			await tasksRow(host, /◯ modeler +faux-panel-model\/backup low {2,}Carry on with the template/);
			assert.doesNotMatch(host.panel().join("\n"), /primary/);
			gates.resumed.resolve();
			await tasksRow(host, /● modeler +faux-panel-model\/backup low {2,}Carry on with the template/);
			await vi.waitFor(() => assert.equal(session.isStreaming, false), WAIT);
		},
		LIVE_TIMEOUT_MS,
	);
}
