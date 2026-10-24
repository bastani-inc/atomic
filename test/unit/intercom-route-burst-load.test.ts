/**
 * Load regression: 50+ concurrent workflow runs published pending-stage routes through one root process and
 * produced a stream of `Intercom event relay failed (atomic:workflow-pending-stage-route): Connection timeout`.
 *
 * Everything here runs the shipped lightweight wrapper, the shipped heavy module and a real broker process. The
 * broker sits behind `IntercomWireProxy`, which forwards bytes untouched and counts frames by type, so "broker
 * work" is read off the wire rather than inferred. A saturated broker is reproduced by holding a connection the
 * proxy accepted: the client sees exactly what a backlogged event loop gives it, a socket that never answers
 * `register`. Connections the test does not hold use the production bounds, so machine load cannot make a healthy
 * connection time out; only a held one is given a short bound.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { jitteredReconnectDelayMs, reconnectDelayMs } from "../../packages/intercom/reconnect-backoff.js";
import {
	IntercomBrokerTimeoutError,
	IntercomClientDisconnectedError,
	isIntercomBrokerTimeout,
	isRecoverableIntercomDisconnect,
} from "../../packages/intercom/recoverable-disconnect.js";
import { ROUTE_CLIENT_CONNECT_CONCURRENCY } from "../../packages/intercom/route-connect-gate.js";
import { scheduledRetryFailure } from "../../packages/intercom/route-retry-waiters.js";
import { isRetryableSameModelFailure } from "../../packages/workflows/src/runs/shared/model-fallback-failures.js";
import { IntercomWireProxy, type WireFrame } from "../helpers/intercom-wire-proxy.js";
import { sleep } from "../helpers/runtime.js";

vi.mock("../../packages/intercom/broker/spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/spawn.js")>()),
	spawnBrokerIfNeeded: async () => {},
}));

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const brokerAgentDir = mkdtempSync(join(tmpdir(), "irb-"));
const frontAgentDir = mkdtempSync(join(tmpdir(), "irf-"));
const brokerSocketPath = getBrokerSocketPath(process.platform, brokerAgentDir);
const frontSocketPath = getBrokerSocketPath(process.platform, frontAgentDir);
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = frontAgentDir;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(frontAgentDir, "intercom"), { recursive: true });

// The client resolves its socket path on load, so everything that reaches it is imported after the override.
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { getJitiCliPath } = await vi.importActual<typeof import("../../packages/intercom/broker/spawn.js")>(
	"../../packages/intercom/broker/spawn.js",
);
const { default: intercom } = await import("../../packages/intercom/index.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");

type Client = InstanceType<typeof IntercomClient>;

/** Workflow runs publishing at once; comfortably past the 50-run report once routes and clients are per run. */
const RUN_COUNT = 56;
const ROUTE_UPDATE_ROUNDS = 3;
/** A held connection never answers, so this only decides how soon the test sees its timeout. */
const STALLED_CONNECT_TIMEOUT_MS = 1_000;
/** Upper bound for anything the test waits on; a failure, not a pace, so it carries load headroom. */
const WAIT_TIMEOUT_MS = 20_000;
const POLL_MS = 10;
/** Past the broker-silence window in which any further route connect would already have arrived. */
const CONNECT_SETTLE_MS = 250;
/** One main-client reconnect attempt is armed `reconnectDelayMs(0)` after a teardown; observe past it. */
const MAIN_RECONNECT_WINDOW_MS = reconnectDelayMs(0) + 500;
/** `setTimeout` may fire a hair before a `Date.now()` difference reaches its delay. */
const TIMER_EARLY_SLACK_MS = 50;
const ROUTE_PREFIX = ":pending-stage-route:";

let broker: ChildProcess | undefined;
let brokerOutput = "";
const proxy = new IntercomWireProxy(frontSocketPath, brokerSocketPath);
const openClients = new Set<Client>();
let hostCounter = 0;

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}\n${brokerOutput}`);
		await sleep(POLL_MS);
	}
}

async function waitForSocket(socketPath: string): Promise<void> {
	await waitFor(
		"the broker socket",
		() =>
			new Promise<true | undefined>((resolveProbe) => {
				const probe = net.createConnection(socketPath);
				probe.once("connect", () => {
					probe.destroy();
					resolveProbe(true);
				});
				probe.once("error", () => resolveProbe(undefined));
			}),
	);
}

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerAgentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	broker.stdout?.on("data", (data) => {
		brokerOutput += String(data);
	});
	broker.stderr?.on("data", (data) => {
		brokerOutput += String(data);
	});
	await waitForSocket(brokerSocketPath);
	await proxy.listen();
});

afterEach(() => {
	proxy.release();
	proxy.transformBrokerFrames(undefined);
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const client of openClients) await client.disconnect().catch(() => {});
	await proxy.close();
	if (broker?.exitCode === null) {
		const stopped = new Promise<void>((resolveExit) => broker?.once("exit", () => resolveExit()));
		broker.kill("SIGTERM");
		await stopped;
	}
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	if (originalLegacyAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalLegacyAgentDir;
	rmSync(brokerAgentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	rmSync(frontAgentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function runIdFor(scope: string, index: number): string {
	return `${scope}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function runGroup(runId: string): string {
	return `workflow:${runId}`;
}

