import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { join } from "node:path";
import {
	type ExtensionContext,
	IntercomBrokerSuccessorTimeoutError,
	isIntercomBrokerSuccessorTimeoutError,
} from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { BrokerSuccessorRetryTiming } from "../../packages/intercom/broker-successor-retry.js";
import { BROKER_RETIRING_RETRY_WINDOW_MS } from "../../packages/intercom/reconnect-backoff.js";
import {
	BROKER_RETIRING_CODE,
	BROKER_RETIRING_REASON,
	IntercomBrokerRetiringError,
	IntercomClientDisconnectedError,
	isRecoverableIntercomDisconnect,
} from "../../packages/intercom/recoverable-disconnect.js";
import { makeDirectorySync } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * A broker that retires (its idle window ends as a killed run's process restarts, or it is restarted or replaced) can
 * end a registration still in flight. A connection that registers a workflow run's routes then spawns the replacement
 * and registers with it, and fails with a typed timeout only when no replacement takes over (#4496). The brokers are
 * fakes on the real socket path, so each case is deterministic, and a case that counts attempts replaces the retry's
 * clock and wait.
 */

const agentDir = useTemporaryAgentDir();
makeDirectorySync(join(agentDir, "intercom"), { recursive: true });

/** The clock and wait the product's own retries use while a case sets them; the real ones otherwise. */
const injected = vi.hoisted(() => ({ timing: undefined as BrokerSuccessorRetryTiming | undefined }));
vi.mock("../../packages/intercom/broker-successor-retry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/intercom/broker-successor-retry.js")>();
	return {
		...actual,
		registerWithBrokerSuccessor: <T>(attempt: () => Promise<T>, timing?: BrokerSuccessorRetryTiming): Promise<T> =>
			actual.registerWithBrokerSuccessor(attempt, timing ?? injected.timing),
	};
});
vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: false, hasSharedStorage: false, protocol: { min: 1, max: 3 } }),
}));

// The client resolves the broker socket from the agent directory when it loads.
const { createEventBus } = await import("../../packages/coding-agent/src/core/event-bus.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { spawnBrokerIfNeeded } = await import("../../packages/intercom/broker/spawn.js");
const { registerWithBrokerSuccessor } = await import("../../packages/intercom/broker-successor-retry.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { INTERCOM_RECOVERY_PEERS_EVENT } = await import("../../packages/intercom/session-recovery.js");
const { createWorkflowRouteOwner } = await import("../../packages/intercom/workflow-route-owner.js");

const ROUTE_EVENT = "atomic:workflow-pending-stage-route";
/**
 * The waits between registrations that a retiring broker keeps ending, when only the waits move the clock: 100 ms
 * doubling to 1 s, until the loss that comes 10 s or more after the first.
 */
const RETRY_WAITS_MS = [100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000];
/** Registrations in that schedule: one before each wait, and the last, which ends past the window. */
const ATTEMPTS_IN_WINDOW = RETRY_WAITS_MS.length + 1;

interface FakeTiming extends BrokerSuccessorRetryTiming {
	/** Every wait asked for, in order. */
	readonly waits: number[];
}

/** A clock that only waits move: each wait adds its length to the clock and returns at once. */
function fakeTiming(): FakeTiming {
	let clock = 0;
	const waits: number[] = [];
	return {
		waits,
		now: () => clock,
		wait: async (ms) => {
			waits.push(ms);
			clock += ms;
		},
	};
}

/** Timing whose first wait holds: `entered` resolves once a retry waits, and the wait ends when `release` is called. */
function heldTiming(): { timing: FakeTiming; entered: Promise<void>; release(): void } {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const waits: number[] = [];
	return {
		timing: {
			waits,
			now: () => 0,
			wait: async (ms) => {
				waits.push(ms);
				entered.resolve();
				await released.promise;
			},
		},
		entered: entered.promise,
		release: () => released.resolve(),
	};
}

interface Frame {
	readonly type?: string;
	readonly requestId?: string;
	readonly returnAddress?: string;
}
type OnRegister = (socket: net.Socket, server: net.Server, frame: Frame) => void;

/** The frames a fake broker received, in order. */
interface FakeBroker {
	readonly frames: Frame[];
}

const servers: net.Server[] = [];

/**
 * A broker on the real socket path that hands each registration to `onRegister`, acknowledges every route registration
 * and answers `list` with no sessions.
 */
async function fakeBroker(onRegister: OnRegister): Promise<FakeBroker> {
	const frames: Frame[] = [];
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					const frame = message as Frame;
					frames.push(frame);
					if (frame.type === "register" || frame.type === "register_verified") onRegister(socket, server, frame);
					if (frame.type === "register_pending_stage_route")
						writeMessage(socket, { type: "pending_stage_route_registered", requestId: frame.requestId });
					if (frame.type === "list")
						writeMessage(socket, { type: "sessions", requestId: frame.requestId, sessions: [] });
				},
				() => socket.destroy(),
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(getBrokerSocketPath(), resolve));
	servers.push(server);
	return { frames };
}

