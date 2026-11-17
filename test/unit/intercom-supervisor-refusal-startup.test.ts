/**
 * A subagent's supervisor capability can be stale by the time the child registers: the session it was issued to
 * released or restarted, as a workflow stage that finished its turn does. The broker then refuses the capability.
 * That must never end the child's start; the child registers without it and reaches its supervisor by name.
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
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { runGenericHandlers } from "../../packages/coding-agent/src/core/extensions/runner-events.js";
import type { Extension, ExtensionError } from "../../packages/coding-agent/src/core/extensions/types.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import intercom from "../../packages/intercom/index.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: false, hasSharedStorage: false, protocol: { min: 1, max: 3 } }),
}));

type LifecycleEvent = SessionStartEvent | SessionShutdownEvent;
type LifecycleHandler = (event: LifecycleEvent, ctx: ExtensionContext) => Promise<void> | void;
type Connect = IntercomClient["connect"];

afterEach(() => vi.restoreAllMocks());

const policy: SubagentChildPolicy = {
	managementActions: "restricted",
	fanoutAuthorized: false,
	inheritProjectContext: true,
	inheritSkills: true,
	intercomGroup: "workflow:run-1",
	intercom: {
		orchestratorTarget: "stage-intercom-id",
		runId: "run-1",
		agent: "debugger",
		index: 0,
		sessionName: "subagent-debugger-run-1-1",
		supervisor: { capability: "issued.to-a-session-that-left", supervisorSessionId: "stage-intercom-id" },
	},
};

function childContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "child-session", getBranch: () => [], getEntries: () => [] },
		subagentPolicy: policy,
	} as never as ExtensionContext;
}

function startChild(refusal: Error) {
	const handlers = new Map<string, LifecycleHandler[]>();
	const tools = new Map<string, ToolDefinition>();
	let sessionName: string | undefined;
	const pi = {
		on(event: string, handler: LifecycleHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		getSessionName: () => sessionName,
		setSessionName(value: string) {
			sessionName = value;
		},
		getActiveTools: () => [],
		setActiveTools() {},
		events: createEventBus(),
	} as never as ExtensionAPI;
	const registrations: Array<{ readonly supervisor: Parameters<Connect>[1] }> = [];
	vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async (_registration, supervisor) => {
		registrations.push({ supervisor });
		if (supervisor !== undefined) throw refusal;
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(
		() => registrations.length > 0 && registrations.at(-1)?.supervisor === undefined,
	);
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	intercom(pi);
	const extension = {
		path: "<intercom>",
		resolvedPath: "<intercom>",
		sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
		handlers: new Map(
			[...handlers].map(([event, registered]) => [
				event,
				registered.map((handler) => async (event: object, ctx: object) => {
					await handler(event as LifecycleEvent, ctx as ExtensionContext);
				}),
			]),
		),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Partial<Extension> as Extension;
	const ctx = childContext();
	const emit = async (event: LifecycleEvent) => {
		const reported: ExtensionError[] = [];
		await runGenericHandlers([extension], ctx, event, (error) => reported.push(error));
		return reported;
	};
	return { emit, registrations };
}

for (const [label, refusal] of [
	["a broker that names the refusal", undefined],
	["an older broker that gives only the reason", new Error("Invalid supervisor authorization")],
] as const) {
	test(`a refused supervisor capability never fails the child's start, from ${label}`, async () => {
		const { IntercomSupervisorAuthorizationRefusedError } = await import(
			"../../packages/intercom/supervisor-refusal.js"
		);
		const child = startChild(refusal ?? new IntercomSupervisorAuthorizationRefusedError());
		try {
			const reported = await child.emit({ type: "session_start", reason: "startup" });
			assert.deepEqual(reported, [], "the child's extensions start");
			assert.equal(child.registrations.length, 2, "it registers again at once");
			assert.ok(child.registrations[0]?.supervisor, "the first registration offered the capability");
			assert.equal(child.registrations[1]?.supervisor, undefined, "the second registers without it");
		} finally {
			await child.emit({ type: "session_shutdown", reason: "quit" });
		}
	});
}