function routePayload(runId: string, round: number, capability = `capability-${runId}`, group = runGroup(runId)) {
	return {
		runId,
		group,
		capability,
		stages: [
			{
				stageId: `reviewer-${round}`,
				stageName: "reviewer",
				target: `${group}/reviewer-${round}`,
				lifecycle: "pending" as const,
				routeEligible: true,
				group,
			},
		],
		completion: undefined as Promise<void> | undefined,
	};
}

interface ToolResult {
	readonly isError: boolean;
	readonly content: ReadonlyArray<{ readonly text: string }>;
}

type EventHandler = (payload: object) => void;

/** The shipped lightweight wrapper over the shipped heavy module, hosted by the smallest host that runs them. */
function createHost(connectTimeoutMs: (returnAddress: string) => number | undefined = () => undefined) {
	hostCounter += 1;
	const sessionId = `route-burst-host-${hostCounter}`;
	const sessionName = `route-burst-host-name-${hostCounter}`;
	const lifecycleHandlers = new Map<string, Array<(event: object, ctx: object) => unknown>>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const emittedEvents: Array<{ eventName: string; payload: object }> = [];
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<ToolResult> }>();
	let activeTools: string[] = [];
	const context = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		orchestrationContext: { intercomGroup: "default" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: { confirm: async () => true, notify() {} },
	};
	const pi = {
		on(eventName: string, handler: (event: object, ctx: object) => unknown) {
			lifecycleHandlers.set(eventName, [...(lifecycleHandlers.get(eventName) ?? []), handler]);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => sessionName,
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(eventName: string, handler: EventHandler) {
				eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
				return () => {};
			},
			emit(eventName: string, payload: object) {
				emittedEvents.push({ eventName, payload });
				for (const handler of eventHandlers.get(eventName) ?? []) handler(payload);
			},
		},
	};
	intercom(pi as never, {
		importHeavy: async () => ({
			default: (heavyPi) => intercomHeavy(heavyPi, { connectTimeoutMs }),
		}),
	});
	const fire = async (eventName: string, event: object): Promise<void> => {
		for (const handler of lifecycleHandlers.get(eventName) ?? []) await handler(event, context);
	};
	return {
		sessionId,
		sessionName,
		emittedEvents,
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
		/** Publish one run's route the way the workflows bridge does, and hand back what it awaits. */
		publishRoute(runId: string, round: number, capability?: string, group?: string): Promise<void> {
			const payload = routePayload(runId, round, capability, group);
			pi.events.emit("atomic:workflow-pending-stage-route", payload);
			assert.ok(payload.completion, "the Intercom relay must claim every route event");
			return payload.completion;
		},
		execute(params: { action: string }): Promise<ToolResult> {
			const execute = tools.get("intercom")?.execute;
			assert.ok(execute, "the intercom tool must be registered");
			return execute("call", params, undefined, undefined, context);
		},
	};
}

type Host = ReturnType<typeof createHost>;

async function withHost<T>(host: Host, body: () => Promise<T>): Promise<T> {
	await host.start();
	try {
		return await body();
	} finally {
		await host.shutdown();
	}
}

async function connectObserver(groups: readonly string[]): Promise<Client> {
	const observer = new IntercomClient(`route-burst-observer-${++hostCounter}`);
	observer.on("error", () => {});
	openClients.add(observer);
	await observer.connect({
		name: `route-burst-observer-${hostCounter}`,
		cwd: repoRoot,
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "default",
		groups: ["default", ...groups],
	});
	return observer;
}

async function rosterRunIds(observer: Client): Promise<Set<string>> {
	return new Set((await observer.listDirectory()).workflowStages.map((stage) => stage.runId));
}

async function waitForRoster(observer: Client, runIds: readonly string[]): Promise<void> {
	await waitFor(`${runIds.length} runs in the broker roster`, async () => {
		const roster = await rosterRunIds(observer);
		return runIds.every((runId) => roster.has(runId)) ? true : undefined;
	});
}

function relayDiagnostics(spy: { mock: { calls: unknown[][] } }): string[] {
	return spy.mock.calls
		.map(([message]) => String(message))
		.filter((message) => message.startsWith("Intercom event relay failed") || message.includes("has not answered"));
}

/** How a completion settles. One still pending after the bound is a hang, which a stage startup would wait on forever. */
async function settleWithinBound(completion: Promise<void>): Promise<PromiseSettledResult<void>> {
	let timer: NodeJS.Timeout | undefined;
	const hang = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`the route completion is still pending after ${WAIT_TIMEOUT_MS}ms`)),
			WAIT_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([Promise.allSettled([completion]).then(([outcome]) => outcome), hang]);
	} finally {
		clearTimeout(timer);
	}
}

function routeRegistersFor(runId: string): number {
	return proxy.toBroker.filter(
		({ frame }) =>
			frame.type === "register" && String(frame.returnAddress).endsWith(`${ROUTE_PREFIX}${runGroup(runId)}`),
	).length;
}

function isRouteClientRegister(frame: WireFrame): boolean {
	return frame.type === "register" && String(frame.returnAddress).includes(ROUTE_PREFIX);
}

function mainRegisters(host: Host): number {
	return proxy.toBroker.filter(({ frame }) => frame.type === "register" && frame.returnAddress === host.sessionId)
		.length;
}

