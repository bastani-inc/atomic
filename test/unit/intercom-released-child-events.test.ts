import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterAll, afterEach, beforeEach, describe, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";

const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousIntercomGroup = process.env.ATOMIC_INTERCOM_GROUP;
const previousLegacyIntercomGroup = process.env.PI_INTERCOM_GROUP;
const previousSessionId = process.env.ATOMIC_INTERCOM_SESSION_ID;
process.env.ATOMIC_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "intercom-released-events-"));
delete process.env.ATOMIC_INTERCOM_GROUP;
delete process.env.PI_INTERCOM_GROUP;

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousIntercomGroup === undefined) delete process.env.ATOMIC_INTERCOM_GROUP;
	else process.env.ATOMIC_INTERCOM_GROUP = previousIntercomGroup;
	if (previousLegacyIntercomGroup === undefined) delete process.env.PI_INTERCOM_GROUP;
	else process.env.PI_INTERCOM_GROUP = previousLegacyIntercomGroup;
	if (previousSessionId === undefined) delete process.env.ATOMIC_INTERCOM_SESSION_ID;
	else process.env.ATOMIC_INTERCOM_SESSION_ID = previousSessionId;
});

import { IntercomClient } from "../../packages/intercom/broker/client.js";
import {
	ReleasedChildReservationError,
	UnknownReleasedChildError,
} from "../../packages/intercom/broker/released-child-errors.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import intercom from "../../packages/intercom/index.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomConnectReason } from "../../packages/intercom/intercom-test-seams.js";
import {
	SUBAGENT_RESULT_INTERCOM_EVENT,
	SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT,
} from "../../packages/intercom/intercom-utils.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import {
	INTERCOM_CONNECTED_EVENT,
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/intercom/session-recovery.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: false, hasSharedStorage: false, protocol: { min: 1, max: 2 } }),
}));

type LifecycleHandler = (event: object, ctx: ExtensionContext) => void | Promise<void>;
type Completion = Promise<unknown> | undefined;
interface Request {
	completion?: Promise<unknown>;
}

const SESSION_ID = "019f0000-aaaa-7bbb-8ccc-eeeeeeeeeeee";
const BROKER_SESSION_ID = "broker-assigned-session-id";

const ctx = {
	hasUI: false,
	cwd: process.cwd(),
	model: { id: "test-model" },
	isIdle: () => true,
	ui: { notify() {} },
	sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [] },
} as unknown as ExtensionContext;

const state = { connected: true, sessionId: BROKER_SESSION_ID as string | null };
let reserveCalls: Array<Parameters<IntercomClient["reserveReleasedChildren"]>> = [];
let dropCalls: Array<Parameters<IntercomClient["dropReleasedChildren"]>> = [];
let acknowledgeCalls: Array<Parameters<IntercomClient["acknowledgeReleasedChildWake"]>> = [];
let dropOutcome: () => Promise<void> = () => Promise.resolve();
let acknowledgeOutcome: () => Promise<void> = () => Promise.resolve();
let connectCount = 0;

beforeEach(() => {
	state.connected = true;
	state.sessionId = BROKER_SESSION_ID;
	reserveCalls = [];
	dropCalls = [];
	acknowledgeCalls = [];
	dropOutcome = () => Promise.resolve();
	acknowledgeOutcome = () => Promise.resolve();
	connectCount = 0;
	vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async () => {
		connectCount += 1;
	});
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(() => state.connected);
	vi.spyOn(IntercomClient.prototype, "sessionId", "get").mockImplementation(() => state.sessionId);
	vi.spyOn(IntercomClient.prototype, "reserveReleasedChildren").mockImplementation(async (...args) => {
		reserveCalls.push(args);
	});
	vi.spyOn(IntercomClient.prototype, "dropReleasedChildren").mockImplementation((...args) => {
		dropCalls.push(args);
		return dropOutcome();
	});
	vi.spyOn(IntercomClient.prototype, "acknowledgeReleasedChildWake").mockImplementation((...args) => {
		acknowledgeCalls.push(args);
		return acknowledgeOutcome();
	});
});

afterEach(() => vi.restoreAllMocks());

function fakePi() {
	const handlers = new Map<string, LifecycleHandler[]>();
	const events = createEventBus();
	const emitted: Array<{ name: string; payload: object }> = [];
	const emit = events.emit.bind(events);
	events.emit = (name: string, payload: unknown) => {
		emitted.push({ name, payload: payload as object });
		emit(name, payload);
	};
	const pi = {
		on(name: string, handler: LifecycleHandler) {
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
	return {
		pi,
		emitted,
		async fire(name: string) {
			for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "startup" }, ctx);
		},
	};
}

