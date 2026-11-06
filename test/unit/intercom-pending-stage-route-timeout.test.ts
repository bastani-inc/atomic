import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import {
	IntercomPendingStageRouteTimeoutError,
	isIntercomPendingStageRouteTimeoutError,
} from "../../packages/intercom/pending-stage-route-timeout-error.js";
import {
	IntercomBrokerTimeoutError,
	isIntercomBrokerTimeout,
	isRecoverableIntercomDisconnect,
} from "../../packages/intercom/recoverable-disconnect.js";
import { makeDirectorySync } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

const agentDir = useTemporaryAgentDir();
makeDirectorySync(join(agentDir, "intercom"), { recursive: true });
// The client resolves its broker socket from the agent directory when it loads.
const { IntercomClient, PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS } = await import("../../packages/intercom/broker/client.js");

const RUN_ID = "route-timeout-run";
const REGISTRATION_START_MS = 1_234;
const GROUP = `workflow:${RUN_ID}`;
const clients: InstanceType<typeof IntercomClient>[] = [];
const sockets = new Set<net.Socket>();
let server: net.Server;
/** Whether the broker answers the health check a client sends once a request went unanswered. */
let answersHealthCheck = true;
/** Whether the broker acknowledges a held route registration just before it answers the health check. */
let acknowledgesBeforeHealthCheck = false;
const heldRegistrations: string[] = [];
const received: string[] = [];
const receivedWaiters: (() => void)[] = [];

beforeAll(async () => {
	server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if (typeof message !== "object" || message === null || Array.isArray(message)) return;
					if (typeof message.type === "string") received.push(message.type);
					for (const waiter of receivedWaiters.splice(0)) waiter();
					// It acknowledges route registrations in general, and never answers the one under test.
					if (message.type === "register")
						writeMessage(socket, {
							type: "registered",
							sessionId: "route-timeout-client",
							acknowledgesPendingStageRoutes: true,
						});
					if (message.type === "register_pending_stage_route" && typeof message.requestId === "string")
						heldRegistrations.push(message.requestId);
					if (message.type === "list_groups" && acknowledgesBeforeHealthCheck)
						for (const requestId of heldRegistrations.splice(0))
							writeMessage(socket, { type: "pending_stage_route_registered", requestId });
					if (message.type === "list_groups" && answersHealthCheck)
						writeMessage(socket, { type: "groups", requestId: message.requestId, groups: [] });
				},
				() => socket.destroy(),
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(getBrokerSocketPath(process.platform, agentDir), resolve));
});

afterEach(async () => {
	vi.useRealTimers();
	for (const client of clients.splice(0)) await client.disconnect();
	for (const socket of sockets) socket.destroy();
	answersHealthCheck = true;
	acknowledgesBeforeHealthCheck = false;
	heldRegistrations.length = 0;
	received.length = 0;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect() {
	const client = new IntercomClient();
	clients.push(client);
	client.on("error", () => {});
	await client.connect({ cwd: agentDir, model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 });
	return client;
}

async function brokerReceived(type: string): Promise<void> {
	while (!received.includes(type)) await new Promise<void>((resolve) => receivedWaiters.push(resolve));
}

function rosterRows(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		stageId: `stage-${index}`,
		stageName: `stage-${index}`,
		target: `${GROUP}/stage-${index}`,
		lifecycle: "pending" as const,
		routeEligible: true,
		group: GROUP,
	}));
}