test("the routes of every run in one invocation group share one broker connection (#3904)", async () => {
	const scope = "39040001";
	const runIds = Array.from({ length: RUN_COUNT }, (_, index) => runIdFor(scope, index));
	const group = runGroup(runIds[0]!);
	const observer = await connectObserver([group]);
	const host = createHost();
	const framesBefore = proxy.toBroker.length;

	await withHost(host, async () => {
		await Promise.all(runIds.map((runId) => host.publishRoute(runId, 1, undefined, group)));
		await waitForRoster(observer, runIds);
		const routeConnections = proxy.toBroker.slice(framesBefore).filter(({ frame }) => isRouteClientRegister(frame));
		assert.equal(
			routeConnections.length,
			1,
			`${RUN_COUNT} runs registered over ${routeConnections.length} connections`,
		);
	});
});

test("a standalone owner registers the routes of every run in one invocation group over one connection (#3904)", async () => {
	const { createWorkflowRouteOwner } = await import("../../packages/intercom/workflow-route-owner.js");
	const owner = createWorkflowRouteOwner(repoRoot);
	const scope = "39040002";
	const runIds = Array.from({ length: RUN_COUNT }, (_, index) => runIdFor(scope, index));
	const group = runGroup(runIds[0]!);
	const observer = await connectObserver([group]);
	const framesBefore = proxy.toBroker.length;
	try {
		await Promise.all(
			runIds.map((runId) => {
				const route = routePayload(runId, 1, undefined, group);
				owner.events.emit("atomic:workflow-pending-stage-route", route);
				return route.completion;
			}),
		);
		await waitForRoster(observer, runIds);
		const routeConnections = proxy.toBroker.slice(framesBefore).filter(({ frame }) => isRouteClientRegister(frame));
		assert.equal(
			routeConnections.length,
			1,
			`${RUN_COUNT} runs registered over ${routeConnections.length} connections`,
		);
	} finally {
		await owner.closeGroup(group);
	}
});

const HEALTHY_RUN_COUNT = 5;
/** Runs whose route the broker refuses; only these may get a route connection of their own. */
const REFUSED_RUN_COUNT = 1;
/** The refused runs' further attempts the healthy routes are watched through, each over its run's own backoff. */
const REFUSED_RUN_RETRIES = 2;
const ROSTER_SAMPLE_MS = 50;

/** A route-owner connection of one run of `scope`, as opposed to the one its invocation group shares. */
function isOwnRouteConnectionRegister(scope: string, frame: WireFrame): boolean {
	return frame.type === "register" && String(frame.returnAddress).includes(`${ROUTE_PREFIX}${scope}-`);
}

function openOwnRouteConnections(scope: string): number {
	return proxy.openConnections((first) => isOwnRouteConnectionRegister(scope, first));
}

async function waitForOwnRouteConnectionsToClose(scope: string): Promise<void> {
	await waitFor("every run's own route connection to close", () =>
		openOwnRouteConnections(scope) === 0 ? true : undefined,
	);
}

/**
 * The refused runs of group `group` are owned by another live session under another capability, so the broker
 * refuses every registration of them the owner under test makes until that session leaves. `publish` registers a
 * route through that owner.
 */
async function watchHealthyRoutesBesideARefusedRun(
	scope: string,
	publish: (runId: string, capability: string | undefined, group: string) => Promise<void>,
): Promise<void> {
	const healthy = Array.from({ length: HEALTHY_RUN_COUNT }, (_, index) => runIdFor(scope, index));
	const refused = Array.from({ length: REFUSED_RUN_COUNT }, (_, index) => runIdFor(scope, HEALTHY_RUN_COUNT + index));
	const group = runGroup(healthy[0]!);
	const observer = await connectObserver([group]);
	const foreign = new IntercomClient(`route-burst-foreign-${++hostCounter}`);
	foreign.on("error", () => {});
	openClients.add(foreign);
	await foreign.connect(registration(`route-burst-foreign-${hostCounter}`, group));
	for (const runId of refused) await foreign.registerPendingStageRouteAcknowledged(runId, group, "foreign-capability");
	try {
		await Promise.all(healthy.map((runId) => publish(runId, undefined, group)));
		await waitForRoster(observer, healthy);

		for (const runId of refused) {
			await assert.rejects(publish(runId, "refused-capability", group), /Pending-stage route is not authorized/);
		}
		await waitForRoster(observer, healthy);
		const sharedRegisters = (): number =>
			proxy.toBroker.filter(
				({ frame }) => frame.type === "register" && String(frame.returnAddress).endsWith(`${ROUTE_PREFIX}${group}`),
			).length;
		const attempts = (runId: string): number =>
			proxy.toBroker.filter(({ frame }) => frame.type === "register_pending_stage_route" && frame.runId === runId)
				.length;
		const sharedRegistersBefore = sharedRegisters();
		const attemptsBefore = new Map(refused.map((runId) => [runId, attempts(runId)]));
		let samples = 0;
		let samplesMissingHealthy = 0;
		await waitFor(`${REFUSED_RUN_RETRIES} more attempts of each refused run`, async () => {
			const roster = await rosterRunIds(observer);
			samples += 1;
			if (!healthy.every((runId) => roster.has(runId))) samplesMissingHealthy += 1;
			await sleep(ROSTER_SAMPLE_MS);
			return refused.every((runId) => attempts(runId) >= attemptsBefore.get(runId)! + REFUSED_RUN_RETRIES)
				? true
				: undefined;
		});

		assert.equal(
			samplesMissingHealthy,
			0,
			`healthy routes were missing from ${samplesMissingHealthy} of ${samples} roster samples`,
		);
		assert.equal(sharedRegisters(), sharedRegistersBefore, "the refused run must not end the group's connection");

		// Once the other session leaves, a refused run registers over its own connection and stays there.
		await foreign.disconnect();
		for (const runId of refused) await publish(runId, "refused-capability-resumed", group);
		await waitForRoster(observer, [...healthy, ...refused]);
		await waitFor(`${REFUSED_RUN_COUNT} runs on connections of their own`, () =>
			openOwnRouteConnections(scope) === REFUSED_RUN_COUNT ? true : undefined,
		);
		assert.equal(
			sharedRegisters(),
			sharedRegistersBefore,
			"a registered refused run must not rejoin the group's connection",
		);
		const runsWithOwnConnection = new Set(
			proxy.toBroker
				.filter(({ frame }) => isOwnRouteConnectionRegister(scope, frame))
				.map(({ frame }) => String(frame.returnAddress).split(ROUTE_PREFIX)[1]),
		);
		assert.equal(runsWithOwnConnection.size, REFUSED_RUN_COUNT, "only a refused run may get a connection of its own");
		assert.deepEqual([...runsWithOwnConnection].sort(), [...refused].sort());
	} finally {
		await foreign.disconnect();
	}
}

