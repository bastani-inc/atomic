/**
 * An admitted subagent child must register with the Intercom broker as soon as
 * its session starts. Before this, a child only connected lazily on its own
 * first Intercom call, so a working child that never touched Intercom was
 * invisible to `intercom list` and unreachable by `send`/`ask` from its
 * launching stage or chat, even though both share the child's group.
 */
import assert from "node:assert/strict";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	SubagentChildPolicy,
	ToolDefinition,
} from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { runGenericHandlers } from "../../packages/coding-agent/src/core/extensions/runner-events.js";
import type { Extension, ExtensionError } from "../../packages/coding-agent/src/core/extensions/types.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import intercom from "../../packages/intercom/index.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { toolContext } from "../helpers/tool-context.js";

type HeavyModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type ImportResult = { error: Error } | { module: HeavyModule };
type LifecycleEvent = SessionStartEvent | SessionShutdownEvent;
type LifecycleHandler = (event: LifecycleEvent, ctx: ExtensionContext) => Promise<void> | void;
type LifecycleHandlers = Map<string, LifecycleHandler[]>;
type ConsoleErrorCall = Parameters<Console["error"]>;
type ConnectRegistration = Parameters<IntercomClient["connect"]>[0];

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));

const EXTENSION_PATH = "<intercom>";
const SESSION_START: SessionStartEvent = { type: "session_start", reason: "startup" };
const SESSION_SHUTDOWN: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
const originalConsoleError = console.error;
let consoleErrorCalls: ConsoleErrorCall[] = [];

beforeEach(() => {
	consoleErrorCalls = [];
	console.error = (...args: ConsoleErrorCall) => {
		consoleErrorCalls.push(args);
	};
});

afterEach(() => {
	console.error = originalConsoleError;
});

const admittedChildPolicy: SubagentChildPolicy = {
	managementActions: "restricted",
	fanoutAuthorized: false,
	inheritProjectContext: true,
	inheritSkills: true,
	intercomGroup: "workflow:run-1",
	intercom: {
		orchestratorTarget: "subagent-chat-parent",
		runId: "run-1",
		agent: "worker",
		index: 0,
		sessionName: "subagent-worker-run-1-1",
	},
};

/** The harness supplies only the context fields the Intercom runtime reads. */
function harnessContext(fields: Partial<ExtensionContext>): ExtensionContext {
	return fields as ExtensionContext;
}

function admittedChildContext(): ExtensionContext {
	return harnessContext({ cwd: process.cwd(), hasUI: false, subagentPolicy: admittedChildPolicy });
}

function plainSessionContext(): ExtensionContext {
	return harnessContext({ cwd: process.cwd(), hasUI: true });
}

function connectedChildContext(policy?: SubagentChildPolicy): ExtensionContext {
	return harnessContext({
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {} } as Partial<ExtensionContext["ui"]> as ExtensionContext["ui"],
		sessionManager: { getSessionId: () => "child-session", getBranch: () => [] } as never,
		...(policy === undefined ? {} : { subagentPolicy: policy }),
	});
}

/** Records lifecycle handlers and tools the way the host loader would. */
function harnessPi(handlers: LifecycleHandlers, tools: Map<string, ToolDefinition>) {
	let sessionName: string | undefined;
	return {
		on(event: string, handler: LifecycleHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry() {},
		getSessionName: () => sessionName,
		setSessionName(value: string) {
			sessionName = value;
		},
		getActiveTools: () => [],
		setActiveTools() {},
		events: createEventBus(),
	} as never as ExtensionAPI;
}

/**
 * The registered handlers as the host loader stores them, so lifecycle events
 * run through the real `runGenericHandlers` catch → `emitError` boundary.
 */
function hostExtension(handlers: LifecycleHandlers): Extension {
	const hostHandlers: Extension["handlers"] = new Map();
	for (const [event, registered] of handlers) {
		hostHandlers.set(
			event,
			registered.map((handler) => async (event, ctx) => {
				await handler(event as LifecycleEvent, ctx as ExtensionContext);
			}),
		);
	}
	return {
		path: EXTENSION_PATH,
		resolvedPath: EXTENSION_PATH,
		sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
		handlers: hostHandlers,
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Partial<Extension> as Extension;
}

async function emitThroughHost(
	handlers: LifecycleHandlers,
	ctx: ExtensionContext,
	event: LifecycleEvent,
): Promise<ExtensionError[]> {
	const reported: ExtensionError[] = [];
	await runGenericHandlers([hostExtension(handlers)], ctx, event, (error) => reported.push(error));
	return reported;
}

function executeIntercomTool(tools: Map<string, ToolDefinition>, action: string, ctx: ExtensionContext) {
	const tool = tools.get("intercom");
	assert.ok(tool, "intercom tool should be registered");
	return tool.execute("tool-call", { action }, new AbortController().signal, undefined, toolContext(ctx));
}

function heavyModule(onSessionStart: (ctx: ExtensionContext) => void): HeavyModule {
	return {
		default(heavyPi) {
			heavyPi.on("session_start", async (_event, ctx) => {
				onSessionStart(ctx);
			});
			heavyPi.registerTool({
				name: "intercom",
				label: "Intercom",
				description: "test intercom",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "connected" }], details: {} };
				},
			});
		},
	};
}

