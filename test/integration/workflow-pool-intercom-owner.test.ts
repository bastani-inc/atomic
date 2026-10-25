/**
 * Pooled child stages call Intercom as soon as they start (#3904).
 *
 * A root host with the Intercom and workflow pending-stage extensions loaded, as an
 * interactive session has them, fans out 150 pooled children through a LocalWorkerPool. Each
 * child is claimed by a protocol stub worker (test/fixtures/pool-intercom-stub-worker.mjs)
 * that publishes an Intercom-capable agent stage and takes the root's pending-stage route,
 * exactly as a real worker does before it starts the stage session. The moment the route
 * request returns, the stub hands the stage to this process, which starts it with the real
 * Intercom extension and immediately calls `intercom status`, `list` and `send`.
 *
 * Under a large fan-out the route owners' broker connections do not stay up: a saturated
 * host misses broker acknowledgements and health checks, the client drops the connection, and
 * the broker drops every route that connection owned until the owner registers it again. The
 * broker sits behind a byte-forwarding proxy, and twice during the fan-out the test closes
 * every route-owner connection just before it starts a stage. No stage may fail an Intercom
 * call because its run's pending-stage route owner is not registered with the broker.
 *
 * While a stage waits for its route owner to register, the worker that runs it must still answer pause and
 * resume: a second test holds the coordinator's route registration and pauses the pool.
 *
 * Run alone:
 *
 *   npx vitest --run --project integration test/integration/workflow-pool-intercom-owner.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";
import { IntercomWireProxy } from "../helpers/intercom-wire-proxy.js";
import { testRunId } from "../helpers/run-id.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	sleep,
	writeTextSync,
} from "../helpers/runtime.js";

/** Pooled children, one per stub worker, all started at once. */
const CHILDREN = 150;
/** Stages (by start order) just before which every route-owner connection is closed. */
const OWNER_CONNECTION_DROPS = new Set([Math.floor(CHILDREN / 3), Math.floor((2 * CHILDREN) / 3)]);
const WORKER_HEARTBEAT_MS = 1_000;
const OWNER_MISSING_REASON = "Live workflow-stage route has no registered workflow owner";
const ROUTE_OWNER_RETURN_ADDRESS = ":pending-stage-route:";
const ROOT_RUN_ID = testRunId("pool-intercom-owner-fanout-root");
const ROOT_GROUP = `workflow:${ROOT_RUN_ID}`;
const ROOT_SESSION_ID = testRunId("pool-intercom-owner-root-session");
const PEER_NAME = "fanout-peer";

/** Structural costs: an Intercom broker, 150 worker processes and 150 stage Intercom sessions. */
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const WORKER_STARTUP_TIMEOUT_MS = 120_000;
const FANOUT_TEST_TIMEOUT_MS = 600_000;

/** Pattern fan-out (#3931): every stage sends this many times to a sibling pattern target, or every 20th to `/**`. */
const PATTERN_CHILDREN = 150;
const PATTERN_SENDS_PER_STAGE = 6;
const PATTERN_BROADCAST_EVERY = 20;
/** Mean interval between one stage's sends (jittered 0.5x to 1.5x). */
const PATTERN_SEND_INTERVAL_MS = 1_000;
/**
 * Root host bounds while the pattern fan-out runs (#3931). Before the fix the host matched every
 * sticky entry against every stage on each change: 550 to 584 of 900 sends succeeded and lag was
 * p99 0.8 to 1.3 s, max 5.7 to 9.1 s. After it, all sends succeed and lag is p99 150 to 175 ms,
 * max 0.3 to 1.4 s. Unlike production, this process also runs the 150 stage Intercom sessions
 * and the broker proxy, which parse every multi-megabyte `list` reply and roster frame (the
 * delivery states of each stage and sticky entry); production runs stages in pool workers. The
 * bounds allow for that extra load; the unfixed lag still exceeds them several times over.
 */
const PATTERN_LAG_P99_BOUND_MS = 250;
const PATTERN_LAG_MAX_BOUND_MS = 2_500;
/** At least 99% of sends (891 of 900) must succeed. */
const PATTERN_SEND_SUCCESS_RATIO = 0.99;