test("a standalone owner keeps every healthy run's route while another run of its group is refused (#3904)", async () => {
	const { createWorkflowRouteOwner } = await import("../../packages/intercom/workflow-route-owner.js");
	const owner = createWorkflowRouteOwner(repoRoot);
	const scope = "39040003";
	try {
		await watchHealthyRoutesBesideARefusedRun(scope, (runId, capability, group) => {
			const route = routePayload(runId, 1, capability, group);
			owner.events.emit("atomic:workflow-pending-stage-route", route);
			assert.ok(route.completion);
			return route.completion;
		});
	} finally {
		await owner.closeGroup(runGroup(runIdFor(scope, 0)));
	}
	await waitForOwnRouteConnectionsToClose(scope);
});

test("a host keeps every healthy run's route while another run of its group is refused (#3904)", async () => {
	const host = createHost();
	const scope = "39040004";
	await withHost(host, () =>
		watchHealthyRoutesBesideARefusedRun(scope, (runId, capability, group) =>
			host.publishRoute(runId, 1, capability, group),
		),
	);
	await waitForOwnRouteConnectionsToClose(scope);
});

test("a burst of route updates from many runs reaches the broker without a session listing per update", async () => {
	const scope = "11110001";
	const runIds = Array.from({ length: RUN_COUNT }, (_, index) => runIdFor(scope, index));
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	const observer = await connectObserver(runIds.map(runGroup));
	const host = createHost();
	const listsBefore = proxy.countToBroker("list");
	const routeFramesBefore = proxy.toBroker.filter(({ frame }) => frame.type === "register_pending_stage_route").length;

	await withHost(host, async () => {
		for (let round = 1; round <= ROUTE_UPDATE_ROUNDS; round += 1) {
			await Promise.all(runIds.map((runId) => host.publishRoute(runId, round)));
		}
		assert.deepEqual(relayDiagnostics(diagnostics), []);
		assert.equal(
			proxy.countToBroker("list") - listsBefore,
			0,
			"route updates must not cost the broker a full session listing each",
		);

		const routeFrames = proxy.toBroker
			.filter(({ frame }) => frame.type === "register_pending_stage_route")
			.slice(routeFramesBefore);
		assert.ok(
			routeFrames.length >= RUN_COUNT * ROUTE_UPDATE_ROUNDS,
			`every route update must reach the broker (saw ${routeFrames.length})`,
		);
		assert.equal(
			routeFrames.filter(({ frame }) => typeof frame.requestId !== "string").length,
			0,
			"every route update is registered with an acknowledgement request",
		);
		const acknowledged = new Set(
			proxy.toClients
				.filter(({ frame }) => frame.type === "pending_stage_route_registered")
				.map(({ frame }) => frame.requestId),
		);
		assert.ok(
			routeFrames.every(({ frame }) => acknowledged.has(frame.requestId as string)),
			"the broker acknowledges every route update itself",
		);
		assert.equal(mainRegisters(host), 1);

		const roster = (await observer.listDirectory()).workflowStages;
		assert.equal(roster.length, RUN_COUNT, "roster semantics are unchanged: one pending stage per run");
		assert.deepEqual(
			new Set(roster.map((stage) => stage.target)),
			new Set(runIds.map((runId) => `${runGroup(runId)}/reviewer-${ROUTE_UPDATE_ROUNDS}`)),
			"the broker holds the latest roster each run published",
		);
	});
});

test("a broker that stops answering does not produce a relay failure per route update", async () => {
	const scope = "22220002";
	const runIds = Array.from({ length: RUN_COUNT }, (_, index) => runIdFor(scope, index));
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	const observer = await connectObserver(runIds.map(runGroup));
	let stalled = true;
	const host = createHost(() => (stalled ? STALLED_CONNECT_TIMEOUT_MS : undefined));
	proxy.hold(() => true);

	await withHost(host, async () => {
		const outcomes = await Promise.allSettled(runIds.map((runId) => host.publishRoute(runId, 1)));
		await tick();

		assert.deepEqual(relayDiagnostics(diagnostics), [], "a recoverable timeout must not be reported per route event");
		assert.equal(outcomes.filter(({ status }) => status === "rejected").length, RUN_COUNT);
		for (const outcome of outcomes) {
			assert.ok(outcome.status === "rejected");
			assert.equal(outcome.reason.message, "Connection timeout");
			assert.equal(isRecoverableIntercomDisconnect(outcome.reason), true);
		}

		const userCall = await host.execute({ action: "list" });
		assert.equal(userCall.isError, true, "a user-initiated call still fails visibly");
		assert.match(userCall.content[0]?.text ?? "", /Connection timeout/);

		stalled = false;
		proxy.release();
		await waitForRoster(observer, runIds);
		assert.deepEqual(relayDiagnostics(diagnostics), []);
	});
});