function fixture(importResults: ImportResult[]) {
	const handlers: LifecycleHandlers = new Map();
	const tools = new Map<string, ToolDefinition>();
	let imports = 0;
	intercom(harnessPi(handlers, tools), {
		async importHeavy() {
			const result = importResults[imports++];
			assert.ok(result, "each heavy initialization attempt needs a fixture result");
			if ("error" in result) throw result.error;
			return result.module;
		},
	});
	return {
		get imports() {
			return imports;
		},
		emitSessionStart: (ctx: ExtensionContext) => emitThroughHost(handlers, ctx, SESSION_START),
		executeIntercomTool: (ctx: ExtensionContext) => executeIntercomTool(tools, "list", ctx),
	};
}

function mockBrokerClient(connect: (registration: ConnectRegistration, registrationGroup?: string) => void) {
	vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(
		async (registration, _supervisor, _ownerToken, _messageSource, registrationGroup) => {
			connect(structuredClone(registration), registrationGroup);
		},
	);
	vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
}

describe("Intercom admitted subagent child warm-up", () => {
	test("connects an admitted child at session_start so its supervisor can list and steer it", async () => {
		const replayed: ExtensionContext[] = [];
		const current = fixture([{ module: heavyModule((ctx) => replayed.push(ctx)) }]);
		const ctx = admittedChildContext();

		const reported = await current.emitSessionStart(ctx);

		assert.deepEqual(reported, []);
		assert.equal(current.imports, 1, "the admitted child must initialize Intercom without waiting for a tool call");
		assert.deepEqual(replayed, [ctx]);
	});

	test("keeps a plain session lazy", async () => {
		const current = fixture([{ module: heavyModule(() => {}) }]);

		await current.emitSessionStart(plainSessionContext());

		assert.equal(current.imports, 0);
	});

	test("keeps a recoverable warm-up disconnect out of the child's launch and reconnects on the next call", async () => {
		const replayed: ExtensionContext[] = [];
		const current = fixture([
			{ error: new IntercomClientDisconnectedError() },
			{ module: heavyModule((ctx) => replayed.push(ctx)) },
		]);
		const ctx = admittedChildContext();

		const reported = await current.emitSessionStart(ctx);
		const result = await current.executeIntercomTool(ctx);

		assert.deepEqual(reported, []);
		assert.deepEqual(consoleErrorCalls, []);
		assert.equal(current.imports, 2);
		assert.deepEqual(replayed, [ctx]);
		assert.deepEqual(result.content, [{ type: "text", text: "connected" }]);
	});

	test("still reports a non-recoverable warm-up failure to the host", async () => {
		const importError = new Error("Cannot import Intercom heavy module");
		const current = fixture([{ error: importError }]);

		const reported = await current.emitSessionStart(admittedChildContext());

		assert.equal(reported.length, 1);
		assert.equal(reported[0]?.event, "session_start");
		assert.equal(reported[0]?.error, importError.message);
	});
});

describe("Intercom heavy runtime admitted child registration", () => {
	afterEach(() => vi.restoreAllMocks());

	function heavyFixture(policy?: SubagentChildPolicy) {
		const registrations: ConnectRegistration[] = [];
		const groups: Array<string | undefined> = [];
		mockBrokerClient((registration, registrationGroup) => {
			registrations.push(registration);
			groups.push(registrationGroup);
		});
		const handlers: LifecycleHandlers = new Map();
		intercomHeavy(harnessPi(handlers, new Map()));
		const ctx = connectedChildContext(policy);
		const fire = async (event: LifecycleEvent) => {
			for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
		};
		return { registrations, groups, fire };
	}

	test("registers an admitted child with its inherited group on session_start", async () => {
		const current = heavyFixture(admittedChildPolicy);
		try {
			await current.fire(SESSION_START);
			assert.equal(current.registrations.length, 1);
			assert.equal(current.registrations[0]?.group, "workflow:run-1");
			assert.deepEqual(current.groups, ["workflow:run-1"]);
		} finally {
			await current.fire(SESSION_SHUTDOWN);
		}
	});

	test("leaves a session without a typed child identity lazy", async () => {
		const current = heavyFixture();
		try {
			await current.fire(SESSION_START);
			assert.equal(current.registrations.length, 0);
		} finally {
			await current.fire(SESSION_SHUTDOWN);
		}
	});
});

describe("Intercom admitted child broker-connect recovery through the real composition", () => {
	afterEach(() => vi.restoreAllMocks());

	test("keeps a recoverable startup connect failure out of the launch and reconnects on the next call", async () => {
		const connectAttempts: ConnectRegistration[] = [];
		mockBrokerClient((registration) => {
			connectAttempts.push(registration);
			if (connectAttempts.length === 1) throw new IntercomClientDisconnectedError();
		});
		vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(() => connectAttempts.length >= 2);
		vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);
		const handlers: LifecycleHandlers = new Map();
		const tools = new Map<string, ToolDefinition>();
		intercom(harnessPi(handlers, tools));
		const ctx = connectedChildContext(admittedChildPolicy);
		try {
			const reported = await emitThroughHost(handlers, ctx, SESSION_START);
			assert.deepEqual(reported, []);
			assert.deepEqual(consoleErrorCalls, []);
			assert.equal(connectAttempts.length, 1, "startup must attempt the broker connection once");

			const result = await executeIntercomTool(tools, "status", ctx);

			assert.equal(connectAttempts.length, 2, "the next Intercom call must reconnect");
			assert.equal(connectAttempts[1]?.group, "workflow:run-1");
			const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
			assert.match(text, /Connected: Yes/);
		} finally {
			await emitThroughHost(handlers, ctx, SESSION_SHUTDOWN);
		}
	});
});