// The Intercom client resolves its broker socket when it loads, so the isolated agent
// directory is in place before anything that reaches it is imported. Clients use the
// proxy's socket in `agentDir`; the broker listens in its own directory behind it.
const directory = makeTempDirectory("pool-intercom-owner-");
const agentDir = join(directory, "agent");
const brokerAgentDir = join(directory, "broker");

const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercom } = await import("../../packages/intercom/index.js");
const { registerPendingStageIntercomBridge } = await import(
	"../../packages/workflows/src/extension/pending-stage-intercom.js"
);
const { workflow } = await import("../../packages/workflows/src/authoring/workflow.js");
const { JournalDurableBackend } = await import("../../packages/workflows/src/durable/journal/journal-backend.js");
const { resolveRunJournal } = await import("../../packages/workflows/src/durable/journal/resolution.js");
const { run } = await import("../../packages/workflows/src/engine/run.js");
const { createStore } = await import("../../packages/workflows/src/shared/store.js");
const { definitionDigest, loadWorkerDefinition } = await import("../../packages/workflows/src/workers/definitions.js");
const { LocalWorkerPool } = await import("../../packages/workflows/src/workers/local-pool.js");

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	removeTempDirectory(directory);
});

interface ToolResult {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
	readonly isError: boolean;
	readonly details?: { readonly delivered?: boolean };
}

interface StageDelivery {
	readonly routeCapability: string;
	ready(): Promise<void>;
	deliverPending(): Promise<void>;
	fail(reason: Error): void;
}

interface HostContext {
	readonly hasUI: false;
	readonly cwd: string;
	isIdle(): boolean;
	readonly model: { readonly id: string };
	readonly orchestrationContext: {
		readonly intercomGroup: string;
		readonly kind?: "workflow-stage";
		readonly workflowRunId?: string;
		readonly workflowStageId?: string;
		readonly workflowStageName?: string;
		readonly pendingStageDelivery?: StageDelivery;
	};
	readonly sessionManager: { getSessionId(): string; getBranch(): []; getEntries(): [] };
	readonly ui: { confirm(): Promise<boolean>; notify(): void };
}

type ToolParams = { readonly action: string; readonly to?: string; readonly message?: string };
type Execute = (
	id: string,
	params: ToolParams,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: HostContext,
) => Promise<ToolResult>;
type LifecycleHandler = (event: Record<string, string>, ctx: HostContext) => void | Promise<void>;
type EventHandler = (payload: object) => void;

/** An Atomic host session as the Intercom extension sees it: lifecycle, tools and the shared event bus. */
function hostSession(sessionId: string, orchestrationContext: HostContext["orchestrationContext"]) {
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const events = new Map<string, EventHandler[]>();
	const tools = new Map<string, Execute>();
	let sessionName = "";
	let activeTools: string[] = [];
	const context: HostContext = {
		hasUI: false,
		cwd: directory,
		isIdle: () => true,
		model: { id: "fixture-model" },
		orchestrationContext,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] },
		ui: { confirm: async () => true, notify() {} },
	};
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
		},
		registerTool(tool: { name: string; execute?: Execute }) {
			if (tool.execute) tools.set(tool.name, tool.execute);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
		},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(name: string, handler: EventHandler) {
				events.set(name, [...(events.get(name) ?? []), handler]);
				return () =>
					events.set(
						name,
						(events.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit(name: string, payload: object) {
				for (const handler of events.get(name) ?? []) handler(payload);
			},
		},
	};
	const fire = async (name: string, event: Record<string, string>): Promise<void> => {
		for (const handler of lifecycle.get(name) ?? []) await handler(event, context);
	};
	return {
		pi,
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
		intercom(params: ToolParams): Promise<ToolResult> {
			const execute = tools.get("intercom");
			assert.ok(execute, "the Intercom tool is registered");
			return execute(`call-${params.action}`, params, undefined, undefined, context);
		},
	};
}

interface PooledStage {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	readonly sessionId: string;
	readonly capability: string;
}

interface StageOutcome {
	readonly runId: string;
	/** Every Intercom failure the stage saw, tool results and the stage warm-up included. */
	readonly failures: string[];
	readonly delivered: boolean;
}