test("one run's route connection failing leaves the healthy main connection in place", async () => {
	const scope = "33330003";
	const runIds = Array.from({ length: RUN_COUNT }, (_, index) => runIdFor(scope, index));
	const [failingRun, ...healthyRuns] = runIds as [string, ...string[]];
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	const observer = await connectObserver(runIds.map(runGroup));
	const host = createHost((returnAddress) =>
		returnAddress.endsWith(`${ROUTE_PREFIX}${runGroup(failingRun)}`) ? STALLED_CONNECT_TIMEOUT_MS : undefined,
	);
	proxy.hold(
		(first) =>
			first.type === "register" && String(first.returnAddress).endsWith(`${ROUTE_PREFIX}${runGroup(failingRun)}`),
	);

	await withHost(host, async () => {
		const outcomes = await Promise.allSettled(runIds.map((runId) => host.publishRoute(runId, 1)));
		await tick();

		const mainIsListed = async () =>
			(await observer.listSessions()).some((session) => session.name === host.sessionName);
		assert.equal(await mainIsListed(), true, "the main connection is still registered");
		assert.deepEqual(relayDiagnostics(diagnostics), []);
		const [failing, ...healthy] = outcomes;
		assert.ok(failing?.status === "rejected" && isRecoverableIntercomDisconnect(failing.reason));
		assert.ok(
			healthy.every(({ status }) => status === "fulfilled"),
			"every other run registers its route",
		);
		await sleep(MAIN_RECONNECT_WINDOW_MS);
		assert.equal(mainRegisters(host), 1, "the main connection was never torn down and rebuilt");
		assert.equal(await mainIsListed(), true);
		const roster = await rosterRunIds(observer);
		assert.equal(roster.has(failingRun), false);
		assert.ok(healthyRuns.every((runId) => roster.has(runId)));

		proxy.release();
		await waitForRoster(observer, [failingRun]);
		assert.equal(mainRegisters(host), 1);
	});
});

test("a burst of route connections is admitted a few at a time", async () => {
	const scope = "44440004";
	const runIds = Array.from({ length: RUN_COUNT }, (_, index) => runIdFor(scope, index));
	const observer = await connectObserver(runIds.map(runGroup));
	const host = createHost();
	proxy.hold((first) => isRouteClientRegister(first));

	await withHost(host, async () => {
		const completions = runIds.map((runId) => host.publishRoute(runId, 1));
		await waitFor("route handshakes in flight", () =>
			proxy.heldConnections() >= ROUTE_CLIENT_CONNECT_CONCURRENCY ? true : undefined,
		);
		await sleep(CONNECT_SETTLE_MS);
		assert.equal(
			proxy.heldConnections(),
			ROUTE_CLIENT_CONNECT_CONCURRENCY,
			"route clients must not all open their connections to a backlogged broker at once",
		);

		proxy.release();
		await Promise.all(completions);
		await waitForRoster(observer, runIds);
	});
});

test("an unacknowledged broker keeps the previous session-listing barrier", async () => {
	const runId = runIdFor("55550005", 0);
	const group = runGroup(runId);
	proxy.transformBrokerFrames((frame) => {
		if (frame.type !== "registered") return frame;
		const { acknowledgesPendingStageRoutes: _advertised, ...legacy } = frame;
		return legacy as WireFrame;
	});
	const client = new IntercomClient(`route-burst-legacy-${++hostCounter}`);
	client.on("error", () => {});
	openClients.add(client);
	await client.connect(registration("legacy-route-owner", group));
	const framesBefore = proxy.toBroker.length;
	const acknowledgementsBefore = proxy.countToClients("pending_stage_route_registered");

	await client.registerPendingStageRouteAcknowledged(runId, group, "legacy-capability");

	const sent = proxy.toBroker.slice(framesBefore).map(({ frame }) => frame);
	assert.deepEqual(
		sent.map((frame) => frame.type),
		["register_pending_stage_route", "list"],
		"a broker that does not advertise the acknowledgement is followed by the barrier listing",
	);
	assert.equal(sent[0]?.requestId, undefined);
	assert.equal(proxy.countToClients("pending_stage_route_registered"), acknowledgementsBefore);
});

test("a client that sends no request id gets no acknowledgement frame from the broker", async () => {
	const runId = runIdFor("66660006", 0);
	const group = runGroup(runId);
	const received: WireFrame[] = [];
	const socket = net.createConnection(frontSocketPath);
	socket.on("error", () => {});
	socket.on(
		"data",
		createMessageReader(
			(message) => received.push(message as WireFrame),
			(error) => socket.destroy(error),
		),
	);
	try {
		const next = async (type: string, requestId?: string): Promise<WireFrame> =>
			waitFor(`broker frame ${type}`, () =>
				received.find((frame) => frame.type === type && (requestId === undefined || frame.requestId === requestId)),
			);
		writeMessage(socket, { type: "register", session: registration("old-client-route-owner", group) });
		await next("registered");
		writeMessage(socket, { type: "register_pending_stage_route", runId, group, capability: "old-client-capability" });
		writeMessage(socket, { type: "list", requestId: "old-client-barrier" });
		await next("sessions", "old-client-barrier");
		assert.equal(
			received.some((frame) => frame.type === "pending_stage_route_registered"),
			false,
		);
	} finally {
		socket.destroy();
	}
});

