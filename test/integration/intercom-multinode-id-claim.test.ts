import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * With multi-node routing, a registration that asks for its Intercom id back waits for the shared database to bind
 * that id before it is registered. What happens to the connection meanwhile is decided when the claim answers. The
 * shared database answers slowly here, so each scenario lands inside that wait.
 */

const REAL_BROKERS_HOOK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 90_000;
const DATABASE_CALL_DELAY_MS = 150;
const WAIT = { timeout: 20_000, interval: 25 };
/** Long enough for a claim that was under way to answer. */
const SETTLE_MS = 2_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ databaseCallDelayMs: DATABASE_CALL_DELAY_MS });
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

/** A raw connection to node a's broker that records the frame types it is sent and whether it closed. */
async function rawConnection() {
	const socket = net.connect(harness.socketPath("a"));
	const frames: string[] = [];
	let closed = false;
	socket.on(
		"data",
		createMessageReader(
			(frame) => {
				if (typeof frame === "object" && frame !== null && !Array.isArray(frame) && typeof frame.type === "string")
					frames.push(frame.type);
			},
			() => socket.destroy(),
		),
	);
	socket.on("error", () => {});
	socket.on("close", () => {
		closed = true;
	});
	await new Promise<void>((resolveConnect) => socket.once("connect", () => resolveConnect()));
	const register = (returnAddress: string, preferredSessionId: string) =>
		writeMessage(socket, {
			type: "register",
			session: {
				name: unique("raw"),
				cwd: harness.root,
				model: "raw",
				pid: process.pid,
				startedAt: 1,
				lastActivity: 1,
			},
			returnAddress,
			preferredSessionId,
		});
	return { socket, frames, register, closed: () => closed };
}

test(
	"a connection that registers again while its requested id is being claimed is refused",
	async () => {
		assert.ok(harness.multiNodeRouting, "the brokers route across nodes");
		const raw = await rawConnection();
		const returnAddress = randomUUID();
		raw.register(returnAddress, randomUUID());
		raw.register(returnAddress, randomUUID());
		await vi.waitFor(() => assert.equal(raw.closed(), true), WAIT);
		await sleep(SETTLE_MS);
		assert.deepEqual(raw.frames, []);
	},
	TEST_TIMEOUT_MS,
);

test(
	"a connection that closes while its requested id is being claimed leaves the id to the session it is bound to",
	async () => {
		assert.ok(harness.multiNodeRouting, "the brokers route across nodes");
		const group = unique("g");
		const original = await harness.connect("a", unique("original"), { group });
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;

		const raw = await rawConnection();
		raw.register(original.returnAddress, id);
		await sleep(DATABASE_CALL_DELAY_MS / 3);
		raw.socket.destroy();
		await sleep(SETTLE_MS);

		const back = await harness.connect("a", original.name, {
			group,
			returnAddress: original.returnAddress,
			preferredSessionId: id,
		});
		assert.equal(back.sessionId, id);
	},
	TEST_TIMEOUT_MS,
);

// Last: it shuts node a's broker down.
test(
	"a broker that starts shutting down while a requested id is being claimed refuses the registration",
	async () => {
		assert.ok(harness.multiNodeRouting, "the brokers route across nodes");
		const raw = await rawConnection();
		raw.register(randomUUID(), randomUUID());
		await harness.requestShutdown("a");
		await vi.waitFor(() => assert.equal(raw.closed(), true), WAIT);
		assert.equal(raw.frames.includes("registered"), false, `the connection was sent ${raw.frames.join(", ")}`);
		assert.equal(
			raw.frames.includes("registration_failed"),
			true,
			`the connection was sent ${raw.frames.join(", ")}`,
		);
	},
	TEST_TIMEOUT_MS,
);
