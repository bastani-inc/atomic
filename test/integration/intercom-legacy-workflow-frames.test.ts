import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { createMessageReader, type JsonWireValue } from "../../packages/intercom/broker/framing.js";
import {
	WORKFLOW_ROUTE_REMOVED_REASON,
	WORKFLOW_TARGET_REMOVED_REASON,
} from "../../packages/intercom/broker/legacy-workflow-frames.js";
import { stopDetachedBroker } from "../helpers/detached-broker.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { bunExecutable, type SpawnedProcess, spawnProcess } from "../helpers/runtime.js";
import { replaceEnvironmentVariable, temporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * Atomic 0.10.0 removed workflows, but kept the Intercom protocol range, so versions mix on one machine:
 * - a 0.9.x session, which still sends its workflow route frames, uses a broker of this version: it keeps asking,
 *   answering and being steered, each workflow frame is answered in place, and no connection drops or registers again;
 * - a session of this version uses a 0.9.x broker that still routes a 0.9.x workflow run: it lists, sends, asks,
 *   replies, joins and leaves as usual, and never sees a workflow row.
 *
 * Every broker is a real process. The 0.9.x clients and broker are the releases vendored unmodified under
 * test/fixtures: intercom-0.9.71 (client and broker, no protocol range) and intercom-0.9.77-alpha.1 (client, with one).
 */

const repoRoot = resolve(import.meta.dirname, "../..");
const RELEASE_0_9_71 = join(repoRoot, "test/fixtures/intercom-0.9.71");
const RELEASE_0_9_77_ALPHA_1 = join(repoRoot, "test/fixtures/intercom-0.9.77-alpha.1");

const TEST_TIMEOUT_MS = 60_000;
const BROKER_START_WAIT_MS = 90_000;
const HOOK_TIMEOUT_MS = BROKER_START_WAIT_MS + 15_000;
const WAIT = { timeout: 15_000, interval: 20 };
/** How long every connection is watched, after the exchanges, for a drop, an error or a second registration. */
const QUIET_MS = 3_000;

type SessionInfo = import("../../packages/intercom/types.js").SessionInfo;
type Message = import("../../packages/intercom/types.js").Message;
type CurrentClient = InstanceType<typeof import("../../packages/intercom/broker/client.js").IntercomClient>;

interface SendOutcome {
	readonly id: string;
	readonly delivered: boolean;
	readonly reason?: string;
}

interface SendOptions {
	readonly text: string;
	readonly replyTo?: string;
	readonly expectsReply?: boolean;
	readonly requirePendingReply?: true;
}

/** A 0.9.x workflow run's roster entry for one stage, as its owner announces it with its pending-stage route. */
interface StageAnnouncement {
	readonly stageId: string;
	readonly stageName: string;
	readonly target: string;
	readonly lifecycle: "pending" | "running";
	readonly routeEligible: true;
	readonly recipientPurpose: "agent";
	readonly group: string;
}

/** The part of a 0.9.x Intercom client a 0.9.x workflow run and its stages use. Loaded by path, so not type-checked. */
interface PreviousClient extends EventEmitter {
	readonly sessionId: string | null;
	isConnected(): boolean;
	connect(
		session: Omit<SessionInfo, "id">,
		supervisor: undefined,
		supervisorOwnerToken: undefined,
		messageSource: undefined,
		registrationGroup: string,
	): Promise<void>;
	send(to: string, options: SendOptions): Promise<SendOutcome>;
	listSessions(): Promise<SessionInfo[]>;
	listDirectory(): Promise<{ readonly sessions: SessionInfo[]; readonly workflowStages: readonly unknown[] }>;
	acknowledgeReceived(messageId: string): void;
	registerPendingStageRouteAcknowledged(
		runId: string,
		group: string,
		capability: string,
		stages: readonly StageAnnouncement[],
		possibleStages: readonly never[],
	): Promise<void>;
	claimWorkflowInvocation(runId: string, launcherCapability: string): Promise<boolean>;
	registerLiveWorkflowStageRoute(runId: string, stageKeys: readonly string[], capability: string): Promise<void>;
	sendPendingStageNotification(
		runId: string,
		capability: string,
		to: string,
		senderRegistrationName: undefined,
		options: SendOptions,
	): Promise<SendOutcome>;
	disconnect(): Promise<void>;
}
type PreviousClientClass = new (
	returnAddress: string,
	options: { acknowledgesReceipt: true; multiplexesPendingStageRoutes?: true; brokerSocketPath?: string },
) => PreviousClient;

/** A client with what it received, the errors it raised and how often it reported its connection lost. */
interface Watched<Client> {
	readonly client: Client;
	readonly received: Message[];
	readonly errors: string[];
	disconnects: number;
}

function watch<Client extends EventEmitter & { acknowledgeReceived(messageId: string): void }>(
	client: Client,
): Watched<Client> {
	const watched: Watched<Client> = { client, received: [], errors: [], disconnects: 0 };
	client.on("message", (_from: SessionInfo, message: Message) => {
		watched.received.push(message);
		client.acknowledgeReceived(message.id);
	});
	client.on("error", (error: Error) => watched.errors.push(error.message));
	client.on("disconnected", () => {
		watched.disconnects += 1;
	});
	return watched;
}

function session(name: string, group: string, groups: readonly string[] = [group]): Omit<SessionInfo, "id"> {
	const now = Date.now();
	return {
		name,
		model: "faux/model",
		cwd: repoRoot,
		pid: process.pid,
		status: "idle",
		startedAt: now,
		lastActivity: now,
		group,
		groups: [...groups],
	};
}

function idOf(client: { readonly sessionId: string | null }): string {
	const id = client.sessionId;
	assert.ok(id, "the client is registered");
	return id;
}

type Frame = { readonly [key: string]: JsonWireValue };

function isFrame(value: JsonWireValue): value is Frame {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One connection through a {@link WireProxy}: every frame its client wrote to the broker and the broker wrote back. */
interface ProxiedConnection {
	readonly toBroker: Frame[];
	readonly toClient: Frame[];
}

/**
 * Forwards every connection made to `path` to the broker at `upstreamPath`, recording each frame both ways. It sees
 * every registration a client makes, on its first socket or any later one, so "registered once" is checked on the wire.
 */
class WireProxy {
	readonly connections: ProxiedConnection[] = [];
	private readonly sockets = new Set<net.Socket>();

	private constructor(private readonly server: net.Server) {}

	static async listen(path: string, upstreamPath: string): Promise<WireProxy> {
		const server = net.createServer();
		const proxy = new WireProxy(server);
		server.on("connection", (client) => proxy.forward(client, upstreamPath));
		await new Promise<void>((settle, fail) => {
			server.once("error", fail);
			server.listen(path, () => {
				server.off("error", fail);
				settle();
			});
		});
		return proxy;
	}

	private forward(client: net.Socket, upstreamPath: string): void {
		const connection: ProxiedConnection = { toBroker: [], toClient: [] };
		this.connections.push(connection);
		const upstream = net.connect(upstreamPath);
		for (const socket of [client, upstream]) {
			this.sockets.add(socket);
			socket.on("error", () => socket.destroy());
			socket.once("close", () => {
				this.sockets.delete(socket);
				client.destroy();
				upstream.destroy();
			});
		}
		const record = (frames: Frame[]) =>
			createMessageReader(
				(frame) => {
					if (isFrame(frame)) frames.push(frame);
				},
				() => {},
			);
		client.on("data", record(connection.toBroker));
		upstream.on("data", record(connection.toClient));
		client.pipe(upstream);
		upstream.pipe(client);
	}

	/** The connections whose client registered as `name`. */
	registeredAs(name: string): ProxiedConnection[] {
		return this.connections.filter((connection) =>
			connection.toBroker.some((frame) => frame.type === "register" && isNamed(frame.session, name)),
		);
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((settle) => this.server.close(() => settle()));
	}
}

function isNamed(value: JsonWireValue | undefined, name: string): boolean {
	return value !== undefined && isFrame(value) && value.name === name;
}

function framesOfType(frames: readonly Frame[], type: string): Frame[] {
	return frames.filter((frame) => frame.type === type);
}

async function waitFor(what: string, predicate: () => boolean): Promise<void> {
	await vi.waitFor(() => assert.ok(predicate(), what), WAIT);
}

function startBroker(entry: string, agentDir: string): SpawnedProcess {
	return spawnProcess([bunExecutable(), entry], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "", ATOMIC_STORAGE: "" },
	});
}