test("an acknowledged registration still refuses a route another session owns", async () => {
	const runId = runIdFor("77770007", 0);
	const group = runGroup(runId);
	const owner = new IntercomClient(`route-burst-owner-${++hostCounter}`);
	const intruder = new IntercomClient(`route-burst-intruder-${hostCounter}`);
	for (const client of [owner, intruder]) {
		client.on("error", () => {});
		openClients.add(client);
	}
	await owner.connect(registration("ack-route-owner", group));
	await intruder.connect(registration("ack-route-intruder", group));
	await owner.registerPendingStageRouteAcknowledged(runId, group, "owner-capability");

	const refusal = await intruder.registerPendingStageRouteAcknowledged(runId, group, "different-capability").then(
		() => undefined,
		(error: Error) => error,
	);

	assert.ok(refusal instanceof Error);
	assert.equal(refusal.message, "Pending-stage route is not authorized");
	assert.equal(isRecoverableIntercomDisconnect(refusal), false);
	assert.equal(owner.isConnected(), true);
	await owner.registerPendingStageRouteAcknowledged(runId, group, "owner-capability");
});

/**
 * One run's route connection times out, so that run waits out its own jittered backoff. A stage that starts in
 * that window awaits the completion of the route its run published last; the run's retry, not the caller,
 * registers it.
 */
async function withRunInBackoff<T>(
	scope: string,
	body: (context: {
		readonly runId: string;
		readonly host: Host;
		readonly observer: Client;
		readonly diagnostics: { mock: { calls: unknown[][] } };
		recover(): void;
	}) => Promise<T>,
): Promise<T> {
	const runId = runIdFor(scope, 0);
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	const observer = await connectObserver([runGroup(runId)]);
	let stalled = true;
	const host = createHost((returnAddress) =>
		stalled && returnAddress.endsWith(`${ROUTE_PREFIX}${runGroup(runId)}`) ? STALLED_CONNECT_TIMEOUT_MS : undefined,
	);
	proxy.hold(
		(first) => first.type === "register" && String(first.returnAddress).endsWith(`${ROUTE_PREFIX}${runGroup(runId)}`),
	);
	await host.start();
	try {
		const first = await settleWithinBound(host.publishRoute(runId, 1));
		assert.ok(
			first.status === "rejected" && isRecoverableIntercomDisconnect(first.reason),
			"the run's route connection must time out for the run to enter its backoff",
		);
		return await body({
			runId,
			host,
			observer,
			diagnostics,
			recover() {
				stalled = false;
				proxy.release();
			},
		});
	} finally {
		await host.shutdown();
	}
}

test("a route published while its run waits out a connection timeout registers once the run's retry connects", async () => {
	await withRunInBackoff("88880008", async ({ runId, host, observer, diagnostics, recover }) => {
		const publishedAt = Date.now();
		const completion = host.publishRoute(runId, 2);
		recover();
		// Releasing forwards the register frame of the timed-out connection the proxy had not yet seen close.
		const registersBefore = routeRegistersFor(runId);

		const outcome = await settleWithinBound(completion);

		assert.ok(
			outcome.status === "fulfilled",
			`a publication during the backoff must wait for the run's retry, not fail (${outcome.status === "rejected" ? outcome.reason.message : ""})`,
		);
		assert.ok(
			Date.now() - publishedAt >= reconnectDelayMs(0) / 2 - TIMER_EARLY_SLACK_MS,
			"the run's jittered backoff is kept: the publication did not open a connection of its own",
		);
		assert.equal(routeRegistersFor(runId) - registersBefore, 1, "one retry connection serves every publication");
		const roster = (await observer.listDirectory()).workflowStages;
		assert.deepEqual(
			roster.filter((stage) => stage.runId === runId).map((stage) => stage.target),
			[`${runGroup(runId)}/reviewer-2`],
			"the broker holds the latest route the run published",
		);
		assert.deepEqual(relayDiagnostics(diagnostics), []);
	});
});

test("a route published while its run waits out a connection timeout fails retryably when the run's retry fails too", async () => {
	await withRunInBackoff("99990009", async ({ runId, host, diagnostics }) => {
		const publishedAt = Date.now();
		const outcome = await settleWithinBound(host.publishRoute(runId, 2));
		const retryOutcomes = host.emittedEvents.filter(
			({ eventName }) => eventName === "atomic:intercom-route-retry-outcome",
		);
		assert.equal(retryOutcomes.length, 1, "the failed retry is reported to the outage tracker, waiter or not");
		const [retryOutcome] = retryOutcomes;
		assert.ok(retryOutcome);
		assert.equal(isIntercomBrokerTimeout((retryOutcome.payload as { error?: Error }).error), true);

		assert.ok(outcome.status === "rejected", "the retry meets the same unresponsive broker");
		assert.ok(
			Date.now() - publishedAt >= STALLED_CONNECT_TIMEOUT_MS - TIMER_EARLY_SLACK_MS,
			"the failure is the run's retry giving up, not an immediate refusal",
		);
		assert.equal(isRecoverableIntercomDisconnect(outcome.reason), true);
		assert.equal(
			isRetryableSameModelFailure(outcome.reason),
			true,
			"a stage starting in the backoff window retries instead of failing terminally",
		);
		assert.deepEqual(relayDiagnostics(diagnostics), [], "a recoverable timeout is not reported per publication");
	});
});