const accept: OnRegister = (socket) =>
	writeMessage(socket, { type: "registered", sessionId: randomUUID(), acknowledgesPendingStageRoutes: true });
const refuseAsRetiring: OnRegister = (socket) => {
	writeMessage(socket, { type: "registration_failed", reason: BROKER_RETIRING_REASON, code: BROKER_RETIRING_CODE });
	socket.end();
};

const isRouteConnection = (frame: Frame) => String(frame.returnAddress).includes(":pending-stage-route:");
const framesOf = (broker: FakeBroker, type: string) => broker.frames.filter((frame) => frame.type === type).length;
const routeConnectionRegistrations = (broker: FakeBroker) =>
	broker.frames.filter((frame) => frame.type === "register" && isRouteConnection(frame)).length;
const spawns = () => vi.mocked(spawnBrokerIfNeeded).mock.calls.length;

interface RoutePayload {
	readonly runId: string;
	readonly group: string;
	readonly capability: string;
	completion?: Promise<void>;
}

function routeOf(runId = randomUUID()): RoutePayload {
	return { runId, group: `successor-${runId.slice(0, 8)}`, capability: randomUUID() };
}

function outcomeOf(completion: Promise<void> | undefined): Promise<unknown> {
	assert.ok(completion, "nothing took the route's registration");
	return completion.then(
		() => undefined,
		(error: unknown) => error,
	);
}

beforeEach(() => {
	vi.mocked(spawnBrokerIfNeeded).mockReset();
	vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
});