/** Starts one pooled stage with the real Intercom extension and calls status, list and send at once. */
async function runStage(stage: PooledStage, group = ROOT_GROUP): Promise<StageOutcome> {
	const failures: string[] = [];
	const delivery: StageDelivery = {
		routeCapability: stage.capability,
		async ready() {},
		async deliverPending() {},
		fail(reason) {
			const causes: string[] = [];
			for (let current: Error | undefined = reason; current !== undefined; ) {
				causes.push(current.message);
				current = current.cause instanceof Error ? current.cause : undefined;
			}
			failures.push(`stage warm-up: ${causes.join(" <- ")}`);
		},
	};
	const host = hostSession(stage.sessionId, {
		intercomGroup: group,
		kind: "workflow-stage",
		workflowRunId: stage.runId,
		workflowStageId: stage.stageId,
		workflowStageName: stage.stageName,
		pendingStageDelivery: delivery,
	});
	intercom(host.pi as never);
	let delivered = false;
	try {
		await host.start();
		for (const params of [
			{ action: "status" },
			{ action: "list" },
			{ action: "send", to: PEER_NAME, message: `hello from ${stage.runId}` },
		]) {
			try {
				const result = await host.intercom(params);
				const text = result.content.map((part) => part.text).join("\n");
				if (result.isError) failures.push(`${params.action}: ${text}`);
				else if (params.action === "send") delivered = result.details?.delivered === true;
			} catch (error) {
				failures.push(`${params.action}: ${(error as Error).message}`);
			}
		}
	} finally {
		await host.shutdown().catch(() => {});
	}
	return { runId: stage.runId, failures, delivered };
}

interface PatternSendOutcome {
	readonly sends: number;
	readonly failures: string[];
}

/** Starts one pooled stage and sends to sibling pattern targets, as a stage of a chatty fan-out does. */
async function runPatternStage(
	stage: PooledStage,
	targets: readonly string[],
	group: string,
): Promise<PatternSendOutcome> {
	const failures: string[] = [];
	const host = hostSession(stage.sessionId, {
		intercomGroup: group,
		kind: "workflow-stage",
		workflowRunId: stage.runId,
		workflowStageId: stage.stageId,
		workflowStageName: stage.stageName,
		pendingStageDelivery: {
			routeCapability: stage.capability,
			async ready() {},
			async deliverPending() {},
			fail(reason) {
				failures.push(`stage warm-up: ${reason.message}`);
			},
		},
	});
	intercom(host.pi as never);
	let sends = 0;
	try {
		await host.start();
		for (const to of targets) {
			await sleep(PATTERN_SEND_INTERVAL_MS * (0.5 + Math.random()));
			sends++;
			try {
				const result = await host.intercom({ action: "send", to, message: `hello from ${stage.runId}` });
				if (result.isError) failures.push(`send ${to}: ${result.content.map((part) => part.text).join("\n")}`);
			} catch (error) {
				failures.push(`send ${to}: ${(error as Error).message}`);
			}
		}
	} finally {
		await host.shutdown().catch(() => {});
	}
	return { sends, failures };
}

/** A broker in its own directory, reached only through a proxy on the clients' broker socket. */
async function startProxiedBroker(brokerDirectory = brokerAgentDir) {
	const intercomPath = fileURLToPath(new URL("../../packages/intercom", import.meta.url));
	const brokerSocket = getBrokerSocketPath(process.platform, brokerDirectory);
	const broker = spawn(process.execPath, [getJitiCliPath(intercomPath), join(intercomPath, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerDirectory },
		stdio: "ignore",
	});
	const stop = async () => {
		if (broker.exitCode !== null || broker.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => broker.once("exit", () => resolve()));
		broker.kill("SIGTERM");
		await exited;
	};
	const deadline = performance.now() + BROKER_STARTUP_TIMEOUT_MS;
	while (!fileExistsSync(brokerSocket)) {
		if (broker.exitCode !== null) throw new Error(`Intercom broker exited with code ${broker.exitCode}`);
		if (performance.now() > deadline) {
			await stop();
			throw new Error("Intercom broker did not start");
		}
		await sleep(25);
	}
	const proxy = new IntercomWireProxy(getBrokerSocketPath(process.platform, agentDir), brokerSocket);
	await proxy.listen();
	return {
		proxy,
		async stop() {
			await proxy.close();
			await stop();
		},
	};
}