test("a route waiting on its run's retry settles when the session shuts down", async () => {
	const runId = runIdFor("aaaa000a", 0);
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	await connectObserver([runGroup(runId)]);
	const host = createHost((returnAddress) =>
		returnAddress.endsWith(`${ROUTE_PREFIX}${runGroup(runId)}`) ? STALLED_CONNECT_TIMEOUT_MS : undefined,
	);
	proxy.hold(
		(first) => first.type === "register" && String(first.returnAddress).endsWith(`${ROUTE_PREFIX}${runGroup(runId)}`),
	);
	await host.start();
	let shutDown = false;
	try {
		await settleWithinBound(host.publishRoute(runId, 1));
		const waiting = host.publishRoute(runId, 2);
		// The relay claims the event at once but reaches the run's backoff a few microtasks later.
		await tick();
		await host.shutdown();
		shutDown = true;

		const outcome = await settleWithinBound(waiting);

		assert.ok(outcome.status === "rejected", "nothing is left to register the route");
		assert.equal(isRecoverableIntercomDisconnect(outcome.reason), true);
		assert.deepEqual(relayDiagnostics(diagnostics), [], "teardown is not reported as a relay failure");
	} finally {
		if (!shutDown) await host.shutdown();
	}
});

test("a route waiting on its run's retry settles when the run's route is replaced", async () => {
	await withRunInBackoff("bbbb000b", async ({ runId, host }) => {
		const waiting = host.publishRoute(runId, 2);
		const replacement = host.publishRoute(runId, 3, `replacement-capability-${runId}`);

		const outcome = await settleWithinBound(waiting);

		assert.ok(outcome.status === "rejected", "the retry that would have registered the old route is gone");
		assert.equal(isRecoverableIntercomDisconnect(outcome.reason), true);
		await settleWithinBound(replacement);
	});
});

test("two routes published back to back after a capability rotation both register and nothing is reported (#3887)", async () => {
	const runId = runIdFor("38870001", 0);
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	const observer = await connectObserver([runGroup(runId)]);
	const host = createHost();

	await withHost(host, async () => {
		await host.publishRoute(runId, 1, `before-rotation-${runId}`);
		const rotated = `after-rotation-${runId}`;
		const first = host.publishRoute(runId, 2, rotated);
		const latest = host.publishRoute(runId, 3, rotated);

		const outcomes = await Promise.all([settleWithinBound(first), settleWithinBound(latest)]);

		assert.deepEqual(
			outcomes.map(({ status }) => status),
			["fulfilled", "fulfilled"],
			"both publications of the rotated route are served by one connection",
		);
		assert.deepEqual(relayDiagnostics(diagnostics), []);
		const roster = (await observer.listDirectory()).workflowStages;
		assert.deepEqual(
			roster.filter((stage) => stage.runId === runId).map((stage) => stage.target),
			[`${runGroup(runId)}/reviewer-3`],
			"the broker holds the roster the run published last, not an earlier one",
		);
	});
});

test("a route still connecting when its capability rotates is superseded without a relay failure (#3887)", async () => {
	const runId = runIdFor("38870002", 0);
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	const observer = await connectObserver([runGroup(runId)]);
	const host = createHost();
	proxy.hold(
		(first) => first.type === "register" && String(first.returnAddress).endsWith(`${ROUTE_PREFIX}${runGroup(runId)}`),
	);

	await withHost(host, async () => {
		const retired = host.publishRoute(runId, 1, `retired-${runId}`);
		await waitFor("the retired route's handshake", () => (proxy.heldConnections() >= 1 ? true : undefined));
		const current = host.publishRoute(runId, 2, `current-${runId}`);
		proxy.release();

		const [retiredOutcome, currentOutcome] = await Promise.all([
			settleWithinBound(retired),
			settleWithinBound(current),
		]);

		assert.ok(
			retiredOutcome.status === "rejected" && isRecoverableIntercomDisconnect(retiredOutcome.reason),
			"the retired capability's publication ends as a superseded route, not as a failure",
		);
		assert.equal(currentOutcome.status, "fulfilled");
		assert.deepEqual(relayDiagnostics(diagnostics), []);
		const roster = (await observer.listDirectory()).workflowStages;
		assert.deepEqual(
			roster.filter((stage) => stage.runId === runId).map((stage) => stage.target),
			[`${runGroup(runId)}/reviewer-2`],
		);
	});
});

test("a route connect abandoned because the session shut down is still reported (#3887)", async () => {
	const runId = runIdFor("38870003", 0);
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	await connectObserver([runGroup(runId)]);
	const host = createHost();
	proxy.hold(
		(first) => first.type === "register" && String(first.returnAddress).endsWith(`${ROUTE_PREFIX}${runGroup(runId)}`),
	);
	await host.start();
	let shutDown = false;
	try {
		const abandoned = host.publishRoute(runId, 1);
		await waitFor("the route's handshake", () => (proxy.heldConnections() >= 1 ? true : undefined));
		const shutdown = host.shutdown();
		shutDown = true;
		proxy.release();

		const outcome = await settleWithinBound(abandoned);
		await shutdown;

		assert.ok(outcome.status === "rejected");
		assert.equal(outcome.reason.message, "Intercom runtime no longer active");
		assert.equal(isRecoverableIntercomDisconnect(outcome.reason), false);
		assert.deepEqual(relayDiagnostics(diagnostics), [
			"Intercom event relay failed (atomic:workflow-pending-stage-route):",
		]);
	} finally {
		if (!shutDown) await host.shutdown();
	}
});