afterEach(async () => {
	injected.timing = undefined;
	vi.restoreAllMocks();
	for (const server of servers.splice(0)) {
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe("registering with the broker that replaces a retiring one (#4496)", () => {
	test("registers again after a wait when a retiring broker ended the registration", async () => {
		const timing = fakeTiming();
		const failures = [new IntercomBrokerRetiringError()];
		let attempts = 0;

		const client = await registerWithBrokerSuccessor(async () => {
			attempts += 1;
			const failure = failures.shift();
			if (failure !== undefined) throw failure;
			return "registered";
		}, timing);

		assert.equal(client, "registered");
		assert.equal(attempts, 2);
		assert.deepEqual(timing.waits, [100]);
	});

	test("gives up with a typed timeout when no broker takes over within the window", async () => {
		const timing = fakeTiming();
		const losses: IntercomBrokerRetiringError[] = [];

		const error = await registerWithBrokerSuccessor(async () => {
			const loss = new IntercomBrokerRetiringError();
			losses.push(loss);
			throw loss;
		}, timing).then(
			() => undefined,
			(failure: unknown) => failure,
		);

		assert.ok(error instanceof IntercomBrokerSuccessorTimeoutError, String(error));
		assert.ok(isIntercomBrokerSuccessorTimeoutError(error));
		assert.equal(error.code, "broker-successor-timeout");
		assert.equal(error.phase, "registration");
		assert.equal(error.retryable, true);
		assert.equal(error.timeoutMs, BROKER_RETIRING_RETRY_WINDOW_MS);
		assert.equal(error.elapsedMs, 10_500);
		assert.equal(error.attempts, ATTEMPTS_IN_WINDOW);
		assert.equal(losses.length, ATTEMPTS_IN_WINDOW);
		assert.deepEqual(timing.waits, RETRY_WAITS_MS);
		assert.equal(error.cause, losses.at(-1));
		assert.ok(isRecoverableIntercomDisconnect(error), "a later registration may still find a broker");
		assert.equal(
			error.message,
			"Intercom registration timed out waiting for a broker to replace a retiring one: 14 attempts over 10500 ms of 10000 ms (broker-successor-timeout). Run `atomic intercom restart` to replace the broker, then resume the run or retry.",
		);
		assert.equal(error.hint, "Run `atomic intercom restart` to replace the broker, then resume the run or retry.");
	});

	/** Retire every registration, with the clock reading `readings` at each loss and 20 s from then on. */
	async function retiringWithClock(readings: number[]) {
		const waits: number[] = [];
		let attempts = 0;
		const error = await registerWithBrokerSuccessor(
			async () => {
				attempts += 1;
				throw new IntercomBrokerRetiringError();
			},
			{
				now: () => readings.shift() ?? 20_000,
				wait: async (ms) => {
					waits.push(ms);
				},
			},
		).then(
			() => undefined,
			(failure: unknown) => failure,
		);
		assert.ok(error instanceof IntercomBrokerSuccessorTimeoutError, String(error));
		return { error, attempts, waits };
	}

	test("gives up at a loss exactly at the window's end, measured from the first loss", async () => {
		// The second registration took the whole window to fail.
		const { error, attempts, waits } = await retiringWithClock([5, 10_005]);

		assert.equal(error.elapsedMs, BROKER_RETIRING_RETRY_WINDOW_MS);
		assert.equal(error.attempts, 2);
		assert.equal(attempts, 2);
		assert.deepEqual(waits, [100]);
	});

	test("reports the time it waited in whole milliseconds", async () => {
		const { error } = await retiringWithClock([0.25, 10_000.5]);

		assert.equal(error.elapsedMs, 10_000);
	});

	test("keeps every other failure as it is, without retrying", async () => {
		for (const failure of [new IntercomClientDisconnectedError(), new Error("Invalid supervisor authorization")]) {
			const timing = fakeTiming();
			let attempts = 0;

			const error = await registerWithBrokerSuccessor(async () => {
				attempts += 1;
				throw failure;
			}, timing).then(
				() => undefined,
				(thrown: unknown) => thrown,
			);

			assert.equal(error, failure);
			assert.equal(attempts, 1);
			assert.deepEqual(timing.waits, []);
		}
	});
});

describe("a standalone workflow route owner whose broker retires as it registers (#4496)", () => {
	test("registers with the replacement of a broker that went away before answering", async () => {
		let replacement: FakeBroker | undefined;
		const first = await fakeBroker((socket, server) => {
			// The broker stops listening and drops the registration, as one whose idle window ended does.
			server.close();
			socket.destroy();
			vi.mocked(spawnBrokerIfNeeded).mockImplementationOnce(async () => {
				replacement = await fakeBroker(accept);
			});
		});
		const owner = createWorkflowRouteOwner(agentDir);
		const route = routeOf();
		try {
			owner.events.emit(ROUTE_EVENT, route);
			assert.equal(await outcomeOf(route.completion), undefined);

			assert.ok(replacement);
			assert.equal(spawns(), 2);
			assert.equal(framesOf(first, "register"), 1);
			assert.equal(framesOf(replacement, "register"), 1);
			assert.equal(framesOf(replacement, "register_pending_stage_route"), 1);
			assert.equal(await owner.registered(route.runId), true);
		} finally {
			await owner.closeGroup(route.group);
		}
	});

	test("registers the run's route once when a broker refused it as retiring", async () => {
		let registrations = 0;
		const broker = await fakeBroker((socket, server, frame) => {
			registrations += 1;
			if (registrations === 1) refuseAsRetiring(socket, server, frame);
			else accept(socket, server, frame);
		});
		const owner = createWorkflowRouteOwner(agentDir);
		const route = routeOf();
		try {
			owner.events.emit(ROUTE_EVENT, route);
			assert.equal(await outcomeOf(route.completion), undefined);
			// The next update is registered after every publication queued before it, so none is left to arrive later.
			const update = { ...route, capability: randomUUID(), completion: undefined };
			owner.events.emit(ROUTE_EVENT, update);
			assert.equal(await outcomeOf(update.completion), undefined);

			assert.equal(spawns(), 2);
			assert.equal(framesOf(broker, "register"), 2);
			assert.equal(framesOf(broker, "register_pending_stage_route"), 2, "the retry published the route again");
		} finally {
			await owner.closeGroup(route.group);
		}
	});

	test("fails the run's route with a typed timeout when no broker takes over", async () => {
		const timing = fakeTiming();
		injected.timing = timing;
		const owner = createWorkflowRouteOwner(agentDir);
		const route = routeOf();
		try {
			owner.events.emit(ROUTE_EVENT, route);
			const error = await outcomeOf(route.completion);

			assert.ok(error instanceof IntercomBrokerSuccessorTimeoutError, String(error));
			assert.equal(error.attempts, ATTEMPTS_IN_WINDOW);
			assert.equal(spawns(), ATTEMPTS_IN_WINDOW);
			assert.deepEqual(timing.waits, RETRY_WAITS_MS);
			assert.ok(error.cause instanceof IntercomBrokerRetiringError, String(error.cause));
			assert.ok(isRecoverableIntercomDisconnect(error));
		} finally {
			await owner.closeGroup(route.group);
		}
	});

	test("spawns no broker and registers nothing for a group closed while it waited to retry", async () => {
		const held = heldTiming();
		injected.timing = held.timing;
		const broker = await fakeBroker(refuseAsRetiring);
		const owner = createWorkflowRouteOwner(agentDir);
		const route = routeOf();
		owner.events.emit(ROUTE_EVENT, route);
		const outcome = outcomeOf(route.completion);
		await held.entered;

		const closing = owner.closeGroup(route.group);
		held.release();
		await closing;

		const error = await outcome;
		assert.ok(error instanceof Error, String(error));
		assert.equal(isIntercomBrokerSuccessorTimeoutError(error), false);
		assert.equal(spawns(), 1);
		assert.equal(framesOf(broker, "register"), 1);
	});
});

describe("a session's route connection whose broker retires as it registers (#4496)", () => {
	let events = createEventBus();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();

	beforeEach(() => {
		events = createEventBus();
		handlers.clear();
	});

	/** One extension instance and a session it starts and connects to the broker; `shutdown` ends the session. */
	async function startSession(): Promise<{ shutdown(): Promise<void> }> {
		const pi = {
			on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			async appendEntry() {},
			getSessionName: () => undefined,
			events,
		};
		intercomHeavy(pi as never);
		const ctx = {
			hasUI: false,
			cwd: process.cwd(),
			isIdle: () => true,
			ui: { notify() {} },
			sessionManager: { getSessionId: () => "route-successor", getEntries: () => [], getBranch: () => [] },
		} as unknown as ExtensionContext;
		const fire = async (name: string) => {
			for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "startup" } as never, ctx);
		};
		await fire("session_start");
		const peers: { completion?: Promise<unknown[]> } = {};
		events.emit(INTERCOM_RECOVERY_PEERS_EVENT, peers);
		assert.deepEqual(await peers.completion, []);
		return { shutdown: () => fire("session_shutdown") };
	}

	/** A broker that accepts the session and refuses its route connection's first `refusals` registrations as retiring. */
	function brokerRefusingRouteConnection(refusals: number): Promise<FakeBroker> {
		let routeRegistrations = 0;
		return fakeBroker((socket, server, frame) => {
			if (isRouteConnection(frame)) routeRegistrations += 1;
			if (isRouteConnection(frame) && routeRegistrations <= refusals) refuseAsRetiring(socket, server, frame);
			else accept(socket, server, frame);
		});
	}

	test("registers the run's route over a connection to the broker that took over", async () => {
		const broker = await brokerRefusingRouteConnection(1);
		const session = await startSession();
		try {
			const route = routeOf();
			events.emit(ROUTE_EVENT, route);
			assert.equal(await outcomeOf(route.completion), undefined);

			assert.equal(routeConnectionRegistrations(broker), 2);
			assert.equal(framesOf(broker, "register_pending_stage_route"), 1);
		} finally {
			await session.shutdown();
		}
	});

	test("fails the run's route with a typed timeout when no broker takes over", async () => {
		const timing = fakeTiming();
		injected.timing = timing;
		const broker = await brokerRefusingRouteConnection(Number.POSITIVE_INFINITY);
		const session = await startSession();
		try {
			const route = routeOf();
			events.emit(ROUTE_EVENT, route);
			const error = await outcomeOf(route.completion);

			assert.ok(error instanceof IntercomBrokerSuccessorTimeoutError, String(error));
			assert.equal(error.attempts, ATTEMPTS_IN_WINDOW);
			assert.equal(routeConnectionRegistrations(broker), ATTEMPTS_IN_WINDOW);
			assert.deepEqual(timing.waits, RETRY_WAITS_MS);
			assert.equal(framesOf(broker, "register_pending_stage_route"), 0);
		} finally {
			await session.shutdown();
		}
	});

	test("spawns no broker and registers nothing for a session that ended while it waited to retry", async () => {
		const held = heldTiming();
		injected.timing = held.timing;
		const broker = await brokerRefusingRouteConnection(1);
		const session = await startSession();
		const route = routeOf();
		events.emit(ROUTE_EVENT, route);
		const outcome = outcomeOf(route.completion);
		await held.entered;
		const spawnsBeforeShutdown = spawns();
		// The session's own connection closes first; its route connections are dropped once that disconnect returns.
		const disconnects: Promise<void>[] = [];
		const disconnect = IntercomClient.prototype.disconnect;
		vi.spyOn(IntercomClient.prototype, "disconnect").mockImplementation(function (
			this: InstanceType<typeof IntercomClient>,
		) {
			const closed = disconnect.call(this);
			disconnects.push(closed);
			return closed;
		});

		const shutdown = session.shutdown();
		await vi.waitFor(() => assert.ok(disconnects.length > 0), { timeout: 10_000 });
		await Promise.all(disconnects);
		await new Promise<void>((resolve) => setImmediate(resolve));
		held.release();
		await shutdown;

		assert.ok((await outcome) instanceof Error);
		assert.equal(spawns(), spawnsBeforeShutdown);
		assert.equal(routeConnectionRegistrations(broker), 1);
	});
});