test.skipIf(process.platform === "win32")(
	"150 pooled children call intercom status, list and send as their stages start, with no owner_missing (#3904)",
	async () => {
		const broker = await startProxiedBroker();
		const path = join(directory, "journal.sqlite");
		const stageSocket = join(directory, "stages.sock");
		const failureLog = join(directory, "stub-failures.log");
		writeTextSync(
			join(directory, "fanout-config.json"),
			JSON.stringify({ stageSocket, failureLog, heartbeatMs: WORKER_HEARTBEAT_MS }),
		);

		const outcomes: StageOutcome[] = [];
		const stageRuns = new Set<Promise<void>>();
		let stagesStarted = 0;
		let ownerConnectionsDropped = 0;
		const stages = net.createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				const stage = JSON.parse(buffer.slice(0, end)) as PooledStage;
				buffer = "";
				if (OWNER_CONNECTION_DROPS.has(++stagesStarted))
					ownerConnectionsDropped += broker.proxy.disconnect(
						(first) =>
							first.type === "register" && String(first.returnAddress).includes(ROUTE_OWNER_RETURN_ADDRESS),
					);
				const stageRun = runStage(stage).then((outcome) => {
					outcomes.push(outcome);
					socket.end(`${JSON.stringify({ done: true })}\n`);
				});
				stageRuns.add(stageRun);
			});
		});
		await new Promise<void>((resolve) => stages.listen(stageSocket, resolve));

		// The peer every stage sends to: an agent session in the invocation group.
		const peer = new IntercomClient("fanout-peer");
		await peer.connect({
			name: PEER_NAME,
			cwd: directory,
			model: "fixture-model",
			pid: process.pid,
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: ROOT_GROUP,
			groups: [ROOT_GROUP],
		});

		const store = createStore();
		const root = hostSession(ROOT_SESSION_ID, { intercomGroup: "default" });
		intercom(root.pi as never);
		const disposeBridge = registerPendingStageIntercomBridge({ events: root.pi.events }, store);
		await root.start();

		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-intercom-fanout-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: CHILDREN,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			startupTimeoutMs: WORKER_STARTUP_TIMEOUT_MS,
			workerEntry: fileURLToPath(new URL("../fixtures/pool-intercom-stub-worker.mjs", import.meta.url)),
		});
		const parent = workflow({
			name: "pool-intercom-owner-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await Promise.all(
					Array.from({ length: CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { index } })),
				);
				return {};
			},
		});
		try {
			const outcome = await run(
				parent,
				{},
				{ runId: ROOT_RUN_ID, cwd: directory, store, durableBackend: backend },
			).then(
				(result) => ({ status: result.status, error: result.error }),
				(error: Error) => ({ status: "rejected", error: error.message }),
			);
			await Promise.all(stageRuns);
			const failed = outcomes.filter((entry) => entry.failures.length > 0);
			const ownerMissing = outcomes.flatMap((entry) =>
				entry.failures.filter((failure) => failure.includes(OWNER_MISSING_REASON)),
			);
			// The broker authorizes a route only for its owner's single registration group, so each route owner
			// keeps one connection per invocation group, never one per run. Every run here is in ROOT_GROUP, so
			// exactly two connections serve the whole fan-out whatever CHILDREN is: the root host's, for the root
			// run, and the pool coordinator's, for every pooled child. Reconnects keep their return address.
			const routeOwnerConnections = new Set(
				broker.proxy.toBroker
					.filter(
						({ frame }) =>
							frame.type === "register" && String(frame.returnAddress).includes(ROUTE_OWNER_RETURN_ADDRESS),
					)
					.map(({ frame }) => String(frame.returnAddress)),
			);
			const routeOwners = [...routeOwnerConnections]
				.map((address) => {
					const [owner, group] = address.split(ROUTE_OWNER_RETURN_ADDRESS);
					return { owner: owner === ROOT_SESSION_ID ? "root host" : "pool coordinator", group };
				})
				.sort((left, right) => left.owner.localeCompare(right.owner));
			const stubFailures = fileExistsSync(failureLog)
				? readTextSync(failureLog, "utf8").split("\n").filter(Boolean)
				: [];
			console.log(
				`[pool-intercom-owner #3904] ${JSON.stringify(
					{
						children: CHILDREN,
						stagesStarted: outcomes.length,
						ownerConnectionsDropped,
						routeOwnerConnections: [...routeOwnerConnections],
						stagesWithFailures: failed.length,
						ownerMissingFailures: ownerMissing.length,
						sendsDelivered: outcomes.filter((entry) => entry.delivered).length,
						run: outcome,
						sampleFailures: failed.slice(0, 5).map((entry) => entry.failures),
						stubFailures: stubFailures.slice(0, 5),
					},
					null,
					2,
				)}`,
			);
			assert.ok(
				ownerConnectionsDropped >= OWNER_CONNECTION_DROPS.size,
				`only ${ownerConnectionsDropped} route-owner connections were open to drop`,
			);
			assert.deepEqual(
				routeOwners,
				[
					{ owner: "pool coordinator", group: ROOT_GROUP },
					{ owner: "root host", group: ROOT_GROUP },
				],
				`expected one route connection per route owner for the invocation group, independent of the ${CHILDREN} pooled runs; got ${[...routeOwnerConnections].join(", ")}`,
			);
			assert.equal(ownerMissing.length, 0, `stages saw owner_missing: ${ownerMissing.slice(0, 5).join("\n")}`);
			assert.deepEqual(
				failed.map((entry) => entry.failures),
				[],
			);
			assert.deepEqual(stubFailures, []);
			assert.equal(outcomes.length, CHILDREN);
			assert.equal(outcomes.filter((entry) => entry.delivered).length, CHILDREN);
			assert.deepEqual(outcome, { status: "completed", error: undefined });
		} finally {
			await pool.close();
			await backend.close();
			disposeBridge();
			await root.shutdown().catch(() => {});
			await peer.disconnect().catch(() => {});
			await new Promise<void>((resolve) => stages.close(() => resolve()));
			await broker.stop();
		}
	},
	FANOUT_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a pooled worker waiting for its run's route registration still acknowledges pause promptly (#3904)",
	async () => {
		const children = 2;
		const rootRunId = testRunId("pool-intercom-owner-pause-root");
		const rootGroup = `workflow:${rootRunId}`;
		const rootSessionId = testRunId("pool-intercom-owner-pause-root-session");
		const testDirectory = join(directory, "pause");
		mkdirSync(testDirectory, { recursive: true });
		const broker = await startProxiedBroker(join(directory, "pause-broker"));
		// The pool coordinator's route owner cannot register while held, so every pooled stage waits for its route.
		broker.proxy.hold(
			(first) =>
				first.type === "register" &&
				String(first.returnAddress).includes(ROUTE_OWNER_RETURN_ADDRESS) &&
				!String(first.returnAddress).startsWith(rootSessionId),
		);
		const path = join(testDirectory, "journal.sqlite");
		const stageSocket = join(testDirectory, "stages.sock");
		const failureLog = join(testDirectory, "stub-failures.log");
		const routeLog = join(testDirectory, "route-requests.log");
		writeTextSync(
			join(testDirectory, "fanout-config.json"),
			JSON.stringify({ stageSocket, failureLog, routeLog, heartbeatMs: 100 }),
		);

		const outcomes: StageOutcome[] = [];
		const stageRuns = new Set<Promise<void>>();
		let stagesStarted = 0;
		const stages = net.createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				const stage = JSON.parse(buffer.slice(0, end)) as PooledStage;
				buffer = "";
				stagesStarted++;
				const stageRun = runStage(stage, rootGroup).then((outcome) => {
					outcomes.push(outcome);
					socket.end(`${JSON.stringify({ done: true })}\n`);
				});
				stageRuns.add(stageRun);
			});
		});
		await new Promise<void>((resolve) => stages.listen(stageSocket, resolve));

		const peer = new IntercomClient("pause-peer");
		await peer.connect({
			name: PEER_NAME,
			cwd: testDirectory,
			model: "fixture-model",
			pid: process.pid,
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: rootGroup,
			groups: [rootGroup],
		});
		const store = createStore();
		const root = hostSession(rootSessionId, { intercomGroup: "default" });
		intercom(root.pi as never);
		const disposeBridge = registerPendingStageIntercomBridge({ events: root.pi.events }, store);
		await root.start();

		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-intercom-fanout-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: children,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			startupTimeoutMs: WORKER_STARTUP_TIMEOUT_MS,
			workerEntry: fileURLToPath(new URL("../fixtures/pool-intercom-stub-worker.mjs", import.meta.url)),
		});
		const parent = workflow({
			name: "pool-intercom-owner-pause-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await Promise.all(
					Array.from({ length: children }, (_, index) => ctx.workflow(child, { inputs: { index } })),
				);
				return {};
			},
		});
		const execution = run(parent, {}, { runId: rootRunId, cwd: testDirectory, store, durableBackend: backend }).then(
			(result) => ({ status: result.status, error: result.error }),
			(error: Error) => ({ status: "rejected", error: error.message }),
		);
		try {
			const deadline = performance.now() + WORKER_STARTUP_TIMEOUT_MS;
			const routeRequests = () =>
				fileExistsSync(routeLog) ? readTextSync(routeLog, "utf8").split("\n").filter(Boolean).length : 0;
			while (routeRequests() < children) {
				assert.ok(performance.now() < deadline, "pooled stages did not request their routes");
				await sleep(25);
			}
			// Let the route requests reach the coordinator and start waiting on the held registration.
			await sleep(500);
			assert.equal(stagesStarted, 0, "a stage started before its run's route owner was registered");

			const pausing = performance.now();
			await pool.control("paused");
			const pauseMs = performance.now() - pausing;
			assert.ok(pauseMs < 2_500, `pause took ${Math.round(pauseMs)} ms while route registration was held`);
			assert.equal(stagesStarted, 0, "a stage started before its run's route owner was registered");

			await pool.control("running");
			broker.proxy.release();
			const outcome = await execution;
			await Promise.all(stageRuns);
			assert.deepEqual(outcome, { status: "completed", error: undefined });
			assert.equal(outcomes.length, children);
			assert.deepEqual(
				outcomes.flatMap((entry) => entry.failures),
				[],
			);
			assert.equal(fileExistsSync(failureLog), false);
		} finally {
			broker.proxy.release();
			await pool.control("running").catch(() => {});
			await execution;
			await pool.close();
			await backend.close();
			disposeBridge();
			await root.shutdown().catch(() => {});
			await peer.disconnect().catch(() => {});
			await new Promise<void>((resolve) => stages.close(() => resolve()));
			await broker.stop();
		}
	},
	FANOUT_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"pooled children sending to sibling pattern targets keep the root host responsive and their sends succeed (#3931)",
	async () => {
		const rootRunId = testRunId("pool-intercom-pattern-root");
		const rootGroup = `workflow:${rootRunId}`;
		const rootSessionId = testRunId("pool-intercom-pattern-root-session");
		const testDirectory = join(directory, "pattern");
		mkdirSync(testDirectory, { recursive: true });
		const broker = await startProxiedBroker(join(directory, "pattern-broker"));
		const path = join(testDirectory, "journal.sqlite");
		const stageSocket = join(testDirectory, "stages.sock");
		const failureLog = join(testDirectory, "stub-failures.log");
		writeTextSync(
			join(testDirectory, "fanout-config.json"),
			JSON.stringify({ stageSocket, failureLog, heartbeatMs: WORKER_HEARTBEAT_MS }),
		);

		const outcomes: PatternSendOutcome[] = [];
		const stageRuns = new Set<Promise<void>>();
		let stagesStarted = 0;
		const stages = net.createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				const stage = JSON.parse(buffer.slice(0, end)) as PooledStage;
				buffer = "";
				const index = stagesStarted++;
				const target =
					index % PATTERN_BROADCAST_EVERY === 0
						? `${rootGroup}/**`
						: `${rootGroup}/child-c${String((index + 1) % PATTERN_CHILDREN).padStart(3, "0")}/**`;
				const stageRun = runPatternStage(stage, Array(PATTERN_SENDS_PER_STAGE).fill(target), rootGroup).then(
					(outcome) => {
						outcomes.push(outcome);
						socket.end(`${JSON.stringify({ done: true })}\n`);
					},
				);
				stageRuns.add(stageRun);
			});
		});
		await new Promise<void>((resolve) => stages.listen(stageSocket, resolve));

		const store = createStore();
		const root = hostSession(rootSessionId, { intercomGroup: "default" });
		intercom(root.pi as never);
		const disposeBridge = registerPendingStageIntercomBridge({ events: root.pi.events }, store);
		await root.start();

		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-intercom-fanout-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: PATTERN_CHILDREN,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			startupTimeoutMs: WORKER_STARTUP_TIMEOUT_MS,
			workerEntry: fileURLToPath(new URL("../fixtures/pool-intercom-stub-worker.mjs", import.meta.url)),
		});
		const parent = workflow({
			name: "pool-intercom-pattern-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await Promise.all(
					Array.from({ length: PATTERN_CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { index } })),
				);
				return {};
			},
		});
		// This process is the workflow host: its main thread runs the root, the pool coordinator and the routes.
		// Unlike production, it also runs every stage's Intercom session, so its lag and CPU overstate the host's.
		const lag = monitorEventLoopDelay({ resolution: 5 });
		lag.enable();
		const cpuBefore = process.cpuUsage();
		const startedAt = performance.now();
		try {
			const outcome = await run(
				parent,
				{},
				{ runId: rootRunId, cwd: testDirectory, store, durableBackend: backend },
			).then(
				(result) => ({ status: result.status, error: result.error }),
				(error: Error) => ({ status: "rejected", error: error.message }),
			);
			await Promise.all(stageRuns);
			lag.disable();
			const elapsedMs = performance.now() - startedAt;
			const cpu = process.cpuUsage(cpuBefore);
			const sends = outcomes.reduce((sum, entry) => sum + entry.sends, 0);
			const failures = outcomes.flatMap((entry) => entry.failures);
			const succeeded = sends - failures.length;
			const lagMs = (nanoseconds: number) => Math.round(Math.max(0, nanoseconds / 1e6 - 5));
			const report = {
				children: PATTERN_CHILDREN,
				stagesStarted,
				sends,
				succeeded,
				elapsedMs: Math.round(elapsedMs),
				hostCpuShare: Math.round(((cpu.user + cpu.system) / 1e3 / elapsedMs) * 100) / 100,
				mainThreadLag: {
					p50Ms: lagMs(lag.percentile(50)),
					p99Ms: lagMs(lag.percentile(99)),
					maxMs: lagMs(lag.max),
				},
				journalBytes: statSync(path).size,
				run: outcome,
				sampleFailures: failures.slice(0, 5),
			};
			console.log(`[pool-intercom-pattern #3931] ${JSON.stringify(report, null, 2)}`);
			assert.deepEqual(outcome, { status: "completed", error: undefined });
			assert.equal(stagesStarted, PATTERN_CHILDREN);
			assert.ok(
				succeeded >= sends * PATTERN_SEND_SUCCESS_RATIO && sends === PATTERN_CHILDREN * PATTERN_SENDS_PER_STAGE,
				`${succeeded} of ${sends} pattern sends succeeded; samples: ${failures.slice(0, 5).join("\n")}`,
			);
			assert.ok(
				report.mainThreadLag.p99Ms < PATTERN_LAG_P99_BOUND_MS,
				`root host main-thread lag p99 ${report.mainThreadLag.p99Ms} ms exceeds ${PATTERN_LAG_P99_BOUND_MS} ms (max ${report.mainThreadLag.maxMs} ms)`,
			);
			assert.ok(
				report.mainThreadLag.maxMs < PATTERN_LAG_MAX_BOUND_MS,
				`root host main-thread lag max ${report.mainThreadLag.maxMs} ms exceeds ${PATTERN_LAG_MAX_BOUND_MS} ms`,
			);
		} finally {
			lag.disable();
			await pool.close();
			await backend.close();
			disposeBridge();
			await root.shutdown().catch(() => {});
			await new Promise<void>((resolve) => stages.close(() => resolve()));
			await broker.stop();
		}
	},
	FANOUT_TEST_TIMEOUT_MS,
);