test("a failed scheduled retry reaches a waiting stage as a retryable failure unless it is a real one", () => {
	const timeout = new IntercomBrokerTimeoutError("Connection timeout");
	assert.equal(scheduledRetryFailure(timeout), timeout, "a broker timeout is already what a stage retries");

	const lostSocket = scheduledRetryFailure(new IntercomClientDisconnectedError());
	assert.equal(isRetryableSameModelFailure(new IntercomClientDisconnectedError()), false, "the bare loss is terminal");
	assert.equal(isRecoverableIntercomDisconnect(lostSocket), true);
	assert.equal(isRetryableSameModelFailure(lostSocket), true, "a loss during the retry is retried by the stage");

	for (const real of [
		new Error("Pending-stage route is not authorized"),
		new Error("Intercom runtime no longer active"),
	]) {
		assert.equal(scheduledRetryFailure(real), real, "a failure that is not transient is reported as it happened");
	}
});

test("route clients that failed together retry spread across their backoff step, never beyond it", () => {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const step = reconnectDelayMs(attempt);
		assert.equal(
			jitteredReconnectDelayMs(attempt, () => 0),
			step / 2,
		);
		assert.equal(
			jitteredReconnectDelayMs(attempt, () => 0.999999),
			step,
		);
		const spread = new Set(
			Array.from({ length: 10 }, (_, slot) => jitteredReconnectDelayMs(attempt, () => slot / 10)),
		);
		assert.ok(spread.size > 1, "synchronized failures must not retry at the same instant");
		for (const delay of spread) assert.ok(delay >= step / 2 && delay <= step);
	}
});

function registration(name: string, group: string) {
	return {
		name,
		group,
		cwd: repoRoot,
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
	};
}

test("an established standalone owner keeps stage routes during an acknowledgement timeout (#3863)", async () => {
	const { createWorkflowRouteOwner } = await import("../../packages/intercom/workflow-route-owner.js");
	const owner = createWorkflowRouteOwner(repoRoot);
	const runId = runIdFor("38630001", 1);
	const group = runGroup(runId);
	const stage = new IntercomClient();
	stage.on("error", () => {});
	openClients.add(stage);
	try {
		const initial = routePayload(runId, 1);
		owner.events.emit("atomic:workflow-pending-stage-route", initial);
		await initial.completion;
		await stage.connect({
			cwd: repoRoot,
			model: "test-model",
			pid: process.pid,
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group,
		});
		await stage.registerLiveWorkflowStageRoute(runId, ["reviewer-1"], initial.capability);
		const observer = await connectObserver([group]);
		let withheld = false;
		proxy.transformBrokerFrames((frame) => {
			if (frame.type !== "pending_stage_route_registered" || withheld) return frame;
			withheld = true;
			return undefined;
		});
		const update = routePayload(runId, 2);
		owner.events.emit("atomic:workflow-pending-stage-route", update);
		assert.ok(update.completion);
		await assert.rejects(update.completion, IntercomBrokerTimeoutError);
		assert.equal(withheld, true);
		await stage.registerLiveWorkflowStageRoute(runId, ["reviewer-2"], update.capability);
		assert.ok(
			(await observer.listDirectory()).workflowStages.some(
				(entry) => entry.runId === runId && entry.sessionId === stage.sessionId,
			),
		);
		await waitFor("the standalone owner's publication retry", () =>
			proxy.toBroker.filter(({ frame }) => frame.type === "register_pending_stage_route" && frame.runId === runId)
				.length >= 3
				? true
				: undefined,
		);
		assert.equal(routeRegistersFor(runId), 1, "publication retries reuse the established owner connection");
	} finally {
		await owner.closeGroup(group);
		await stage.disconnect();
	}
});

test("a standalone owner replaces an unacknowledged initial connection before retrying (#3863)", async () => {
	const { createWorkflowRouteOwner } = await import("../../packages/intercom/workflow-route-owner.js");
	const owner = createWorkflowRouteOwner(repoRoot);
	const runId = runIdFor("38630002", 1);
	const group = runGroup(runId);
	const observer = await connectObserver([group]);
	let withheld = false;
	proxy.transformBrokerFrames((frame) => {
		if (frame.type !== "pending_stage_route_registered" || withheld) return frame;
		withheld = true;
		return undefined;
	});
	try {
		const initial = routePayload(runId, 1);
		owner.events.emit("atomic:workflow-pending-stage-route", initial);
		assert.ok(initial.completion);
		await assert.rejects(initial.completion, IntercomBrokerTimeoutError);
		assert.equal(withheld, true);
		await waitFor("a replacement standalone owner connection", () =>
			routeRegistersFor(runId) >= 2 ? true : undefined,
		);
		await waitForRoster(observer, [runId]);
		assert.equal(routeRegistersFor(runId), 2, "the failed initial client is replaced on retry");
	} finally {
		await owner.closeGroup(group);
	}
	await waitFor("the closed standalone owner's route to leave the broker roster", async () =>
		(await rosterRunIds(observer)).has(runId) ? undefined : true,
	);
});
