import assert from "node:assert/strict";
import { setTimeout as realDelay } from "node:timers/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
} from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { runGenericHandlers } from "../../packages/coding-agent/src/core/extensions/runner-events.js";
import type { Extension, ExtensionError } from "../../packages/coding-agent/src/core/extensions/types.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import intercom from "../../packages/intercom/index.js";
import { toolContext } from "../helpers/tool-context.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: false, hasSharedStorage: false, protocol: { min: 1, max: 4 } }),
}));
const intercomConfig = vi.hoisted(() => ({ joinAtStartup: true }));
vi.mock("../../packages/intercom/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/intercom/config.js")>();
	return {
		...actual,
		loadConfigAsync: async () => ({ ...actual.defaultConfig(), joinAtStartup: intercomConfig.joinAtStartup }),
	};
});

type LifecycleEvent = SessionStartEvent | SessionShutdownEvent;
type LifecycleHandler = (event: LifecycleEvent, ctx: ExtensionContext) => Promise<void> | void;
type ConnectRegistration = Parameters<IntercomClient["connect"]>[0];
type Registration = { readonly registration: ConnectRegistration; readonly group: string | undefined };

const SESSION_START: SessionStartEvent = { type: "session_start", reason: "startup" };
const SESSION_SHUTDOWN: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
const JOIN_ENV = "ATOMIC_INTERCOM_JOIN_AT_STARTUP";
const originalConsoleError = console.error;
const originalJoinEnv = process.env[JOIN_ENV];
let consoleErrors: unknown[][] = [];

beforeEach(() => {
	delete process.env[JOIN_ENV];
	intercomConfig.joinAtStartup = true;
	consoleErrors = [];
	console.error = (...args: unknown[]) => {
		consoleErrors.push(args);
	};
});

afterEach(() => {
	console.error = originalConsoleError;
	if (originalJoinEnv === undefined) delete process.env[JOIN_ENV];
	else process.env[JOIN_ENV] = originalJoinEnv;
	vi.restoreAllMocks();
});

function sessionContext(fields: Partial<ExtensionContext>, notices: string[]): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (message: string) => notices.push(message) } as Partial<
			ExtensionContext["ui"]
		> as ExtensionContext["ui"],
		sessionManager: {
			getSessionId: () => "01a1f7b0-0000-7000-8000-00000000000b",
			getBranch: () => [],
			getEntries: () => [],
		} as never,
		...fields,
	} as ExtensionContext;
}

function hostExtension(handlers: Map<string, LifecycleHandler[]>): Extension {
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
		path: "<intercom>",
		resolvedPath: "<intercom>",
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

/** One session's Intercom, loaded the way Atomic loads it, on a broker that records each registration. */
type HeavyModule = { default: (pi: ExtensionAPI) => void | Promise<void> };

function intercomSession(
	options: { activeTools?: readonly string[]; refuse?: () => boolean; importHeavy?: () => Promise<HeavyModule> } = {},
) {
	const registrations: Registration[] = [];
	const appended: string[] = [];
	vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async function (
		this: IntercomClient,
		registration,
		_supervisor,
		_ownerToken,
		_messageSource,
		group,
	) {
		if (options.refuse?.()) throw new Error("Intercom broker did not start");
		registrations.push({ registration: structuredClone(registration), group });
		Object.assign(this, { _sessionId: `intercom-${registrations.length}` });
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(() => registrations.length > 0);
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);
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
		async appendEntry(customType: string) {
			appended.push(customType);
		},
		getSessionName: () => sessionName,
		setSessionName(value: string) {
			sessionName = value;
		},
		getActiveTools: () => [...(options.activeTools ?? ["read", "intercom"])],
		setActiveTools() {},
		events: createEventBus(),
	} as never as ExtensionAPI;
	intercom(pi, options.importHeavy === undefined ? {} : { importHeavy: options.importHeavy });
	const emit = async (event: LifecycleEvent, ctx: ExtensionContext): Promise<ExtensionError[]> => {
		const reported: ExtensionError[] = [];
		await runGenericHandlers([hostExtension(handlers)], ctx, event, (error) => reported.push(error));
		return reported;
	};
	return {
		registrations,
		appended,
		start: (ctx: ExtensionContext) => emit(SESSION_START, ctx),
		firstTurn: (ctx: ExtensionContext) => emit({ type: "agent_start" } as never, ctx),
		shutdown: (ctx: ExtensionContext) => emit(SESSION_SHUTDOWN, ctx),
		useIntercom: (ctx: ExtensionContext, action = "status") => {
			const tool = tools.get("intercom");
			assert.ok(tool, "intercom tool should be registered");
			return tool.execute("tool-call", { action }, new AbortController().signal, undefined, toolContext(ctx));
		},
	};
}