function connectedNotices(emitted: Array<{ name: string; payload: object }>): object[] {
	return emitted.filter((entry) => entry.name === INTERCOM_CONNECTED_EVENT).map((entry) => entry.payload);
}

async function startHeavy(reasons: IntercomConnectReason[] = []) {
	const harness = fakePi();
	intercomHeavy(harness.pi as never, {
		beforeConnectAttempt: (reason) => {
			reasons.push(reason);
		},
	});
	await harness.fire("session_start");
	await request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children: [] }).completion;
	reserveCalls = [];
	return harness;
}

async function startLightweight() {
	const harness = fakePi();
	intercom(harness.pi as never);
	await harness.fire("turn_start");
	return harness;
}

function request(
	harness: { pi: { events: { emit(name: string, payload: unknown): void } } },
	name: string,
	body: object,
) {
	const payload: Request = { ...body };
	harness.pi.events.emit(name, payload);
	return payload;
}

describe("heavy extension: INTERCOM_CONNECTED_EVENT", () => {
	test("is emitted once with the broker session id after connecting (#4326)", async () => {
		const harness = await startHeavy();
		assert.equal(connectCount, 1);
		assert.deepEqual(connectedNotices(harness.emitted), [{ sessionId: BROKER_SESSION_ID }]);
	});

	test("is not emitted when the connection has no session id (#4326)", async () => {
		state.sessionId = null;
		const harness = await startHeavy();
		assert.equal(connectCount, 1);
		assert.deepEqual(connectedNotices(harness.emitted), []);
	});

	test("is emitted again for a reconnect, one notice per connection (#4326)", async () => {
		const harness = await startHeavy();
		state.connected = false;
		const reserve = request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [{ childName: "subagent-a", wake: true }],
		});
		await reserve.completion;
		assert.equal(connectCount, 2);
		assert.deepEqual(connectedNotices(harness.emitted), [
			{ sessionId: BROKER_SESSION_ID },
			{ sessionId: BROKER_SESSION_ID },
		]);
	});
});

describe("heavy extension: released child bus events", () => {
	test("reserve passes the children to the client and connects in the background when disconnected (#4326)", async () => {
		const reasons: IntercomConnectReason[] = [];
		const harness = await startHeavy(reasons);
		state.connected = false;
		const children = [
			{ childName: "subagent-a", wake: true },
			{ childName: "subagent-b", wake: false, group: "g", aliases: ["x"] },
		];
		const reserve = request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children });
		assert.ok(reserve.completion instanceof Promise);
		await reserve.completion;
		assert.deepEqual(reserveCalls, [[children]]);
		assert.deepEqual(reasons, ["background", "background"]);
	});

	test("reserve ignores an invalid payload and one that already has a completion (#4326)", async () => {
		const harness = await startHeavy();
		const invalid = request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children: "subagent-a" });
		assert.equal(invalid.completion, undefined);
		const existing = Promise.resolve("existing");
		const taken = request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [{ childName: "subagent-a", wake: true }],
			completion: existing,
		});
		assert.equal(taken.completion, existing);
		await existing;
		assert.deepEqual(reserveCalls, []);
	});

	test("drop passes the names, gone and refusal to a connected client (#4326)", async () => {
		const harness = await startHeavy();
		const drop = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, {
			childNames: ["subagent-a", "subagent-b"],
			gone: "ended",
			refusal: "taken over",
		});
		assert.ok(drop.completion instanceof Promise);
		await drop.completion;
		assert.deepEqual(dropCalls, [[["subagent-a", "subagent-b"], { gone: "ended", refusal: "taken over" }]]);
	});

	test("drop leaves out an absent gone and refusal (#4326)", async () => {
		const harness = await startHeavy();
		await request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-a"] }).completion;
		await request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-b"], gone: "ended" })
			.completion;
		await request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-c"], refusal: "no" })
			.completion;
		assert.deepEqual(dropCalls, [
			[["subagent-a"], {}],
			[["subagent-b"], { gone: "ended" }],
			[["subagent-c"], { refusal: "no" }],
		]);
		for (const call of dropCalls) {
			assert.equal(Object.hasOwn(call[1] ?? {}, "refusal"), call[0][0] === "subagent-c");
			assert.equal(Object.hasOwn(call[1] ?? {}, "gone"), call[0][0] === "subagent-b");
		}
	});

	test("drop completes without calling a disconnected client and without a client at all (#4326)", async () => {
		const unstarted = fakePi();
		intercomHeavy(unstarted.pi as never);
		const noClient = request(unstarted, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-a"] });
		assert.ok(noClient.completion instanceof Promise);
		assert.equal(await noClient.completion, undefined);

		const harness = await startHeavy();
		state.connected = false;
		const drop = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-a"] });
		assert.equal(await drop.completion, undefined);
		assert.deepEqual(dropCalls, []);
	});

	test("drop completion is the client's promise and rejects as the client does (#4326)", async () => {
		const harness = await startHeavy();
		dropOutcome = () => Promise.reject(new Error("broker refused the drop"));
		const drop = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-a"] });
		await assert.rejects(drop.completion as Promise<unknown>, /broker refused the drop/);
	});

	test("drop ignores an invalid payload and one that already has a completion (#4326)", async () => {
		const harness = await startHeavy();
		const invalid = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: [1] });
		assert.equal(invalid.completion, undefined);
		const existing = Promise.resolve("existing");
		const taken = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, {
			childNames: ["subagent-a"],
			completion: existing,
		});
		assert.equal(taken.completion, existing);
		assert.deepEqual(dropCalls, []);
	});

	test("acknowledge passes the child name to a connected client (#4326)", async () => {
		const harness = await startHeavy();
		const acknowledge = request(harness, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, {
			childName: "subagent-a",
		});
		assert.ok(acknowledge.completion instanceof Promise);
		await acknowledge.completion;
		assert.deepEqual(acknowledgeCalls, [["subagent-a"]]);
	});

	test("acknowledge completes without calling a disconnected client and without a client at all (#4326)", async () => {
		const unstarted = fakePi();
		intercomHeavy(unstarted.pi as never);
		const noClient = request(unstarted, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName: "a" });
		assert.ok(noClient.completion instanceof Promise);
		assert.equal(await noClient.completion, undefined);

		const harness = await startHeavy();
		state.connected = false;
		const acknowledge = request(harness, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName: "a" });
		assert.equal(await acknowledge.completion, undefined);
		assert.deepEqual(acknowledgeCalls, []);
	});

	test("acknowledge ignores an invalid payload and one that already has a completion (#4326)", async () => {
		const harness = await startHeavy();
		const invalid = request(harness, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName: 4 });
		assert.equal(invalid.completion, undefined);
		const existing = Promise.resolve("existing");
		const taken = request(harness, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, {
			childName: "subagent-a",
			completion: existing,
		});
		assert.equal(taken.completion, existing);
		assert.deepEqual(acknowledgeCalls, []);
	});
});