test("an unanswered pending-stage route registration rejects with a typed timeout naming the run and roster size (#4376)", async () => {
	const client = await connect();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	// The registration starts well after the monotonic clock's origin, so its wait is measured from its own start.
	vi.advanceTimersByTime(REGISTRATION_START_MS);
	const registration = client.registerPendingStageRouteAcknowledged(RUN_ID, GROUP, "route-capability", rosterRows(3));
	const outcome = registration.then(
		() => assert.fail("the broker never answered the registration"),
		(error: unknown) => error,
	);
	await brokerReceived("register_pending_stage_route");
	vi.advanceTimersByTime(PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	const error = await outcome;
	assert.ok(error instanceof IntercomPendingStageRouteTimeoutError);
	assert.equal(isIntercomPendingStageRouteTimeoutError(error), true);
	assert.equal(error.code, "pending_stage_route_timeout");
	assert.equal(error.phase, "pending-stage-route-registration");
	assert.equal(error.runId, RUN_ID);
	assert.equal(error.stageCount, 3);
	assert.equal(error.timeoutMs, PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	assert.equal(error.elapsedMs, PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	assert.equal(error.retryable, true);
	assert.equal(error.cause, undefined, "the broker still answered its health check");
	assert.equal(isIntercomBrokerTimeout(error), true);
	assert.equal(isRecoverableIntercomDisconnect(error), true);
	assert.equal(client.isConnected(), true);
});

test("a route registration timeout on a silent broker carries the failed health check as its cause (#4376)", async () => {
	answersHealthCheck = false;
	const client = await connect();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const registration = client.registerPendingStageRouteAcknowledged(RUN_ID, GROUP, "route-capability");
	const outcome = registration.then(
		() => assert.fail("the broker never answered the registration"),
		(error: unknown) => error,
	);
	await brokerReceived("register_pending_stage_route");
	vi.advanceTimersByTime(PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	await brokerReceived("list_groups");
	// Past the health check's own bound, which is shorter than the registration's.
	vi.advanceTimersByTime(PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	const error = await outcome;
	assert.ok(error instanceof IntercomPendingStageRouteTimeoutError);
	assert.equal(error.stageCount, 0, "a registration without a roster carries no rows");
	assert.equal(error.elapsedMs, PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	assert.ok(error.cause instanceof IntercomBrokerTimeoutError);
	assert.equal(isIntercomPendingStageRouteTimeoutError(error.cause), false);
	assert.equal(client.isConnected(), false);
});

test("another request on a silent broker still times out with the failed health check as its cause", async () => {
	answersHealthCheck = false;
	const client = await connect();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const outcome = client.listSessions().then(
		() => assert.fail("the broker never answered the listing"),
		(error: unknown) => error,
	);
	await brokerReceived("list");
	vi.advanceTimersByTime(PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	await brokerReceived("list_groups");
	vi.advanceTimersByTime(PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	const error = await outcome;
	assert.ok(error instanceof IntercomBrokerTimeoutError);
	assert.equal(isIntercomPendingStageRouteTimeoutError(error), false);
	assert.ok(error.cause instanceof IntercomBrokerTimeoutError);
	assert.equal(client.isConnected(), false);
});

test("an acknowledgement read only once the bound expired still settles the registration (#4376)", async () => {
	acknowledgesBeforeHealthCheck = true;
	const client = await connect();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const registration = client.registerPendingStageRouteAcknowledged(RUN_ID, GROUP, "route-capability", rosterRows(1));
	await brokerReceived("register_pending_stage_route");
	vi.advanceTimersByTime(PENDING_STAGE_ROUTE_ACK_TIMEOUT_MS);
	await registration;
	assert.equal(client.isConnected(), true);
});

test("the route registration timeout reads as what failed, the run, its code and the next step", () => {
	const error = new IntercomPendingStageRouteTimeoutError({
		runId: RUN_ID,
		stageCount: 2_500,
		timeoutMs: 10_000,
		elapsedMs: 10_250,
	});
	assert.equal(error.name, "IntercomPendingStageRouteTimeoutError");
	assert.equal(
		error.message,
		`Pending-stage route registration timed out: run ${RUN_ID} with 2500 roster stages, unanswered after 10250 ms of 10000 ms (pending_stage_route_timeout). ${error.hint}`,
	);
	assert.equal(
		error.hint,
		"Resume the run, and Intercom registers its route again; run `atomic intercom restart` if the broker keeps timing out.",
	);
});

test("the route registration timeout guard recognizes the error by name and code once it is plain data", () => {
	const error = new IntercomPendingStageRouteTimeoutError({
		runId: RUN_ID,
		stageCount: 1,
		timeoutMs: 10,
		elapsedMs: 11,
	});
	const serialized = JSON.parse(
		JSON.stringify({
			name: error.name,
			code: error.code,
			message: error.message,
			hint: error.hint,
			runId: error.runId,
			stageCount: error.stageCount,
			timeoutMs: error.timeoutMs,
			elapsedMs: error.elapsedMs,
		}),
	);
	assert.equal(isIntercomPendingStageRouteTimeoutError(serialized), true);
	const renamed = new IntercomPendingStageRouteTimeoutError({
		runId: RUN_ID,
		stageCount: 0,
		timeoutMs: 10,
		elapsedMs: 10,
	});
	Object.defineProperty(renamed, "name", { value: "RenamedRouteTimeout" });
	assert.equal(isIntercomPendingStageRouteTimeoutError(renamed), true, "an instance is recognized by its class");
	assert.deepEqual(
		{
			runId: serialized.runId,
			stageCount: serialized.stageCount,
			timeoutMs: serialized.timeoutMs,
			elapsedMs: serialized.elapsedMs,
		},
		{ runId: RUN_ID, stageCount: 1, timeoutMs: 10, elapsedMs: 11 },
	);
	assert.equal(isIntercomPendingStageRouteTimeoutError({ ...serialized, code: "pending_stage_route_refused" }), false);
	assert.equal(isIntercomPendingStageRouteTimeoutError({ ...serialized, name: "IntercomBrokerTimeoutError" }), false);
	assert.equal(isIntercomPendingStageRouteTimeoutError(new IntercomBrokerTimeoutError("Connection timeout")), false);
	assert.equal(isIntercomPendingStageRouteTimeoutError(null), false);
	assert.equal(isIntercomPendingStageRouteTimeoutError(undefined), false);
	assert.equal(isIntercomPendingStageRouteTimeoutError("IntercomPendingStageRouteTimeoutError"), false);
});