describe("an interactive top-level session joins Intercom at startup", () => {
	test("it registers in the background without any Intercom use, and its start does not wait for it", async () => {
		const notices: string[] = [];
		const session = intercomSession();
		const ctx = sessionContext({ mode: "tui" }, notices);
		try {
			assert.deepEqual(await session.start(ctx), []);
			assert.equal(session.registrations.length, 0, "session_start returns before the session joins");
			await vi.waitFor(() => assert.equal(session.registrations.length, 1), { timeout: 15_000 });
			assert.equal(session.registrations[0]?.group, "default");
			assert.deepEqual(notices, []);
			assert.deepEqual(consoleErrors, []);
		} finally {
			await session.shutdown(ctx);
		}
	});

	test("it registers under the name and group the same session gets when it joins on first use", async () => {
		const eager = intercomSession();
		const eagerCtx = sessionContext({ mode: "tui", cwd: "/work/repo" }, []);
		try {
			await eager.start(eagerCtx);
			await vi.waitFor(() => assert.equal(eager.registrations.length, 1), { timeout: 15_000 });
		} finally {
			await eager.shutdown(eagerCtx);
		}
		vi.restoreAllMocks();
		const lazy = intercomSession({ activeTools: ["read"] });
		const lazyCtx = sessionContext({ mode: "tui", cwd: "/work/repo" }, []);
		try {
			await lazy.start(lazyCtx);
			await lazy.useIntercom(lazyCtx);
			assert.equal(lazy.registrations.length, 1);
		} finally {
			await lazy.shutdown(lazyCtx);
		}
		const identity = ({ registration, group }: Registration) => ({
			name: registration.name,
			cwd: registration.cwd,
			group: registration.group,
			groups: registration.groups,
			registrationGroup: group,
		});
		assert.deepEqual(identity(eager.registrations[0]!), identity(lazy.registrations[0]!));
		assert.equal(eager.registrations[0]?.registration.name, "subagent-chat-01a1f7b0-0000-7000-8000-00000000000b");
	});

	test("print, JSON, RPC and SDK sessions, the terminal's presentation host, subagents and sessions without the intercom tool keep joining on first use", async () => {
		const lazySessions: Array<[string, Partial<ExtensionContext>, (readonly string[])?]> = [
			["print", { mode: "print", hasUI: false }],
			["json", { mode: "json", hasUI: false }],
			["rpc", { mode: "rpc" }],
			["sdk without bindings", { mode: "print", hasUI: false }],
			["presentation host", { mode: "tui", isPresentationOnly: true }],
			[
				"subagent",
				{ mode: "tui", subagentPolicy: { managementActions: "restricted", fanoutAuthorized: false } as never },
			],
			["no intercom tool", { mode: "tui" }, ["read", "bash"]],
		];
		useBackoffClock();
		try {
			for (const [label, fields, activeTools] of lazySessions) {
				const session = intercomSession(activeTools === undefined ? {} : { activeTools });
				const ctx = sessionContext(fields, []);
				try {
					assert.deepEqual(await session.start(ctx), [], label);
					await elapse(10_000);
					assert.equal(session.registrations.length, 0, `${label} must not join at startup`);
				} finally {
					await session.shutdown(ctx);
					vi.restoreAllMocks();
				}
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

/** Fake timers for the backoff; real setImmediate turns let the broker client's file and module I/O finish. */
function useBackoffClock(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

async function elapse(ms: number): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += 250) {
		await vi.advanceTimersByTimeAsync(250);
		const until = performance.now() + 2;
		while (performance.now() < until) await new Promise((resolve) => setImmediate(resolve));
	}
}

/**
 * Real time a join that has started may take to load Intercom and register on a loaded machine. The fake clock does not
 * move meanwhile, so only a join already due by the clock can register.
 */
const JOIN_REAL_TIME_BUDGET_MS = 15_000;
const JOIN_POLL_MS = 10;

/** Waits in real time, with the fake clock where it is, until `registrations` holds `count` registrations. */
async function untilRegistered(registrations: readonly Registration[], count: number): Promise<void> {
	const deadline = performance.now() + JOIN_REAL_TIME_BUDGET_MS;
	while (registrations.length < count && performance.now() < deadline) await realDelay(JOIN_POLL_MS);
}

/**
 * Waits in real time, with the fake clock where it is, until the startup join waits on the clock for its next attempt
 * (its timer is the only one this file fakes) or `finished` holds: an attempt in progress loads Intercom and reaches the
 * broker in real time.
 */
async function untilJoinWaits(finished: () => boolean = () => false): Promise<void> {
	const deadline = performance.now() + JOIN_REAL_TIME_BUDGET_MS;
	while (vi.getTimerCount() === 0 && !finished()) {
		assert.ok(performance.now() < deadline, "the startup join neither waited for another attempt nor finished");
		await realDelay(JOIN_POLL_MS);
	}
}

/** {@link elapse}, moving the clock on only once the join's attempt in progress, if any, has ended. */
async function elapseAttempts(ms: number, finished: () => boolean): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += 250) {
		await untilJoinWaits(finished);
		await elapse(250);
	}
}

describe("what the startup join leaves to the session", () => {
	test("it saves the Intercom id it joined under, so a resumed session asks for the same id", async () => {
		const session = intercomSession();
		const ctx = sessionContext({ mode: "tui" }, []);
		try {
			await session.start(ctx);
			await vi.waitFor(() => assert.equal(session.registrations.length, 1), { timeout: 15_000 });
			await vi.waitFor(() => assert.deepEqual(session.appended, ["intercom_session_identity"]), { timeout: 5_000 });
			await session.useIntercom(ctx);
			assert.deepEqual(session.appended, ["intercom_session_identity"], "the first use does not save it again");
			assert.equal(session.registrations.length, 1, "the use reuses the startup connection");
		} finally {
			await session.shutdown(ctx);
		}
	});

	test("a session whose folder is not trusted joins once it is trusted", async () => {
		useBackoffClock();
		let trusted = false;
		const session = intercomSession();
		const ctx = sessionContext({ mode: "tui", isProjectTrusted: () => trusted }, []);
		try {
			await session.start(ctx);
			await elapse(10_000);
			assert.equal(session.registrations.length, 0, "no join while the folder's trust may still be undecided");
			trusted = true;
			await elapse(5_000);
			await untilRegistered(session.registrations, 1);
			assert.equal(session.registrations.length, 1);
		} finally {
			await session.shutdown(ctx);
			vi.useRealTimers();
		}
	});
});

describe("a session whose folder stays untrusted", () => {
	afterEach(() => vi.useRealTimers());

	test("does not join while its folder's trust is undecided, however long, and joins when its first turn starts", async () => {
		useBackoffClock();
		const idle = intercomSession();
		const idleCtx = sessionContext({ mode: "tui", isProjectTrusted: () => false }, []);
		try {
			await idle.start(idleCtx);
			await elapse(10 * 60_000);
			assert.equal(idle.registrations.length, 0, "no other session can reach it before its folder is trusted");
			await idle.firstTurn(idleCtx);
			await elapse(5_000);
			await untilRegistered(idle.registrations, 1);
			assert.equal(idle.registrations.length, 1);
		} finally {
			await idle.shutdown(idleCtx);
			vi.restoreAllMocks();
		}
		const early = intercomSession();
		const earlyCtx = sessionContext({ mode: "tui", isProjectTrusted: () => false }, []);
		try {
			await early.start(earlyCtx);
			await early.firstTurn(earlyCtx);
			await elapse(5_000);
			await untilRegistered(early.registrations, 1);
			assert.equal(
				early.registrations.length,
				1,
				"a first prompt sent before the first attempt still joins at once",
			);
		} finally {
			await early.shutdown(earlyCtx);
		}
	});
});

describe("quitting while the startup join is still loading Intercom", () => {
	afterEach(() => vi.useRealTimers());

	test("does not wait for the load, and the load cleans itself up when it finishes", async () => {
		useBackoffClock();
		const load = Promise.withResolvers<HeavyModule>();
		const heavyEvents: string[] = [];
		let imports = 0;
		const session = intercomSession({
			importHeavy: () => {
				imports += 1;
				return load.promise;
			},
		});
		const ctx = sessionContext({ mode: "tui" }, []);
		await session.start(ctx);
		await elapse(4_000);
		assert.equal(imports, 1, "the startup join is loading Intercom");

		let closed = false;
		const closing = session.shutdown(ctx).then(() => {
			closed = true;
		});
		await elapse(500);
		assert.equal(closed, true, "closing the session waited for Intercom to load");

		load.resolve({
			default(heavyPi) {
				heavyPi.on("session_start", () => {
					heavyEvents.push("session_start");
				});
				heavyPi.on("session_shutdown", () => {
					heavyEvents.push("session_shutdown");
				});
			},
		});
		await closing;
		await elapse(500);
		assert.equal(session.registrations.length, 0);
		assert.deepEqual(
			heavyEvents.filter((event) => event === "session_start").length,
			0,
			"nothing starts in a closed session",
		);
	});
});

describe("turning the startup join off", () => {
	afterEach(() => vi.useRealTimers());

	/** `waitForJoin`: give a join that the clock started real time to register (see {@link untilRegistered}). */
	async function joinsWithin(ms: number, waitForJoin = false): Promise<boolean> {
		useBackoffClock();
		const session = intercomSession();
		const ctx = sessionContext({ mode: "tui" }, []);
		try {
			await session.start(ctx);
			await elapse(ms);
			if (waitForJoin) await untilRegistered(session.registrations, 1);
			return session.registrations.length > 0;
		} finally {
			await session.shutdown(ctx);
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	}

	test("ATOMIC_INTERCOM_JOIN_AT_STARTUP=0 keeps an interactive session joining on first use", async () => {
		process.env[JOIN_ENV] = "0";
		assert.equal(await joinsWithin(10_000), false);
		const session = intercomSession();
		const ctx = sessionContext({ mode: "tui" }, []);
		try {
			await session.start(ctx);
			await session.useIntercom(ctx);
			assert.equal(session.registrations.length, 1, "it still joins when it uses Intercom");
		} finally {
			await session.shutdown(ctx);
		}
	});

	test("joinAtStartup false in Intercom's config keeps it from joining, and the variable set to 1 overrides the config", async () => {
		intercomConfig.joinAtStartup = false;
		assert.equal(await joinsWithin(10_000), false);
		process.env[JOIN_ENV] = "1";
		assert.equal(await joinsWithin(10_000, true), true);
	});
});

describe("a startup join that cannot reach the broker", () => {
	afterEach(() => vi.useRealTimers());

	test("stays silent, retries on the reconnect backoff a bounded number of times, then joins on first use", async () => {
		useBackoffClock();
		const notices: string[] = [];
		let brokerDown = true;
		let attempts = 0;
		const session = intercomSession({
			refuse: () => {
				attempts += 1;
				return brokerDown;
			},
		});
		const ctx = sessionContext({ mode: "tui" }, notices);
		try {
			assert.deepEqual(await session.start(ctx), []);
			await elapseAttempts(60_000, () => attempts === 6);
			assert.equal(attempts, 6, "one join and five retries");
			await elapse(120_000);
			assert.equal(attempts, 6, "no background reconnect for a session that never used Intercom");
			assert.deepEqual(notices, []);
			assert.deepEqual(consoleErrors, []);

			brokerDown = false;
			await session.useIntercom(ctx);
			assert.equal(session.registrations.length, 1, "the next use joins");
		} finally {
			await session.shutdown(ctx);
		}
	});

	test("joins when the broker comes back during the retries", async () => {
		useBackoffClock();
		let brokerDown = true;
		const session = intercomSession({ refuse: () => brokerDown });
		const ctx = sessionContext({ mode: "tui" }, []);
		try {
			await session.start(ctx);
			await elapse(4_500);
			assert.equal(session.registrations.length, 0, "the join and its first retry met no broker");
			brokerDown = false;
			await elapse(3_000);
			await untilRegistered(session.registrations, 1);
			assert.equal(session.registrations.length, 1);
		} finally {
			await session.shutdown(ctx);
		}
	});

	test("a session that ends first never registers and stops retrying", async () => {
		useBackoffClock();
		let attempts = 0;
		const ended = intercomSession();
		const endedCtx = sessionContext({ mode: "tui" }, []);
		await ended.start(endedCtx);
		await ended.shutdown(endedCtx);
		await elapse(60_000);
		assert.equal(ended.registrations.length, 0);
		vi.restoreAllMocks();

		const retrying = intercomSession({
			refuse: () => {
				attempts += 1;
				return true;
			},
		});
		const retryingCtx = sessionContext({ mode: "tui" }, []);
		await retrying.start(retryingCtx);
		await elapse(4_500);
		await untilJoinWaits();
		const before = attempts;
		await retrying.shutdown(retryingCtx);
		await elapse(60_000);
		assert.equal(attempts, before);
	});
});
