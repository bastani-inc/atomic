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
// Loaded up front, as a running host has it: the child's Intercom loads it on its start, under the fake clock here.
import "../../packages/intercom/index-heavy.js";
import {
	IntercomSupervisorAuthorizationRefusedError,
	SUPERVISOR_REFUSAL_RETRY_MS,
} from "../../packages/intercom/supervisor-refusal.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: false, hasSharedStorage: false, protocol: { min: 1, max: 4 } }),
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

function startChild(refusal: Error, refusals = Number.POSITIVE_INFINITY) {
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
	let refused = 0;
	let connected = false;
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async (_registration, supervisor) => {
		registrations.push({ supervisor });
		if (supervisor !== undefined && refused < refusals) {
			refused++;
			throw refusal;
		}
		connected = true;
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(() => connected);
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

afterEach(() => vi.useRealTimers());

const realSetTimeout = globalThis.setTimeout;
const realNow = performance.now.bind(performance);
/** Real time the child's start may take to reach the broker: it reads its configuration and project group first. */
const FIRST_REGISTRATION_WAIT_MS = 10_000;

/**
 * Waits in real time until the child first offers its registration, then advances the fake clock in steps until
 * `done()`. The start's disk reads and Git lookup finish in real time, not on the fake clock, so fake time runs only
 * once the start is waiting on the broker's answers.
 */
async function advanceUntil(
	child: { readonly registrations: readonly object[] },
	done: () => boolean,
	limitMs: number,
	stepMs: number,
): Promise<void> {
	const deadline = realNow() + FIRST_REGISTRATION_WAIT_MS;
	while (child.registrations.length === 0 && !done() && realNow() < deadline)
		await new Promise((resolve) => realSetTimeout(resolve, 5));
	for (let waited = 0; !done() && waited < limitMs; waited += stepMs) {
		await new Promise((resolve) => realSetTimeout(resolve, 1));
		await vi.advanceTimersByTimeAsync(stepMs);
	}
}

for (const [label, refusal] of [
	["a broker that names the refusal", undefined],
	["an older broker that gives only the reason", new Error("Invalid supervisor authorization")],
] as const) {
	test(`a supervisor capability the broker keeps refusing never fails the child's start, from ${label}`, async () => {
		vi.useFakeTimers();
		const child = startChild(refusal ?? new IntercomSupervisorAuthorizationRefusedError());
		try {
			let settled = false;
			const starting = child.emit({ type: "session_start", reason: "startup" }).finally(() => {
				settled = true;
			});
			await advanceUntil(child, () => settled, SUPERVISOR_REFUSAL_RETRY_MS + 10_000, 1_000);
			const reported = await starting;
			assert.deepEqual(reported, [], "the child's extensions start");
			const offered = child.registrations.filter((registration) => registration.supervisor !== undefined);
			assert.ok(offered.length > 1, "it kept offering the capability before giving it up");
			assert.equal(child.registrations.at(-1)?.supervisor, undefined, "then it registered without it");
		} finally {
			await child.emit({ type: "session_shutdown", reason: "quit" });
		}
	});
}

test("a supervisor capability refused only until its supervisor is back, as after a broker restart, is kept", async () => {
	vi.useFakeTimers();
	// The broker refuses the capability twice, until the supervisor reconnects and restores it.
	const child = startChild(new IntercomSupervisorAuthorizationRefusedError(), 2);
	try {
		let settled = false;
		const starting = child.emit({ type: "session_start", reason: "startup" }).finally(() => {
			settled = true;
		});
		await advanceUntil(child, () => settled, 5_000, 250);
		assert.deepEqual(await starting, []);
		assert.equal(child.registrations.length, 3);
		assert.ok(
			child.registrations.every((registration) => registration.supervisor !== undefined),
			"it registered with its capability, never without it",
		);
	} finally {
		await child.emit({ type: "session_shutdown", reason: "quit" });
	}
});