async function stopBroker(broker: SpawnedProcess | undefined, agentDir: string): Promise<void> {
	if (broker !== undefined && broker.exitCode === null) {
		broker.kill("SIGTERM");
		await broker.exited;
	}
	await stopDetachedBroker(agentDir);
}

/** How a 0.9.x client's pending-stage route request settled. */
type RouteOutcome =
	| { readonly outcome: "acknowledged" }
	| {
			readonly outcome: "refused";
			readonly name: unknown;
			readonly connectionKept: unknown;
			readonly code: unknown;
			readonly message: unknown;
	  };

function settleRoute(request: Promise<void>): Promise<RouteOutcome> {
	return request.then(
		() => ({ outcome: "acknowledged" }) as const,
		(error: { name?: unknown; connectionKept?: unknown; code?: unknown; message?: unknown }) => ({
			outcome: "refused",
			name: error?.name,
			connectionKept: error?.connectionKept,
			code: error?.code,
			message: error?.message,
		}),
	);
}

const REFUSED_IN_PLACE: RouteOutcome = {
	outcome: "refused",
	name: "IntercomPendingStageRouteRefusedError",
	connectionKept: true,
	code: "not_authorized",
	message: WORKFLOW_ROUTE_REMOVED_REASON,
};

describe("0.9.x Intercom clients of a workflow run on this version's broker (Atomic 0.10.0 removed workflows)", () => {
	const brokerFixture = new IntercomBrokerFixture(temporaryAgentDir(process.env.ATOMIC_TEST_RUN_DIR));
	const proxyAgentDir = temporaryAgentDir(process.env.ATOMIC_TEST_RUN_DIR);
	const cleanups: Array<() => Promise<unknown>> = [];
	let restoreAgentDir: (() => void) | undefined;
	let broker: SpawnedProcess | undefined;
	let proxy: WireProxy | undefined;
	/** Each 0.9.x release's client, and the socket it is given when it takes one rather than reading its agent dir. */
	const releases = new Map<string, { readonly Client: PreviousClientClass; readonly brokerSocketPath?: string }>();

	beforeAll(async () => {
		const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
		broker = startBroker(join(repoRoot, "packages/intercom/broker/broker.ts"), brokerFixture.agentDir);
		const brokerSocketPath = getBrokerSocketPath(process.platform, brokerFixture.agentDir);
		await brokerFixture.holdSession(brokerSocketPath, BROKER_START_WAIT_MS);

		// The 0.9.71 client fixes its broker socket when its module loads, from the agent directory then current: the
		// proxy's. Every 0.9.x connection reaches the broker through the proxy, which records each of its frames.
		restoreAgentDir = replaceEnvironmentVariable("ATOMIC_CODING_AGENT_DIR", proxyAgentDir);
		vi.resetModules();
		const previousPaths = (await import(join(RELEASE_0_9_71, "broker/paths.ts"))) as {
			getBrokerSocketPath(platform: NodeJS.Platform, agentDir: string): string;
		};
		const proxySocketPath = previousPaths.getBrokerSocketPath(process.platform, proxyAgentDir);
		mkdirSync(join(proxyAgentDir, "intercom"), { recursive: true });
		proxy = await WireProxy.listen(proxySocketPath, brokerSocketPath);
		const load = async (release: string) =>
			((await import(join(release, "broker/client.ts"))) as { IntercomClient: PreviousClientClass }).IntercomClient;
		releases.set("0.9.71", { Client: await load(RELEASE_0_9_71) });
		releases.set("0.9.77-alpha.1", {
			Client: await load(RELEASE_0_9_77_ALPHA_1),
			brokerSocketPath: proxySocketPath,
		});
	}, HOOK_TIMEOUT_MS);

	afterAll(async () => {
		try {
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
			await proxy?.close();
			await stopBroker(broker, brokerFixture.agentDir);
			await brokerFixture.cleanup();
		} finally {
			restoreAgentDir?.();
		}
	}, HOOK_TIMEOUT_MS);

	async function connect(
		release: string,
		name: string,
		group: string,
		options: { multiplexesPendingStageRoutes?: true } = {},
	): Promise<Watched<PreviousClient>> {
		const found = releases.get(release);
		assert.ok(found, release);
		const { Client, brokerSocketPath } = found;
		const watched = watch(
			new Client(randomUUID(), {
				acknowledgesReceipt: true,
				...options,
				...(brokerSocketPath === undefined ? {} : { brokerSocketPath }),
			}),
		);
		await watched.client.connect(session(name, group), undefined, undefined, undefined, group);
		cleanups.push(() => watched.client.disconnect().catch(() => undefined));
		return watched;
	}

	/** Registered once on the wire, under the id the client holds: one connection, one `register`, one `registered`. */
	function assertRegisteredOnce(name: string, sessionId: string): void {
		assert.ok(proxy);
		const connections = proxy.registeredAs(name);
		assert.equal(connections.length, 1, `${name} opened one connection`);
		const [connection] = connections;
		assert.ok(connection);
		assert.equal(framesOfType(connection.toBroker, "register").length, 1, `${name} registered once`);
		const registered = framesOfType(connection.toClient, "registered");
		assert.deepEqual(
			registered.map((frame) => frame.sessionId),
			[sessionId],
			`${name} was registered once, under its own id`,
		);
	}

	test.each([
		{ release: "0.9.71", mainConnectionRoute: { outcome: "acknowledged" } as RouteOutcome },
		{ release: "0.9.77-alpha.1", mainConnectionRoute: REFUSED_IN_PLACE },
	])(
		"a $release stage asks its parent and is steered by name and id; workflow frames are answered in place, and no connection drops or registers again",
		async ({ release, mainConnectionRoute }) => {
			const runId = randomUUID();
			const group = `workflow:${runId}`;
			const capability = `cap-${runId}`;
			const parentName = `parent-${release}`;
			const stageName = `stage-${release}`;
			const routeName = `route-${release}`;

			const parent = await connect(release, parentName, group);
			const parentId = idOf(parent.client);

			// The run's owner announces its pending-stage route on its main connection. A client without a protocol range
			// may predate the in-place refusal, so it is acknowledged; a client with one is refused in place.
			const stages: StageAnnouncement[] = [
				{
					stageId: "reviewer-1",
					stageName: "reviewer",
					target: `${group}/reviewer`,
					lifecycle: "pending",
					routeEligible: true,
					recipientPurpose: "agent",
					group,
				},
			];
			assert.deepEqual(
				await settleRoute(
					parent.client.registerPendingStageRouteAcknowledged(runId, group, capability, stages, []),
				),
				mainConnectionRoute,
			);
			assert.equal(parent.client.isConnected(), true, "the owner keeps its connection after its pending route");

			// Its routes connection asks for in-place refusals, and is refused in place.
			const route = await connect(release, routeName, group, { multiplexesPendingStageRoutes: true });
			assert.deepEqual(
				await settleRoute(route.client.registerPendingStageRouteAcknowledged(runId, group, capability, stages, [])),
				REFUSED_IN_PLACE,
			);
			assert.equal(route.client.isConnected(), true, "the route connection survives the refusal");
			assert.equal(await parent.client.claimWorkflowInvocation(runId, "launcher-capability"), false);
			assertRegisteredOnce(routeName, idOf(route.client));
			await route.client.disconnect();

			// A stage of the run registers and announces its live route, as its Intercom runtime does on every connect.
			const stage = await connect(release, stageName, group);
			const stageId = idOf(stage.client);
			await stage.client.registerLiveWorkflowStageRoute(runId, ["reviewer-1", "reviewer"], capability);

			// The stage asks its parent by name, and the parent answers.
			const ask = await stage.client.send(parentName, { text: "which file?", expectsReply: true });
			assert.equal(ask.delivered, true, ask.reason);
			await waitFor("the parent receives the ask", () => parent.received.some((message) => message.id === ask.id));
			const answer = await parent.client.send(stageId, {
				text: "src/app.ts",
				replyTo: ask.id,
				requirePendingReply: true,
			});
			assert.equal(answer.delivered, true, answer.reason);
			await waitFor("the stage receives the answer", () =>
				stage.received.some((message) => message.replyTo === ask.id && message.content.text === "src/app.ts"),
			);

			// After the round trip it keeps asking, by its parent's id.
			const again = await stage.client.send(parentId, { text: "and the test?", expectsReply: true });
			assert.equal(again.delivered, true, again.reason);
			await waitFor("the parent receives the second ask", () =>
				parent.received.some((message) => message.id === again.id),
			);

			// The parent steers the stage by name and by id.
			for (const to of [stageName, stageId]) {
				const steer = await parent.client.send(to, { text: `steer via ${to}` });
				assert.equal(steer.delivered, true, steer.reason);
			}
			await waitFor("the stage receives both steers", () =>
				[stageName, stageId].every((to) =>
					stage.received.some((message) => message.content.text === `steer via ${to}`),
				),
			);

			// A send to the stage's workflow path, and a pending-stage notification, are refused with the 0.10.0 reason.
			const viaPath = await parent.client.send(`${group}/reviewer`, { text: "via path" });
			assert.equal(viaPath.delivered, false);
			assert.equal(viaPath.reason, WORKFLOW_TARGET_REMOVED_REASON);
			assert.match(viaPath.reason ?? "", /removed in Atomic 0\.10\.0/);
			const notification = await parent.client.sendPendingStageNotification(
				runId,
				capability,
				`${group}/reviewer`,
				undefined,
				{ text: "notice" },
			);
			assert.equal(notification.delivered, false);
			assert.equal(notification.reason, WORKFLOW_ROUTE_REMOVED_REASON);

			// Nothing dropped, raised an error or registered again, on the client or on the wire.
			await new Promise((settle) => setTimeout(settle, QUIET_MS));
			const listed = await parent.client.listSessions();
			for (const [name, watched, sessionId] of [
				[parentName, parent, parentId],
				[stageName, stage, stageId],
			] as const) {
				assert.equal(watched.client.isConnected(), true, `${name} is connected`);
				assert.equal(watched.client.sessionId, sessionId, `${name} kept its session id`);
				assert.equal(watched.disconnects, 0, `${name} never lost its connection`);
				assert.deepEqual(watched.errors, [], `${name} raised no error`);
				assert.ok(
					listed.some((info) => info.id === sessionId && info.name === name),
					`${name} is listed under its id`,
				);
				assertRegisteredOnce(name, sessionId);
			}
			await stage.client.disconnect();
			await parent.client.disconnect();
		},
		TEST_TIMEOUT_MS,
	);
});