describe("lightweight extension: released child bus events", () => {
	test("reserve loads the heavy extension and forwards the children (#4326)", async () => {
		const harness = await startLightweight();
		const children = [{ childName: "subagent-a", wake: true, group: "g", aliases: ["x", "y"] }];
		const reserve = request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children });
		assert.ok(reserve.completion instanceof Promise);
		await reserve.completion;
		assert.deepEqual(reserveCalls, [[children]]);
	});

	test("reserve ignores an invalid payload and one that already has a completion (#4326)", async () => {
		const harness = await startLightweight();
		const invalid = request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children: [null] });
		assert.equal(invalid.completion, undefined);
		const existing = Promise.resolve("existing");
		const taken = request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [{ childName: "subagent-a", wake: true }],
			completion: existing,
		});
		assert.equal(taken.completion, existing);
		await existing;
		assert.deepEqual(reserveCalls, []);
	});

	test("reserve rejects when the heavy extension does not handle the request (#4326)", async () => {
		const harness = fakePi();
		intercom(
			harness.pi as never,
			{
				importHeavy: async () => ({ default: async () => {} }),
			} as never,
		);
		await harness.fire("turn_start");
		const reserve = request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [{ childName: "subagent-a", wake: true }],
		});
		await assert.rejects(reserve.completion as Promise<unknown>, /Intercom cannot reserve released subagents/);
	});

	test("drop and acknowledge forward to a loaded heavy extension (#4326)", async () => {
		const harness = await startLightweight();
		await request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [{ childName: "subagent-a", wake: true }],
		}).completion;
		const drop = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, {
			childNames: ["subagent-a"],
			gone: "ended",
			refusal: "taken over",
		});
		assert.ok(drop.completion instanceof Promise);
		await drop.completion;
		assert.deepEqual(dropCalls, [[["subagent-a"], { gone: "ended", refusal: "taken over" }]]);
		const acknowledge = request(harness, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName: "subagent-a" });
		assert.ok(acknowledge.completion instanceof Promise);
		await acknowledge.completion;
		assert.deepEqual(acknowledgeCalls, [["subagent-a"]]);
	});

	test("drop and acknowledge resolve without loading Intercom when it is not loaded (#4326)", async () => {
		const harness = await startLightweight();
		const importsBefore = connectCount;
		const drop = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-a"] });
		const acknowledge = request(harness, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName: "subagent-a" });
		assert.equal(await drop.completion, undefined);
		assert.equal(await acknowledge.completion, undefined);
		assert.equal(connectCount, importsBefore);
		assert.deepEqual(dropCalls, []);
		assert.deepEqual(acknowledgeCalls, []);
	});

	test("drop and acknowledge settle quietly when the broker connection went away under them (#4326)", async () => {
		const harness = await startLightweight();
		await request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [{ childName: "subagent-a", wake: true }],
		}).completion;
		dropOutcome = () => Promise.reject(new IntercomClientDisconnectedError());
		acknowledgeOutcome = () => Promise.reject(new IntercomClientDisconnectedError());
		const drop = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-a"] });
		const acknowledge = request(harness, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName: "subagent-a" });
		assert.equal(await drop.completion, undefined);
		assert.equal(await acknowledge.completion, undefined);
		assert.equal(dropCalls.length, 1);
		assert.equal(acknowledgeCalls.length, 1);
	});

	test("a broker refusal of a drop or an acknowledgement reaches the caller as its typed error (#4326)", async () => {
		const harness = await startLightweight();
		await request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [{ childName: "subagent-a", wake: true }],
		}).completion;
		dropOutcome = () =>
			Promise.reject(new ReleasedChildReservationError({ code: "not_owner", childName: "subagent-a" }));
		acknowledgeOutcome = () =>
			Promise.reject(new UnknownReleasedChildError({ code: "unknown_released_child", childName: "subagent-a" }));
		const drop = request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: ["subagent-a"] });
		const acknowledge = request(harness, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName: "subagent-a" });
		await assert.rejects(drop.completion as Promise<unknown>, (error: Error) => {
			assert.ok(error instanceof ReleasedChildReservationError);
			assert.equal(error.code, "not_owner");
			return true;
		});
		await assert.rejects(acknowledge.completion as Promise<unknown>, (error: Error) => {
			assert.ok(error instanceof UnknownReleasedChildError);
			assert.equal(error.code, "unknown_released_child");
			return true;
		});
	});

	test("drop and acknowledge ignore invalid payloads and ones that already have a completion (#4326)", async () => {
		const harness = await startLightweight();
		await request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [{ childName: "subagent-a", wake: true }],
		}).completion;
		const existing: Completion = Promise.resolve("existing");
		for (const [name, invalid, valid] of [
			[SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: "a" }, { childNames: ["a"] }],
			[SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, { childName: 1 }, { childName: "a" }],
		] as const) {
			assert.equal(request(harness, name, invalid).completion, undefined);
			assert.equal(request(harness, name, { ...valid, completion: existing }).completion, existing);
		}
		assert.deepEqual(dropCalls, []);
		assert.deepEqual(acknowledgeCalls, []);
	});
});

describe("heavy extension: supervisor authorizations of children that are no longer live", () => {
	test("a reconnect re-authorizes only live children, not released, parked, dropped, gone or finished ones (#4326)", async () => {
		const restored: string[] = [];
		vi.spyOn(IntercomClient.prototype, "authorizeSupervisorChild").mockImplementation(
			async (childName, capability) => {
				if (capability !== undefined) restored.push(childName);
				return {
					childName,
					capability: capability ?? `${childName}.capability`,
					supervisorSessionId: BROKER_SESSION_ID,
				};
			},
		);
		vi.spyOn(IntercomClient.prototype, "releaseRestoringRecipient").mockResolvedValue();
		vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);
		vi.spyOn(IntercomClient.prototype, "send").mockResolvedValue({ id: "relayed", delivered: true });
		const harness = await startHeavy();
		const children = ["live", "released", "parked", "dropped", "gone", "finished"].map(
			(name) => `subagent-${name}-1`,
		);
		for (const childName of children) {
			await request(harness, SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT, { childName }).completion;
		}
		const [live, released, parked, dropped, gone, finished] = children as [
			string,
			string,
			string,
			string,
			string,
			string,
		];
		await request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, {
			children: [
				{ childName: released, wake: true },
				{ childName: parked, wake: false },
			],
		}).completion;
		await request(harness, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, { childNames: [dropped], gone: "ended" })
			.completion;
		await request(harness, SUBAGENT_RELEASE_RESTORING_CHILD_EVENT, {
			capability: `${gone}.capability`,
			gone: "its session file was deleted",
		}).completion;
		harness.pi.events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, {
			to: "subagent-parent",
			message: "done",
			runId: "run-1",
			children: [{ intercomTarget: finished }],
		});

		state.connected = false;
		await request(harness, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, { children: [] }).completion;
		assert.equal(connectCount, 2);
		assert.deepEqual(restored, [live]);
	});
});