describe("this version's Intercom client on a 0.9.71 broker routing a 0.9.71 workflow run", () => {
	const brokerFixture = new IntercomBrokerFixture(temporaryAgentDir(process.env.ATOMIC_TEST_RUN_DIR));
	const cleanups: Array<() => Promise<unknown>> = [];
	let restoreAgentDir: (() => void) | undefined;
	let broker: SpawnedProcess | undefined;
	let brokerSocketPath = "";
	let PreviousIntercomClient: PreviousClientClass;
	let CurrentIntercomClient: typeof import("../../packages/intercom/broker/client.js").IntercomClient;

	beforeAll(async () => {
		// The 0.9.71 client fixes its broker socket when its module loads, from the agent directory then current.
		restoreAgentDir = replaceEnvironmentVariable("ATOMIC_CODING_AGENT_DIR", brokerFixture.agentDir);
		vi.resetModules();
		const previousPaths = (await import(join(RELEASE_0_9_71, "broker/paths.ts"))) as {
			getBrokerSocketPath(platform: NodeJS.Platform, agentDir: string): string;
		};
		brokerSocketPath = previousPaths.getBrokerSocketPath(process.platform, brokerFixture.agentDir);
		broker = startBroker(join(RELEASE_0_9_71, "broker/broker.ts"), brokerFixture.agentDir);
		await brokerFixture.holdSession(brokerSocketPath, BROKER_START_WAIT_MS);
		PreviousIntercomClient = (
			(await import(join(RELEASE_0_9_71, "broker/client.ts"))) as { IntercomClient: PreviousClientClass }
		).IntercomClient;
		CurrentIntercomClient = (await import("../../packages/intercom/broker/client.js")).IntercomClient;
	}, HOOK_TIMEOUT_MS);

	afterAll(async () => {
		try {
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
			await stopBroker(broker, brokerFixture.agentDir);
			await brokerFixture.cleanup();
		} finally {
			restoreAgentDir?.();
		}
	}, HOOK_TIMEOUT_MS);

	async function connectPrevious(name: string, group: string): Promise<Watched<PreviousClient>> {
		const watched = watch(new PreviousIntercomClient(randomUUID(), { acknowledgesReceipt: true }));
		await watched.client.connect(session(name, group), undefined, undefined, undefined, group);
		cleanups.push(() => watched.client.disconnect().catch(() => undefined));
		return watched;
	}

	async function connectCurrent(name: string, group: string, groups?: readonly string[]) {
		const watched = watch<CurrentClient>(
			new CurrentIntercomClient(randomUUID(), { acknowledgesReceipt: true, brokerSocketPath }),
		);
		await watched.client.connect(session(name, group, groups), undefined, undefined, undefined, group);
		cleanups.push(() => watched.client.disconnect().catch(() => undefined));
		return watched;
	}

	test(
		"lists no workflow rows, and sends, asks, replies, joins and leaves with the run's stage and other sessions",
		async () => {
			const runId = randomUUID();
			const runGroup = `workflow:${runId}`;
			const capability = `cap-${runId}`;

			// A 0.9.71 workflow run: its owner registers the run's pending-stage route and roster, its stage its live route.
			const owner = await connectPrevious("previous-owner", runGroup);
			await owner.client.registerPendingStageRouteAcknowledged(
				runId,
				runGroup,
				capability,
				[
					{
						stageId: "reviewer-1",
						stageName: "reviewer",
						target: `${runGroup}/reviewer-1`,
						lifecycle: "running",
						routeEligible: true,
						recipientPurpose: "agent",
						group: runGroup,
					},
				],
				[],
			);
			const stage = await connectPrevious("previous-stage", runGroup);
			await stage.client.registerLiveWorkflowStageRoute(runId, ["reviewer-1"], capability);
			const previousDirectory = await owner.client.listDirectory();
			assert.ok(previousDirectory.workflowStages.length > 0, "the 0.9.71 broker lists the run's stage to its owner");

			// Sessions of this version join the run's group, an ordinary group to them, and the default group.
			const alpha = await connectCurrent("current-alpha", runGroup, [runGroup, "default"]);
			const beta = await connectCurrent("current-beta", "default");

			const directory = await alpha.client.listDirectory();
			assert.deepEqual(
				Object.keys(directory).filter((key) => /workflow/i.test(key)),
				[],
			);
			assert.ok(directory.sessions.some((info) => info.name === "previous-stage" && info.id === idOf(stage.client)));

			// Sends and asks both ways between sessions of this version, and with the run's 0.9.71 stage.
			const toBeta = await alpha.client.send("current-beta", { text: "new to new" });
			assert.equal(toBeta.delivered, true, toBeta.reason);
			const toStage = await alpha.client.send("previous-stage", { text: "new to old stage", expectsReply: true });
			assert.equal(toStage.delivered, true, toStage.reason);
			await waitFor("the stage receives the ask", () => stage.received.some((message) => message.id === toStage.id));
			const stageAnswers = await stage.client.send(idOf(alpha.client), {
				text: "old answers",
				replyTo: toStage.id,
				requirePendingReply: true,
			});
			assert.equal(stageAnswers.delivered, true, stageAnswers.reason);
			const stageAsks = await stage.client.send("current-alpha", { text: "old asks", expectsReply: true });
			assert.equal(stageAsks.delivered, true, stageAsks.reason);
			await waitFor(
				"alpha receives the stage's answer and its ask",
				() =>
					alpha.received.some((message) => message.replyTo === toStage.id) &&
					alpha.received.some((message) => message.id === stageAsks.id),
			);
			const alphaAnswers = await alpha.client.send(idOf(stage.client), {
				text: "new answers",
				replyTo: stageAsks.id,
				requirePendingReply: true,
			});
			assert.equal(alphaAnswers.delivered, true, alphaAnswers.reason);
			await waitFor("the stage receives alpha's answer", () =>
				stage.received.some(
					(message) => message.replyTo === stageAsks.id && message.content.text === "new answers",
				),
			);
			await waitFor("beta receives", () => beta.received.some((message) => message.content.text === "new to new"));

			// Groups: list, join and leave.
			const groups = await alpha.client.listGroups();
			assert.ok(groups.some((summary) => summary.group === "default"));
			assert.ok((await beta.client.joinGroup("team-x")).includes("team-x"));
			assert.equal((await beta.client.leaveGroup("team-x")).includes("team-x"), false);

			await new Promise((settle) => setTimeout(settle, QUIET_MS));
			for (const [name, watched] of [
				["current-alpha", alpha],
				["current-beta", beta],
				["previous-owner", owner],
				["previous-stage", stage],
			] as const) {
				assert.equal(watched.client.isConnected(), true, `${name} is connected`);
				assert.equal(watched.disconnects, 0, `${name} never lost its connection`);
				assert.deepEqual(watched.errors, [], `${name} raised no error`);
			}
			for (const watched of [alpha, beta, stage, owner]) await watched.client.disconnect();
		},
		TEST_TIMEOUT_MS,
	);
});
